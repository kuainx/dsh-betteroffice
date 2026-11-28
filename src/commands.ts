import { DomainError } from './errors.js'
import {
  MIN_NODE_VERSION,
  changeKind,
  cliPathFor,
  compareVersions,
  nodeGate,
  rollbackGate,
  satisfiesNode,
} from './runtime.js'
import type { Installer } from './installer.js'

/** 斜杠命令 handler 的返回契约（dsh-commands 的 CommandResult）。 */
export type CommandResult =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

/** 只用到命令注册的这一小块。 */
export interface CommandApi {
  register(definition: {
    name: string
    description: string
    handler: (invocation: { rawInput: string; signal?: AbortSignal }) => CommandResult | Promise<CommandResult>
  }): () => void
}

export const COMMAND_NAME = 'betteroffice'

const USAGE = '用法：/betteroffice 状态 | 安装 [版本] | 检查更新 | 更新 [版本] | 回退 <版本>'

export interface CommandDeps {
  home: string
  nodeVersion: string
  exists(path: string): boolean
  currentConfig(): { runtimeVersion: string; nodePath: string }
  setRuntimeVersion(version: string): void | Promise<void>
  installer: Installer
  latestVersion(): Promise<string>
  installedVersions(): readonly string[]
}

export interface BetterOfficeCommand {
  name: string
  description: string
  handler(invocation: { rawInput: string; signal?: AbortSignal }): Promise<CommandResult>
}

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

function describeError(error: unknown): string {
  if (error instanceof DomainError) return error.message
  const message = error instanceof Error ? error.message : String(error)
  return `出错了：${message}`
}

/** `/betteroffice` 斜杠命令：运行时检测、安装、检查更新、更新、回退，全部由用户触发。 */
export function createBetterOfficeCommand(deps: CommandDeps): BetterOfficeCommand {
  const installedList = (): string[] => [...deps.installedVersions()].sort(compareVersions)

  function status(): CommandResult {
    const configured = deps.currentConfig().runtimeVersion
    const installed = installedList()
    const nodeOk = satisfiesNode(deps.nodeVersion)
    const lines = ['BetterOffice 运行时', '']
    lines.push(`- 当前使用的版本：${configured === '' ? '未设置（打开文档前请先 /betteroffice 安装）' : configured}`)
    lines.push(`- 已安装的版本：${installed.length === 0 ? '无' : installed.join('、')}`)
    lines.push(
      `- Node：v${deps.nodeVersion}（${nodeOk ? `满足 ≥${MIN_NODE_VERSION}` : `需要 ≥${MIN_NODE_VERSION}，请升级 Node`}）`,
    )
    if (configured !== '' && !deps.exists(cliPathFor(deps.home, configured))) {
      lines.push('- 注意：当前版本目录里没有 betteroffice-mcp，装好它之前打开文档会失败')
    }
    lines.push('', USAGE)
    return ok(lines.join('\n'))
  }

  async function install(version: string | undefined, mode: '安装' | '更新'): Promise<CommandResult> {
    const tooOld = nodeGate(deps.nodeVersion)
    if (tooOld !== undefined) return fail(tooOld)
    const target = version ?? (await deps.latestVersion())
    const before = deps.currentConfig().runtimeVersion
    const result = await deps.installer.install(target)
    await deps.setRuntimeVersion(result.version)
    const change = changeKind(before, result.version)
    if (change === 'same') {
      return ok(`没有变化：@betteroffice/agents@${result.version} 已经是当前版本。\n- 目录：${result.dir}`)
    }
    const others = installedList().filter((item) => item !== result.version)
    const keep = others.length === 0 ? '' : `\n旧版本仍保留：${others.join('、')}（可用 /betteroffice 回退 切回）`
    const note = change === 'downgrade' ? '（这是降级，不是更新）' : ''
    return ok(
      `${mode}完成${note}：@betteroffice/agents@${result.version}\n- 目录：${result.dir}\n- 之后新打开的文档都用这个版本${keep}`,
    )
  }

  async function checkUpdate(): Promise<CommandResult> {
    const latest = await deps.latestVersion()
    const configured = deps.currentConfig().runtimeVersion
    if (configured === '') return ok(`最新版本是 ${latest}。还没装过，运行 /betteroffice 安装 即可。`)
    const compared = compareVersions(configured, latest)
    if (compared === 0) return ok(`已经是最新版 ${latest}。`)
    if (compared > 0) return ok(`当前 ${configured} 比 registry 上的 latest（${latest}）还新，没有可更新的东西。`)
    return ok(`有新版：${latest}（当前 ${configured}）。运行 /betteroffice 更新 安装它；旧版本会保留，之后可回退。`)
  }

  async function rollback(version: string | undefined): Promise<CommandResult> {
    if (version === undefined) return fail(`回退需要指定版本。${USAGE}`)
    const problem = rollbackGate(installedList(), version)
    if (problem !== undefined) return fail(problem)
    await deps.setRuntimeVersion(version)
    return ok(`已切回 ${version}。之后新打开的文档用它；已打开的任务继续用自己记录的版本。`)
  }

  return {
    name: COMMAND_NAME,
    description: 'BetterOffice：检测 / 安装 / 更新 / 回退文档处理运行时',
    async handler(invocation): Promise<CommandResult> {
      const words = invocation.rawInput
        .trim()
        .split(/\s+/)
        .filter((word) => word !== '')
      const verb = words[0] ?? '状态'
      const argument = words[1]
      try {
        switch (verb) {
          case '状态':
          case 'status':
            return status()
          case '安装':
          case 'install':
            return await install(argument, '安装')
          case '检查更新':
          case 'check':
            return await checkUpdate()
          case '更新':
          case 'update':
            return await install(argument, '更新')
          case '回退':
          case 'rollback':
            return await rollback(argument)
          default:
            return fail(`不认识的子命令：${verb}\n${USAGE}`)
        }
      } catch (error) {
        return fail(describeError(error))
      }
    },
  }
}
