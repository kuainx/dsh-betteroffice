import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanupDecision, cleanupWorkspace } from '../src/cleanup.js'
import type { TaskLedger } from '../src/workspace.js'

function ledger(extra: Partial<TaskLedger> = {}): TaskLedger {
  return {
    taskId: 'a71c2e90',
    sessionId: 's1',
    sourcePath: 'C:/docs/年度报告.docx',
    sourceHash: 'h',
    mode: 'edit',
    rootKind: 'workspace',
    workspaceDir: 'C:/docs/dsh-年度报告.docx-261127-144126-a71c2e90',
    createdAt: '2026-11-27T14:41:26.000Z',
    status: 'closed',
    mcpVersion: '0.4.0',
    checkpoints: [
      {
        name: '年度报告-261127-144200-v1.docx',
        path: 'C:/docs/dsh-x/checkpoints/年度报告-261127-144200-v1.docx',
        size: 3,
        sha256: 'c',
        createdAt: 't',
      },
    ],
    deliveries: [
      {
        taskId: 'a71c2e90',
        name: '年度报告.docx',
        path: 'C:/docs/年度报告.docx',
        size: 3,
        sha256: 'x',
        createdAt: 't',
      },
    ],
    ...extra,
  }
}

const baseFiles = ['.betteroffice-task.json', 'draft/年度报告.docx', 'checkpoints/年度报告-261127-144200-v1.docx']

test('设置禁用时一律不删', () => {
  const decision = cleanupDecision({
    mode: 'off',
    ledger: ledger(),
    files: baseFiles,
    discard: true,
  })
  assert.equal(decision.remove, false)
  assert.match(decision.reason, /禁用/u)
})

test('没有交付也没有放弃草稿时保留', () => {
  const decision = cleanupDecision({
    mode: 'auto',
    ledger: ledger({ deliveries: [] }),
    files: baseFiles,
  })
  assert.equal(decision.remove, false)
  assert.match(decision.reason, /交付/u)
})

test('有未登记文件时保留并指出文件', () => {
  const decision = cleanupDecision({
    mode: 'on',
    ledger: ledger(),
    files: [...baseFiles, 'draft/我自己加的备注.txt'],
  })
  assert.equal(decision.remove, false)
  assert.match(decision.reason, /我自己加的备注\.txt/u)
})

test('台账缺失时保留', () => {
  const decision = cleanupDecision({ mode: 'on', ledger: undefined, files: baseFiles })
  assert.equal(decision.remove, false)
  assert.match(decision.reason, /台账/u)
})

test('已交付且只剩自己的文件时允许删除', () => {
  const decision = cleanupDecision({ mode: 'on', ledger: ledger(), files: baseFiles })
  assert.equal(decision.remove, true)
})

test('用户放弃草稿时即使没有交付也允许删除', () => {
  const decision = cleanupDecision({
    mode: 'auto',
    ledger: ledger({ deliveries: [] }),
    files: baseFiles,
    discard: true,
  })
  assert.equal(decision.remove, true)
})

test('cleanupWorkspace 在允许时真的删掉目录', async () => {
  const removed: string[] = []
  const decision = await cleanupWorkspace({
    mode: 'on',
    dir: 'C:/docs/dsh-x',
    readLedger: async () => ledger(),
    listFiles: async () => baseFiles,
    removeDir: async (dir) => {
      removed.push(dir)
    },
  })
  assert.equal(decision.remove, true)
  assert.deepEqual(removed, ['C:/docs/dsh-x'])
})

test('cleanupWorkspace 在保留时不碰目录，并把原因记进日志', async () => {
  const removed: string[] = []
  const logged: string[] = []
  const decision = await cleanupWorkspace({
    mode: 'on',
    dir: 'C:/docs/dsh-x',
    readLedger: async () => ledger(),
    listFiles: async () => [...baseFiles, 'notes.txt'],
    removeDir: async (dir) => {
      removed.push(dir)
    },
    logger: (message) => {
      logged.push(message)
    },
  })
  assert.equal(decision.remove, false)
  assert.deepEqual(removed, [])
  assert.match(logged.join('\n'), /notes\.txt/u)
})
