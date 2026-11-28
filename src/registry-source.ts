import { REGISTRY_PRESETS, isRegistryUrl } from './registry.js'

/**
 * 「默认」档不写死源，而是跟随 npm 自己的配置——内网、公司镜像、`.npmrc` 都能生效。
 * 读不到或读出来的不是合法地址时退回 npmjs，免得一个坏配置把插件卡死。
 */
export async function resolveRegistry(
  stored: string,
  readNpmConfig: () => Promise<string>,
): Promise<string> {
  if (stored !== '') return stored
  let fromNpm = ''
  try {
    fromNpm = (await readNpmConfig()).trim()
  } catch {
    fromNpm = ''
  }
  return isRegistryUrl(fromNpm) ? fromNpm : REGISTRY_PRESETS.npmjs
}