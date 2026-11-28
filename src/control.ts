/** 配置卡片的状态快照：纯函数，文件存在性与 Node 版本都由调用方注入，便于测试。 */

import type { ConfigData } from './config.js'
import { MIN_NODE_VERSION, cliPathFor, satisfiesNode } from './runtime.js'

export interface StatusSnapshot {
  node: { version: string; ok: boolean; required: string }
  runtime: { configured: string; installed: readonly string[]; cliReady: boolean }
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
    latest: input.latest ?? null,
    inFlight: [...(input.inFlight ?? [])],
    messages,
  }
}
