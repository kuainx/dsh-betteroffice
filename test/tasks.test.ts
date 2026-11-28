import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sha256File } from '../src/paths.js'
import { readLedger } from '../src/workspace.js'
import { harness } from './tasks-harness.js'

test('打开文档前先等启动恢复完成，避免读到半途的事务', async () => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  const { reg } = harness({ awaitRecovery: () => gate })
  let opened = false
  const pending = reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' }).then(() => {
    opened = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(opened, false, '恢复还没完成就不该打开文档')
  release()
  await pending
  assert.equal(opened, true)
})

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

test('透传调用直接落到该任务的连接上', async () => {
  const { reg, calls } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  const result = await reg.call('s1', task.taskId, 'xlsx_outline', { document: 'doc1' })
  assert.deepEqual(calls.at(-1), { name: 'xlsx_outline', args: { document: 'doc1' } })
  assert.equal(Array.isArray((result as { content: unknown[] }).content), true)
})

test('透传也不许绕过守卫去导出或列目录', async () => {
  const { reg } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  await assert.rejects(
    () => reg.call('s1', task.taskId, 'office_export', {}),
    (error: { code?: string }) => error.code === 'tool-denied' && /betteroffice_deliver/.test(String(error)),
  )
})

test('别的会话用同一 taskId 被拒', async () => {
  const { reg } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  assert.throws(() => reg.get('s2', task.taskId), (error: never) => (error as { code?: string }).code === 'task-foreign')
})

test('MCP 启动失败时不留下任务记录', async () => {
  const { reg, disposed } = harness({ failConnect: true })
  await assert.rejects(() => reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' }), /spawn 失败/)
  assert.deepEqual(reg.list('s1'), [])
  assert.deepEqual(disposed, [])
})

test('open 时插件自己调 office_open 并记下文档 id', async () => {
  const { reg, calls } = harness({ document: 'doc7' })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  assert.equal(task.documentId, 'doc7')
  assert.deepEqual(calls, [{ name: 'office_open', args: { path: 'a.docx' } }])
  assert.equal(task.openedPath, 'C:/d/a.docx')
})

test('编辑副本：打开的是临时目录里的副本而不是源文件', async () => {
  const { reg, copies, calls } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d', mode: 'edit' })
  const copy = join('C:/tmp/bo-x', 'a.docx')
  assert.equal(task.rootKind, 'temp')
  assert.equal(task.openedPath, copy)
  assert.deepEqual(copies, [`C:/d/a.docx->${copy}`])
  assert.deepEqual(calls, [{ name: 'office_open', args: { path: 'a.docx' } }])
})

test('office_open 失败时关掉连接、删掉临时目录、不留记录', async () => {
  let tempDir = ''
  const { reg, disposed } = harness({
    failOpen: true,
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
  const { reg } = harness({ config: () => ({ workspaceMode: 'always', cleanupMode: 'off', nodePath: '', runtimeVersion: '0.4.0' }) })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: source, mode: 'edit' })
  const saved = await reg.checkpoint('s1', task.taskId)

  assert.ok(task.workspaceDir !== null)
  assert.equal(dirname(saved.path), join(task.workspaceDir, 'checkpoints'))
  assert.ok(existsSync(saved.path))
  assert.equal(saved.size, 'exported-bytes'.length)
  assert.equal(saved.sha256, await sha256File(saved.path))

  const ledger = await readLedger(task.workspaceDir)
  assert.deepEqual(ledger.checkpoints?.map((cp) => cp.name), [saved.name])
})

test('替换原文件前必须有 confirm，否则不导出也不动原件', async () => {
  const { reg, disposed, calls } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d', mode: 'edit' })
  await assert.rejects(
    () => reg.replace('s1', task.taskId, {}),
    (error: never) => (error as { code?: string }).code === 'confirm-required',
  )
  assert.deepEqual(calls, [{ name: 'office_open', args: { path: 'a.docx' } }])
  assert.deepEqual(disposed, [])
})

test('confirm 为 true 时先导出草稿到中转目录再交给替换事务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bo-rep-'))
  const replaced: { input: unknown; home: string; hasRecycle: boolean }[] = []
  const { reg, calls } = harness({
    makeTempDir: async () => root,
    home: root,
    replaceFile: async (input, deps) => {
      const bag = deps as { home: string; recycle: unknown }
      replaced.push({ input, home: bag.home, hasRecycle: typeof bag.recycle === 'function' })
      return { path: 'C:/d/a.docx', sha256: 'sha256:new', bytes: 14, recycled: true as const, backupPath: 'C:/h/b.docx' }
    },
  })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d', mode: 'edit' })
  const outcome = await reg.replace('s1', task.taskId, { confirm: true })

  const staging = join(root, '.deliver', 'a.docx')
  assert.deepEqual(calls.at(-1), {
    name: 'office_export',
    args: { document: 'doc1', path: '.deliver/a.docx' },
  })
  assert.deepEqual(replaced.map((item) => item.input), [
    {
      taskId: task.taskId,
      sourcePath: 'C:/d/a.docx',
      candidatePath: staging,
      expectedSourceSha256: 'sha256:x',
    },
  ])
  assert.equal(replaced[0]?.home, root)
  assert.equal(replaced[0]?.hasRecycle, true)
  assert.deepEqual(outcome, { taskId: task.taskId, path: 'C:/d/a.docx', sha256: 'sha256:new', bytes: 14 })
  assert.equal(existsSync(join(root, '.deliver')), false)
})

test('只读任务不允许替换原文件', async () => {
  const { reg } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  await assert.rejects(
    () => reg.replace('s1', task.taskId, { confirm: true }),
    (error: never) => (error as { code?: string }).code === 'replace-failed',
  )
})

test('临时目录编辑的检查点落在临时目录 checkpoints/ 下且不记账', async () => {
  let tempDir = ''
  const { reg } = harness({
    makeTempDir: async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'bo-cpt-'))
      return tempDir
    },
  })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d', mode: 'edit' })
  const saved = await reg.checkpoint('s1', task.taskId)
  assert.equal(dirname(saved.path), join(tempDir, 'checkpoints'))
  assert.ok(existsSync(saved.path))
})

test('关闭任务时把清理设置与 discard 交给清理逻辑，且只在有工作文件夹时调用', async () => {
  const calls: unknown[] = []
  const { reg } = harness({
    config: () => ({ workspaceMode: 'always', cleanupMode: 'on', nodePath: '', runtimeVersion: '' }),
    cleanupWorkspace: async opts => {
      calls.push(opts)
      return { remove: true, reason: '测试' }
    },
  })
  const cwd = await mkdtemp(join(tmpdir(), 'bo-clean-'))
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd, mode: 'edit' })
  await reg.close({}, 's1', task.taskId, { discard: true })
  assert.equal(calls.length, 1)
  const opts = calls[0] as { mode: string; dir: string; discard?: boolean }
  assert.equal(opts.mode, 'on')
  assert.equal(opts.dir, task.workspaceDir)
  assert.equal(opts.discard, true)
})

test('编辑但不建工作文件夹时关闭任务不触发清理', async () => {
  const calls: unknown[] = []
  const { reg } = harness({
    makeTempDir: async () => mkdtemp(join(tmpdir(), 'bo-noclean-')),
    cleanupWorkspace: async opts => {
      calls.push(opts)
      return { remove: true, reason: '测试' }
    },
  })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d', mode: 'edit' })
  await reg.close({}, 's1', task.taskId)
  assert.deepEqual(calls, [])
})