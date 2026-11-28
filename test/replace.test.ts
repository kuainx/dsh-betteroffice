import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readJournal } from '../src/journal.js'
import { replaceOriginal, type ReplaceDeps } from '../src/replace.js'
import { sha256File } from '../src/paths.js'

interface Fixture {
  home: string
  sourcePath: string
  candidatePath: string
  sourceText: string
  candidateText: string
  deps: ReplaceDeps
  recycled: string[]
}

async function fixture(overrides: Partial<ReplaceDeps> = {}): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'bo-replace-'))
  const sourceText = 'old original bytes'
  const candidateText = 'new exported bytes'
  const sourcePath = join(home, '年度报告.docx')
  const candidatePath = join(home, 'candidate.docx')
  await writeFile(sourcePath, sourceText, 'utf8')
  await writeFile(candidatePath, candidateText, 'utf8')
  const recycled: string[] = []
  const deps: ReplaceDeps = {
    home,
    platform: 'win32',
    recycle: async (path) => {
      recycled.push(path)
      await rm(path, { force: true })
    },
    ...overrides,
  }
  return { home, sourcePath, candidatePath, sourceText, candidateText, deps, recycled }
}

function base(fix: Fixture) {
  return {
    taskId: 'a71c2e90',
    sourcePath: fix.sourcePath,
    candidatePath: fix.candidatePath,
    expectedSourceSha256: undefined as string | undefined,
  }
}

test('替换成功后原件进回收站、新文件就位、事务日志清空', async () => {
  const fix = await fixture()
  const expected = await sha256File(fix.sourcePath)
  const result = await replaceOriginal({ ...base(fix), expectedSourceSha256: expected }, fix.deps)
  assert.deepEqual(fix.recycled, [fix.sourcePath])
  assert.equal(await readFile(fix.sourcePath, 'utf8'), fix.candidateText)
  assert.equal(result.sha256, await sha256File(fix.sourcePath))
  assert.equal(result.bytes, fix.candidateText.length)
  assert.equal(result.recycled, true)
  assert.equal(await readJournal(join(fix.home, 'betteroffice', 'commits'), 'a71c2e90'), undefined)
  // 恢复副本与候选文件都已清理
  await assert.rejects(stat(join(fix.home, 'betteroffice', 'backups', 'a71c2e90.docx')))
  await assert.rejects(stat(fix.candidatePath))
})

test('源文件哈希与打开时不一致时拒绝替换，原件不动', async () => {
  const fix = await fixture()
  await assert.rejects(
    replaceOriginal({ ...base(fix), expectedSourceSha256: 'f'.repeat(64) }, fix.deps),
    /源文件在打开后被改动/,
  )
  assert.deepEqual(fix.recycled, [])
  assert.equal(await readFile(fix.sourcePath, 'utf8'), fix.sourceText)
})

test('回收失败时报错并保留原件', async () => {
  const fix = await fixture({
    recycle: async () => {
      throw new Error('回收站不可用')
    },
  })
  await assert.rejects(replaceOriginal(base(fix), fix.deps), /回收站不可用/)
  assert.equal(await readFile(fix.sourcePath, 'utf8'), fix.sourceText)
})

test('发布阶段发现目标已存在时从备份恢复原件', async () => {
  const fix = await fixture({
    publish: async () => {
      const error = new Error('EEXIST') as NodeJS.ErrnoException
      error.code = 'EEXIST'
      throw error
    },
  })
  await assert.rejects(replaceOriginal(base(fix), fix.deps), /发布/)
  assert.equal(await readFile(fix.sourcePath, 'utf8'), fix.sourceText)
})

test('发布后哈希对不上时从备份恢复原件', async () => {
  const fix = await fixture()
  const broken: ReplaceDeps = {
    ...fix.deps,
    sha256: async (path) => (path === fix.candidatePath ? '0'.repeat(64) : await sha256File(path)),
  }
  await assert.rejects(replaceOriginal(base(fix), broken), /校验/)
  assert.equal(await readFile(fix.sourcePath, 'utf8'), fix.sourceText)
})

test('非 Windows 平台只能另存', async () => {
  const fix = await fixture({ platform: 'linux' })
  await assert.rejects(replaceOriginal(base(fix), fix.deps), /只能另存/)
  assert.deepEqual(fix.recycled, [])
})
