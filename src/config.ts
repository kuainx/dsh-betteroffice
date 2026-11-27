import z from '@deepseek-ai/schemastery'
import { plainConfig } from '@hyzyn/dsh-kit'

/**
 * 插件配置。字段全部 volatile：DSH 的设置机制只允许更新 volatile 字段，
 * 改动会写进 profile 的用户层，不需要插件自己去改用户的配置文件。
 */
export const Config = z.object({
  workspaceMode: z
    .union([z.const('auto'), z.const('never'), z.const('always')])
    .default('auto')
    .description('是否使用工作文件夹：自动（由 agent 决定）/ 不使用 / 强制使用')
    .volatile(),
  cleanupMode: z
    .union([z.const('off'), z.const('auto'), z.const('on')])
    .default('auto')
    .description('工作完成后删除工作文件夹：禁用 / 自动 / 开启')
    .volatile(),
  nodePath: z
    .string()
    .default('')
    .description('Node.js 可执行文件路径（留空自动检测，需要 22.12.0 及以上）')
    .volatile(),
  runtimeVersion: z
    .string()
    .default('')
    .description('要使用的 betteroffice-mcp 私有版本（由 /betteroffice 安装、更新、回退写入；留空表示尚未安装）')
    .volatile(),
})

export type ConfigData = {
  workspaceMode: 'auto' | 'never' | 'always'
  cleanupMode: 'off' | 'auto' | 'on'
  nodePath: string
  runtimeVersion: string
}

/**
 * 把宿主给的（可能是 volatile 引用的）配置解析成普通对象：补齐默认值、校验枚举。
 * 宿主传入非法值时给出中文报错而不是让 schemastery 的栈冒到用户面前。
 */
export function resolveConfig(raw: unknown): ConfigData {
  let parsed: unknown
  try {
    // volatile 字段解析成 { get() } 引用，必须再拆一层才是普通值。
    parsed = plainConfig(Config(raw as never) as unknown)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new TypeError(`betteroffice 配置无效：${detail}`)
  }
  const value = parsed as Partial<ConfigData>
  return {
    workspaceMode: value.workspaceMode ?? 'auto',
    cleanupMode: value.cleanupMode ?? 'auto',
    nodePath: value.nodePath ?? '',
    runtimeVersion: value.runtimeVersion ?? '',
  }
}
