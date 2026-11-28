import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRegistry } from '../src/registry-source.js'

test('用户选过源就用它，不去问 npm', async () => {
  let asked = false
  const registry = await resolveRegistry('https://registry.npmmirror.com/', async () => {
    asked = true
    return 'https://registry.npmjs.org/'
  })
  assert.equal(registry, 'https://registry.npmmirror.com/')
  assert.equal(asked, false)
})

test('默认档跟随 npm 自己的配置', async () => {
  const registry = await resolveRegistry('', async () => 'https://npm.corp.local/\n')
  assert.equal(registry, 'https://npm.corp.local/')
})

test('问不到 npm 配置时退回 npmjs', async () => {
  assert.equal(
    await resolveRegistry('', async () => {
      throw new Error('npm 不在 PATH')
    }),
    'https://registry.npmjs.org/',
  )
  assert.equal(await resolveRegistry('', async () => 'ftp://nope'), 'https://registry.npmjs.org/')
})