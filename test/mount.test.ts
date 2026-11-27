import test from 'node:test'
import assert from 'node:assert/strict'
import { createMounter, type McpClientModule } from '../src/mount.js'

type Call = { mod?: unknown; cfg?: any; disposed?: boolean }

function fakeScope() {
  const calls: Call[] = []
  return {
    calls,
    plugin(mod: unknown, cfg: unknown) {
      calls.push({ mod, cfg })
      return {
        dispose: async () => {
          calls.push({ disposed: true })
        },
      }
    },
  }
}

const fakeClient: McpClientModule = { apply() {} }
const spec = { serverName: 'bo_a71c2e90', command: 'node', args: ['cli.js', '--root', 'C:/d'], cwd: 'C:/d' }

test('挂载传入正确的 dsh-mcp-client 配置', async () => {
  const scope = fakeScope()
  const mounter = createMounter({ loadClient: async () => fakeClient })
  await mounter.mount(scope, spec)
  const cfg = scope.calls[0]?.cfg
  assert.equal(cfg.serverName, 'bo_a71c2e90')
  assert.equal(cfg.transport, 'stdio')
  assert.equal(cfg.failOnStartupError, true)
  assert.equal(cfg.command, 'node')
  assert.deepEqual(cfg.args, ['cli.js', '--root', 'C:/d'])
  assert.equal(cfg.cwd, 'C:/d')
})

test('同一 scope 同名重复挂载只挂一次', async () => {
  const scope = fakeScope()
  const mounter = createMounter({ loadClient: async () => fakeClient })
  await mounter.mount(scope, { ...spec, serverName: 's1' })
  await mounter.mount(scope, { ...spec, serverName: 's1' })
  assert.equal(scope.calls.filter((c) => c.cfg).length, 1)
})

test('dispose 释放 fiber 且 has 变为 false', async () => {
  const scope = fakeScope()
  const mounter = createMounter({ loadClient: async () => fakeClient })
  const handle = await mounter.mount(scope, { ...spec, serverName: 's1' })
  assert.equal(mounter.has(scope, 's1'), true)
  await handle.dispose()
  assert.equal(mounter.has(scope, 's1'), false)
  assert.ok(scope.calls.some((c) => c.disposed))
})

test('客户端不可用时给出 mcp-unavailable', async () => {
  const mounter = createMounter({ loadClient: async () => undefined })
  await assert.rejects(
    () => mounter.mount(fakeScope(), { ...spec, serverName: 's1' }),
    (error: any) => error.code === 'mcp-unavailable',
  )
})

// 注：cordis 的 plugin() 同步抛错是可观测的（重复 serverName、配置非法）；
// failOnStartupError 的异步启动失败发生在 fiber 内部，宿主不提供就绪信号，
// 由调用方在工具首次调用时暴露。shortcut: 引入 fiber 就绪信号后在此转换为 mcp-start-failed。
test('plugin 同步抛错转为 mcp-start-failed', async () => {
  const scope = fakeScope()
  scope.plugin = () => {
    throw new Error('duplicate serverName')
  }
  const mounter = createMounter({ loadClient: async () => fakeClient })
  await assert.rejects(
    () => mounter.mount(scope, { ...spec, serverName: 's1' }),
    (error: any) => error.code === 'mcp-start-failed',
  )
  assert.equal(mounter.has(scope, 's1'), false)
})

test('dispose 抛错不打断调用方', async () => {
  const scope = fakeScope()
  scope.plugin = () => ({
    dispose: async () => {
      throw new Error('boom')
    },
  })
  const mounter = createMounter({ loadClient: async () => fakeClient, logger: () => {} })
  const handle = await mounter.mount(scope, { ...spec, serverName: 's1' })
  await handle.dispose()
  assert.equal(mounter.has(scope, 's1'), false)
})
