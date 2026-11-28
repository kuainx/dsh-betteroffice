/** 任务注册表测试用的假件：假 MCP 连接 + 假 connector 的 harness。 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ConfigData } from '../src/config.js'
import { DomainError } from '../src/errors.js'
import type { McpConnection, McpSpawnSpec } from '../src/mcp.js'
import { createTaskRegistry } from '../src/tasks.js'

export type ToolCall = { name: string; args: Record<string, unknown> }

const DEFAULT_CONFIG: ConfigData = {
  workspaceMode: 'never',
  cleanupMode: 'auto',
  nodePath: '',
  runtimeVersion: '',
}

export function harness(
  options: {
    failConnect?: boolean
    failOpen?: boolean
    failCall?: string
    toolList?: unknown
    document?: string
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
    awaitRecovery?: () => Promise<unknown>
  } = {},
) {
  const mounted: string[] = []
  const disposed: string[] = []
  const copies: string[] = []
  const calls: ToolCall[] = []

  const connector = {
    has: () => true,
    connect: async (spec: McpSpawnSpec): Promise<McpConnection> => {
      if (options.failConnect === true) throw new Error('spawn 失败')
      mounted.push(spec.serverName)
      return {
        serverName: spec.serverName,
        list: async () => options.toolList ?? { tools: [] },
        call: async (name, args) => {
          calls.push({ name, args })
          if (options.failCall !== undefined && name !== 'office_open' && name !== 'office_export') {
            throw new DomainError('mcp-tool-failed', options.failCall)
          }
          if (options.failOpen === true) throw new Error('office_open 失败')
          if (name === 'office_export') {
            const target = join(spec.cwd, String(args['path']))
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, 'exported-bytes')
            return { content: [{ type: 'text', text: '{}' }] }
          }
          return {
            content: [
              { type: 'text', text: JSON.stringify({ document: options.document ?? 'doc1' }) },
            ],
          }
        },
        close: async () => {
          disposed.push(spec.serverName)
        },
      }
    },
  }

  const reg = createTaskRegistry({
    connector,
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
    copyFile: async (from: string, to: string) => {
      copies.push(`${from}->${to}`)
      await options.copyFile?.(from, to)
    },
    home: options.home ?? 'C:/h',
    recycle: options.recycle ?? (async () => {}),
    ...(options.replaceFile === undefined ? {} : { replaceFile: options.replaceFile as never }),
    ...(options.cleanupWorkspace === undefined ? {} : { cleanupWorkspace: options.cleanupWorkspace as never }),
    ...(options.awaitRecovery === undefined ? {} : { awaitRecovery: options.awaitRecovery }),
  })
  return { reg, mounted, disposed, copies, calls }
}