import test from 'node:test'
import assert from 'node:assert/strict'
import { readToolJson } from '../src/invoke.js'

test('把 content[].text 拼起来当 JSON 解', () => {
  const result = {
    content: [
      { type: 'text', text: '{"document":' },
      { type: 'text', text: '"doc1"}' },
    ],
  }
  assert.deepEqual(readToolJson(result), { document: 'doc1' })
})

test('structuredContent 优先，解不出来或没有内容时返回 undefined', () => {
  assert.deepEqual(readToolJson({ structuredContent: { a: 1 }, content: [] }), { a: 1 })
  assert.equal(readToolJson({ content: [{ type: 'text', text: '不是 JSON' }] }), undefined)
  assert.equal(readToolJson({ content: [] }), undefined)
  assert.equal(readToolJson(null), undefined)
})
