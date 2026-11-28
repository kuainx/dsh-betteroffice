import { DomainError } from './errors.js'

const PACKAGE = '@betteroffice/agents'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 内置的两个源；「默认」不在这里，它表示跟随 npm 自己的配置。 */
export const REGISTRY_PRESETS = {
  npmjs: 'https://registry.npmjs.org/',
  npmmirror: 'https://registry.npmmirror.com/',
} as const

/** 把源拼成包地址，容忍结尾多写的斜杠。 */
export function packageUrl(registry: string): string {
  return `${registry.trim().replace(/\/+$/, '')}/${PACKAGE}`
}

/** 只收 http(s) 的完整地址：其余（file:、ftp:、协议相对地址、裸域名）一律不认。 */
export function isRegistryUrl(value: string): boolean {
  const text = value.trim()
  if (!/^https?:\/\//i.test(text)) return false
  try {
    const url = new URL(text)
    return url.hostname !== '' && (url.protocol === 'http:' || url.protocol === 'https:')
  } catch {
    return false
  }
}

/** 只用到 fetch 的这一小块，测试可替换。 */
export interface RegistryFetch {
  (
    url: string,
    init?: { headers?: Record<string, string> },
  ): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
  }>
}

export interface FetchLatestOptions {
  /** 选中的源；不传就用 npmjs。 */
  registry?: string
  fetch?: RegistryFetch
  timeoutMs?: number
}

/** 查 npm 上的最新版本号；失败抛中文 DomainError。 */
export async function fetchLatestVersion(options: FetchLatestOptions = {}): Promise<string> {
  const doFetch: RegistryFetch = options.fetch ?? (globalThis.fetch as unknown as RegistryFetch)
  if (typeof doFetch !== 'function') {
    throw new DomainError('registry-unreachable', '当前环境没有 fetch，无法检查更新。')
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 10_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Awaited<ReturnType<RegistryFetch>>
  try {
    response = await doFetch(packageUrl(options.registry ?? REGISTRY_PRESETS.npmjs), {
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
