import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { admitRoute, dshHome, readJsonBody, settingsEntryScope, writeJson } from '@hyzyn/dsh-kit'
import { Config, resolveConfig, type ConfigData } from './config.js'
import { createBetterOfficeCommand, type CommandApi } from './commands.js'
import { decideMcpCall } from './guard.js'
import { createConnector } from './mcp.js'
import { listInstalledRuntimes } from './npm-runtime.js'
import { fetchLatestVersion } from './registry.js'
import { resolveRegistry } from './registry-source.js'
import { createControlApi, registerControlRoutes, type RouteWeb } from './routes.js'
import { resolveDocumentPath } from './paths.js'
import { resolveMcpRuntime } from './runtime.js'
import { readStored, writeStored } from './store.js'
import { recycleFile } from './recycle.js'
import { recoverCommits } from './recovery.js'
import { createTaskRegistry, type TaskRegistry } from './tasks.js'
import { registerTools, type ToolDefinition } from './tools.js'
import { createCommandDeps, createRuntimeInstaller, readNpmRegistry, runPowershell } from './wire.js'
import type { Installer } from './installer.js'

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
  // 版本号与卡片上那两个开关都落盘在插件自己的目录：宿主设置服务缺 describe/update 时
  // 那一路是空的，而详情页那一格是插件自己画的，没有「按 Config 自动生成表单」。
  const storeIo = () => ({
    exists: existsSync,
    read: (path: string) => readFileSync(path, 'utf8'),
    mkdir: (path: string) => mkdirSync(path, { recursive: true }),
    write: (path: string, text: string) => writeFileSync(path, text, 'utf8'),
  })
  const withStored = (config: ConfigData): ConfigData => {
    const stored = readStored(dshHome(), storeIo())
    return {
      ...config,
      runtimeVersion: config.runtimeVersion === '' ? stored.runtimeVersion : config.runtimeVersion,
      workspaceMode: (stored.workspaceMode === '' ? config.workspaceMode : stored.workspaceMode) as ConfigData['workspaceMode'],
      cleanupMode: (stored.cleanupMode === '' ? config.cleanupMode : stored.cleanupMode) as ConfigData['cleanupMode'],
    }
  }
  const currentConfig = (): ConfigData => {
    if (configOverride !== undefined) return configOverride
    try {
      return withStored(resolveConfig(rawConfig))
    } catch (error) {
      log('配置无效，改用默认值', error)
      return withStored(resolveConfig(undefined))
    }
  }

  // 安装器与设置作用域各只造一份：配置卡片的按钮和 `/betteroffice` 命令必须落在同一张去重表上，
  // 否则两边各装各的，双击还会真跑两次 npm。
  const runtimeInstaller = createRuntimeInstaller({ home: dshHome(), logger: log })
  const storedSettings = () => readStored(dshHome(), storeIo())
  // 「默认」档跟随 npm 自己的配置：卡片与命令共用这一个解析入口，两边不会打不同源。
  const resolveRegistryNow = (): Promise<string> =>
    resolveRegistry(storedSettings().registry, () => readNpmRegistry(dshHome()))
  const installer: Installer = {
    install: async (version, registry) =>
      await runtimeInstaller.install(version, registry ?? (await resolveRegistryNow())),
    inFlight: () => runtimeInstaller.inFlight(),
  }
  let runtimeSettings: ReturnType<typeof settingsEntryScope>
  const saveRuntimeVersion = async (version: string): Promise<void> => {
    configOverride = { ...currentConfig(), runtimeVersion: version }
    writeStored(dshHome(), { runtimeVersion: version }, storeIo())
    if (runtimeSettings === undefined) return
    try {
      await runtimeSettings.update({ runtimeVersion: version })
    } catch (error) {
      // 宿主设置项写不进去不影响使用：文件已经落了，下次启动照样认这个版本。
      log('宿主设置项没写进去，已改用插件自己的记录', error)
    }
  }

  // 卡片上的两个开关：落盘之后立刻改内存里的配置，页面刷新前就生效。
  const saveSettings = async (patch: {
    workspaceMode: string
    cleanupMode: string
    registry: string
  }): Promise<void> => {
    writeStored(dshHome(), patch, storeIo())
    configOverride = {
      ...currentConfig(),
      workspaceMode: patch.workspaceMode as ConfigData['workspaceMode'],
      cleanupMode: patch.cleanupMode as ConfigData['cleanupMode'],
    }
    if (runtimeSettings === undefined) return
    try {
      await runtimeSettings.update(patch)
    } catch (error) {
      log('宿主设置项没写进去，已改用插件自己的记录', error)
    }
  }

  // 自己拉起 MCP 子进程：宿主沙箱不暴露 ctx.plugin，没法再借宿主的 mcp-client 挂载。
  const connector = createConnector({ logger: log })

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
    connector,
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
    // 取时求值：会话里切了工作目录，相对路径要跟着新目录走，别钉在注册那一刻。
    const cwd = (): string => agent.session?.header?.cwd ?? process.cwd()
    try {
      registerTools(tools, {
        registry,
        sessionId,
        config: currentConfig,
        scope,
        cwd,
      })
    } catch (error) {
      log(`为会话 ${sessionId} 注册 BetterOffice 工具失败`, error)
    }
  }

  // `/betteroffice` 只要有 commands 就能注册：设置服务是可选的，缺了配置项就只落插件自己的记录。
  host.inject?.(['commands'], scoped => {
    const commands = (scoped.get('commands') ?? host.get('commands')) as CommandApi | undefined
    if (commands === undefined || typeof commands.register !== 'function') {
      log('宿主没有提供 commands 服务，/betteroffice 命令不可用')
      return
    }
    runtimeSettings = settingsEntryScope(scoped as unknown as Context, 'betteroffice')
    const command = createBetterOfficeCommand(
      createCommandDeps({
        home: dshHome(),
        getConfig: currentConfig,
        saveRuntimeVersion,
        logger: log,
        installer,
        getRegistry: resolveRegistryNow,
      }),
    )
    const dispose = commands.register({
      name: command.name,
      description: command.description,
      handler: invocation => command.handler(invocation),
    })
    scoped.effect?.(() => dispose, 'betteroffice.command')
  })

  // 配置卡片的两条路由：动作路由会跑 npm、写设置，所以每条都要先过访问围栏。
  host.inject?.(['webServer'], scoped => {
    const web = (scoped.get('webServer') ?? host.get('webServer')) as unknown as RouteWeb | undefined
    if (web === undefined || typeof web.register !== 'function') {
      log('宿主没有 webServer，配置卡片不可用')
      return
    }
    const api = createControlApi({
      home: dshHome(),
      nodeVersion: process.versions.node,
      getConfig: currentConfig,
      saveRuntimeVersion,
      saveSettings,
      storedRegistry: () => storedSettings().registry,
      resolveRegistry: resolveRegistryNow,
      install: (version, registry) => installer.install(version, registry),
      inFlight: () => installer.inFlight(),
      latestVersion: registry => fetchLatestVersion({ registry }),
      installedVersions: () => listInstalledRuntimes(dshHome(), { readdir: readdirSync, exists: existsSync }),
      exists: existsSync,
      logger: log,
    })
    const disposers = registerControlRoutes({
      ctx: scoped,
      web,
      api,
      admitRoute: (inner, request) => admitRoute(inner as never, request as never),
      writeJson: (response, status, body) => writeJson(response as never, status, body),
      readJsonBody: request => readJsonBody(request as never),
    })
    scoped.effect?.(
      () => () => {
        for (const dispose of disposers) dispose()
      },
      'betteroffice.routes',
    )
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

