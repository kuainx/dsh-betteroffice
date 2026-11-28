import test from 'node:test'
import assert from 'node:assert/strict'
import { decideMcpCall, deniedReason } from '../src/guard.js'

test('裸工具名也查得到禁规则：透传工具和宿主守卫共用一张表', () => {
  assert.match(deniedReason('office_export') ?? '', /betteroffice_deliver/)
  assert.equal(deniedReason('xlsx_outline'), undefined)
})

test('挡住 agent 直接调用 office_export：写文件必须走交付或替换工具', () => {
  const decision = decideMcpCall('mcp__bo_a71c2e90__office_export')
  assert.equal(decision?.kind, 'deny')
  assert.match(decision?.reason ?? '', /betteroffice_deliver/)
})

test('挡住 office_files：目录枚举不给 agent', () => {
  const decision = decideMcpCall('mcp__bo_a71c2e90__office_files')
  assert.equal(decision?.kind, 'deny')
  assert.match(decision?.reason ?? '', /betteroffice_open/)
})

test('读写类 MCP 工具放行', () => {
  for (const name of [
    'mcp__bo_a71c2e90__office_read',
    'mcp__bo_a71c2e90__office_propose',
    'mcp__bo_a71c2e90__office_render',
    'betteroffice_deliver',
  ]) {
    assert.equal(decideMcpCall(name), undefined, name)
  }
})

test('同类导出工具按命名一起挡，免得新版本多出来的写法绕过去', () => {
  const decision = decideMcpCall('mcp__bo_a71c2e90__office_export_pdf')
  assert.equal(decision?.kind, 'deny')
  assert.match(decision?.reason ?? '', /betteroffice_deliver/u)
})

test('别的家族工具照常放行：这个 MCP 还有 xlsx_* 之类的工具', () => {
  assert.equal(decideMcpCall('mcp__bo_a71c2e90__xlsx_outline'), undefined)
  assert.equal(decideMcpCall('mcp__bo_a71c2e90__xlsx_write_range'), undefined)
})

test('不是本插件挂载的 MCP 服务不管', () => {
  assert.equal(decideMcpCall('mcp__other__office_export'), undefined)
  assert.equal(decideMcpCall('mcp__bo_zzz__office_export'), undefined)
})
