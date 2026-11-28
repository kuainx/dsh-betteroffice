/** 配置卡片的动作层：只处理「请求 → 结果」，不碰 http 对象，方便测试与复用。 */

import type { ConfigData } from './config.js'
import { buildStatus, parseAction } from './control.js'
import type { ActionRequest, StatusSnapshot } from './control.js'
import { DomainError } from './errors.js'
import { changeKind, compareVersions, nodeGate, rollbackGate } from './runtime.js'

export interface ControlDeps {
  home: string
  nodeVersion: string
  getConfig: () => ConfigData
  saveRuntimeVersion: (version: string) => Promise<void>
  /** 卡片上那两个开关 + 运行时来源。 */
  saveSettings: (patch: { workspaceMode: string; cleanupMode: string; registry: string }) => Promise<void>
  /** 已存的来源选择：空串表示默认档。 */
  storedRegistry: () => string
  /** 实际要用的源：默认档会去问 npm，读不到退回 npmjs。 */
  resolveRegistry: () => Promise<string>
  install: (version: string, registry?: string) => Promise<{ version: string; dir: string; cliPath: string }>
  latestVersion: (registry: string) => Promise<string>
  installedVersions: () => readonly string[]
  exists: (path: string) => boolean
  inFlight: () => readonly string[]
  logger?: (message: string, error?: unknown) => void
}

export type ApiResult = { status: 200 | 400 | 409 | 500; body: unknown }

/** 用户侧错误自带状态码（见 DomainError.status），其余一律 500。 */
function statusOf(error: unknown): 400 | 409 | 500 {
  if (!(error instanceof DomainError)) return 500
  return error.status ?? 500
}

const WORKSPACE_TEXT: Record<string, string> = { auto: '自动', never: '不使用', always: '强制使用' }
const CLEANUP_TEXT: Record<string, string> = { off: '不删除', auto: '自动删除', on: '总是删除' }

function fail(status: 400 | 409 | 500, error: unknown): ApiResult {
  return {
    status,
    body: { ok: false, error: error instanceof Error ? error.message : String(error) },
  }
}

/** 宿主 webServer 的最小形状：register 返回**一个**注销函数（不是数组）。 */
export interface RouteWeb {
  register(route: ControlRoute): () => void
}

/**
 * 一条精确匹配路由。
 *
 * 宿主以 `(req, res)` 调用 handler，`kind: 'exact'` 才是精确表——省了它会被塞进
 * prefix 表，`/api/betteroffice/statusxyz` 也会命中。宿主只认 kind / path /
 * handler / auth，method 是我们自己拿来回 405 的。
 */
export interface ControlRoute {
  kind: 'exact'
  method: 'GET' | 'POST'
  path: string
  handler(request: unknown, response: unknown): Promise<void>
}

export interface RegisterRoutesInput {
  /** 注册时的插件 Context：admitRoute 要用它读宿主服务，请求进来时才有值。 */
  ctx: unknown
  web: RouteWeb
  api: { status(): Promise<ApiResult>; action(raw: unknown): Promise<ApiResult> }
  admitRoute: (ctx: unknown, request: unknown) => { status: number; error: string } | undefined
  writeJson: (response: unknown, status: number, body: unknown) => void
  readJsonBody: (request: unknown) => Promise<unknown>
}

export const STATUS_PATH = '/api/betteroffice/status'
export const ACTION_PATH = '/api/betteroffice/action'

/** 把控制接口挂到宿主 webServer 上；每条路由第一件事都是过访问围栏。 */
export function registerControlRoutes(input: RegisterRoutesInput): readonly (() => void)[] {
  const { ctx, web, api, admitRoute, writeJson, readJsonBody } = input

  async function guarded(
    request: unknown,
    response: unknown,
    method: ControlRoute['method'],
    run: () => Promise<ApiResult> | ApiResult,
  ): Promise<void> {
    try {
      const rejection = admitRoute(ctx, request)
      if (rejection !== undefined) {
        writeJson(response, rejection.status, { ok: false, error: rejection.error })
        return
      }
      if ((request as { method?: unknown }).method !== method) {
        writeJson(response, 405, { ok: false, error: `这个地址只接受 ${method} 请求。` })
        return
      }
      const result = await run()
      writeJson(response, result.status, result.body)
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const statusRoute: ControlRoute = {
    kind: 'exact',
    method: 'GET',
    path: STATUS_PATH,
    handler: (request, response) => guarded(request, response, 'GET', () => api.status()),
  }

  const actionRoute: ControlRoute = {
    kind: 'exact',
    method: 'POST',
    path: ACTION_PATH,
    handler: (request, response) =>
      guarded(request, response, 'POST', async () => {
        const body = await readJsonBody(request)
        if (body === undefined) {
          return {
            status: 400 as const,
            body: {
              ok: false,
              error: '请求体不是合法 JSON。请发送 {"action":"check"} 这样的对象。',
            },
          }
        }
        return api.action(body)
      }),
  }

  return [web.register(statusRoute), web.register(actionRoute)]
}

export function createControlApi(deps: ControlDeps): {
  status(): Promise<ApiResult>
  action(raw: unknown): Promise<ApiResult>
} {
  function ensureIdle(version: string): void {
    if (deps.inFlight().includes(version)) {
      throw new DomainError('in-flight', `${version} 正在安装中，等它跑完再点一次就好。`, {
        status: 409,
      })
    }
  }

  async function check(): Promise<string> {
    const latest = await deps.latestVersion(await deps.resolveRegistry())
    const current = deps.getConfig().runtimeVersion.trim()
    if (current === '') return `最新版本是 ${latest}，当前还没安装运行时。`
    const diff = compareVersions(latest, current)
    if (diff > 0) return `有新版本 ${latest}（当前 ${current}），点「更新」即可升级。`
    if (diff < 0) return `当前 ${current} 比 registry 上的 ${latest} 还新，不用动。`
    return `已是最新：${current}。`
  }

  async function switchTo(mode: 'install' | 'update' | 'rollback', version: string): Promise<string> {
    // 命令侧与卡片侧共用同一句 Node 门禁；缺了会装出一份跑不起来的运行时。
    const tooOld = nodeGate(deps.nodeVersion)
    if (tooOld !== undefined) throw new DomainError('node-too-old', tooOld, { status: 400 })
    ensureIdle(version)
    const before = deps.getConfig().runtimeVersion.trim()
    const result = await deps.install(version, await deps.resolveRegistry())
    await deps.saveRuntimeVersion(result.version)
    const change = changeKind(before, result.version)
    if (change === 'same') return `已经是 ${result.version}，没有变化。`
    if (change === 'downgrade') return `已降到 ${result.version}。`
    if (mode === 'update') return `已更新到 ${result.version}。`
    if (mode === 'rollback') return `已切回 ${result.version}。`
    return `已安装 ${result.version}，并切到该版本。`
  }

  async function run(request: ActionRequest): Promise<string> {
    if (request.action === 'settings') {
      const patch = request.settings
      await deps.saveSettings(patch)
      const source = patch.registry === '' ? '默认（跟随 npm 配置）' : patch.registry
      return `已保存：工作文件夹 ${WORKSPACE_TEXT[patch.workspaceMode] ?? patch.workspaceMode}，清理模式 ${CLEANUP_TEXT[patch.cleanupMode] ?? patch.cleanupMode}，运行时源 ${source}。`
    }
    if (request.action === 'check') return check()
    if (request.action === 'rollback') {
      const problem = rollbackGate(deps.installedVersions(), request.version)
      if (problem !== undefined) throw new DomainError('rollback-unknown', problem, { status: 400 })
      return switchTo('rollback', request.version)
    }
    return switchTo(request.action, request.version ?? (await deps.latestVersion(await deps.resolveRegistry())))
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
        registry: deps.storedRegistry(),
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
