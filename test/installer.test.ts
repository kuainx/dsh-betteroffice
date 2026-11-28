import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstaller } from '../src/installer.js'
import { cliPathFor } from '../src/runtime.js'
import { runtimeDirFor } from '../src/npm-runtime.js'

const HOME = 'C:/dsh-home'

interface RunCall {
  command: string
  args: string[]
  cwd: string
}

function harness(options: { code?: number; stderr?: string; installedAfter?: boolean } = {}) {
  const calls: RunCall[] = []
  const installs = new Set<string>()
  const deps = {
    home: HOME,
    logger: () => {},
    exists: (path: string) => installs.has(path),
    mkdir: async () => {},
    run: async (command: string, args: string[], runOptions: { cwd: string }) => {
      calls.push({ command, args, cwd: runOptions.cwd })
      if ((options.code ?? 0) === 0 && options.installedAfter !== false) {
        installs.add(cliPathFor(HOME, '0.4.0'))
      }
      return { code: options.code ?? 0, stderr: options.stderr ?? '' }
    },
  }
  return { calls, installs, installer: createInstaller(deps) }
}

test('安装成功时返回目录与 CLI 路径，且全部落在私有目录', async () => {
  const { calls, installer } = harness()
  const result = await installer.install('0.4.0')
  assert.equal(result.version, '0.4.0')
  assert.equal(result.dir, runtimeDirFor(HOME, '0.4.0'))
  assert.equal(result.cliPath, cliPathFor(HOME, '0.4.0'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.command, 'npm')
  const args = calls[0]?.args ?? []
  assert.ok(args.includes('@betteroffice/agents@0.4.0'))
  assert.equal(args[args.indexOf('--prefix') + 1], runtimeDirFor(HOME, '0.4.0'))
  assert.ok(args.includes('--no-fund'))
  assert.equal(calls[0]?.cwd, runtimeDirFor(HOME, '0.4.0'))
})

test('已经装过同一版本时不再调用 npm', async () => {
  const { calls, installs, installer } = harness()
  installs.add(cliPathFor(HOME, '0.4.0'))
  const result = await installer.install('0.4.0')
  assert.equal(result.cliPath, cliPathFor(HOME, '0.4.0'))
  assert.equal(calls.length, 0)
})

test('npm 失败时抛出可读中文错误并带上 stderr 尾部', async () => {
  const { installer } = harness({
    code: 1,
    stderr: 'npm error code ETIMEDOUT\nnpm error network timeout',
  })
  await assert.rejects(
    () => installer.install('0.4.0'),
    (error: unknown) => {
      const e = error as { code?: string; message?: string }
      assert.equal(e.code, 'install-failed')
      assert.match(String(e.message), /退出码 1/)
      assert.match(String(e.message), /network timeout/)
      return true
    },
  )
})

test('npm 说成功但找不到 CLI 时仍算失败', async () => {
  const { installer } = harness({ installedAfter: false })
  await assert.rejects(
    () => installer.install('0.4.0'),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'install-failed')
      assert.match(String((error as Error).message), /betteroffice-mcp|入口/)
      return true
    },
  )
})

test('缺少版本号或版本号不合法时直接拒绝', async () => {
  const { calls, installer } = harness()
  for (const bad of ['', 'latest', '../evil', '0.4']) {
    await assert.rejects(
      () => installer.install(bad),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'invalid-version')
        return true
      },
    )
  }
  assert.equal(calls.length, 0)
})

test('inFlight 暴露正在安装的版本，装完就清空', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let installed = false
  const installer = createInstaller({
    home: HOME,
    exists: (path) => installed && path === cliPathFor(HOME, '0.4.0'),
    mkdir: async () => {},
    run: async () => {
      await gate
      installed = true
      return { code: 0, stderr: '' }
    },
  })
  const task = installer.install('0.4.0')
  assert.deepEqual(installer.inFlight(), ['0.4.0'])
  assert.equal(installer.install('0.4.0'), task)
  release()
  const result = await task
  assert.equal(result.version, '0.4.0')
  assert.deepEqual(installer.inFlight(), [])
})

test('同一版本并发安装只真正装一次', async () => {
  const { calls, installer } = harness()
  const [a, b] = await Promise.all([installer.install('0.4.0'), installer.install('0.4.0')])
  assert.equal(a.cliPath, b.cliPath)
  assert.equal(calls.length, 1)
})
