import { join } from 'node:path'
import { CLEANUP_MODES, WORKSPACE_MODES } from './config.js'
import { isVersion } from './npm-runtime.js'
import { isRegistryUrl } from './registry.js'

/**
 * 插件自己的设置记录。宿主的 settings 服务在部分版本上拿不到（`settingsEntryScope` 返回
 * undefined），那时「装完刷新就忘」——所以真正落盘的是这份文件，宿主设置只当顺带同步。
 *
 * 卡片上的两个开关（工作文件夹、清理模式）与运行时来源也走这里：宿主详情页那一格是插件
 * 自己注册的组件，没有「按 Config 自动生成表单」这回事，不自己存就永远取默认值。
 */
export type StoredSettings = {
  runtimeVersion: string
  workspaceMode: string
  cleanupMode: string
  /** 空串 = 默认档，跟随 npm 自己的配置。 */
  registry: string
}

const EMPTY: StoredSettings = {
  runtimeVersion: '',
  workspaceMode: '',
  cleanupMode: '',
  registry: '',
}

export function storePath(home: string): string {
  return join(home, 'betteroffice', 'settings.json')
}

type ReadDeps = {
  exists(path: string): boolean
  read(path: string): string
}

type WriteDeps = ReadDeps & {
  mkdir(path: string): void
  write(path: string, text: string): void
}

function pick<T extends string>(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? (value as T) : ''
}

/** 读不到、读坏了、值不在允许集合里，一律当「还没设置」，不抛错。 */
export function readStored(home: string, deps: ReadDeps): StoredSettings {
  const path = storePath(home)
  if (!deps.exists(path)) return EMPTY
  try {
    const raw = JSON.parse(deps.read(path)) as Record<string, unknown>
    const version =
      typeof raw['runtimeVersion'] === 'string' && isVersion(raw['runtimeVersion']) ? raw['runtimeVersion'] : ''
    return {
      runtimeVersion: version,
      workspaceMode: pick(raw['workspaceMode'], WORKSPACE_MODES),
      cleanupMode: pick(raw['cleanupMode'], CLEANUP_MODES),
      registry:
        typeof raw['registry'] === 'string' && (raw['registry'] === '' || isRegistryUrl(raw['registry']))
          ? raw['registry']
          : '',
    }
  } catch {
    return EMPTY
  }
}

/** 只写传进来的字段，其余保留：装版本与改开关互不覆盖。 */
export function writeStored(home: string, patch: Partial<StoredSettings>, deps: WriteDeps): void {
  const dir = join(home, 'betteroffice')
  const merged = { ...readStored(home, deps), ...patch }
  const text = {
    ...(merged.runtimeVersion === '' ? {} : { runtimeVersion: merged.runtimeVersion }),
    ...(merged.workspaceMode === '' ? {} : { workspaceMode: merged.workspaceMode }),
    ...(merged.cleanupMode === '' ? {} : { cleanupMode: merged.cleanupMode }),
    ...(merged.registry === '' ? {} : { registry: merged.registry }),
  }
  deps.mkdir(dir)
  deps.write(storePath(home), `${JSON.stringify(text, null, 2)}\n`)
}
