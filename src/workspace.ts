/** 工作文件夹名：`dsh-<原文件名含扩展名>-<YYMMDD-HHmmss>-<任务 id>`。 */

export const WORKSPACE_PREFIX = 'dsh-'
/** 目录名上限（字节）。留余量给路径总长限制与同级目录。 */
export const MAX_NAME_BYTES = 200

const ILLEGAL_RUN = /[<>:"/\\|?*\u0000-\u001f]+/g

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** 本地时间的 `YYMMDD-HHmmss`。 */
export function formatStamp(at: Date): string {
  const date = `${pad(at.getFullYear() % 100, 2)}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}`
  const time = `${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`
  return `${date}-${time}`
}

function stripTrailingDotsAndSpaces(name: string): string {
  return name.replace(/[ .]+$/u, '')
}

/** 把 Windows 非法字符/控制字符的连续片段压成一个 `_`，并去掉尾随空格与点。 */
function sanitize(fileName: string): string {
  return stripTrailingDotsAndSpaces(fileName.replace(ILLEGAL_RUN, '_'))
}

function splitExt(name: string): [string, string] {
  const at = name.lastIndexOf('.')
  if (at <= 0 || at === name.length - 1) return [name, '']
  const ext = name.slice(at)
  if (ext.length > 12 || /[\\/]/u.test(ext)) return [name, '']
  return [name.slice(0, at), ext]
}

export function workspaceDirName(sourceFileName: string, taskId: string, at: Date): string {
  const suffix = `-${formatStamp(at)}-${taskId}`
  const budget = MAX_NAME_BYTES - Buffer.byteLength(WORKSPACE_PREFIX, 'utf8') - Buffer.byteLength(suffix, 'utf8')
  let name = sanitize(sourceFileName)
  if (Buffer.byteLength(name, 'utf8') > budget) {
    // 超长时只裁文件名主体，保住扩展名与 `-时间-任务id` 尾部：这两个是恢复时唯一的线索。
    const [stem, ext] = splitExt(name)
    const chars = [...stem]
    while (chars.length > 0 && Buffer.byteLength(chars.join('') + ext, 'utf8') > budget) chars.pop()
    name = stripTrailingDotsAndSpaces(chars.join('')) + ext
  }
  return `${WORKSPACE_PREFIX}${name}${suffix}`
}
