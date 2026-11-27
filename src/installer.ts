import { join } from 'node:path'
import { DomainError } from './errors.js'
import { cliPathFor } from './runtime.js'
import { isVersion, npmInstallArgs, runtimeDirFor } from './npm-runtime.js'

/** 安装结果。 */
export interface InstallResult {
  version: string
  dir: string
  cliPath: string
}

/** 跑一条外部命令的结果；实现方负责收集 stderr 尾部。 */
export interface RunResult {
  code: number | null
  stderr: string
}

export interface InstallerDeps {
  home: string
  run(command: string, args: string[], options: { cwd: string }): Promise<RunResult>
  exists(path: string): boolean
  mkdir(path: string): Promise<void>
  logger?(message: string): void
}

export interface Installer {
  install(version: string): Promise<InstallResult>
}

const STDERR_TAIL = 20

function tail(text: string, lines = STDERR_TAIL): string {
  const kept = text.trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  return kept === '' ? '（没有输出）' : kept
}

/** 把某一版本的 `@betteroffice/agents` 装进插件私有目录；幂等、并发安全。 */
export function createInstaller(deps: InstallerDeps): Installer {
  const inFlight = new Map<string, Promise<InstallResult>>()

  async function run(version: string): Promise<InstallResult> {
    const dir = runtimeDirFor(deps.home, version)
    const cliPath = cliPathFor(deps.home, version)
    if (deps.exists(cliPath)) {
      deps.logger?.(`betteroffice: ${version} 已经装好了，直接用。`)
      return { version, dir, cliPath }
    }

    await deps.mkdir(dir)
    const result = await deps.run('npm', npmInstallArgs({ prefix: dir, version, cacheDir: join(dir, '.npm-cache') }), {
      cwd: dir,
    })
    if (result.code !== 0) {
      throw new DomainError(
        'install-failed',
        `安装 @betteroffice/agents@${version} 失败（退出码 ${String(result.code)}）：\n${tail(result.stderr)}`,
      )
    }
    if (!deps.exists(cliPath)) {
      throw new DomainError(
        'install-failed',
        `npm 报告成功，但没找到 betteroffice-mcp 入口：${cliPath}。请确认网络与 npm registry 可用后重试。`,
      )
    }
    deps.logger?.(`betteroffice: 已安装 ${version} 到 ${dir}`)
    return { version, dir, cliPath }
  }

  return {
    install(version: string): Promise<InstallResult> {
      if (!isVersion(version)) {
        return Promise.reject(
          new DomainError('invalid-version', `版本号看起来不对：${JSON.stringify(version)}。请用形如 0.4.0 的版本号。`),
        )
      }
      const running = inFlight.get(version)
      if (running !== undefined) return running
      const task = run(version).finally(() => inFlight.delete(version))
      inFlight.set(version, task)
      return task
    },
  }
}
