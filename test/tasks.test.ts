import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sha256File } from '../src/paths.js'
import { readLedger } from '../src/workspace.js'
import { exportingTools, fakeTools, harness } from './tasks-harness.js'

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

test('open 时插件自己调 office_open 并记下文档 id', async () => {
  const tools = fakeTools({ document: 'doc7' })
  const { reg } = harness({ tools: tools.view })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  assert.equal(task.documentId, 'doc7')
  assert.deepEqual(tools.calls, [
    { name: 'mcp__bo_a71c2e90__office_open', args: { path: 'a.docx' } },
  ])
  assert.equal(task.openedPath, 'C:/d/a.docx')
})

test('编辑副本：打开的是临时目录里的副本而不是源文件', async () => {
  const tools = fakeTools()
  const { reg, copies } = harness({ tools: tools.view })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d', mode: 'edit' })
  const copy = join('C:/tmp/bo-x', 'a.docx')
  assert.equal(task.rootKind, 'temp')
  assert.equal(task.openedPath, copy)
  assert.deepEqual(copies, [`C:/d/a.docx->${copy}`])
  assert.deepEqual(tools.calls, [{ name: 'mcp__bo_a71c2e90__office_open', args: { path: 'a.docx' } }])
})

test('office_open 失败时卸载挂载、删掉临时目录、不留记录', async () => {
  const tools = fakeTools({ fail: true })
  let tempDir = ''
  const { reg, disposed } = harness({
    tools: tools.view,
    makeTempDir: async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bo-task-'))
      return tempDir
    },
  })
  await assert.rejects(() => reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d', mode: 'edit' }), /office_open 失败/)
  assert.deepEqual(disposed, ['bo_a71c2e90'])
  assert.deepEqual(reg.list('s1'), [])
  assert.equal(existsSync(tempDir), false)
})

test('检查点落在工作文件夹 checkpoints/ 下并写进台账', async () => {
  const source = await mkdtemp(join(tmpdir(), 'bo-cp-'))
  const docPath = join(source, 'a.docx')
  await writeFile(docPath, 'source-bytes')
  const holder = { root: '' }
  const tools = exportingTools(holder)
  const { reg } = harness({ tools: tools.view, config: () => ({ workspaceMode: 'always', cleanupMode: 'off', nodePath: '', runtimeVersion: '0.4.0' }) })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: source, mode: 'edit' })
  holder.root = task.root
  const saved = await reg.checkpoint('s1', task.taskId)

  assert.ok(task.workspaceDir !== null)
  assert.equal(dirname(saved.path), join(task.workspaceDir, 'checkpoints'))
  assert.ok(existsSync(saved.path))
  assert.equal(saved.size, 'exported-bytes'.length)
  assert.equal(saved.sha256, await sha256File(saved.path))

  const ledger = await readLedger(task.workspaceDir)
  assert.deepEqual(ledger.checkpoints?.map((cp) => cp.name), [saved.name])
})

test('临时目录编辑的检查点落在临时目录 checkpoints/ 下且不记账', async () => {
  const holder = { root: '' }
  const tools = exportingTools(holder)
  let tempDir = ''
  const { reg } = harness({
    tools: tools.view,
    makeTempDir: async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bo-cpt-'))
      return tempDir
    },
  })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d', mode: 'edit' })
  holder.root = tempDir
  const saved = await reg.checkpoint('s1', task.taskId)
  assert.equal(dirname(saved.path), join(tempDir, 'checkpoints'))
  assert.ok(existsSync(saved.path))
})
