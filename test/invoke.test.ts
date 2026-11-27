import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolInvoker, waitForTool } from '../src/invoke.js'

type FakeTool = { execute(args: unknown, exec: unknown): Promise<unknown> }

function viewOf(tools: Record<string, FakeTool>) {
  return { view: () => new Map(Object.entries(tools)) }
}

test('调用已注册的 MCP 工具并透传结果', async () => {
  const calls: unknown[] = []
  const invoker = createToolInvoker(viewOf({
    'mcp__bo_1__office_export': {
      execute: async (args) => {
        calls.push(args)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    },
  }), undefined)
  const result = await invoker.invoke('mcp__bo_1__office_export', { path: 'checkpoints/cp-0001.docx' })
  assert.deepEqual(calls, [{ path: 'checkpoints/cp-0001.docx' }])
  assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] })
})

test('工具不存在时报 tool-not-found', async () => {
  const invoker = createToolInvoker(viewOf({}), undefined)
  await assert.rejects(
    () => invoker.invoke('mcp__bo_missing__office_export', {}),
    (error: { code?: string }) => error.code === 'tool-not-found',
  )
})

test('工具执行失败原样冒出', async () => {
  const invoker = createToolInvoker(viewOf({
    'mcp__bo_1__office_export': { execute: async () => { throw new Error('MCP 断开了') } },
  }), undefined)
  await assert.rejects(() => invoker.invoke('mcp__bo_1__office_export', {}), /MCP 断开了/)
})

test('等工具注册：晚一点出现也能等到', async () => {
  let polls = 0
  const tools = {
    view: () => {
      polls += 1
      const ready = polls >= 3
      return new Map<string, FakeTool>(ready ? [['mcp__bo_1__office_open', { execute: async () => ({}) }]] : [])
    },
  }
  await waitForTool(tools, undefined, 'mcp__bo_1__office_open', { timeoutMs: 1000, intervalMs: 1 })
  assert.ok(polls >= 3)
})

test('等工具注册：超时给出 tool-timeout', async () => {
  await assert.rejects(
    () => waitForTool(viewOf({}), undefined, 'mcp__bo_1__office_open', { timeoutMs: 20, intervalMs: 1 }),
    (error: { code?: string }) => error.code === 'tool-timeout',
  )
})
