import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStatus, parseAction } from '../src/control.js'
import type { ConfigData } from '../src/config.js'

const base: { home: string; nodeVersion: string; config: ConfigData } = {
  home: 'C:/h',
  nodeVersion: '24.22.1',
  config: { workspaceMode: 'auto', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' },
}

test('settings 动作原样带出两个开关', () => {
  assert.deepEqual(parseAction({ action: 'settings', workspaceMode: 'always', cleanupMode: 'off' }), {
    action: 'settings',
    settings: { workspaceMode: 'always', cleanupMode: 'off' },
  })
})

test('settings 的枚举值不对时给出中文原因，别静默改成默认', () => {
  assert.throws(() => parseAction({ action: 'settings', workspaceMode: 'sometimes', cleanupMode: 'off' }), /工作文件夹/)
})

test('快照里带上当前的两个开关，卡片才有东西可显示', () => {
  const snapshot = buildStatus({ ...base, installed: [], exists: () => false })
  assert.deepEqual(snapshot.settings, { workspaceMode: 'auto', cleanupMode: 'auto' })
})

test('未安装时给出可行动提示', () => {
  const s = buildStatus({ ...base, installed: [], exists: () => false })
  assert.equal(s.runtime.installed.length, 0)
  assert.equal(s.runtime.cliReady, false)
  assert.ok(s.messages.some(m => m.includes('/betteroffice 安装')))
})

test('Node 版本不足时标记 ok=false 并给出最低版本', () => {
  const s = buildStatus({ ...base, nodeVersion: '20.11.0', installed: ['0.4.0'], exists: () => true })
  assert.equal(s.node.ok, false)
  assert.equal(s.node.required, '22.12.0')
})

test('已装版本缺 CLI 入口时提示重装', () => {
  const s = buildStatus({ ...base, config: { ...base.config, runtimeVersion: '0.4.0' }, installed: ['0.4.0'], exists: () => false })
  assert.equal(s.runtime.cliReady, false)
  assert.ok(s.messages.some(m => m.includes('重装')))
})

test('安装中的版本出现在 inFlight', () => {
  const s = buildStatus({ ...base, installed: [], exists: () => false, inFlight: ['0.4.0'] })
  assert.deepEqual(s.inFlight, ['0.4.0'])
})

test('未知动作被拒', () => {
  assert.throws(() => parseAction({ action: 'delete' }), /不认识的操?作|invalid-action/i)
})

test('版本号带路径分隔符被拒', () => {
  assert.throws(() => parseAction({ action: 'install', version: '../x' }), /版本号/)
})

test('rollback 必须带版本', () => {
  assert.throws(() => parseAction({ action: 'rollback' }), /回退需要指定版本/)
})

test('version 不是字符串时被拒，而不是当成没给', () => {
  assert.throws(() => parseAction({ action: 'install', version: 123 }), /版本号看起来不对/)
})

test('合法请求原样返回', () => {
  assert.deepEqual(parseAction({ action: 'install', version: '0.4.0' }), {
    action: 'install',
    version: '0.4.0',
  })
})
