import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const manifest: {
  dsh?: { engines?: { dsh?: unknown }; client?: { inject?: unknown } }
  peerDependencies?: Record<string, string>
  // 测试编译到 lib/test/，仓库根的 package.json 在两层之上。
} = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

test('客户端声明官方组件库，卡片才能借到 DSH 的按钮', () => {
  // 宿主的客户端模块加载器只把 dsh.client.inject 里列出的包交给 require()。
  // 漏一个就等于运行时 require 抛错 → 客户端 apply 抛错 → 整个插件起不来。
  const inject = manifest.dsh?.client?.inject
  assert.ok(Array.isArray(inject), 'package.json 的 dsh.client.inject 必须是数组')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-primitives'), 'dsh.client.inject 要包含 @deepseek-ai/dsh-client-ui-primitives')
})

test('插件声明 DSH 兼容范围，客户端才肯装', () => {
  // 宿主装配用 @deepseek-ai/dsh-app-boot 的 evaluatePluginCompatibility 判定：
  // 有 dsh.engines.dsh 就只看它，否则每个 @deepseek-ai/dsh* 的 peer 都必须满足运行版本。
  const range = manifest.dsh?.engines?.dsh
  assert.equal(typeof range, 'string', 'package.json 的 dsh.engines.dsh 必须是字符串')

  // 宿主版本只写一处：所有 @deepseek-ai/dsh* 的 peer 跟着它走，免得又出现各自过期的范围。
  for (const [name, peerRange] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(peerRange, range, `${name} 的 peer 范围要和 dsh.engines.dsh 一致`)
  }
})
