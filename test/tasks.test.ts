import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskRegistry } from '../src/tasks.js'

function harness(options: { failMount?: boolean } = {}) {
  const mounted: string[] = []
  const disposed: string[] = []
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
    config: () => ({ workspaceMode: 'never', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' }),
    makeTempDir: async () => 'C:/tmp/bo-x',
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
  })
  return { reg, mounted, disposed }
}

test('只读打开挂载 bo_<id8> 且返回任务', async () => {
  const { reg, mounted } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  assert.equal(task.serverName, 'bo_a71c2e90')
  assert.equal(task.readOnly, true)
  assert.equal(task.root, 'C:/d')
  assert.deepEqual(mounted, ['bo_a71c2e90'])
})

test('关闭时释放挂载并标记任务不可再用', async () => {
  const { reg, disposed } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  await reg.close({}, 's1', task.taskId)
  assert.deepEqual(disposed, ['bo_a71c2e90'])
  assert.throws(() => reg.get('s1', task.taskId), (error: never) => (error as { code?: string }).code === 'task-not-found')
})

test('别的会话用同一 taskId 被拒', async () => {
  const { reg } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  assert.throws(() => reg.get('s2', task.taskId), (error: never) => (error as { code?: string }).code === 'task-foreign')
})

test('MCP 挂载失败时不留下任务记录', async () => {
  const { reg, disposed } = harness({ failMount: true })
  await assert.rejects(() => reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' }), /spawn 失败/)
  assert.deepEqual(reg.list('s1'), [])
  assert.deepEqual(disposed, [])
})
