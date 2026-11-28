import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConfigData } from '../src/config.js'
import { DomainError } from '../src/errors.js'
import { createControlApi, registerControlRoutes, type ControlDeps } from '../src/routes.js'

function fakeDeps(overrides: Partial<ControlDeps> = {}): ControlDeps {
  const config: ConfigData = {
    workspaceMode: 'auto',
    cleanupMode: 'off',
    nodePath: '',
    runtimeVersion: '',
  }
  return {
    home: 'C:/h',
    nodeVersion: '24.22.1',
    getConfig: () => config,
    saveRuntimeVersion: async () => {},
    install: async (version: string) => ({
      version,
      dir: `C:/h/runtime/${version}`,
      cliPath: `C:/h/runtime/${version}/cli.js`,
    }),
    latestVersion: async () => '0.4.0',
    installedVersions: () => [],
    exists: () => false,
    inFlight: () => [],
    ...overrides,
  }
}

test('status 返回快照', async () => {
  const r = await createControlApi(fakeDeps()).status()
  assert.equal(r.status, 200)
  assert.equal((r.body as { runtime: { installed: string[] } }).runtime.installed.length, 0)
})

test('install 成功后回写运行时版本并返回 200', async () => {
  const saved: string[] = []
  const api = createControlApi(
    fakeDeps({
      saveRuntimeVersion: async (version: string) => {
        saved.push(version)
      },
    }),
  )
  const r = await api.action({ action: 'install', version: '0.4.0' })
  assert.equal(r.status, 200)
  assert.deepEqual(saved, ['0.4.0'])
})

test('非法动作返回 400 且带中文原因', async () => {
  const r = await createControlApi(fakeDeps()).action({ action: 'nope' })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /不认识的操作/)
})

test('同一版本安装中再次请求返回 409', async () => {
  const api = createControlApi(fakeDeps({ inFlight: () => ['0.4.0'] }))
  const r = await api.action({ action: 'install', version: '0.4.0' })
  assert.equal(r.status, 409)
})

interface FakeRoute {
  method: string
  path: string
  handler: (ctx: unknown, request: unknown, res: unknown) => Promise<void>
}

interface Written {
  status: number
  body: unknown
}

function fakeRoutes(options: { rejection?: { status: number; error: string }; body?: unknown } = {}) {
  const routes: FakeRoute[] = []
  const written: Written[] = []
  const calls: string[] = []
  const deps = fakeDeps({
    install: async (version: string) => {
      calls.push(version)
      return { version, dir: `C:/h/runtime/${version}`, cliPath: `C:/h/runtime/${version}/cli.js` }
    },
  })
  const disposers = registerControlRoutes({
    web: {
      register: route => {
        routes.push(route as FakeRoute)
        return [() => {}]
      },
    },
    api: createControlApi(deps),
    admitRoute: () => options.rejection,
    writeJson: (res, status, body) => {
      written.push({ status, body })
      void res
    },
    readJsonBody: async () => options.body,
  })
  return { routes, written, calls, disposers }
}

test('非授权来源的动作请求被拒且不调 install', async () => {
  const { routes, written, calls } = fakeRoutes({
    rejection: { status: 403, error: 'forbidden' },
    body: { action: 'install', version: '0.4.0' },
  })
  await routes[1]!.handler({}, {}, {})
  assert.equal(written[0]?.status, 403)
  assert.match(JSON.stringify(written[0]?.body), /forbidden/)
  assert.deepEqual(calls, [])
})

test('授权来源的 POST 走通并写 JSON', async () => {
  const { routes, written } = fakeRoutes({ body: { action: 'check' } })
  await routes[1]!.handler({}, {}, {})
  assert.equal(written[0]?.status, 200)
  assert.equal((written[0]?.body as { ok: boolean }).ok, true)
})

test('GET status 在授权下返回快照', async () => {
  const { routes, written } = fakeRoutes()
  const disposers = routes.map(route => route.path)
  assert.deepEqual(disposers, ['/api/betteroffice/status', '/api/betteroffice/action'])
  await routes[0]!.handler({}, {}, {})
  assert.equal(written[0]?.status, 200)
  assert.ok((written[0]?.body as { runtime: unknown }).runtime !== undefined)
})

test('请求体不是合法 JSON 时返回 400', async () => {
  const { routes, written } = fakeRoutes({ body: undefined })
  await routes[1]!.handler({}, {}, {})
  assert.equal(written[0]?.status, 400)
  assert.match(JSON.stringify(written[0]?.body), /合法 JSON/)
})

test('registry 不可用返回 500 与中文原因', async () => {
  const api = createControlApi(
    fakeDeps({
      latestVersion: async () => {
        throw new DomainError('registry-unreachable', '拿不到最新版本：网络或代理问题')
      },
    }),
  )
  const r = await api.action({ action: 'check' })
  assert.equal(r.status, 500)
  assert.match(JSON.stringify(r.body), /网络或代理/)
})
