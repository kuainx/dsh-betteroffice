import z from '@deepseek-ai/schemastery'

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
    .description('要使用的 betteroffice-mcp 私有版本（留空使用默认版本）')
    .volatile(),
})

export type ConfigData = {
  workspaceMode: 'auto' | 'never' | 'always'
  cleanupMode: 'off' | 'auto' | 'on'
  nodePath: string
  runtimeVersion: string
}
