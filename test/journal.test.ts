import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  acquireLock,
  clearJournal,
  listJournals,
  readJournal,
  writeJournal,
  type CommitRecord,
} from '../src/journal.js'

function record(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    version: 1,
    taskId: 'a71c2e90',
    phase: 'prepared',
    originalPath: 'C:/docs/年度报告.docx',
    originalSha256: 'a'.repeat(64),
    backupPath: 'C:/home/betteroffice/backups/a71c2e90.docx',
    backupSha256: 'a'.repeat(64),
    candidatePath: null,
    candidateSha256: null,
    startedAt: '2026-11-28T01:00:00.000Z',
    updatedAt: '2026-11-28T01:00:00.000Z',
    ...overrides,
  }
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'bo-journal-'))
}

test('写进日志后能原样读回', async () => {
  const dir = await tempDir()
  await writeJournal(dir, record())
  const back = await readJournal(dir, 'a71c2e90')
  assert.equal(back?.phase, 'prepared')
  assert.equal(back?.originalPath, 'C:/docs/年度报告.docx')
  assert.equal(back?.originalSha256, 'a'.repeat(64))
})

test('写入是原子的：目录里不留下临时文件', async () => {
  const dir = await tempDir()
  await writeJournal(dir, record())
  await writeJournal(dir, record({ phase: 'recycled' }))
  const names = await readdir(dir)
  assert.deepEqual(names, ['a71c2e90.json'])
})

test('日志损坏时读回 undefined 而不是抛错', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8')
  assert.equal(await readJournal(dir, 'broken'), undefined)
})

test('列出全部日志时跳过损坏与临时文件', async () => {
  const dir = await tempDir()
  await writeJournal(dir, record({ taskId: 'aaaa1111' }))
  await writeJournal(dir, record({ taskId: 'bbbb2222', phase: 'recycled' }))
  await writeFile(join(dir, 'cccc3333.json'), 'nope', 'utf8')
  await writeFile(join(dir, 'dddd4444.json.tmp'), '{}', 'utf8')
  const all = await listJournals(dir)
  assert.deepEqual(all.map(item => [item.taskId, item.phase]).sort(), [
    ['aaaa1111', 'prepared'],
    ['bbbb2222', 'recycled'],
  ])
})

test('目录不存在时列出空数组', async () => {
  assert.deepEqual(await listJournals(join(await tempDir(), 'missing')), [])
})

test('清除日志后读回 undefined', async () => {
  const dir = await tempDir()
  await writeJournal(dir, record())
  await clearJournal(dir, 'a71c2e90')
  assert.equal(await readJournal(dir, 'a71c2e90'), undefined)
})

test('同一目标的锁只能拿一次，释放后可再拿', async () => {
  const dir = await tempDir()
  const lock = await acquireLock(dir, 'C:/docs/年度报告.docx')
  await assert.rejects(acquireLock(dir, 'C:/docs/年度报告.docx'), /正在进行替换/)
  await lock.release()
  const again = await acquireLock(dir, 'C:/docs/年度报告.docx')
  await again.release()
})

test('锁文件记下的是当前进程号，且不同目标互不影响', async () => {
  const dir = await tempDir()
  const first = await acquireLock(dir, 'C:/a.docx')
  const second = await acquireLock(dir, 'C:/b.docx')
  const files = await readdir(dir)
  assert.equal(files.filter(name => name.endsWith('.lock')).length, 2)
  const body = JSON.parse(await readFile(join(dir, files.find(name => name.endsWith('.lock'))!), 'utf8'))
  assert.equal(body.pid, process.pid)
  await first.release()
  await second.release()
})
