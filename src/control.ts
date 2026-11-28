/** 配置卡片的状态快照：纯函数，文件存在性与 Node 版本都由调用方注入，便于测试。 */

import { CLEANUP_MODES, WORKSPACE_MODES, type ConfigData } from './config.js'
import { DomainError } from './errors.js'
import { isVersion } from './npm-runtime.js'
import { isRegistryUrl } from './registry.js'
import { MIN_NODE_VERSION, cliPathFor, satisfiesNode } from './runtime.js'

export interface StatusSnapshot {
  node: { version: string; ok: boolean; required: string }
  runtime: { configured: string; installed: readonly string[]; cliReady: boolean }
  settings: { workspaceMode: string; cleanupMode: string; registry: string }
  latest: string | null
  inFlight: readonly string[]
  messages: readonly string[]
}

export interface StatusInput {
  home: string
  nodeVersion: string
  config: ConfigData
  installed: readonly string[]
  exists: (path: string) => boolean
  latest?: string | null
  inFlight?: readonly string[]
  /** 已存的运行时来源；空串表示「默认，跟随 npm 配置」。 */
  registry?: string
}

export type ControlAction = 'install' | 'check' | 'update' | 'rollback' | 'settings'

export type SettingsPatch = { workspaceMode: string; cleanupMode: string; registry: string }

export type ActionRequest =
  | { action: 'check' }
  | { action: 'settings'; settings: SettingsPatch }
  | { action: 'install'; version?: string }
  | { action: 'update'; version?: string }
  | { action: 'rollback'; version: string }

const ACTIONS: readonly ControlAction[] = ['install', 'check', 'update', 'rollback', 'settings']

/** 卡片发来的东西是用户输入：统一标 400，别让调用方去猜哪个码算「用户的错」。 */
function badRequest(code: string, message: string): DomainError {
  return new DomainError(code, message, { status: 400 })
}

/** 卡片发来的两个开关：值只看白名单，别的写法一律拒绝，不静默取默认。 */
function parseSettings(body: { workspaceMode?: unknown; cleanupMode?: unknown; registry?: unknown }): SettingsPatch {
  const workspaceMode = body.workspaceMode
  const cleanupMode = body.cleanupMode
  if (typeof workspaceMode !== 'string' || !(WORKSPACE_MODES as readonly string[]).includes(workspaceMode)) {
    throw badRequest(
      'invalid-settings',
      `工作文件夹取值不对：${workspaceMode === undefined ? '空' : String(workspaceMode)}；可用：auto / never / always。`,
    )
  }
  if (typeof cleanupMode !== 'string' || !(CLEANUP_MODES as readonly string[]).includes(cleanupMode)) {
    throw badRequest(
      'invalid-settings',
      `清理模式取值不对：${cleanupMode === undefined ? '空' : String(cleanupMode)}；可用：off / auto / on。`,
    )
  }
  return { workspaceMode, cleanupMode, registry: parseRegistry(body.registry) }
}

/** 空串 = 默认档（跟随 npm 自己的配置）；其余必须是 http(s) 完整地址。 */
function parseRegistry(value: unknown): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || !isRegistryUrl(value)) {
    throw badRequest(
      'invalid-settings',
      `运行时源地址不对：${value === undefined ? '空' : String(value)}；要写成 https://registry.npmjs.org/ 这样的完整地址，或者留空跟随 npm 配置。`,
    )
  }
  return value.trim()
}

/** 校验卡片发来的动作：不认识的动作、路径穿越的版本号都在这里挡掉，别进业务逻辑。 */
export function parseAction(raw: unknown): ActionRequest {
  const body =
    typeof raw === 'object' && raw !== null
      ? (raw as {
          action?: unknown
          version?: unknown
          workspaceMode?: unknown
          cleanupMode?: unknown
        })
      : {}
  const action = body.action
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    throw badRequest(
      'invalid-action',
      `不认识的操作：${action === undefined ? '空' : String(action)}；可用：install / check / update / rollback / settings。`,
    )
  }
  const kind = action as ControlAction
  if (kind === 'settings') return { action: 'settings', settings: parseSettings(body) }
  // 给了 version 但不是字符串（123 / null / 对象）不能当成「没给」——那会静默装成最新版。
  if ('version' in body && typeof body.version !== 'string') {
    throw badRequest('invalid-version', `版本号看起来不对：${String(body.version)}；只能是 1.2.3 这样的形式。`)
  }
  const version = typeof body.version === 'string' ? body.version.trim() : undefined
  if (kind === 'check') return { action: 'check' }
  if (kind === 'rollback') {
    if (!version) throw badRequest('invalid-action', '回退需要指定版本号，写成 0.4.0 这样的形式。')
    // 空串也算「给了版本号」：宁可报错，也不要静默改成本次最新的版本。
    if (!isVersion(version)) {
      throw badRequest('invalid-version', `版本号看起来不对：${version}；只能是 1.2.3 这样的形式。`)
    }
    return { action: 'rollback', version }
  }
  if (version !== undefined && !isVersion(version)) {
    throw badRequest('invalid-version', `版本号看起来不对：${version}；只能是 1.2.3 这样的形式。`)
  }
  return version === undefined ? { action: kind } : { action: kind, version }
}

/** 组装卡片要显示的状态，并给出「下一步该做什么」的中文提示（按固定顺序追加）。 */
export function buildStatus(input: StatusInput): StatusSnapshot {
  const { home, nodeVersion, config, installed, exists } = input
  const configured = config.runtimeVersion.trim()
  const nodeOk = satisfiesNode(nodeVersion)
  const cliReady = configured !== '' && exists(cliPathFor(home, configured))
  const messages: string[] = []

  if (!nodeOk) {
    messages.push(
      `当前 Node 是 ${nodeVersion}，BetterOffice 需要 ≥${MIN_NODE_VERSION}。请升级 Node.js，或在设置里填写 node 路径。`,
    )
  }
  if (configured === '') {
    messages.push('还没有安装运行时，请发送 /betteroffice 安装，或用本卡片下方的「安装」按钮。')
  } else if (!cliReady) {
    messages.push(`运行时 ${configured} 目录缺 betteroffice-mcp 入口，请重装该版本。`)
  }

  return {
    node: { version: nodeVersion, ok: nodeOk, required: MIN_NODE_VERSION },
    runtime: { configured, installed: [...installed], cliReady },
    settings: {
      workspaceMode: config.workspaceMode,
      cleanupMode: config.cleanupMode,
      registry: input.registry ?? '',
    },
    latest: input.latest ?? null,
    inFlight: [...(input.inFlight ?? [])],
    messages,
  }
}
