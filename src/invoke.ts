/** 读 MCP 工具返回的内容。MCP 子进程由插件自己拉起（见 mcp.ts），这里只管把结果解成对象。 */

/** MCP 工具结果是 `{content:[{type:'text',text:'<json>'}]}` 或结构化内容，统一取成对象。 */
export function readToolJson(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return undefined
  const structured = (result as { structuredContent?: unknown }).structuredContent
  if (structured !== undefined) return structured
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((item) => {
      if (typeof item !== 'object' || item === null) return ''
      const block = item as { type?: unknown; text?: unknown }
      return block.type === 'text' ? String(block.text ?? '') : ''
    })
    .join('')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
