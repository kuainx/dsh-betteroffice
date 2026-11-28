import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  RUNTIME_ROOT,
  agentPackageDirFor,
  listInstalledRuntimes,
  npmInstallArgs,
  runtimeDirFor,
} from '../src/npm-runtime.js'

const HOME = 'C:/dsh-home'

test('运行时目录与包目录都在私有子目录下', () => {
  assert.equal(RUNTIME_ROOT, join('betteroffice', 'runtime'))
  assert.equal(runtimeDirFor(HOME, '0.4.0'), join(HOME, 'betteroffice', 'runtime', '0.4.0'))
  assert.equal(
    agentPackageDirFor(HOME, '0.4.0'),
    join(HOME, 'betteroffice', 'runtime', '0.4.0', 'node_modules', '@betteroffice', 'agents'),
  )
})

test('只列出真的装好了 CLI 的版本，且按版本排序', () => {
  const listings: Record<string, readonly string[]> = {
    [join(HOME, 'betteroffice', 'runtime')]: ['0.4.0', '0.10.0', 'not-a-version', '0.2.0'],
  }
  const present = new Set([
    join(runtimeDirFor(HOME, '0.4.0'), 'node_modules', '@betteroffice', 'agents', 'dist', 'cli.js'),
    join(runtimeDirFor(HOME, '0.10.0'), 'node_modules', '@betteroffice', 'agents', 'dist', 'cli.js'),
    join(runtimeDirFor(HOME, '0.2.0'), 'node_modules', '@betteroffice', 'agents', 'dist', 'cli.js'),
  ])
  const installed = listInstalledRuntimes(HOME, {
    readdir: (dir) => listings[dir] ?? [],
    exists: (path) => present.has(path),
  })
  assert.deepEqual(installed, ['0.2.0', '0.4.0', '0.10.0'])
})

test('运行时根目录不存在时返回空列表而不是抛错', () => {
  const installed = listInstalledRuntimes(HOME, {
    readdir: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    exists: () => false,
  })
  assert.deepEqual(installed, [])
})

test('安装参数装进私有目录、用私有 cache、不改全局', () => {
  const args = npmInstallArgs({
    prefix: runtimeDirFor(HOME, '0.4.0'),
    version: '0.4.0',
    cacheDir: join(runtimeDirFor(HOME, '0.4.0'), '.npm-cache'),
  })
  assert.deepEqual(args, [
    'install',
    '@betteroffice/agents@0.4.0',
    '--prefix',
    join(HOME, 'betteroffice', 'runtime', '0.4.0'),
    '--no-fund',
    '--no-audit',
    '--cache',
    join(HOME, 'betteroffice', 'runtime', '0.4.0', '.npm-cache'),
  ])
})
