import { test } from 'node:test'
import assert from 'node:assert/strict'
import { npmInstallArgs } from '../src/npm-runtime.js'

test('指定了源就带上 --registry，没指定就不带', () => {
  const withSource = npmInstallArgs({
    prefix: 'C:/p',
    version: '0.4.0',
    cacheDir: 'C:/p/.npm-cache',
    registry: 'https://registry.npmmirror.com/',
  })
  assert.deepEqual(withSource.slice(-2), ['--registry', 'https://registry.npmmirror.com/'])
  assert.equal(withSource.includes('--registry'), true)

  const without = npmInstallArgs({ prefix: 'C:/p', version: '0.4.0', cacheDir: 'C:/p/.npm-cache' })
  assert.equal(without.includes('--registry'), false)
})