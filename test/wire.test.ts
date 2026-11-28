import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCommandDeps } from '../src/wire.js'
import { cliPathFor } from '../src/runtime.js'
import type { ConfigData } from '../src/config.js'

const CONFIG: ConfigData = { workspaceMode: 'auto', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' }

async function homeWithRuntime(version: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'bo-wire-'))
  const cli = cliPathFor(home, version)
  await mkdir(join(cli, '..'), { recursive: true })
  await writeFile(cli, '')
  return home
}

test('createCommandDeps 复用注入的 installer', () => {
  const installer = {
    install: async (version: string) => ({ version, dir: 'd', cliPath: 'c' }),
    inFlight: () => ['0.4.0'],
  }
  const deps = createCommandDeps({
    home: 'C:/dsh-home',
    getConfig: () => CONFIG,
    saveRuntimeVersion: () => {},
    installer,
  })
  assert.equal(deps.installer, installer)
})

test('已安装版本从私有运行时目录扫出来', async () => {
  const home = await homeWithRuntime('0.4.0')
  const deps = createCommandDeps({ home, getConfig: () => CONFIG, saveRuntimeVersion: () => {} })
  assert.deepEqual(deps.installedVersions(), ['0.4.0'])
  assert.equal(deps.exists(cliPathFor(home, '0.4.0')), true)
  assert.equal(deps.exists(cliPathFor(home, '0.3.0')), false)
})

test('配置与版本写入透传给宿主', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bo-wire-'))
  const saved: string[] = []
  const deps = createCommandDeps({
    home,
    getConfig: () => ({ ...CONFIG, runtimeVersion: '0.4.0' }),
    saveRuntimeVersion: version => {
      saved.push(version)
    },
  })
  assert.equal(deps.currentConfig().runtimeVersion, '0.4.0')
  await deps.setRuntimeVersion('0.5.0')
  assert.deepEqual(saved, ['0.5.0'])
  assert.deepEqual(deps.installedVersions(), [])
})

test('最新版本走 npm registry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bo-wire-'))
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ 'dist-tags': { latest: '0.4.2' } }), { status: 200 })) as typeof fetch
  try {
    const deps = createCommandDeps({ home, getConfig: () => CONFIG, saveRuntimeVersion: () => {} })
    assert.equal(await deps.latestVersion(), '0.4.2')
  } finally {
    globalThis.fetch = original
  }
})
