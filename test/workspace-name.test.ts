import test from 'node:test'
import assert from 'node:assert/strict'
import { formatStamp, workspaceDirName } from '../src/workspace.js'

const at = new Date(2026, 10, 27, 14, 41, 26) // 2026-11-27 14:41:26 本地时间
const id = 'a71c2e90'

test('时间戳格式为 YYMMDD-HHmmss', () => {
  assert.equal(formatStamp(at), '261127-144126')
})
test('中文文件名与扩展名保留', () => {
  assert.equal(workspaceDirName('年度报告.docx', id, at), 'dsh-年度报告.docx-261127-144126-a71c2e90')
})
test('非法字符被剔除且不留尾随空格/点', () => {
  assert.equal(workspaceDirName('a<>:"/\\|?*b .docx ', id, at), 'dsh-a_b .docx-261127-144126-a71c2e90')
})
test('超长名被截断但保留扩展名与后缀，总字节数不超上限', () => {
  const name = workspaceDirName('长'.repeat(200) + '.docx', id, at)
  assert.ok(Buffer.byteLength(name, 'utf8') <= 200)
  assert.ok(name.startsWith('dsh-长'))
  assert.ok(name.endsWith(`-261127-144126-${id}`))
  assert.ok(name.includes('.docx-'))
})
test('同一秒同名文档靠任务 id 区分', () => {
  const a = workspaceDirName('同名.docx', 'aaaaaaaa', at)
  const b = workspaceDirName('同名.docx', 'bbbbbbbb', at)
  assert.notEqual(a, b)
})
