import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { checkpointName, createCheckpoint } from '../src/checkpoint.js'

const at = new Date(2026, 10, 27, 14, 41, 26)

function harness(options: { existing?: string[]; exportFails?: boolean; noFile?: boolean } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const existing = new Set(options.existing ?? [])
  const dirs: string[] = []
  const deps = {
    dir: 'C:/ws/checkpoints',
    root: 'C:/ws',
    serverName: 'bo_a71c2e90',
    documentId: 'doc1',
    sourceName: '年度报告.docx',
    now: () => at,
    exists: (path: string) => existing.has(path),
    mkdir: async (path: string) => {
      dirs.push(path)
    },
    stat: async () => {
      if (options.noFile === true) throw new Error('ENOENT')
      return { size: 1024 }
    },
    sha256: async () => 'sha256:cp',
    invoke: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      if (options.exportFails === true) throw new Error('export 被拒绝')
      return { content: [{ type: 'text', text: '{}' }] }
    },
  }
  return { deps, calls, dirs }
}

test('检查点名字带源文件主名、时间戳与版本号', () => {
  assert.equal(checkpointName('年度报告.docx', at, 1), '年度报告-261127-144126-v1.docx')
})

test('检查点导出到 checkpoints/ 下的相对路径并返回真实文件信息', async () => {
  const { deps, calls, dirs } = harness()
  const cp = await createCheckpoint(deps)
  assert.deepEqual(dirs, ['C:/ws/checkpoints'])
  assert.deepEqual(calls, [
    {
      name: 'mcp__bo_a71c2e90__office_export',
      args: { document: 'doc1', path: 'checkpoints/年度报告-261127-144126-v1.docx' },
    },
  ])
  assert.equal(cp.name, '年度报告-261127-144126-v1.docx')
  assert.equal(cp.size, 1024)
  assert.equal(cp.sha256, 'sha256:cp')
})

test('同名检查点已存在时不覆盖，改用下一个版本号', async () => {
  const { deps, calls } = harness({
    existing: [join('C:/ws/checkpoints', '年度报告-261127-144126-v1.docx')],
  })
  const cp = await createCheckpoint(deps)
  assert.equal(cp.name, '年度报告-261127-144126-v2.docx')
  assert.equal(calls[0]?.args['path'], 'checkpoints/年度报告-261127-144126-v2.docx')
})

test('导出被拒绝或没有真实文件时抛 checkpoint-failed', async () => {
  for (const options of [{ exportFails: true }, { noFile: true }]) {
    const { deps } = harness(options)
    await assert.rejects(
      () => createCheckpoint(deps),
      (error: never) => (error as { code?: string }).code === 'checkpoint-failed',
    )
  }
})

test('导出用的路径始终在工作文件夹根之下', async () => {
  const { deps, calls } = harness()
  await createCheckpoint(deps)
  assert.equal(calls[0]?.args['path'], join('checkpoints', '年度报告-261127-144126-v1.docx').replaceAll('\\', '/'))
})
