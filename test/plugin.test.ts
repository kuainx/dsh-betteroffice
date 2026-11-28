import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import type { ToolDefinition } from '../src/tools.js'

type FakeContext = {
  on(event: string, handler: (...args: unknown[]) => void): () => void
  effect(fn: () => (() => void) | void): () => void
  get(name: string): unknown
  inject(deps: string[], fn: (ctx: unknown) => void): void
}

function fakeContext(
  services: Record<string, unknown> = {},
  injected: string[][] = [],
): {
  ctx: FakeContext
  listeners: Map<string, ((...args: unknown[]) => void)[]>
  cleanups: (() => void)[]
} {
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
    get: (name) => services[name],
    inject(deps, fn) {
      injected.push(deps)
      fn(ctx)
    },
  }
  return { ctx, listeners, cleanups }
}

test('apply 把配置卡片的两条路由挂到宿主 webServer 上', () => {
  const routes: { method: string; path: string }[] = []
  const injected: string[][] = []
  const { ctx } = fakeContext(
    {
      webServer: {
        register: (route: { method: string; path: string }) => {
          routes.push(route)
          // 跟宿主一致：返回单个注销函数，不是数组。
          return () => {}
        },
      },
    },
    injected,
  )
  apply(ctx as never, undefined)
  assert.ok(injected.some((names) => names.includes('webServer')))
  assert.deepEqual(
    routes.map((route) => route.path),
    ['/api/betteroffice/status', '/api/betteroffice/action'],
  )
})

test('宿主只有 commands 没有 settings 时也注册 /betteroffice', () => {
  const injected: string[][] = []
  const names: string[] = []
  const { ctx } = fakeContext(
    {
      commands: {
        register: (definition: { name: string }) => {
          names.push(definition.name)
          return () => {}
        },
      },
    },
    injected,
  )
  apply(ctx as never, undefined)
  const commandDeps = injected.find((deps) => deps.includes('commands'))
  assert.deepEqual(commandDeps, ['commands'], '设置服务是可选的，不该成为注册命令的前提')
  assert.deepEqual(names, ['betteroffice'])
})

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

test('open 的相对路径按调用时的会话工作目录解析', async () => {
  const definitions: ToolDefinition[] = []
  const cwdA = await mkdtemp(join(tmpdir(), 'bo-cwd-a-'))
  const cwdB = await mkdtemp(join(tmpdir(), 'bo-cwd-b-'))
  const { ctx, listeners } = fakeContext({
    tools: {
      register: (definition: ToolDefinition) => {
        definitions.push(definition)
        return () => {}
      },
    },
  })
  apply(ctx as never, undefined)

  const agent = {
    id: 's1',
    session: { id: 's1', header: { cwd: cwdA } },
    ctx: { get: () => undefined },
  }
  for (const handler of listeners.get('agent/created') ?? []) handler({ agent })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const open = definitions.find((definition) => definition.name === 'betteroffice_open')
  assert.ok(open !== undefined)

  const missing = async (): Promise<string> => {
    try {
      await open.execute({ path: 'nope.docx' }, {})
    } catch (error) {
      return (error as Error).message
    }
    return ''
  }

  assert.ok((await missing()).includes(join(cwdA, 'nope.docx')), '第一次应该解析到注册时的目录')
  agent.session.header.cwd = cwdB
  assert.ok((await missing()).includes(join(cwdB, 'nope.docx')), '切了工作目录之后要按新的解析')
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
