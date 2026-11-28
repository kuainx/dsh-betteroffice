import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBetterOfficeCommand, COMMAND_NAME } from '../src/commands.js'
import type { CommandResult } from '../src/commands.js'
import { createInstaller } from '../src/installer.js'
import { cliPathFor } from '../src/runtime.js'

const HOME = 'C:/dsh-home'

function harness(options: { installed?: string[]; configured?: string; latest?: string } = {}) {
  const installedClis = new Set((options.installed ?? []).map((version) => cliPathFor(HOME, version)))
  const installedRuntimes = new Set(options.installed ?? [])
  const versions = { current: options.configured ?? '' }
  const installerCalls: string[] = []
  const installer = createInstaller({
    home: HOME,
    exists: (path) => installedClis.has(path),
    mkdir: async () => {},
    run: async (_command, args) => {
      const spec = args.find((a) => a.startsWith('@betteroffice/agents@')) ?? ''
      const version = spec.split('@')[2] ?? ''
      installerCalls.push(version)
      installedClis.add(cliPathFor(HOME, version))
      installedRuntimes.add(version)
      return { code: 0, stderr: '' }
    },
  })
  const command = createBetterOfficeCommand({
    home: HOME,
    nodeVersion: '24.22.1',
    exists: (path) => installedClis.has(path),
    currentConfig: () => ({ runtimeVersion: versions.current, nodePath: '' }),
    setRuntimeVersion: async (version) => {
      versions.current = version
    },
    installer,
    latestVersion: async () => options.latest ?? '0.4.0',
    installedVersions: () => [...installedRuntimes],
  })
  return { command, installedClis, versions, installerCalls }
}

const run = async (command: { handler: (i: never) => Promise<CommandResult> | CommandResult }, input: string) =>
  await command.handler({
    rawInput: ` ${input}`,
    attachments: [],
    signal: new AbortController().signal,
    commandId: 'c1',
  } as never)

test('命令名与描述符合斜杠命令约定', () => {
  const { command } = harness()
  assert.equal(COMMAND_NAME, 'betteroffice')
  assert.equal(command.name, 'betteroffice')
  assert.match(command.description, /BetterOffice/)
})

test('状态：没装运行时说清未安装与怎么办', async () => {
  const { command } = harness()
  const result = await run(command, '')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /未安装|未设置/)
  assert.match(result.text, /安装/)
})

test('安装默认装 registry 最新版并写入运行时版本', async () => {
  const { command, versions, installerCalls } = harness({ latest: '0.4.0' })
  const result = await run(command, '安装')
  assert.equal(result.kind, 'success')
  assert.deepEqual(installerCalls, ['0.4.0'])
  assert.equal(versions.current, '0.4.0')
  assert.match(result.text, /0\.4\.0/)
})

test('安装可指定版本号', async () => {
  const { command, versions, installerCalls } = harness()
  const result = await run(command, '安装 0.3.0')
  assert.equal(result.kind, 'success')
  assert.deepEqual(installerCalls, ['0.3.0'])
  assert.equal(versions.current, '0.3.0')
})

test('检查更新：已是最新时说明，不安装', async () => {
  const { command, installerCalls } = harness({ configured: '0.4.0', latest: '0.4.0' })
  const result = await run(command, '检查更新')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /最新/)
  assert.deepEqual(installerCalls, [])
})

test('检查更新：有新版本时给出更新命令', async () => {
  const { command, installerCalls } = harness({ configured: '0.3.0', latest: '0.4.0' })
  const result = await run(command, '检查更新')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /0\.4\.0/)
  assert.match(result.text, /更新/)
  assert.deepEqual(installerCalls, [])
})

test('更新会装新版本并切换默认', async () => {
  const { command, versions, installerCalls } = harness({
    installed: ['0.3.0'],
    configured: '0.3.0',
  })
  const result = await run(command, '更新 0.4.0')
  assert.equal(result.kind, 'success')
  assert.deepEqual(installerCalls, ['0.4.0'])
  assert.equal(versions.current, '0.4.0')
})

test('回退只接受已安装的版本', async () => {
  const { command, versions } = harness({ installed: ['0.3.0'], configured: '0.4.0' })
  const bad = await run(command, '回退 0.9.9')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /0\.9\.9/)

  const ok = await run(command, '回退 0.3.0')
  assert.equal(ok.kind, 'success')
  assert.equal(versions.current, '0.3.0')
})

test('未知子命令给出用法', async () => {
  const { command } = harness()
  const result = await run(command, '瞎写')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法|\/betteroffice/)
})

test('安装失败时把中文原因原样返回给用户', async () => {
  const failing = createBetterOfficeCommand({
    home: HOME,
    nodeVersion: '24.22.1',
    exists: () => false,
    currentConfig: () => ({ runtimeVersion: '', nodePath: '' }),
    setRuntimeVersion: async () => {},
    installer: {
      install: async () => {
        throw Object.assign(new Error('安装失败（退出码 1）：network timeout'), {
          code: 'install-failed',
        })
      },
      inFlight: () => [],
    },
    latestVersion: async () => '0.4.0',
    installedVersions: () => [],
  })
  const result = await run(failing, '安装')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /network timeout/)
})
