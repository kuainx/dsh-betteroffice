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
