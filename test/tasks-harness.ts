/** 任务注册表测试用的假件：假 MCP 工具视图 + 假 mounter 的 harness。 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ConfigData } from '../src/config.js'
import { createTaskRegistry } from '../src/tasks.js'

export type ToolCall = { name: string; args: Record<string, unknown> }

/** 假的工具视图：只有被点名的那一个 MCP 工具存在。 */
export function fakeTools(behavior: { document?: string; fail?: boolean } = {}) {
  const calls: ToolCall[] = []
  const map = (name: string): unknown =>
    name.startsWith('mcp__')
      ? {
          execute: async (args: Record<string, unknown>) => {
            calls.push({ name, args })
            if (behavior.fail === true) throw new Error('office_open 失败')
            return {
              content: [
                { type: 'text', text: JSON.stringify({ document: behavior.document ?? 'doc1' }) },
              ],
            }
          },
        }
      : undefined
  const view = { view: () => ({ get: map }) as unknown }
  return { calls, view }
}

/** 假 MCP：office_open 返回固定 id，office_export 真的把文件写到 root 下。 */
export function exportingTools(holder: { root: string }) {
  const calls: ToolCall[] = []
  const view = {
    view: () => ({
      get: (name: string) => ({
        execute: async (args: Record<string, unknown>) => {
          calls.push({ name, args })
          if (name.endsWith('__office_export')) {
            const target = join(holder.root, String(args['path']))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, 'exported-bytes')
            return { content: [{ type: 'text', text: '{}' }] }
          }
          return { content: [{ type: 'text', text: JSON.stringify({ document: 'doc1' }) }] }
        },
      }),
    }),
  }
  return { view, calls }
}

const DEFAULT_CONFIG: ConfigData = {
  workspaceMode: 'never',
  cleanupMode: 'auto',
  nodePath: '',
  runtimeVersion: '',
}

export function harness(
  options: {
    failMount?: boolean
    tools?: unknown
    copyFile?: (from: string, to: string) => Promise<void>
    makeTempDir?: () => Promise<string>
    config?: () => ConfigData
    home?: string
    recycle?: (path: string) => Promise<void>
    replaceFile?: (input: unknown, deps: unknown) => Promise<{
      path: string
      sha256: string
      bytes: number
      recycled: true
      backupPath: string
    }>
    cleanupWorkspace?: (opts: unknown) => Promise<{ remove: boolean; reason: string }>
  } = {},
) {
  const mounted: string[] = []
  const disposed: string[] = []
  const copies: string[] = []
  const mounter = {
    mount: async (_scope: unknown, spec: { serverName: string }) => {
      if (options.failMount === true) throw new Error('spawn 失败')
      mounted.push(spec.serverName)
      return {
        serverName: spec.serverName,
        dispose: async () => {
          disposed.push(spec.serverName)
        },
      }
    },
    has: () => true,
  }
  const reg = createTaskRegistry({
    mounter: mounter as never,
    resolveRuntime: () => ({ command: 'node', cliPath: 'C:/h/cli.js' }),
    config: options.config ?? (() => DEFAULT_CONFIG),
    makeTempDir: options.makeTempDir ?? (async () => 'C:/tmp/bo-x'),
    now: () => new Date(2026, 10, 27, 14, 41, 26),
    newTaskId: () => 'a71c2e90',
    resolveDocument: async (path: string, cwd: string) => ({
      absPath: `${cwd}/${path}`,
      realPath: `${cwd}/${path}`,
      dir: cwd,
      name: path,
      ext: '.docx' as const,
      size: 1,
      sha256: 'sha256:x',
    }),
    toolViewFor: options.tools === undefined ? undefined : () => options.tools as never,
    copyFile: async (from: string, to: string) => {
      copies.push(`${from}->${to}`)
      await options.copyFile?.(from, to)
    },
    home: options.home ?? 'C:/h',
    recycle: options.recycle ?? (async () => {}),
    ...(options.replaceFile === undefined ? {} : { replaceFile: options.replaceFile as never }),
    ...(options.cleanupWorkspace === undefined ? {} : { cleanupWorkspace: options.cleanupWorkspace as never }),
  })
  return { reg, mounted, disposed, copies }
}
