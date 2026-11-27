import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { spawnPortable } from '@hyzyn/dsh-kit'
import type { CommandDeps, CommandResult } from './commands.js'
import type { ConfigData } from './config.js'
import { createInstaller, type RunResult } from './installer.js'
import { listInstalledRuntimes } from './npm-runtime.js'
import { fetchLatestVersion } from './registry.js'

export interface WireOptions {
  home: string
  getConfig(): ConfigData
  saveRuntimeVersion(version: string): Promise<void> | void
  logger?(message: string, error?: unknown): void
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

/** 把真实宿主能力接成 `/betteroffice` 命令需要的依赖。 */
export function createCommandDeps(options: WireOptions): CommandDeps {
  const installer = createInstaller({
    home: options.home,
    exists: existsSync,
    mkdir: async path => {
      await mkdir(path, { recursive: true })
    },
    run: runNpm,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
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
