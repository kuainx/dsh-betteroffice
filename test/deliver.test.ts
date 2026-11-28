import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickDeliveryTarget } from '../src/deliver.js'
import { readLedger } from '../src/workspace.js'
import { harness } from './tasks-harness.js'

const noFiles = (): boolean => false

test('目标目录里的同名文件不存在时直接用原名', () => {
  const target = pickDeliveryTarget('C:/out', '年度报告.docx', noFiles)
  assert.equal(target.path, join('C:/out', '年度报告.docx'))
  assert.equal(target.name, '年度报告.docx')
})

test('同名文件已存在时依次加序号，绝不覆盖', () => {
  const taken = new Set([join('C:/out', 'a.docx'), join('C:/out', 'a (2).docx')])
  const target = pickDeliveryTarget('C:/out', 'a.docx', (path) => taken.has(path))
  assert.equal(target.name, 'a (3).docx')
})

test('失败时给出可行动的错误', async () => {
  assert.throws(() => pickDeliveryTarget('C:/out', 'a.docx', () => true), /同名文件太多/)
})

test('交付把草稿另存到目标目录并清掉中转文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bo-doc-'))
  await writeFile(join(dir, 'a.docx'), 'source-bytes')
  const outDir = join(dir, 'out')
  const { reg } = harness({
    makeTempDir: async () => mkdtemp(join(tmpdir(), 'bo-dlv-')),
  })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: dir, mode: 'edit' })

  const delivered = await reg.deliver('s1', task.taskId, { dir: outDir })
  assert.equal(delivered.path, join(outDir, 'a.docx'))
  assert.equal(await readFile(delivered.path, 'utf8'), 'exported-bytes')
  assert.equal(delivered.sha256.length, 64)
  assert.equal(existsSync(join(task.root, '.deliver')), false)
})

test('交付目录越出源文件目录时拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bo-doc-out-'))
  await writeFile(join(dir, 'a.docx'), 'source-bytes')
  const { reg } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: dir, mode: 'edit' })
  await assert.rejects(() => reg.deliver('s1', task.taskId, { dir: '..\\elsewhere' }), /只能在源文件所在目录/)
})

test('只读任务不提供交付', async () => {
  const { reg } = harness()
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  await assert.rejects(() => reg.deliver('s1', task.taskId, { dir: 'C:/out' }), /只读/)
})

test('交付成功后写进工作文件夹台账', async () => {
  const source = await mkdtemp(join(tmpdir(), 'bo-dl-'))
  await writeFile(join(source, 'a.docx'), 'source-bytes')
  const { reg } = harness({
    config: () => ({
      workspaceMode: 'always',
      cleanupMode: 'off',
      nodePath: '',
      runtimeVersion: '0.4.0',
    }),
  })
  const task = await reg.open({}, 's1', { path: 'a.docx', cwd: source, mode: 'edit' })
  const outDir = join(source, 'out')
  const delivered = await reg.deliver('s1', task.taskId, { dir: outDir })
  const ledger = await readLedger(task.workspaceDir as string)
  assert.deepEqual(
    ledger.deliveries?.map((item) => item.path),
    [delivered.path],
  )
})
