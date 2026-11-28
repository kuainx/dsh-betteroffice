import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REGISTRY_PRESETS, fetchLatestVersion, isRegistryUrl, packageUrl } from '../src/registry.js'

const respond =
  (body: unknown, status = 200) =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

test('取 dist-tags.latest 作为最新版本', async () => {
  const seen: string[] = []
  const version = await fetchLatestVersion({
    fetch: async (url) => {
      seen.push(String(url))
      return (await respond({ 'dist-tags': { latest: '0.4.0' } })()) as never
    },
  })
  assert.equal(version, '0.4.0')
  assert.match(seen[0] ?? '', /registry\.npmjs\.org/)
  assert.match(seen[0] ?? '', /@betteroffice%2Fagents|@betteroffice\/agents/)
})

test('网络失败给出中文可行动提示', async () => {
  await assert.rejects(
    () =>
      fetchLatestVersion({
        fetch: async () => {
          throw new Error('ECONNRESET')
        },
      }),
    (error: unknown) => {
      const e = error as { code?: string; message?: string }
      assert.equal(e.code, 'registry-unreachable')
      assert.match(String(e.message), /网络/)
      return true
    },
  )
})

test('非 2xx 视为响应异常', async () => {
  await assert.rejects(
    () => fetchLatestVersion({ fetch: async () => (await respond({}, 500)()) as never }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'registry-bad-response')
      return true
    },
  )
})

test('响应里没有可用版本号时报响应异常', async () => {
  for (const body of [{}, { 'dist-tags': {} }, { 'dist-tags': { latest: 'not-semver' } }]) {
    await assert.rejects(
      () => fetchLatestVersion({ fetch: async () => (await respond(body)()) as never }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'registry-bad-response')
        return true
      },
    )
  }
})

test('自定义源拼出的包地址不会出现双斜杠', () => {
  assert.equal(packageUrl(REGISTRY_PRESETS.npmmirror), 'https://registry.npmmirror.com/@betteroffice/agents')
  assert.equal(packageUrl('https://npm.example.com/mirror/'), 'https://npm.example.com/mirror/@betteroffice/agents')
})

test('自定义源只认 http(s) 的完整地址', () => {
  assert.equal(isRegistryUrl('https://registry.npmmirror.com/'), true)
  assert.equal(isRegistryUrl('http://127.0.0.1:4873'), true)
  for (const bad of ['javascript:alert(1)', 'file:///C:/npm', '//host/x', 'registry.npmjs.org', '', 'ftp://host']) {
    assert.equal(isRegistryUrl(bad), false, bad)
  }
})

test('检查更新打的是选中的那个源', async () => {
  const seen: string[] = []
  await fetchLatestVersion({
    registry: REGISTRY_PRESETS.npmmirror,
    fetch: async (url) => {
      seen.push(String(url))
      return (await respond({ 'dist-tags': { latest: '0.4.0' } })()) as never
    },
  })
  assert.match(seen[0] ?? '', /^https:\/\/registry\.npmmirror\.com\/@betteroffice\/agents$/)
})
