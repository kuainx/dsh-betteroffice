import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readJournal, writeJournal, type CommitRecord } from '../src/journal.js'
import { sha256File } from '../src/paths.js'
import { recoverCommits } from '../src/recovery.js'

interface Fixture {
  home: string
  commitsDir: string
  originalPath: string
  backupPath: string
}

async function fixture(original: string | null, backup: string | null, phase: CommitRecord['phase']): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'bo-recovery-'))
  const commitsDir = join(home, 'betteroffice', 'commits')
  const originalPath = join(home, '年度报告.docx')
  const backupPath = join(home, 'betteroffice', 'backups', 'a71c2e90.docx')
  await writeFile(join(home, 'seed.txt'), 'seed', 'utf8')
  if (original !== null) await writeFile(originalPath, original, 'utf8')
  if (backup !== null) {
    await mkdir(join(home, 'betteroffice', 'backups'), { recursive: true })
    await writeFile(backupPath, backup, 'utf8')
  }
  const candidate = 'new exported bytes'
  await writeJournal(commitsDir, {
    version: 1,
    taskId: 'a71c2e90',
    phase,
    originalPath,
    originalSha256: backup === null ? '' : await sha256File(backupPath),
    backupPath,
    backupSha256: backup === null ? '' : await sha256File(backupPath),
    candidatePath: null,
    candidateSha256: candidate === original ? '0'.repeat(64) : '0'.repeat(64),
    startedAt: '2026-11-28T01:00:00.000Z',
    updatedAt: '2026-11-28T01:00:00.000Z',
  })
  return { home, commitsDir, originalPath, backupPath }
}

test('prepared 阶段崩溃：原件未动，只清日志与副本', async () => {
  const fix = await fixture('old original bytes', 'old original bytes', 'prepared')
  const outcomes = await recoverCommits({ home: fix.home })
  assert.equal(outcomes[0]?.action, 'cleared')
  assert.equal(await readFile(fix.originalPath, 'utf8'), 'old original bytes')
  assert.equal(await readJournal(fix.commitsDir, 'a71c2e90'), undefined)
})

test('prepared 阶段崩溃但原件已不在：用副本把它放回去', async () => {
  const fix = await fixture(null, 'old original bytes', 'prepared')
  const outcomes = await recoverCommits({ home: fix.home })
  assert.equal(outcomes[0]?.action, 'restored')
  assert.equal(await readFile(fix.originalPath, 'utf8'), 'old original bytes')
})

test('recycled 阶段原路径上是别的文件：保留现场，不覆盖也不删副本', async () => {
  const fix = await fixture('someone else wrote this', 'old original bytes', 'recycled')
  const outcomes = await recoverCommits({ home: fix.home })
  assert.equal(outcomes[0]?.action, 'kept')
  assert.equal(await readFile(fix.originalPath, 'utf8'), 'someone else wrote this')
  assert.equal(await readFile(fix.backupPath, 'utf8'), 'old original bytes')
  assert.notEqual(await readJournal(fix.commitsDir, 'a71c2e90'), undefined)
})

test('recycled 阶段崩溃：用副本把原件还原回去', async () => {
  const fix = await fixture(null, 'old original bytes', 'recycled')
  const outcomes = await recoverCommits({ home: fix.home })
  assert.equal(outcomes[0]?.action, 'restored')
  assert.equal(await readFile(fix.originalPath, 'utf8'), 'old original bytes')
  assert.equal(await readJournal(fix.commitsDir, 'a71c2e90'), undefined)
})

test('published 阶段且新文件校验通过：保留新文件、清日志与副本', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bo-recovery-'))
  const commitsDir = join(home, 'betteroffice', 'commits')
  const originalPath = join(home, 'a.docx')
  const backupPath = join(home, 'betteroffice', 'backups', 'a71c2e90.docx')
  await writeFile(originalPath, 'new exported bytes', 'utf8')
  await mkdir(join(home, 'betteroffice', 'backups'), { recursive: true })
  await writeFile(backupPath, 'old original bytes', 'utf8')
  const expected = await sha256File(originalPath)
  await writeJournal(commitsDir, {
    version: 1,
    taskId: 'a71c2e90',
    phase: 'published',
    originalPath,
    originalSha256: await sha256File(backupPath),
    backupPath,
    backupSha256: await sha256File(backupPath),
    candidatePath: null,
    candidateSha256: expected,
    startedAt: '2026-11-28T01:00:00.000Z',
    updatedAt: '2026-11-28T01:00:00.000Z',
  })
  const outcomes = await recoverCommits({ home })
  assert.equal(outcomes[0]?.action, 'cleared')
  assert.equal(await readFile(originalPath, 'utf8'), 'new exported bytes')
  await assert.rejects(stat(backupPath))
})

test('published 阶段但新文件哈希不符：用副本还原', async () => {
  const fix = await fixture('old original bytes', 'old original bytes', 'published')
  const outcomes = await recoverCommits({ home: fix.home })
  assert.equal(outcomes[0]?.action, 'restored')
  assert.equal(await readFile(fix.originalPath, 'utf8'), 'old original bytes')
})

test('副本丢失的 recycled 日志：保留日志并报告，不清理', async () => {
  const fix = await fixture(null, null, 'recycled')
  const outcomes = await recoverCommits({ home: fix.home })
  assert.equal(outcomes[0]?.action, 'kept')
  assert.ok(await readJournal(fix.commitsDir, 'a71c2e90'))
})

test('没有日志时什么也不做', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bo-recovery-'))
  await rm(join(home, 'seed.txt'), { force: true })
  assert.deepEqual(await recoverCommits({ home }), [])
})
