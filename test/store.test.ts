import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readStoredVersion, storePath, writeStoredVersion } from '../src/store.js'

test('没写过的时候读出来是空串，不是报错', () => {
  const stored = readStoredVersion('C:/home', { exists: () => false, read: () => '' })
  assert.equal(stored, '')
})

test('文件内容坏掉时也当没写过，不能把插件拖崩', () => {
  const stored = readStoredVersion('C:/home', { exists: () => true, read: () => '{ not json' })
  assert.equal(stored, '')
})

test('写进去的版本能读回来，落在 betteroffice 自己的目录里', () => {
  let written = ''
  let writtenPath = ''
  writeStoredVersion(
    'C:/home',
    '0.4.0',
    {
      mkdir: () => undefined,
      write: (path, text) => {
        writtenPath = path
        written = text
      },
    },
  )
  assert.match(writtenPath, /betteroffice[/\\]settings\.json$/)
  const stored = readStoredVersion('C:/home', {
    exists: () => true,
    read: () => written,
  })
  assert.equal(stored, '0.4.0')
})

test('存下来的不是版本号形状时忽略，避免拿脏数据去拼路径', () => {
  const stored = readStoredVersion('C:/home', {
    exists: () => true,
    read: () => JSON.stringify({ runtimeVersion: '../escape' }),
  })
  assert.equal(stored, '')
})

test('storePath 跟着 home 走', () => {
  assert.match(storePath('C:/home'), /home[/\\]betteroffice[/\\]settings\.json$/)
})
