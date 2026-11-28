/** 配置卡片的动作层：只处理「请求 → 结果」，不碰 http 对象，方便测试与复用。 */

import type { ConfigData } from './config.js'
import { buildStatus, parseAction } from './control.js'
import type { ActionRequest, StatusSnapshot } from './control.js'
import { DomainError } from './errors.js'
import { MIN_NODE_VERSION, compareVersions, satisfiesNode } from './runtime.js'

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
const BAD_REQUEST_CODES = new Set(['invalid-action', 'invalid-version', 'rollback-unknown', 'node-too-old'])

function fail(status: 400 | 409 | 500, error: unknown): ApiResult {
  return { status, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

function statusOf(error: unknown): 400 | 409 | 500 {
  if (!(error instanceof DomainError)) return 500
  if (error.code === 'in-flight') return 409
  return BAD_REQUEST_CODES.has(error.code) ? 400 : 500
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
      writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
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
            body: { ok: false, error: '请求体不是合法 JSON。请发送 {"action":"check"} 这样的对象。' },
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
    // 命令侧先过 Node 门禁（src/commands.ts），卡片这边没有就会装出一份跑不起来的运行时。
    if (!satisfiesNode(deps.nodeVersion)) {
      throw new DomainError(
        'node-too-old',
        `当前 Node 是 ${deps.nodeVersion}，BetterOffice 需要 ≥${MIN_NODE_VERSION}。请升级 Node.js，或在设置里填写 node 路径。`,
      )
    }
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
