import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'

test('空配置得到默认值', () => {
  assert.deepEqual(resolveConfig(undefined), { workspaceMode: 'auto', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' })
})
test('非法枚举值被拒绝', () => {
  assert.throws(() => resolveConfig({ workspaceMode: 'yes' }), /workspaceMode/)
})
test('已知字段被保留', () => {
  assert.equal(resolveConfig({ nodePath: 'C:/node/node.exe' }).nodePath, 'C:/node/node.exe')
})
