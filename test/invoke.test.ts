import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolInvoker, describeView, waitForTool } from '../src/invoke.js'

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

test('describeView 把各种工具表形状说成人话', () => {
  assert.equal(describeView(null), 'null')
  assert.equal(describeView(() => undefined), 'typeof function')
  assert.equal(describeView([{ name: 'a' }]), 'array(1){a}')
  assert.match(describeView(new Map()), /^Map\(0\)\{(.*)\}$/)
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

test('宿主把工具表给成数组时也能按名字找到工具', async () => {
  const invoker = createToolInvoker({
    view: () => [{ name: 'mcp__bo_1__office_open', execute: async () => ({ ok: 1 }) }],
  }, undefined)
  assert.deepEqual(await invoker.invoke('mcp__bo_1__office_open', {}), { ok: 1 })
})

test('宿主把工具表给成按名字索引的对象时也能找到工具', async () => {
  const invoker = createToolInvoker({
    view: () => ({ mcp__bo_1__office_open: { execute: async () => ({ ok: 2 }) } }),
  }, undefined)
  assert.deepEqual(await invoker.invoke('mcp__bo_1__office_open', {}), { ok: 2 })
})

test('等工具注册：数组形态也认得', async () => {
  await waitForTool(
    { view: () => [{ name: 'mcp__bo_1__office_open', execute: async () => ({}) }] },
    undefined,
    'mcp__bo_1__office_open',
    { timeoutMs: 1000, intervalMs: 1 },
  )
})

test('等工具注册：超时给出 tool-timeout', async () => {
  await assert.rejects(
    () => waitForTool(viewOf({}), undefined, 'mcp__bo_1__office_open', { timeoutMs: 20, intervalMs: 1 }),
    (error: { code?: string }) => error.code === 'tool-timeout',
  )
})

test('宿主把工具表给成 {visible,registrations} 时也能按名字找到工具', async () => {
  const invoker = createToolInvoker({
    view: () => ({
      visible: [{ name: 'mcp__bo_1__office_open', execute: async () => ({ ok: 3 }) }],
      registrations: new Map<string, FakeTool>(),
      knownNames: ['mcp__bo_1__office_open'],
      restrictableNames: [],
    }),
  }, undefined)
  assert.deepEqual(await invoker.invoke('mcp__bo_1__office_open', {}), { ok: 3 })
})

test('工具定义藏在 registrations 表里时也能找到', async () => {
  const invoker = createToolInvoker({
    view: () => ({
      visible: [],
      registrations: new Map([['mcp__bo_1__office_open', { execute: async () => ({ ok: 4 }) }]]),
      knownNames: [],
      restrictableNames: [],
    }),
  }, undefined)
  assert.deepEqual(await invoker.invoke('mcp__bo_1__office_open', {}), { ok: 4 })
})

test('describeView 把嵌套的工具表讲到能看出有没有工具', () => {
  const shape = describeView({ visible: [{ name: 'mcp__bo_1__office_open' }], registrations: new Map() })
  assert.match(shape, /visible=array\(1\)\{mcp__bo_1__office_open\}/)
  assert.match(shape, /registrations=Map\(0\)/)
})
