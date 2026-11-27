import { DomainError } from './errors.js'

const PACKAGE = '@betteroffice/agents'
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE).replace('%40', '@')}`

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 只用到 fetch 的这一小块，测试可替换。 */
export interface RegistryFetch {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
  }>
}

export interface FetchLatestOptions {
  fetch?: RegistryFetch
  timeoutMs?: number
}

/** 查 npm 上的最新版本号；失败抛中文 DomainError。 */
export async function fetchLatestVersion(options: FetchLatestOptions = {}): Promise<string> {
  const doFetch: RegistryFetch =
    options.fetch ?? (globalThis.fetch as unknown as RegistryFetch)
  if (typeof doFetch !== 'function') {
    throw new DomainError('registry-unreachable', '当前环境没有 fetch，无法检查更新。')
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 10_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Awaited<ReturnType<RegistryFetch>>
  try {
    response = await doFetch(REGISTRY_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    })
  } catch (error) {
    throw new DomainError(
      'registry-unreachable',
      `连不上 npm registry（网络或代理问题）：${(error as Error).message}。可以稍后再试，或手动指定要装的版本。`,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new DomainError('registry-bad-response', `npm registry 返回 HTTP ${response.status}，无法判断最新版本。`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new DomainError('registry-bad-response', `npm registry 的响应不是合法 JSON：${(error as Error).message}`)
  }

  const latest = (body as { 'dist-tags'?: { latest?: unknown } } | undefined)?.['dist-tags']?.latest
  if (typeof latest !== 'string' || !SEMVER.test(latest)) {
    throw new DomainError('registry-bad-response', 'npm registry 的响应里没有可用的版本号。')
  }
  return latest
}
