/**
 * 按 scope 挂载 BetterOffice MCP。
 *
 * 关键约束：必须用宿主那一份 @deepseek-ai/dsh-mcp-client（由调用方注入 loadClient），
 * 自己再装一份会让 dsh-scope 的 kScope Symbol 分裂，per-agent 隔离静默失效。
 */

import { McpStartFailedError, McpUnavailableError } from './errors.js'

export type McpClientModule = { apply: unknown }

export type MountSpec = {
  serverName: string
  command: string
  args: string[]
  cwd: string
}

export type MountHandle = {
  serverName: string
  dispose(): Promise<void>
}

type FiberLike = { dispose?: () => unknown }
type ScopeLike = { plugin(mod: unknown, config: unknown): FiberLike }

export type MounterDeps = {
  loadClient: () => Promise<McpClientModule | undefined>
  logger?: (message: string, error?: unknown) => void
}

export type Mounter = {
  mount(scope: unknown, spec: MountSpec): Promise<MountHandle>
  has(scope: unknown, serverName: string): boolean
}

function isScope(value: unknown): value is ScopeLike {
  return typeof value === 'object' && value !== null && typeof (value as ScopeLike).plugin === 'function'
}

export function createMounter(deps: MounterDeps): Mounter {
  const log = deps.logger ?? (() => {})
  const registry = new WeakMap<object, Map<string, Promise<MountHandle>>>()

  function tableFor(scope: object): Map<string, Promise<MountHandle>> {
    let table = registry.get(scope)
    if (table === undefined) {
      table = new Map()
      registry.set(scope, table)
    }
    return table
  }

  return {
    has(scope, serverName) {
      if (!isScope(scope)) return false
      const pending = registry.get(scope)?.get(serverName)
      return pending !== undefined
    },

    async mount(scope, spec) {
      if (!isScope(scope)) {
        throw new McpStartFailedError(spec.serverName, new Error('scope 缺少 plugin()'))
      }
      const table = tableFor(scope)
      const existing = table.get(spec.serverName)
      if (existing !== undefined) return await existing

      const pending = (async (): Promise<MountHandle> => {
        const client = await deps.loadClient()
        if (client === undefined) throw new McpUnavailableError()

        let fiber: FiberLike
        try {
          fiber = scope.plugin(client, {
            serverName: spec.serverName,
            transport: 'stdio',
            command: spec.command,
            args: spec.args,
            cwd: spec.cwd,
            failOnStartupError: true,
          })
        } catch (error) {
          throw new McpStartFailedError(spec.serverName, error)
        }

        return {
          serverName: spec.serverName,
          async dispose() {
            table.delete(spec.serverName)
            try {
              await fiber.dispose?.()
            } catch (error) {
              // agent 销毁序列是串行的，这里抛错会连累其它任务；只记日志。
              log(`betteroffice: 释放 MCP ${spec.serverName} 失败`, error)
            }
          },
        }
      })()

      table.set(spec.serverName, pending)
      try {
        return await pending
      } catch (error) {
        table.delete(spec.serverName)
        throw error
      }
    },
  }
}
