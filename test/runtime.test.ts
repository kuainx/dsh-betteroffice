import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  cliPathFor,
  compareVersions,
  findNodeOnPath,
  resolveMcpRuntime,
  satisfiesNode,
  MIN_NODE_VERSION,
} from '../src/runtime.js'

const cfg = { workspaceMode: 'auto' as const, cleanupMode: 'auto' as const, nodePath: '', runtimeVersion: '' }
const nodeExe = process.platform === 'win32' ? 'node.exe' : 'node'

test('版本比较与 22.12.0 下限', () => {
  assert.equal(compareVersions('22.12.0', '22.9.0'), 1)
  assert.equal(compareVersions('22.9.0', '22.12.0'), -1)
  assert.equal(compareVersions('22.12.0', '22.12.0'), 0)
  assert.equal(satisfiesNode('22.11.9'), false)
  assert.equal(satisfiesNode('22.12.0'), true)
  assert.equal(satisfiesNode('24.22.1'), true)
  assert.equal(satisfiesNode('v24.22.1'), true)
  assert.equal(MIN_NODE_VERSION, '22.12.0')
})

test('CLI 路径按 home/版本拼接', () => {
  assert.equal(
    cliPathFor('C:/h', '0.4.0'),
    join('C:/h', 'betteroffice', 'runtime', '0.4.0', 'node_modules', '@betteroffice', 'agents', 'dist', 'cli.js'),
  )
})

test('PATH 中找不到 node 时给出缺 Node 原因', () => {
  assert.throws(
    () => resolveMcpRuntime({ config: cfg, home: 'C:/h', nodeVersion: '24.0.0', exists: () => false, env: { PATH: 'C:/empty' }, sep: ';' }),
    /未找到 Node/,
  )
})

test('Node 版本过低时报出版本要求', () => {
  const exists = (p: string) => p.includes(nodeExe) || p.includes('cli.js')
  assert.throws(
    () => resolveMcpRuntime({ config: cfg, home: 'C:/h', nodeVersion: '20.0.0', exists, env: { PATH: 'C:/n' }, sep: ';' }),
    /22\.12\.0/,
  )
})

test('未安装私有 CLI 时提示去配置页安装', () => {
  assert.throws(
    () =>
      resolveMcpRuntime({
        config: cfg,
        home: 'C:/h',
        nodeVersion: '24.0.0',
        exists: (p) => p.includes(nodeExe),
        env: { PATH: 'C:/n' },
        sep: ';',
      }),
    /安装/,
  )
})

test('配置了 nodePath 时优先使用', () => {
  const result = resolveMcpRuntime({
    config: { ...cfg, nodePath: 'C:/custom/node.exe', runtimeVersion: '0.4.0' },
    home: 'C:/h',
    nodeVersion: '24.0.0',
    exists: (p) => p === 'C:/custom/node.exe' || p.includes('cli.js'),
    env: { PATH: '' },
    sep: ';',
  })
  assert.equal(result.command, 'C:/custom/node.exe')
  assert.ok(result.cliPath.endsWith('cli.js'))
})

test('PATH 扫描返回候选 node 可执行文件', () => {
  const exists = (p: string) => p.endsWith(nodeExe)
  assert.deepEqual(findNodeOnPath({ PATH: ['C:/a', 'C:/b'].join(';') }, exists, ';'), [
    join('C:/a', nodeExe),
    join('C:/b', nodeExe),
  ])
})
