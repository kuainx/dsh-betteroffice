import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recycleFile, recycleScript } from '../src/recycle.js'
import { DomainError } from '../src/errors.js'

function record() {
  const calls: { command: string; args: readonly string[]; env: Record<string, string> }[] = []
  return {
    calls,
    run: async (command: string, args: readonly string[], options: { env: Record<string, string> }) => {
      calls.push({ command, args, env: options.env })
      return { code: 0, stderr: '', stdout: 'noise\n{"recycled":true,"name":"a.docx"}\n' }
    },
  }
}

test('脚本用 VB API 回收并用 shell 命名空间确认', () => {
  const script = recycleScript()
  assert.match(script, /SendToRecycleBin/)
  assert.match(script, /DeleteFile/)
  assert.match(script, /Namespace\(10\)/)
  assert.match(script, /BO_RECYCLE_PATH/)
  assert.match(script, /OutputEncoding[^\n]*UTF8/)
})

test('非 Windows 平台直接报 recycle-unavailable', async () => {
  const { calls, run } = record()
  await assert.rejects(
    () => recycleFile('C:/d/a.docx', { platform: 'linux', run }),
    (error: unknown) => error instanceof DomainError && error.code === 'recycle-unavailable',
  )
  assert.equal(calls.length, 0)
})

test('回收成功时把路径经环境变量传入', async () => {
  const { calls, run } = record()
  await recycleFile('C:/d/年度 报告.docx', { platform: 'win32', run })
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.command, 'powershell.exe')
  assert.deepEqual([...call.args].slice(0, 2), ['-NoProfile', '-NonInteractive'])
  assert.equal(call.env.BO_RECYCLE_PATH, 'C:/d/年度 报告.docx')
})

test('脚本报告回收失败时抛 recycle-failed', async () => {
  const run = async () => ({ code: 0, stderr: '', stdout: '{"recycled":false,"reason":"文件被占用"}' })
  await assert.rejects(
    () => recycleFile('C:/d/a.docx', { platform: 'win32', run }),
    (error: unknown) =>
      error instanceof DomainError && error.code === 'recycle-failed' && /文件被占用/.test(error.message),
  )
})

test('输出无法解析或退出码非零时抛 recycle-failed', async () => {
  const junk = async () => ({ code: 1, stderr: 'boom', stdout: 'not json' })
  await assert.rejects(
    () => recycleFile('C:/d/a.docx', { platform: 'win32', run: junk }),
    (error: unknown) => error instanceof DomainError && error.code === 'recycle-failed',
  )
})
