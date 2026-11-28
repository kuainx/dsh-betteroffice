/** DESIGN §3 的 root 决策矩阵：谁能看到哪个目录，由这里唯一决定。 */

import { DomainError } from './errors.js'
import type { ConfigData } from './config.js'
import type { ResolvedDoc } from './paths.js'

export type RootKind = 'parent' | 'temp' | 'workspace'

export type RootPlan = {
  root: string
  readOnly: boolean
  args: string[]
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

/** 编辑时要不要工作文件夹：tasks 与 planRoot 共用这一处判定，别再各写一遍。 */
export function needsWorkspace(config: ConfigData, workspaceRequested: boolean | undefined): boolean {
  return config.workspaceMode === 'always' || (config.workspaceMode === 'auto' && workspaceRequested === true)
}

export function planRoot(input: PlanRootInput): RootPlan {
  const { doc, mode, config, tempDir, workspaceDir, workspaceRequested } = input

  if (mode === 'read') {
    return {
      root: doc.dir,
      readOnly: true,
      args: ['--root', doc.dir, '--read-only'],
      rootKind: 'parent',
    }
  }

  if (needsWorkspace(config, workspaceRequested)) {
    if (workspaceDir === null) {
      throw new DomainError('workspace-missing', '需要工作文件夹但没有创建：请先准备同名工作文件夹再编辑')
    }
    return {
      root: workspaceDir,
      readOnly: false,
      args: ['--root', workspaceDir],
      rootKind: 'workspace',
    }
  }

  return { root: tempDir, readOnly: false, args: ['--root', tempDir], rootKind: 'temp' }
}
