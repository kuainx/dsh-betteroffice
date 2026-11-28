/** 运行时探测：纯函数，不 spawn；Node 版本与文件存在性由调用方注入，便于测试。 */

import { join } from 'node:path'
import { DomainError } from './errors.js'
import type { ConfigData } from './config.js'

export const MIN_NODE_VERSION = '22.12.0'

export class RuntimeUnavailableError extends DomainError {
  constructor(message: string) {
    super('runtime-unavailable', message)
    this.name = 'RuntimeUnavailableError'
  }
}

/** 只比较 major.minor.patch 的数字段，忽略 `v` 前缀与预发布后缀。 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function parse(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]!
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

export function satisfiesNode(version: string): boolean {
  return compareVersions(version, MIN_NODE_VERSION) >= 0
}

export function cliPathFor(home: string, version: string): string {
  return join(home, 'betteroffice', 'runtime', version, 'node_modules', '@betteroffice', 'agents', 'dist', 'cli.js')
}

/** 装/切运行时前统一的 Node 门禁：够了返回 undefined，否则返回给用户看的原因。 */
export function nodeGate(nodeVersion: string): string | undefined {
  if (satisfiesNode(nodeVersion)) return undefined
  return `当前 Node 是 ${nodeVersion}，BetterOffice 需要 ≥${MIN_NODE_VERSION}。请升级 Node.js，或在设置里填写 node 路径。`
}

/** 回退前确认目标版本真的装过：不合法时返回原因。 */
export function rollbackGate(installed: readonly string[], version: string): string | undefined {
  if (installed.includes(version)) return undefined
  const have = installed.length === 0 ? '还没装任何版本' : installed.join(' / ')
  return `回退只能选已安装的版本：${version} 没装过；已安装 ${have}。`
}

/** 切换前后是什么变化，给文案用。 */
export function changeKind(before: string, after: string): 'same' | 'upgrade' | 'downgrade' | 'fresh' {
  if (before === '') return 'fresh'
  const diff = compareVersions(after, before)
  if (diff === 0) return 'same'
  return diff > 0 ? 'upgrade' : 'downgrade'
}

function nodeExeName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

export function findNodeOnPath(
  env: { PATH?: string },
  exists: (path: string) => boolean,
  sep: string,
): string[] {
  const dirs = (env.PATH ?? '').split(sep).filter((dir) => dir.trim() !== '')
  const found: string[] = []
  for (const dir of dirs) {
    const candidate = join(dir.trim(), nodeExeName())
    if (exists(candidate)) found.push(candidate)
  }
  return found
}

export type RuntimeResolution = { command: string; cliPath: string }

export type ResolveRuntimeInput = {
  config: ConfigData
  home: string
  nodeVersion: string
  exists: (path: string) => boolean
  env: { PATH?: string }
  sep: string
}

export function resolveMcpRuntime(input: ResolveRuntimeInput): RuntimeResolution {
  const { config, home, nodeVersion, exists, env, sep } = input

  const configured = config.nodePath.trim()
  let command: string
  if (configured !== '') {
    command = configured
  } else {
    const [first] = findNodeOnPath(env, exists, sep)
    if (first === undefined) {
      throw new RuntimeUnavailableError(
        '未找到 Node：BetterOffice MCP 需要 Node.js ≥ ' +
          `${MIN_NODE_VERSION}。请安装 Node.js，或在设置 → 插件配置 → BetterOffice 里填写 node 可执行文件路径。`,
      )
    }
    command = first
  }

  if (!satisfiesNode(nodeVersion)) {
    throw new RuntimeUnavailableError(
      `Node 版本过低：当前 ${nodeVersion}，BetterOffice MCP 需要 ≥ ${MIN_NODE_VERSION}。请升级 Node.js 或指定新的 node 路径。`,
    )
  }

  const version = config.runtimeVersion.trim()
  if (version === '') {
    throw new RuntimeUnavailableError(
      '未安装 BetterOffice MCP 运行时。请在对话里发送 /betteroffice 安装。',
    )
  }

  const cliPath = cliPathFor(home, version)
  if (!exists(cliPath)) {
    throw new RuntimeUnavailableError(
      `BetterOffice MCP 运行时 ${version} 的文件缺失（${cliPath}）。请发送 /betteroffice 安装 ${version} 重新安装。`,
    )
  }

  return { command, cliPath }
}
