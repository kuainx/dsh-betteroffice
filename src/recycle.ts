import { DomainError } from './errors.js'

export type RecycleRun = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string> },
) => Promise<{ code: number; stderr: string; stdout: string }>

/**
 * 固定脚本：路径只经环境变量进入，避免拼接注入。
 * 回收后必须用 shell 命名空间确认条目存在——直接枚举 $Recycle.Bin 会被 ACL 拒绝。
 */
export function recycleScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    // Windows PowerShell 5.1 默认按控制台代码页输出中文，重定向时会被 node 当 UTF-8 读成乱码
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '$path = $env:BO_RECYCLE_PATH',
    'if ([string]::IsNullOrWhiteSpace($path)) {',
    '  Write-Output (ConvertTo-Json -Compress @{ recycled = $false; reason = "缺少路径" })',
    '  exit 0',
    '}',
    'try {',
    '  Add-Type -AssemblyName Microsoft.VisualBasic',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '} catch {',
    '  Write-Output (ConvertTo-Json -Compress @{ recycled = $false; reason = $_.Exception.Message })',
    '  exit 0',
    '}',
    '$name = [System.IO.Path]::GetFileName($path)',
    '$found = $false',
    'try {',
    '  $shell = New-Object -ComObject Shell.Application',
    '  foreach ($item in $shell.Namespace(10).Items()) {',
    '    if ($item.Name -eq $name) { $found = $true; break }',
    '  }',
    '} catch { $found = $false }',
    'if (-not (Test-Path -LiteralPath $path) -and $found) {',
    '  Write-Output (ConvertTo-Json -Compress @{ recycled = $true; name = $name })',
    '} else {',
    '  Write-Output (ConvertTo-Json -Compress @{ recycled = $false; reason = "回收站里没有找到该文件" })',
    '}',
  ].join('\n')
}

function lastJson(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      // 继续向前找
    }
  }
  return undefined
}

/** 把文件移入 Windows 回收站；不可用或未被确认时抛错，绝不降级为永久删除。 */
export async function recycleFile(path: string, deps: { platform?: string; run: RecycleRun }): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    throw new DomainError('recycle-unavailable', `这个平台（${platform}）没有可用的回收站，只能另存为新文件。`)
  }
  const result = await deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', recycleScript()], {
    env: { BO_RECYCLE_PATH: path },
  })
  const parsed = lastJson(result.stdout)
  if (result.code !== 0 || parsed === undefined) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-5).join(' ')
    throw new DomainError('recycle-failed', `移入回收站失败（退出码 ${result.code}）：${tail || '无输出'}`)
  }
  if (parsed.recycled !== true) {
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '未知原因'
    throw new DomainError('recycle-failed', `移入回收站失败：${reason}`)
  }
}
