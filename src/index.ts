import type { Context } from '@deepseek-ai/cordis'
import { plainConfig } from '@hyzyn/dsh-kit'
import { Config, type ConfigData } from './config.js'

export const name = 'betteroffice'

/**
 * 顶层不注入任何服务：宿主没有 agents/tools 服务时插件仍要能加载，
 * 需要服务的装配放在 ctx.inject(...) 里做。
 */
export const inject: string[] = []

export { Config }
export type { ConfigData }

export function apply(ctx: Context, config?: ConfigData): void {
  const resolved = plainConfig(config as ConfigData)
  void resolved
  void ctx
}
