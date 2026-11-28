import { join } from 'node:path'
import { isVersion } from './npm-runtime.js'

/**
 * 插件自己的版本记录。宿主的 settings 服务在部分版本上拿不到（`settingsEntryScope` 返回
 * undefined），那时「装完刷新就忘」——所以真正落盘的是这份文件，宿主设置只当顺带同步。
 */
export function storePath(home: string): string {
  return join(home, 'betteroffice', 'settings.json')
}

type ReadDeps = {
  exists(path: string): boolean
  read(path: string): string
}

type WriteDeps = {
  mkdir(path: string): void
  write(path: string, text: string): void
}

/** 读不到、读坏了、内容不是版本号，一律当「还没设置」，不抛错。 */
export function readStoredVersion(home: string, deps: ReadDeps): string {
  const path = storePath(home)
  if (!deps.exists(path)) return ''
  try {
    const value = (JSON.parse(deps.read(path)) as { runtimeVersion?: unknown }).runtimeVersion
    return typeof value === 'string' && isVersion(value) ? value : ''
  } catch {
    return ''
  }
}

export function writeStoredVersion(home: string, version: string, deps: WriteDeps): void {
  deps.mkdir(join(home, 'betteroffice'))
  deps.write(storePath(home), `${JSON.stringify({ runtimeVersion: version }, null, 2)}\n`)
}
