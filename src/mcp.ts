import { spawn } from 'node:child_process'

import { DomainError, McpStartFailedError } from './errors.js'

/** 一次连接需要的全部信息：谁启动、怎么启动、在哪启动。 */
export type McpSpawnSpec = { serverName: string; command: string; args: string[]; cwd: string }

/** 一条活着的 MCP 连接。工具名是服务器自己的裸名（office_open），不带 mcp__ 前缀。 */
export type McpConnection = {
  serverName: string
  call(name: string, args: Record<string, unknown>): Promise<unknown>
  list(): Promise<unknown>
  close(): Promise<void>
}

type Chunk = { toString(encoding: 'utf8'): string }

/** 子进程里我们真正用到的那几个口子，测试可以手搓一个。 */
export type ChildLike = {
  stdin: { write(text: string): unknown; end?(): unknown }
  stdout: { on(event: 'data', handler: (chunk: Chunk) => void): unknown }
  stderr: { on(event: 'data', handler: (chunk: Chunk) => void): unknown }
  on(event: 'exit' | 'error', handler: (value: unknown) => void): unknown
  kill(): unknown
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildLike

export type McpConnectorDeps = {
  spawn?: SpawnLike
  startupTimeoutMs?: number
  callTimeoutMs?: number
  /** close 等子进程退出的兜底时限；到点还在就放弃等。 */
  closeTimeoutMs?: number
  logger?: (message: string, error?: unknown) => void
}

export type McpConnector = {
  connect(spec: McpSpawnSpec): Promise<McpConnection>
  has(serverName: string): boolean
}

const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'dsh-betteroffice', version: '0.1.0' }
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000
/** close 最多等子进程退出这么久：等的是「文件句柄放开了」，不是「它愿意退出」。 */
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type JsonObject = { [key: string]: unknown }

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null
}

/** 服务器回的错误正文，能读出来就直接用它，读不出来给出可行动的一句话。 */
function failureText(result: unknown): string {
  if (isObject(result)) {
    const content = result['content']
    if (Array.isArray(content)) {
      for (const item of content) {
        if (isObject(item) && typeof item['text'] === 'string' && item['text'] !== '') return item['text']
      }
    }
    const message = result['message']
    if (typeof message === 'string' && message !== '') return message
  }
  return 'BetterOffice 那边的工具报错了，但没说明原因。'
}

export function createConnector(deps: McpConnectorDeps = {}): McpConnector {
  const spawnFn: SpawnLike = deps.spawn ?? ((command, args, options) => spawn(command, args, options))
  const live = new Map<string, McpConnection>()

  async function connect(spec: McpSpawnSpec): Promise<McpConnection> {
    const child = spawnFn(spec.command, spec.args, { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    // close() 要等它真的走了再让调用方删临时目录，否则 Windows 上句柄还占着，rm 会失败。
    const exited = new Promise<void>((resolve) => {
      child.on('exit', () => resolve())
      child.on('error', () => resolve())
    })
    const pending = new Map<number, Pending>()
    let nextId = 1
    let closed = false
    let buffer = ''

    const disconnected = (): DomainError =>
      new DomainError('mcp-disconnected', `BetterOffice MCP 断开了（${spec.serverName}），请重新打开文档。`)

    function failAll(error: Error): void {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }

    function send(message: JsonObject): void {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    function request(method: string, params: JsonObject, timeoutMs: number, onTimeout: () => Error): Promise<unknown> {
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(onTimeout())
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        send({ jsonrpc: '2.0', id, method, params })
      })
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line === '') continue
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          deps.logger?.(`betteroffice: MCP 打了一行不是 JSON 的日志：${line.slice(0, 200)}`)
          continue
        }
        if (!isObject(message) || typeof message['id'] !== 'number') continue
        const entry = pending.get(message['id'])
        if (entry === undefined) continue
        pending.delete(message['id'])
        clearTimeout(entry.timer)
        if (isObject(message['error'])) {
          entry.reject(
            new DomainError('mcp-tool-failed', failureText(message['error'])),
          )
          continue
        }
        entry.resolve(message['result'])
      }
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') deps.logger?.(`betteroffice: MCP 说 ${text.slice(0, 400)}`)
    })

    child.on('exit', () => {
      if (closed) return
      closed = true
      failAll(disconnected())
    })
    child.on('error', (error) => {
      closed = true
      failAll(new McpStartFailedError(spec.serverName, error))
    })

    try {
      await request(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        () =>
          new McpStartFailedError(
            spec.serverName,
            new Error('30 秒内没有回应 initialize，BetterOffice MCP 可能没起来'),
          ),
      )
    } catch (error) {
      closed = true
      child.kill()
      throw error
    }

    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })

    const connection: McpConnection = {
      serverName: spec.serverName,
      async call(name, args) {
        if (closed) throw disconnected()
        const result = await request(
          'tools/call',
          { name, arguments: args },
          deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
          () =>
            new DomainError(
              'mcp-timeout',
              `调用 ${name} 超时（${deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS}ms），BetterOffice 可能卡住了。`,
            ),
        )
        if (isObject(result) && result['isError'] === true) {
          throw new DomainError('mcp-tool-failed', failureText(result))
        }
        return result
      },
      async list() {
        if (closed) throw disconnected()
        return await request(
          'tools/list',
          {},
          deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
          () => new DomainError('mcp-timeout', '取工具清单超时，BetterOffice 可能卡住了。'),
        )
      },
      async close() {
        if (!closed) {
          closed = true
          failAll(disconnected())
        }
        child.stdin.end?.()
        child.kill()
        live.delete(spec.serverName)
        const timeoutMs = deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs)
          timer.unref?.()
          void exited.then(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      },
    }

    live.set(spec.serverName, connection)
    return connection
  }

  return { connect, has: (serverName) => live.has(serverName) }
}