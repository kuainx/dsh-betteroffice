import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

type FakeContext = {
  on(event: string, handler: (...args: unknown[]) => void): () => void
  effect(fn: () => (() => void) | void): () => void
  get(name: string): unknown
  inject(deps: string[], fn: (ctx: unknown) => void): void
}

function fakeContext(): { ctx: FakeContext; listeners: Map<string, ((...args: unknown[]) => void)[]>; cleanups: (() => void)[] } {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const cleanups: (() => void)[] = []
  const ctx: FakeContext = {
    on(event, handler) {
      const bucket = listeners.get(event) ?? []
      bucket.push(handler)
      listeners.set(event, bucket)
      return () => {}
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    get: () => undefined,
    inject(_deps, fn) {
      fn(ctx)
    },
  }
  return { ctx, listeners, cleanups }
}

test('apply 订阅 agent 生命周期并注册总清理', () => {
  const { ctx, listeners, cleanups } = fakeContext()
  apply(ctx as never, undefined)
  assert.ok((listeners.get('agent/created') ?? []).length > 0)
  assert.ok((listeners.get('agent/disposed') ?? []).length > 0)
  assert.ok(cleanups.length > 0)
})

test('apply 在宿主没有任何服务时也不抛错', () => {
  const { ctx } = fakeContext()
  assert.doesNotThrow(() => apply(ctx as never, undefined))
})

test('替换工具在 pre-execute 阶段要求宿主审批，其他工具放行', async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx as never, undefined)
  const hook = (listeners.get('tools/pre-execute') ?? [])[0]
  assert.ok(hook !== undefined)
  let passed = false
  const other = await hook({ name: 'betteroffice_deliver' }, () => {
    passed = true
    return 'next'
  })
  assert.equal(other, 'next')
  assert.equal(passed, true)
  const decision = (await hook({ name: 'betteroffice_replace' }, () => 'next')) as unknown as {
    kind: string
    reason: string
  }
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /回收站/)
})

test('pre-execute 挡住 agent 直接调 MCP 的导出与列目录工具', async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx as never, undefined)
  const hook = (listeners.get('tools/pre-execute') ?? [])[0]
  assert.ok(hook !== undefined)
  for (const name of ['mcp__bo_a71c2e90__office_export', 'mcp__bo_a71c2e90__office_files']) {
    const decision = (await hook({ name }, () => 'next')) as unknown as { kind: string }
    assert.equal(decision.kind, 'deny', name)
  }
  const allowed = await hook({ name: 'mcp__bo_a71c2e90__office_read' }, () => 'next')
  assert.equal(allowed, 'next')
})

test('agent/created 缺 tools 服务时只记日志不抛错', async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx as never, undefined)
  const handlers = listeners.get('agent/created') ?? []
  for (const handler of handlers) {
    assert.doesNotThrow(() => handler({ agent: { id: 'a1', ctx: { get: () => undefined } } }))
  }
  await new Promise((resolve) => setTimeout(resolve, 10))
})
