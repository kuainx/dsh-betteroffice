import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../src/index.js'

test('插件导出 name/inject/apply', () => {
  assert.equal(plugin.name, 'betteroffice')
  assert.deepEqual(plugin.inject, [])
  assert.equal(typeof plugin.apply, 'function')
})
