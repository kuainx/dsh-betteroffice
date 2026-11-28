/**
 * agent 直接调 MCP 工具的拦截规则。
 *
 * BetterOffice MCP 把写盘、列目录都暴露成工具，但插件对「写到哪、能看见哪些文件」有自己的判定，
 * 所以这几条必须只走插件的工具（交付、替换），不让 agent 绕过去。
 *
 * 不按工具名整表拉黑：同一个 MCP 还有 xlsx_* 之类的家族工具，硬编码清单既挡不全也误伤。
 * 显式列出已知的两条，再按命名规则挡住同类（office_export_pdf 这种）。
 */

/** 本插件挂载的 MCP 工具名：`mcp__bo_<8位任务id>__<工具名>`。 */
const MANAGED_TOOL = /^mcp__bo_[0-9a-f]{8}__(.+)$/

export type GuardDecision = { kind: 'deny'; reason: string }

const DENIED: Record<string, string> = {
  office_export:
    '不要直接调用 MCP 的导出工具：写文件请用 betteroffice_deliver（另存）或 betteroffice_replace（用户确认后替换原件）。',
  office_files: '不要用 MCP 的列目录工具：用 betteroffice_open 打开文档，然后按任务 id 继续。',
}

/** 工具名是 `<家族>_<动作>`：带 export / files 段的都是能绕开插件写盘或枚举目录的。 */
const DENIED_NAME = /(^|_)(export|files)(_|$)/

/** 按裸 MCP 工具名查禁规则：透传工具和宿主侧守卫共用同一张表。 */
export function deniedReason(toolName: string): string | undefined {
  const explicit = DENIED[toolName]
  if (explicit !== undefined) return explicit
  if (!DENIED_NAME.test(toolName)) return undefined
  return `不要直接调用 MCP 的 ${toolName}：写文件请用 betteroffice_deliver（另存）或 betteroffice_replace（用户确认后替换原件）。`
}

export function decideMcpCall(toolName: string): GuardDecision | undefined {
  const match = MANAGED_TOOL.exec(toolName)
  if (match === null) return undefined
  const reason = deniedReason(match[1] ?? '')
  return reason === undefined ? undefined : { kind: 'deny', reason }
}
