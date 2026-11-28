import { join } from 'node:path'
import { cliPathFor, compareVersions } from './runtime.js'

/** 插件私有运行时根目录（相对 DSH 主目录）。 */
export const RUNTIME_ROOT = join('betteroffice', 'runtime')

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 是否是形如 0.4.0 / 0.4.0-rc.1 的版本号（同时挡住 ../ 之类的路径注入）。 */
export function isVersion(value: string): boolean {
  return VERSION_PATTERN.test(value)
}

/** 某一版本运行时的安装目录。 */
export function runtimeDirFor(home: string, version: string): string {
  return join(home, RUNTIME_ROOT, version)
}

/** `@betteroffice/agents` 包目录（读 package.json 用）。 */
export function agentPackageDirFor(home: string, version: string): string {
  return join(runtimeDirFor(home, version), 'node_modules', '@betteroffice', 'agents')
}

/** 检测时用到的文件系统能力，便于测试替换。 */
export interface RuntimeScanDeps {
  readdir(path: string): readonly string[]
  exists(path: string): boolean
}

/** 列出真的装好了 CLI 的版本，升序；根目录不存在时返回空列表。 */
export function listInstalledRuntimes(home: string, deps: RuntimeScanDeps): string[] {
  let names: readonly string[]
  try {
    names = deps.readdir(join(home, RUNTIME_ROOT))
  } catch {
    return []
  }
  return names
    .filter((name) => VERSION_PATTERN.test(name))
    .filter((name) => deps.exists(cliPathFor(home, name)))
    .sort(compareVersions)
}

/** `npm install` 的参数：装进私有目录，cache 也私有，不动全局。 */
export function npmInstallArgs(opts: {
  prefix: string
  version: string
  cacheDir: string
  registry?: string
}): string[] {
  const args = [
    'install',
    `@betteroffice/agents@${opts.version}`,
    '--prefix',
    opts.prefix,
    '--no-fund',
    '--no-audit',
    '--cache',
    opts.cacheDir,
  ]
  if (opts.registry !== undefined && opts.registry !== '') {
    args.push('--registry', opts.registry)
  }
  return args
}
