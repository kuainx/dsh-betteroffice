/** DESIGN §3 的 root 决策矩阵：谁能看到哪个目录，由这里唯一决定。 */

import { DomainError } from './errors.js'
import type { ConfigData } from './config.js'
import type { ResolvedDoc } from './paths.js'

/** 只读模式必须排除的工具：它们能枚举整棵 root。 */
export const READONLY_EXCLUDED_TOOLS: string[] = ['office_files']

export type RootKind = 'parent' | 'temp' | 'workspace'

export type RootPlan = {
  root: string
  readOnly: boolean
  args: string[]
  allowedTools?: string[]
  rootKind: RootKind
}

export type PlanRootInput = {
  doc: ResolvedDoc
  mode: 'read' | 'edit'
  config: ConfigData
  tempDir: string
  workspaceDir: string | null
  workspaceRequested?: boolean
}

export function planRoot(input: PlanRootInput): RootPlan {
  const { doc, mode, config, tempDir, workspaceDir, workspaceRequested } = input

  if (mode === 'read') {
    return {
      root: doc.dir,
      readOnly: true,
      args: ['--root', doc.dir, '--read-only'],
      allowedTools: READONLY_EXCLUDED_TOOLS.filter((t) => t !== 'office_files'),
      rootKind: 'parent',
    }
  }

  const wantsWorkspace =
    config.workspaceMode === 'always' || (config.workspaceMode === 'auto' && workspaceRequested === true)
  if (wantsWorkspace) {
    if (workspaceDir === null) {
      throw new DomainError('workspace-missing', '需要工作文件夹但没有创建：请先准备同名工作文件夹再编辑')
    }
    return { root: workspaceDir, readOnly: false, args: ['--root', workspaceDir], rootKind: 'workspace' }
  }

  return { root: tempDir, readOnly: false, args: ['--root', tempDir], rootKind: 'temp' }
}
