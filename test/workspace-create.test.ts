import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspace, readLedger } from '../src/workspace.js'

const ledger = (taskId: string, sourcePath: string) => ({
  taskId, sessionId: 's1', sourcePath, sourceHash: 'sha256:x', mode: 'edit' as const,
  rootKind: 'workspace' as const, workspaceDir: null, createdAt: '2026-11-27T14:41:26.000Z',
  status: 'open' as const, mcpVersion: '0.4.0',
})

const at = new Date(2026, 10, 27, 14, 41, 26)

test('创建 draft/ 与 checkpoints/ 并写入可回读的台账', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  const source = join(base, '报告.docx'); await writeFile(source, 'x')
  const dir = join(base, 'dsh-报告.docx-261127-144126-a71c2e90')
  const ws = await createWorkspace({ sourcePath: source, taskId: 'a71c2e90', at, ledger: ledger('a71c2e90', source) })
  assert.equal(ws.dir, dir)
  assert.equal((await readLedger(ws.dir)).taskId, 'a71c2e90')
})

test('同名目录已存在时失败而不接管', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  const source = join(base, '报告.docx'); await writeFile(source, 'x')
  await createWorkspace({ sourcePath: source, taskId: 'a71c2e90', at, ledger: ledger('a71c2e90', source) })
  await assert.rejects(
    () => createWorkspace({ sourcePath: source, taskId: 'a71c2e90', at, ledger: ledger('a71c2e90', source) }),
    (e: any) => e.code === 'workspace-exists',
  )
})
