import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDocumentPath } from '../src/paths.js'

test('相对路径按 cwd 解析并返回 sha256', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  await writeFile(join(base, 'a.docx'), 'hello')
  const doc = await resolveDocumentPath('a.docx', base)
  assert.equal(doc.name, 'a.docx')
  assert.equal(doc.ext, '.docx')
  assert.equal(doc.size, 5)
  assert.match(doc.sha256, /^[0-9a-f]{64}$/)
})
test('含 .. 的路径解析到同一真实文件', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  await mkdir(join(base, 'sub'))
  await writeFile(join(base, 'a.docx'), 'hello')
  const doc = await resolveDocumentPath(join('sub', '..', 'a.docx'), base)
  assert.equal(doc.realPath, await realpath(join(base, 'a.docx')))
})
test('目录联接指向别处时拒绝', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  const target = join(base, 'real')
  await mkdir(target)
  await writeFile(join(target, 'a.docx'), 'x')
  await symlink(target, join(base, 'link'), 'junction')
  await assert.rejects(
    () => resolveDocumentPath(join('link', 'a.docx'), base),
    (e: any) => e.code === 'path-redirected',
  )
})
test('不支持的后缀被拒绝', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  await writeFile(join(base, 'a.txt'), 'x')
  await assert.rejects(
    () => resolveDocumentPath('a.txt', base),
    (e: any) => e.code === 'unsupported-format',
  )
})
test('不存在给出 not-found', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  await assert.rejects(
    () => resolveDocumentPath('nope.docx', base),
    (e: any) => e.code === 'not-found',
  )
})
