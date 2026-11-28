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
}

/** 用 `npm` 装包：stdio 收进内存，退出码决定成败。 */
export function runNpm(command: string, args: string[], options: { cwd: string }): Promise<RunResult> {
  return new Promise<RunResult>(resolve => {
    const child = spawnPortable(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      resolve({ code: -1, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', code => {
      resolve({ code: code ?? -1, stderr })
    })
  })
}

/** 用 `powershell.exe` 跑一次性脚本：回收站适配器要读 stdout 里的 JSON。 */
export function runPowershell(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string> },
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise(resolve => {
    const child = spawnPortable(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      resolve({ code: -1, stderr: `${stderr}\n${error.message}`, stdout })
    })
    child.on('close', code => {
      resolve({ code: code ?? -1, stderr, stdout })
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
    latestVersion: async () => await fetchLatestVersion(),
    installedVersions: () => listInstalledRuntimes(options.home, { readdir: readdirSync, exists: existsSync }),
  }
}

export type { CommandResult }
