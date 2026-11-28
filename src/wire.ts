import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { spawnPortable } from '@hyzyn/dsh-kit'
import type { CommandDeps, CommandResult } from './commands.js'
import type { ConfigData } from './config.js'
import { createInstaller, type Installer, type RunResult } from './installer.js'
import { listInstalledRuntimes } from './npm-runtime.js'
import { fetchLatestVersion } from './registry.js'

export interface WireOptions {
  home: string
  getConfig(): ConfigData
  saveRuntimeVersion(version: string): Promise<void> | void
  logger?(message: string, error?: unknown): void
  /** 一次装配里共享的安装器；GUI 路由与 `/betteroffice` 命令必须共用同一张去重表。 */
  installer?: Installer
  /** 当前生效的源：默认档要问 npm，所以是异步的。 */
  getRegistry?(): Promise<string>
}

/** 外部命令的兜底时限：npm 卡在代理认证或 registry 无响应时，不能让 Promise 永远悬着。 */
const DEFAULT_SPAWN_TIMEOUT_MS = 120_000

/** 到点杀掉子进程；返回清理函数，正常结束时调用方要清掉定时器。 */
function armTimeout(child: { kill(): unknown }, timeoutMs: number, onTimeout: () => void): () => void {
  const timer = setTimeout(() => {
    child.kill()
    onTimeout()
  }, timeoutMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

function timeoutNote(timeoutMs: number, hint: string): string {
  return `\n（超时：${Math.round(timeoutMs / 1000)} 秒内没有结束，已终止。${hint}）`
}

/** 用 `npm` 装包：stdio 收进内存，退出码决定成败。 */
export function runNpm(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
  return new Promise<RunResult>(resolve => {
    const child = spawnPortable(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    const stop = armTimeout(child, timeoutMs, () => {
      resolve({ code: -1, stderr: `${stderr}${timeoutNote(timeoutMs, '检查网络、代理或 npm 登录状态')}` })
    })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      stop()
      resolve({ code: -1, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', code => {
      stop()
      resolve({ code: code ?? -1, stderr })
    })
  })
}

/** 用 `powershell.exe` 跑一次性脚本：回收站适配器要读 stdout 里的 JSON。 */
export function runPowershell(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs?: number },
): Promise<{ code: number; stderr: string; stdout: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
  return new Promise(resolve => {
    const child = spawnPortable(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    })
    let stdout = ''
    let stderr = ''
    const stop = armTimeout(child, timeoutMs, () => {
      resolve({ code: -1, stderr: `${stderr}${timeoutNote(timeoutMs, '回收站调用没响应')}`, stdout })
    })
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      stop()
      resolve({ code: -1, stderr: `${stderr}\n${error.message}`, stdout })
    })
    child.on('close', code => {
      stop()
      resolve({ code: code ?? -1, stderr, stdout })
    })
  })
}

/** 读 npm 自己配置的源（`npm config get registry`）；读不到返回空串。 */
export function readNpmRegistry(cwd: string, timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS): Promise<string> {
  return new Promise<string>(resolve => {
    const child = spawnPortable('npm', ['config', 'get', 'registry'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    const stop = armTimeout(child, timeoutMs, () => resolve(''))
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.on('error', () => {
      stop()
      resolve('')
    })
    child.on('close', code => {
      stop()
      resolve(code === 0 ? stdout : '')
    })
  })
}

/** 按真实宿主能力造一个安装器：装进插件私有目录，走 npm。 */
export function createRuntimeInstaller(options: Pick<WireOptions, 'home' | 'logger'>): Installer {
  return createInstaller({
    home: options.home,
    exists: existsSync,
    mkdir: async path => {
      await mkdir(path, { recursive: true })
    },
    run: runNpm,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}

/** 把真实宿主能力接成 `/betteroffice` 命令需要的依赖。 */
export function createCommandDeps(options: WireOptions): CommandDeps {
  const installer = options.installer ?? createRuntimeInstaller(options)
  return {
    home: options.home,
    nodeVersion: process.versions.node,
    exists: existsSync,
    currentConfig: () => options.getConfig(),
    setRuntimeVersion: version => options.saveRuntimeVersion(version),
    installer,
    latestVersion: async () =>
      await fetchLatestVersion(
        options.getRegistry === undefined ? {} : { registry: await options.getRegistry() },
      ),
    installedVersions: () => listInstalledRuntimes(options.home, { readdir: readdirSync, exists: existsSync }),
  }
}

export type { CommandResult }
