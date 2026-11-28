import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConfigData } from '../src/config.js'
import { DomainError } from '../src/errors.js'
import { createControlApi, type ControlDeps } from '../src/routes.js'

function fakeDeps(overrides: Partial<ControlDeps> = {}): ControlDeps {
  const config: ConfigData = {
    workspaceMode: 'auto',
    cleanupMode: 'off',
    nodePath: '',
    runtimeVersion: '',
  }
  return {
    home: 'C:/h',
    nodeVersion: '24.22.1',
    getConfig: () => config,
    saveRuntimeVersion: async () => {},
    install: async (version: string) => ({
      version,
      dir: `C:/h/runtime/${version}`,
      cliPath: `C:/h/runtime/${version}/cli.js`,
    }),
    latestVersion: async () => '0.4.0',
    installedVersions: () => [],
    exists: () => false,
    inFlight: () => [],
    ...overrides,
  }
}

test('status 返回快照', async () => {
  const r = await createControlApi(fakeDeps()).status()
  assert.equal(r.status, 200)
  assert.equal((r.body as { runtime: { installed: string[] } }).runtime.installed.length, 0)
})

test('install 成功后回写运行时版本并返回 200', async () => {
  const saved: string[] = []
  const api = createControlApi(
    fakeDeps({
      saveRuntimeVersion: async (version: string) => {
        saved.push(version)
      },
    }),
  )
  const r = await api.action({ action: 'install', version: '0.4.0' })
  assert.equal(r.status, 200)
  assert.deepEqual(saved, ['0.4.0'])
})

test('非法动作返回 400 且带中文原因', async () => {
  const r = await createControlApi(fakeDeps()).action({ action: 'nope' })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /不认识的操作/)
})

test('同一版本安装中再次请求返回 409', async () => {
  const api = createControlApi(fakeDeps({ inFlight: () => ['0.4.0'] }))
  const r = await api.action({ action: 'install', version: '0.4.0' })
  assert.equal(r.status, 409)
})

test('registry 不可用返回 500 与中文原因', async () => {
  const api = createControlApi(
    fakeDeps({
      latestVersion: async () => {
        throw new DomainError('registry-unreachable', '拿不到最新版本：网络或代理问题')
      },
    }),
  )
  const r = await api.action({ action: 'check' })
  assert.equal(r.status, 500)
  assert.match(JSON.stringify(r.body), /网络或代理/)
})
