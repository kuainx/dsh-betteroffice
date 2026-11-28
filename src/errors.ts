/** 领域错误：带稳定 `code`，工具层据此生成中文可行动消息。 */
export class DomainError extends Error {
  readonly code: string
  /**
   * 明确的用户侧错误才标 400/409；不标的一律当系统错误回 500。
   * 这样新增错误码不会因为忘加白名单而悄悄变成 500。
   */
  readonly status: 400 | 409 | undefined

  constructor(code: string, message: string, options: { status?: 400 | 409 } = {}) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.status = options.status
  }
}

export class WorkspaceExistsError extends DomainError {
  constructor(dir: string) {
    super('workspace-exists', `工作文件夹已存在，不会接管：${dir}`)
    this.name = 'WorkspaceExistsError'
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
