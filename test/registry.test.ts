import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchLatestVersion } from '../src/registry.js'

const respond = (body: unknown, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

test('取 dist-tags.latest 作为最新版本', async () => {
  const seen: string[] = []
  const version = await fetchLatestVersion({
    fetch: async url => {
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
