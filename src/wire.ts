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

type CaptureOptions = {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** 超时时追加到 stderr 的提示，告诉用户该查什么。 */
  hint: string
}

type CaptureResult = { code: number; stdout: string; stderr: string }

/** 收完 stdout/stderr、到点杀掉子进程：三个外部调用共用这一份。 */
function capture(command: string, args: readonly string[], options: CaptureOptions): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
  return new Promise<CaptureResult>((resolve) => {
    const child = spawnPortable(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    timer = setTimeout(() => {
      child.kill()
      stderr += `\n（超时：${Math.round(timeoutMs / 1000)} 秒内没有结束，已终止。${options.hint}）`
      finish(-1)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

/** 用 `npm` 装包：stdio 收进内存，退出码决定成败。 */
export async function runNpm(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<RunResult> {
  const { code, stderr } = await capture(command, args, {
    cwd: options.cwd,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    hint: '检查网络、代理或 npm 登录状态',
  })
  return { code, stderr }
}

/** 用 `powershell.exe` 跑一次性脚本：回收站适配器要读 stdout 里的 JSON。 */
export async function runPowershell(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs?: number },
): Promise<{ code: number; stderr: string; stdout: string }> {
  return await capture(command, args, {
    env: options.env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    hint: '回收站调用没响应',
  })
}

/** 读 npm 自己配置的源（`npm config get registry`）；读不到返回空串。 */
export async function readNpmRegistry(cwd: string, timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS): Promise<string> {
  const { code, stdout } = await capture('npm', ['config', 'get', 'registry'], {
    cwd,
    timeoutMs,
    hint: '检查 npm 是否可用',
  })
  return code === 0 ? stdout : ''
}

/** 按真实宿主能力造一个安装器：装进插件私有目录，走 npm。 */
export function createRuntimeInstaller(options: Pick<WireOptions, 'home' | 'logger'>): Installer {
  return createInstaller({
    home: options.home,
    exists: existsSync,
    mkdir: async (path) => {
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
    setRuntimeVersion: (version) => options.saveRuntimeVersion(version),
    installer,
    latestVersion: async () =>
      await fetchLatestVersion(options.getRegistry === undefined ? {} : { registry: await options.getRegistry() }),
    installedVersions: () => listInstalledRuntimes(options.home, { readdir: readdirSync, exists: existsSync }),
  }
}

export type { CommandResult }
