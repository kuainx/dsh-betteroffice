/** 领域错误：带稳定 `code`，工具层据此生成中文可行动消息。 */
export class DomainError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

export class WorkspaceExistsError extends DomainError {
  constructor(dir: string) {
    super('workspace-exists', `工作文件夹已存在，不会接管：${dir}`)
    this.name = 'WorkspaceExistsError'
  }
}

export class McpUnavailableError extends DomainError {
  constructor() {
    super('mcp-unavailable', '宿主没有提供 @deepseek-ai/dsh-mcp-client，无法挂载 BetterOffice MCP')
    this.name = 'McpUnavailableError'
  }
}

export class McpStartFailedError extends DomainError {
  constructor(serverName: string, cause: unknown) {
    super('mcp-start-failed', `BetterOffice MCP 启动失败（${serverName}）：${describe(cause)}`)
    this.name = 'McpStartFailedError'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
