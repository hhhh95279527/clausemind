// server/src/contract/review/revision-anchor.ts
// 修订锚点定位（纯函数，无依赖）：在条款原文中定位已接受修订的原句位置。
// 独立成模块避免 revision.service ↔ pdf-export.service 循环依赖（Nest DI 元数据会被环打断）。
import type { Risk } from '@prisma/client'

export type EditToken =
  | { type: 'plain'; text: string }
  | { type: 'edit'; del: string; ins: string }

/**
 * 在条款原文中定位每条已接受修订的原句锚点，切成 原文片段 / 修订替换 的有序 token。
 * - quote 经引用校验可能带首尾「…」省略号，取其核心片段定位
 * - 锚点重叠或找不到的修订进 unmatched（调用方追加呈现），正文保证完整不丢
 */
export function tokenizeEdits(content: string, revs: Risk[]): { tokens: EditToken[]; unmatched: Risk[] } {
  const located: Array<{ start: number; end: number; r: Risk }> = []
  const unmatched: Risk[] = []

  const candidates = revs
    .map((r) => {
      const core = r.quote.replace(/^…+|…+$/g, '')
      const start = core ? content.indexOf(core) : -1
      return { r, start, end: start >= 0 ? start + core.length : -1 }
    })
    .sort((a, b) => (a.start - b.start) || (b.end - a.end))

  let cursorEnd = 0
  for (const c of candidates) {
    if (c.start < 0 || c.start < cursorEnd) {
      unmatched.push(c.r)
      continue
    }
    located.push({ start: c.start, end: c.end, r: c.r })
    cursorEnd = c.end
  }

  const tokens: EditToken[] = []
  let pos = 0
  for (const loc of located) {
    if (loc.start > pos) tokens.push({ type: 'plain', text: content.slice(pos, loc.start) })
    tokens.push({ type: 'edit', del: content.slice(loc.start, loc.end), ins: loc.r.rewritten! })
    pos = loc.end
  }
  if (pos < content.length) tokens.push({ type: 'plain', text: content.slice(pos) })
  return { tokens, unmatched }
}
