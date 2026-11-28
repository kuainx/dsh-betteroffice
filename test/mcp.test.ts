import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'

import { createConnector } from '../src/mcp.js'

type JsonObject = { [key: string]: unknown }

/** 从 stdin 里写出去的一条 JSON-RPC。 */
type Written = { method?: string; id?: number; params?: JsonObject }

/** 手搓的假子进程：记下我们写了什么，也能主动回包。 */
class FakeChild extends EventEmitter {
  readonly writes: Written[] = []
  killed = false
  readonly stdin = {
    write: (text: string) => {
      this.writes.push(JSON.parse(text) as Written)
      if (this.answerInitialize && this.writes.at(-1)?.method === 'initialize') {
        const id = this.writes.at(-1)?.id
        queueMicrotask(() => {
          this.reply({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05' } })
        })
      }
      return true
    },
    end: () => undefined,
  }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  constructor(private readonly answerInitialize: boolean) {
    super()
  }

  kill(): void {
    this.killed = true
  }

  reply(message: JsonObject): void {
    this.stdout.emit('data', { toString: () => `${JSON.stringify(message)}\n` })
  }
}

function connect(t: string, options: { answerInitialize?: boolean; startupTimeoutMs?: number } = {}) {
  const child = new FakeChild(options.answerInitialize ?? true)
  const connector = createConnector({
    spawn: () => child,
    startupTimeoutMs: options.startupTimeoutMs,
  })
  return { child, connector, ready: connector.connect({ serverName: 'bo_test', command: 'node', args: ['cli.js'], cwd: '.' }) }
}

function request(written: Written | undefined): Written {
  assert.ok(written !== undefined, '还没写出任何 JSON-RPC')
  return written
}

describe('MCP 连接器', () => {
  test('connect 先发 initialize，拿到结果再发 notifications/initialized', async () => {
    const { child, ready } = connect('init')
    await ready

    const first = request(child.writes[0])
    assert.equal(first.method, 'initialize')
    assert.equal(first.params?.['protocolVersion'], '2024-11-05')
    assert.deepEqual(first.params?.['clientInfo'], { name: 'dsh-betteroffice', version: '0.1.0' })

    const second = request(child.writes[1])
    assert.equal(second.method, 'notifications/initialized')
    assert.equal(second.id, undefined)
  })

  test('call 发 tools/call 并返回 result', async () => {
    const { child, ready } = connect('call')
    const connection = await ready

    const pending = connection.call('office_open', { path: 'draft/a.docx' })
    const written = request(child.writes.at(-1))
    assert.equal(written.method, 'tools/call')
    assert.deepEqual(written.params, {
      name: 'office_open',
      arguments: { path: 'draft/a.docx' },
    })

    child.reply({ jsonrpc: '2.0', id: written.id, result: { content: [{ type: 'text', text: '{"document":"doc1"}' }] } })
    assert.deepEqual(await pending, { content: [{ type: 'text', text: '{"document":"doc1"}' }] })
  })

  test('两个并发 call 按 id 关联，乱序返回也不串', async () => {
    const { child, ready } = connect('concurrent')
    const connection = await ready

    const firstCall = connection.call('office_open', { path: 'a.docx' })
    const secondCall = connection.call('office_files', { offset: 0 })
    const firstId = request(child.writes.at(-2)).id
    const secondId = request(child.writes.at(-1)).id

    child.reply({ jsonrpc: '2.0', id: secondId, result: { kind: 'files' } })
    child.reply({ jsonrpc: '2.0', id: firstId, result: { kind: 'open' } })

    assert.deepEqual(await firstCall, { kind: 'open' })
    assert.deepEqual(await secondCall, { kind: 'files' })
  })

  test('isError 的结果转成 mcp-tool-failed，并带上服务器原文', async () => {
    const { child, ready } = connect('isError')
    const connection = await ready

    const pending = connection.call('office_open', { path: 'missing.docx' })
    const written = request(child.writes.at(-1))
    child.reply({
      jsonrpc: '2.0',
      id: written.id,
      result: { isError: true, content: [{ type: 'text', text: '找不到文档' }] },
    })

    await assert.rejects(pending, (error: Error & { code?: string }) => {
      assert.equal(error.code, 'mcp-tool-failed')
      assert.match(error.message, /找不到文档/)
      return true
    })
  })

  test('子进程退出后 call 立刻失败，不等超时', async () => {
    const { child, ready } = connect('exit')
    const connection = await ready

    const pending = connection.call('office_open', { path: 'a.docx' })
    child.emit('exit', 1)

    await assert.rejects(pending, (error: Error & { code?: string }) => {
      assert.equal(error.code, 'mcp-disconnected')
      return true
    })
  })

  test('close 之后 call 拒绝', async () => {
    const { child, ready } = connect('close')
    const connection = await ready

    await connection.close()
    assert.equal(child.killed, true)

    await assert.rejects(connection.call('office_open', { path: 'a.docx' }), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'mcp-disconnected')
      return true
    })
  })

  test('initialize 迟迟不回则 mcp-start-failed', async () => {
    const { ready } = connect('timeout', { answerInitialize: false, startupTimeoutMs: 10 })

    await assert.rejects(ready, (error: Error & { code?: string }) => {
      assert.equal(error.code, 'mcp-start-failed')
      return true
    })
  })
})