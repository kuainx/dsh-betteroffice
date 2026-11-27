/** 调用宿主已注册的工具（MCP 工具就是宿主注册进来的），用于检查点与交付这类插件自己发起的操作。 */

import { DomainError } from './errors.js'

export type ToolDefinitionLike = { execute(args: unknown, exec: unknown): Promise<unknown> }

export type ToolView = { view(scope: unknown): ReadonlyMap<string, ToolDefinitionLike> }

export type InvokeOptions = { signal?: AbortSignal }

export type ToolInvoker = {
  invoke(name: string, args: unknown, options?: InvokeOptions): Promise<unknown>
}

export function createToolInvoker(tools: ToolView, scope: unknown): ToolInvoker {
  return {
    async invoke(name, args, options = {}) {
      const definition = tools.view(scope)?.get(name)
      if (definition === undefined) {
        throw new DomainError(
          'tool-not-found',
          `找不到工具 ${name}：该文档的 MCP 可能已断开，请用 betteroffice_list 确认任务状态，必要时重新打开文档。`,
        )
      }
      // shortcut: dsh-mcp-client 的工具实现只读 execution.signal（其 tools.ts:196），
      // 其它字段由宿主执行器填充。宿主若收紧这个契约，这里要改成经 tools 服务正式派发。
      return await definition.execute(args, { signal: options.signal ?? new AbortController().signal })
    },
  }
}

export type WaitOptions = { timeoutMs?: number; intervalMs?: number }

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

/**
 * 等 MCP 把工具注册上来。挂载返回不代表子进程已经握手完成，
 * 所以按工具出现与否判断就绪，而不是赌 fiber 的内部状态。
 */
export async function waitForTool(
  tools: ToolView,
  scope: unknown,
  name: string,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 50
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (tools.view(scope)?.get(name) !== undefined) return
    if (Date.now() >= deadline) {
      throw new DomainError(
        'tool-timeout',
        `等待 ${name} 注册超时（${timeoutMs}ms）：MCP 可能启动失败或已断开，请用 betteroffice_list 确认任务状态后重试。`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
