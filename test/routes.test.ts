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
    saveSettings: async () => {},
    storedRegistry: () => '',
    resolveRegistry: async () => 'https://registry.npmjs.org/',
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
  kind: string
  method: string
  path: string
  handler: (request: unknown, response: unknown) => Promise<void>
}

interface Written {
  status: number
  body: unknown
}

function fakeRoutes(
  options: {
    rejection?: { status: number; error: string }
    body?: unknown
    admitThrows?: boolean
  } = {},
) {
  const routes: FakeRoute[] = []
  const written: Written[] = []
  const calls: string[] = []
  let disposed = 0
  const deps = fakeDeps({
    install: async (version: string) => {
      calls.push(version)
      return { version, dir: `C:/h/runtime/${version}`, cliPath: `C:/h/runtime/${version}/cli.js` }
    },
  })
  const disposers = registerControlRoutes({
    ctx: {},
    web: {
      register: (route) => {
        routes.push(route as FakeRoute)
        // 宿主 register 返回单个注销函数（不是数组）：数组会让展开语法直接抛错、第二条路由挂不上。
        return () => {
          disposed += 1
        }
      },
    },
    api: createControlApi(deps),
    admitRoute: () => {
      if (options.admitThrows === true) throw new Error('围栏自己坏了')
      return options.rejection
    },
    writeJson: (res, status, body) => {
      written.push({ status, body })
      void res
    },
    readJsonBody: async () => options.body,
  })
  return { routes, written, calls, disposers, disposed: () => disposed }
}

/** 宿主以 (req, res) 两个参数调用 handler。 */
async function hit(route: FakeRoute, method = route.method): Promise<void> {
  await route.handler({ method }, {})
}

test('非授权来源的动作请求被拒且不调 install', async () => {
  const { routes, written, calls } = fakeRoutes({
    rejection: { status: 403, error: 'forbidden' },
    body: { action: 'install', version: '0.4.0' },
  })
  await hit(routes[1]!)
  assert.equal(written[0]?.status, 403)
  assert.match(JSON.stringify(written[0]?.body), /forbidden/)
  assert.deepEqual(calls, [])
})

test('授权来源的 POST 走通并写 JSON', async () => {
  const { routes, written } = fakeRoutes({ body: { action: 'check' } })
  await hit(routes[1]!)
  assert.equal(written[0]?.status, 200)
  assert.equal((written[0]?.body as { ok: boolean }).ok, true)
})

test('GET status 在授权下返回快照', async () => {
  const { routes, written } = fakeRoutes()
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]),
    [
      ['exact', '/api/betteroffice/status'],
      ['exact', '/api/betteroffice/action'],
    ],
  )
  await hit(routes[0]!)
  assert.equal(written[0]?.status, 200)
  assert.ok((written[0]?.body as { runtime: unknown }).runtime !== undefined)
})

test('请求体不是合法 JSON 时返回 400', async () => {
  const { routes, written } = fakeRoutes({ body: undefined })
  await hit(routes[1]!)
  assert.equal(written[0]?.status, 400)
  assert.match(JSON.stringify(written[0]?.body), /合法 JSON/)
})

test('每条路由各返回一个注销函数，调用后两条都能摘掉', () => {
  const { disposers, disposed } = fakeRoutes()
  assert.equal(disposers.length, 2)
  for (const dispose of disposers) {
    assert.equal(typeof dispose, 'function')
    dispose()
  }
  assert.equal(disposed(), 2)
})

test('方法不对返回 405，不执行动作', async () => {
  const { routes, written, calls } = fakeRoutes({ body: { action: 'install', version: '0.4.0' } })
  await hit(routes[1]!, 'GET')
  assert.equal(written[0]?.status, 405)
  assert.deepEqual(calls, [])
})

test('围栏抛错也回 JSON 500，而不是让宿主兜底成 400', async () => {
  const { routes, written } = fakeRoutes({ admitThrows: true })
  await hit(routes[0]!)
  assert.equal(written[0]?.status, 500)
  assert.equal((written[0]?.body as { ok: boolean }).ok, false)
})

test('回退到没装过的版本返回 400 且列出可选项', async () => {
  const api = createControlApi(fakeDeps({ installedVersions: () => ['0.3.0'] }))
  const r = await api.action({ action: 'rollback', version: '0.1.0' })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /0\.1\.0 没装过/u)
  assert.match(JSON.stringify(r.body), /已安装 0\.3\.0/u)
})

test('Node 版本不足时动作返回 400，不去跑 npm', async () => {
  const calls: string[] = []
  const api = createControlApi(
    fakeDeps({
      nodeVersion: '20.11.0',
      install: async (version: string) => {
        calls.push(version)
        return {
          version,
          dir: `C:/h/runtime/${version}`,
          cliPath: `C:/h/runtime/${version}/cli.js`,
        }
      },
    }),
  )
  const r = await api.action({ action: 'install', version: '0.4.0' })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /需要 ≥22\.12\.0/)
  assert.deepEqual(calls, [])
})

test('安装结束后同一版本可以再装，不再 409', async () => {
  let installing = true
  const api = createControlApi(fakeDeps({ inFlight: () => (installing ? ['0.4.0'] : []) }))
  assert.equal((await api.action({ action: 'install', version: '0.4.0' })).status, 409)
  // 那一次 npm 跑完了：inFlight 清空，同样的请求应该放行。
  installing = false
  assert.equal((await api.action({ action: 'install', version: '0.4.0' })).status, 200)
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

test('settings 动作把两个开关与运行时源原样交给保存', async () => {
  const saved: { workspaceMode: string; cleanupMode: string; registry: string }[] = []
  const api = createControlApi(
    fakeDeps({
      saveSettings: async (patch) => {
        saved.push(patch)
      },
    }),
  )
  const r = await api.action({
    action: 'settings',
    workspaceMode: 'always',
    cleanupMode: 'on',
    registry: 'https://registry.npmmirror.com/',
  })
  assert.equal(r.status, 200)
  assert.deepEqual(saved, [{ workspaceMode: 'always', cleanupMode: 'on', registry: 'https://registry.npmmirror.com/' }])
  assert.match(JSON.stringify(r.body), /运行时源 https:\/\/registry\.npmmirror\.com\//)
})

test('来源不是完整地址时 400，不落盘', async () => {
  const saved: unknown[] = []
  const api = createControlApi(
    fakeDeps({
      saveSettings: async (patch) => {
        saved.push(patch)
      },
    }),
  )
  const r = await api.action({
    action: 'settings',
    workspaceMode: 'auto',
    cleanupMode: 'auto',
    registry: 'ftp://x',
  })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /运行时源地址不对/)
  assert.deepEqual(saved, [])
})

test('检查更新与安装都用选中的源', async () => {
  const asked: string[] = []
  const installed: string[] = []
  const api = createControlApi(
    fakeDeps({
      resolveRegistry: async () => 'https://registry.npmmirror.com/',
      latestVersion: async (registry: string) => {
        asked.push(registry)
        return '0.4.0'
      },
      install: async (version: string, registry?: string) => {
        installed.push(`${version}@${registry ?? ''}`)
        return {
          version,
          dir: `C:/h/runtime/${version}`,
          cliPath: `C:/h/runtime/${version}/cli.js`,
        }
      },
    }),
  )
  assert.equal((await api.action({ action: 'check' })).status, 200)
  assert.equal((await api.action({ action: 'install' })).status, 200)
  assert.deepEqual(asked, ['https://registry.npmmirror.com/', 'https://registry.npmmirror.com/'])
  assert.deepEqual(installed, ['0.4.0@https://registry.npmmirror.com/'])
})

test('保存设置失败时回 500 并把原因带出来', async () => {
  const api = createControlApi(
    fakeDeps({
      saveSettings: async () => {
        throw new DomainError('settings-failed', '写不进去：磁盘只读')
      },
    }),
  )
  const r = await api.action({ action: 'settings', workspaceMode: 'always', cleanupMode: 'off' })
  assert.equal(r.status, 500)
  assert.match(JSON.stringify(r.body), /磁盘只读/)
})
