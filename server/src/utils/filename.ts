// server/src/utils/filename.ts
// multipart 文件名编码修复。
// 背景：multer 1.x 的 busboy 默认按 Latin-1 解读 Content-Disposition 中的 filename，
// 而浏览器对中文文件名发送的是 UTF-8 原始字节，导致 originalname 变成 mojibake
// （如「实习协议.docx」→ å®žä¹ åè®®.docx）。
// 已配置 defParamCharset='utf8'，本函数是对异常客户端/旧链路的兜底：
// 仅当字符串是"纯 Latin1 可编码、按 UTF-8 还原后含 CJK"的典型 mojibake 时才转换，
// 正常 ASCII / 正常中文 / 含全角符号的文件名一律原样返回，不会误伤。

/** 是否含 CJK 统一表意文字 */
function hasCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0x4e00 && cp <= 0x9fff) return true
  }
  return false
}

/** 尝试把 Latin1 误读的文件名还原为 UTF-8；不像乱码则原样返回 */
export function decodeOriginalName(raw: string | undefined | null): string {
  const name = (raw ?? '').toString()
  if (!name) return ''

  let hasLatin1High = false
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp > 0xff) return name // 含 CJK/全角/emoji 等，说明已是正常 Unicode
    if (cp >= 0x80) hasLatin1High = true
  }
  if (!hasLatin1High) return name

  const restored = Buffer.from(name, 'latin1').toString('utf8')
  if (restored !== name && hasCjk(restored)) return restored
  return name
}
