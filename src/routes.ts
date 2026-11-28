/** 配置卡片的动作层：只处理「请求 → 结果」，不碰 http 对象，方便测试与复用。 */

import type { ConfigData } from './config.js'
import { buildStatus, parseAction } from './control.js'
import type { ActionRequest, StatusSnapshot } from './control.js'
import { DomainError } from './errors.js'
import { compareVersions } from './runtime.js'

export interface ControlDeps {
  home: string
  nodeVersion: string
  getConfig: () => ConfigData
  saveRuntimeVersion: (version: string) => Promise<void>
  install: (version: string) => Promise<{ version: string; dir: string; cliPath: string }>
  latestVersion: () => Promise<string>
  installedVersions: () => readonly string[]
  exists: (path: string) => boolean
  inFlight: () => readonly string[]
  logger?: (message: string, error?: unknown) => void
}

export type ApiResult = { status: 200 | 400 | 409 | 500; body: unknown }

/** 这几类错误是用户输入或时机的错，回 400；安装中的撞车回 409；其余一律 500。 */
const BAD_REQUEST_CODES = new Set(['invalid-action', 'invalid-version', 'rollback-unknown'])

function fail(status: 400 | 409 | 500, error: unknown): ApiResult {
  return { status, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

function statusOf(error: unknown): 400 | 409 | 500 {
  if (!(error instanceof DomainError)) return 500
  if (error.code === 'in-flight') return 409
  return BAD_REQUEST_CODES.has(error.code) ? 400 : 500
}

export function createControlApi(deps: ControlDeps): {
  status(): Promise<ApiResult>
  action(raw: unknown): Promise<ApiResult>
} {
  function ensureIdle(version: string): void {
    if (deps.inFlight().includes(version)) {
      throw new DomainError('in-flight', `${version} 正在安装中，等它跑完再点一次就好。`)
    }
  }

  async function check(): Promise<string> {
    const latest = await deps.latestVersion()
    const current = deps.getConfig().runtimeVersion.trim()
    if (current === '') return `最新版本是 ${latest}，当前还没安装运行时。`
    const diff = compareVersions(latest, current)
    if (diff > 0) return `有新版本 ${latest}（当前 ${current}），点「更新」即可升级。`
    if (diff < 0) return `当前 ${current} 比 registry 上的 ${latest} 还新，不用动。`
    return `已是最新：${current}。`
  }

  async function switchTo(request: ActionRequest, version: string): Promise<string> {
    ensureIdle(version)
    const result = await deps.install(version)
    await deps.saveRuntimeVersion(result.version)
    if (request.action === 'update') return `已更新到 ${result.version}。`
    if (request.action === 'rollback') return `已切回 ${result.version}。`
    return `已安装 ${result.version}，并切到该版本。`
  }

  async function run(request: ActionRequest): Promise<string> {
    if (request.action === 'check') return check()
    if (request.action === 'rollback') {
      const version = request.version ?? ''
      const installed = deps.installedVersions()
      if (!installed.includes(version)) {
        throw new DomainError(
          'rollback-unknown',
          `回退只能选已安装的版本：${installed.length === 0 ? '（还没装任何版本）' : installed.join(' / ')}。`,
        )
      }
      return switchTo(request, version)
    }
    return switchTo(request, request.version ?? (await deps.latestVersion()))
  }

  return {
    async status(): Promise<ApiResult> {
      const snapshot: StatusSnapshot = buildStatus({
        home: deps.home,
        nodeVersion: deps.nodeVersion,
        config: deps.getConfig(),
        installed: deps.installedVersions(),
        exists: deps.exists,
        latest: null,
        inFlight: deps.inFlight(),
      })
      return { status: 200, body: snapshot }
    },

    async action(raw: unknown): Promise<ApiResult> {
      let request: ActionRequest
      try {
        request = parseAction(raw)
      } catch (error) {
        return fail(400, error)
      }
      try {
        return { status: 200, body: { ok: true, text: await run(request) } }
      } catch (error) {
        const status = statusOf(error)
        if (status === 500) deps.logger?.(`betteroffice: ${request.action} 失败`, error)
        return fail(status, error)
      }
    },
  }
}
