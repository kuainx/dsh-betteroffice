import test from 'node:test'
import assert from 'node:assert/strict'
import { planRoot } from '../src/root.js'

const doc = {
  absPath: 'C:/d/a.docx',
  realPath: 'C:/d/a.docx',
  dir: 'C:/d',
  name: 'a.docx',
  ext: '.docx' as const,
  size: 1,
  sha256: 'x',
}
const cfg = { workspaceMode: 'auto' as const, cleanupMode: 'auto' as const, nodePath: '', runtimeVersion: '' }
const base = { doc, config: cfg, tempDir: 'C:/tmp/bo-1', workspaceDir: null }

test('只读用父目录并带 --read-only', () => {
  const p = planRoot({ ...base, mode: 'read' })
  assert.equal(p.root, 'C:/d')
  assert.equal(p.readOnly, true)
  assert.equal(p.rootKind, 'parent')
  assert.deepEqual(p.args, ['--root', 'C:/d', '--read-only'])
})

test('编辑且不使用工作文件夹用临时目录', () => {
  const p = planRoot({ ...base, mode: 'edit', config: { ...cfg, workspaceMode: 'never' } })
  assert.equal(p.rootKind, 'temp')
  assert.equal(p.root, 'C:/tmp/bo-1')
  assert.equal(p.readOnly, false)
  assert.deepEqual(p.args, ['--root', 'C:/tmp/bo-1'])
})

test('编辑且强制使用工作文件夹必须有工作文件夹', () => {
  assert.throws(() => planRoot({ ...base, mode: 'edit', config: { ...cfg, workspaceMode: 'always' } }), /工作文件夹/)
})

test('自动模式下 agent 要求工作文件夹即使用', () => {
  const p = planRoot({ ...base, mode: 'edit', workspaceDir: 'C:/d/dsh-a.docx-1-x', workspaceRequested: true })
  assert.equal(p.rootKind, 'workspace')
  assert.equal(p.root, 'C:/d/dsh-a.docx-1-x')
})

test('自动模式下未要求工作文件夹则用临时目录', () => {
  const p = planRoot({ ...base, mode: 'edit', workspaceDir: 'C:/d/dsh-a.docx-1-x' })
  assert.equal(p.rootKind, 'temp')
})
