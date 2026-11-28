import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHome, settingsEntryScope } from '@hyzyn/dsh-kit'
import { Config, resolveConfig, type ConfigData } from './config.js'
import { createBetterOfficeCommand, type CommandApi } from './commands.js'
import { decideMcpCall } from './guard.js'
import { createMounter, type McpClientModule } from './mount.js'
import { resolveDocumentPath } from './paths.js'
import { resolveMcpRuntime } from './runtime.js'
import { recycleFile } from './recycle.js'
import { recoverCommits } from './recovery.js'
import { createTaskRegistry, type TaskRegistry } from './tasks.js'
import type { ToolView } from './invoke.js'
import { registerTools, type ToolDefinition } from './tools.js'
import { createCommandDeps, runPowershell } from './wire.js'

export const name = 'betteroffice'

/**
 * 顶层不注入任何服务：宿主没有 agents/tools 服务时插件仍要能加载，
 * 需要服务的装配在 agent 事件里按需取。
 */
export const inject: string[] = []

export { Config }
export type { ConfigData }

type AgentLike = {
  id?: string
  ctx?: { get?: (service: string) => unknown }
  session?: { id?: string; header?: { cwd?: string } }
}

type ServiceBag = { register(definition: ToolDefinition): unknown }

/**
 * cordis 的事件名靠各包声明合并进 Events；本插件不依赖 dsh-agent 等包的类型，
 * 只用到 on/effect/get，所以按结构取用。
 */
type HostContext = {
  on(event: string, handler: (...args: unknown[]) => void): () => void
  effect(fn: () => (() => void) | void, label?: string): unknown
  get(service: string): unknown
  inject?(names: string[], handler: (scoped: HostContext) => void): unknown
}

function log(message: string, error?: unknown): void {
  const detail =
    error === undefined ? '' : `：${error instanceof Error ? error.message : String(error)}`
  console.warn(`[betteroffice] ${message}${detail}`)
}

function sessionIdOf(agent: AgentLike): string | undefined {
  return agent.session?.id ?? agent.id
}

export function apply(ctx: Context, config?: ConfigData): void {
  const host = ctx as unknown as HostContext
  const rawConfig = config as unknown
  let configOverride: ConfigData | undefined
  const currentConfig = (): ConfigData => {
    if (configOverride !== undefined) return configOverride
    try {
      return resolveConfig(rawConfig)
    } catch (error) {
      log('配置无效，改用默认值', error)
      return resolveConfig(undefined)
    }
  }

  const mounter = createMounter({
    logger: log,
    async loadClient() {
      // 变量说明符：避免打包器把可选 peer 内联进来，同时确保用的是宿主那一份。
      const specifier: string = '@deepseek-ai/dsh-mcp-client'
      try {
        const module = (await import(specifier)) as { apply?: unknown }
        if (typeof module.apply !== 'function') {
          log('@deepseek-ai/dsh-mcp-client 不提供 apply，无法挂载')
          return undefined
        }
        return module as McpClientModule
      } catch (error) {
        log('宿主没有提供 @deepseek-ai/dsh-mcp-client，BetterOffice 工具将不可用', error)
        return undefined
      }
    },
  })

  /** 先看 agent 自己的 scope，再退到根 ctx：MCP 工具挂在 agent.ctx 那一层。 */
  function toolBag(scope: unknown): ToolView | undefined {
    const bag =
      (scope as { get?: (name: string) => unknown } | undefined)?.get?.('tools') ?? host.get('tools')
    if (bag === undefined || typeof (bag as ToolView).view !== 'function') return undefined
    return bag as ToolView
  }

  // 替换原文件不可逆：参数里的 confirm 之外，再走一次宿主审批弹窗，用户点同意才真的动原件。
  // 必须继续 next()：排在后面的策略（拒绝规则、审计）不能被我们截断。
  host.on(
    'tools/pre-execute',
    ((execution: { name?: string }, next: () => unknown) => {
      const name = execution?.name ?? ''
      const guard = decideMcpCall(name)
      if (guard !== undefined) return guard
      if (name !== 'betteroffice_replace') return next()
      return Promise.resolve(next()).then((rest) => {
        if (rest !== null && typeof rest === 'object' && (rest as { kind?: string }).kind === 'deny') {
          return rest
        }
        return {
          kind: 'ask',
          reason: 'BetterOffice 要把这个文档的原件移入回收站，再用草稿替换它。确认继续？',
        }
      })
    }) as (...args: unknown[]) => void,
  )

  // 上次替换如果中断在半路，启动时按事务日志还原或收尾；打开文档前要等它结束。
  const recovery = recoverCommits({ home: dshHome(), logger: log }).catch((error: unknown) => {
    log('检查未完成的替换事务失败', error)
  })

  const registry: TaskRegistry = createTaskRegistry({
    mounter,
    config: currentConfig,
    resolveRuntime: () =>
      resolveMcpRuntime({
        config: currentConfig(),
        home: dshHome(),
        nodeVersion: process.versions.node,
        exists: existsSync,
        env: process.env,
        sep: delimiter,
      }),
    makeTempDir: () => mkdtemp(`${tmpdir()}/betteroffice-`),
    now: () => new Date(),
    newTaskId: () => randomBytes(4).toString('hex'),
    resolveDocument: resolveDocumentPath,
    toolViewFor: toolBag,
    home: dshHome(),
    // 回收站是平台能力：非 Windows 上这里会以 recycle-unavailable 结束，工具不会退化成永久删除。
    recycle: path => recycleFile(path, { run: runPowershell }),
    awaitRecovery: () => recovery,
    logger: log,
  })

  const sessionIds = new Set<string>()
  const sessionOf = new WeakMap<object, string>()

  async function attach(agent: AgentLike): Promise<void> {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) {
      log('agent 没有会话 id，跳过 BetterOffice 工具注册')
      return
    }
    sessionIds.add(sessionId)
    sessionOf.set(agent, sessionId)
    const scope = agent.ctx
    const tools = (scope?.get?.('tools') ?? host.get('tools')) as ServiceBag | undefined
    if (tools === undefined || typeof tools.register !== 'function') {
      log('宿主没有提供 tools 服务，跳过 BetterOffice 工具注册')
      return
    }
    const cwd = agent.session?.header?.cwd ?? process.cwd()
    try {
      registerTools(tools, {
        registry,
        sessionId,
        config: currentConfig,
        scope,
        cwd: () => cwd,
      })
    } catch (error) {
      log(`为会话 ${sessionId} 注册 BetterOffice 工具失败`, error)
    }
  }

  // `/betteroffice` 只在宿主同时提供 commands 与 settings 时注册：配置项的写入要落进设置里。
  host.inject?.(['commands', 'settings'], scoped => {
    const commands = (scoped.get('commands') ?? host.get('commands')) as CommandApi | undefined
    if (commands === undefined || typeof commands.register !== 'function') {
      log('宿主没有提供 commands 服务，/betteroffice 命令不可用')
      return
    }
    const settings = settingsEntryScope(scoped as unknown as Context, 'betteroffice')
    const command = createBetterOfficeCommand(
      createCommandDeps({
        home: dshHome(),
        getConfig: currentConfig,
        saveRuntimeVersion: async version => {
          configOverride = { ...currentConfig(), runtimeVersion: version }
          if (settings === undefined) {
            log('宿主没有提供可写的设置项，运行时版本只在本次会话生效')
            return
          }
          await settings.update({ runtimeVersion: version })
        },
        logger: log,
      }),
    )
    const dispose = commands.register({
      name: command.name,
      description: command.description,
      handler: invocation => command.handler(invocation),
    })
    scoped.effect?.(() => dispose, 'betteroffice.command')
  })

  // agent/created 是串行派发，这里不能 await：挂载 MCP 是异步的，失败只记日志。
  host.on('agent/created', (...args: unknown[]) => {
    const agent = (args[0] as { agent?: AgentLike } | undefined)?.agent
    if (agent === undefined) return
    void attach(agent).catch((error: unknown) => log('BetterOffice agent 装配失败', error))
  })

  host.on('agent/disposed', (...args: unknown[]) => {
    const agent = (args[0] as { agent?: AgentLike } | undefined)?.agent
    if (agent === undefined) return
    const sessionId = sessionOf.get(agent) ?? sessionIdOf(agent)
    if (sessionId === undefined) return
    void registry
      .closeSession(sessionId)
      .catch((error: unknown) => log(`关闭会话 ${sessionId} 的任务失败`, error))
  })

  host.effect(
    () => () => {
      for (const sessionId of sessionIds) {
        void registry.closeSession(sessionId).catch((error: unknown) => {
          log(`插件卸载时关闭会话 ${sessionId} 的任务失败`, error)
        })
      }
      sessionIds.clear()
    },
    'betteroffice.lifecycle',
  )
}

