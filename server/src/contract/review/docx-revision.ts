// server/src/contract/review/docx-revision.ts
// 在用户上传的原始 .docx 上应用修订，其余 XML（样式/字体/标题/表格/图片/页眉页脚/页面设置）原样保留，
// 从而保证导出文件版式与输入文件一致。
// 两种模式：
// - clean（默认）：把采纳的改写直接落为最终正文，输出「修订后新合同」，无修订痕迹、可直接定稿
// - redline：注入 Word 原生修订痕迹（w:del/w:ins），供对照复核
//
// 匹配模型（v1）：
// - 以 <w:p> 段落为单位，拼接段内所有 <w:r>/<w:t> 文本后做原句定位（支持跨 run、空白归一化）
// - 命中后把对应 run 切分为 原文片段 / w:del 删除痕迹 / w:ins 插入痕迹
// - 跨段落、落在 sdt/smartTag/fldSimple/文本框等复杂结构内的原句不硬改，转文末「附加修订建议」节
//   （绝不静默丢修订，也不破坏 OOXML 合法性）
import JSZip from 'jszip'

interface DocxEdit {
  quote: string
  ins: string
}

/** redline=Word 修订痕迹模式；clean=已应用修改、无痕迹的修订后合同 */
export type DocxMode = 'redline' | 'clean'

interface DocxInjectResult {
  buffer: Buffer
  applied: number
  unmatched: DocxEdit[]
}

const CHANGE_AUTHOR = 'ClauseMind AI'
let changeSeq = 1000
const nextId = () => ++changeSeq

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unesc(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

const nowIso = () => new Date().toISOString()

/** 从 run XML 中提取 rPr 关键字符属性，按 OOXML schema 顺序重组并叠加颜色/下划线 */
function styledRPr(runXml: string, opts: { color?: string; underline?: boolean }): string {
  const m = runXml.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/)
  const inner = m ? m[1] : ''
  const pick = (re: RegExp) => (inner.match(re) || [])[0] || ''
  // CT_RPr 顺序：rStyle → rFonts → b/bCs → i/iCs → sz/szCs → strike/dstrike → color → u
  const parts = [
    pick(/<w:rStyle\b[^>]*\/>/),
    pick(/<w:rFonts\b[^>]*?\/>/),
    pick(/<w:b\b[^>]*?\/>/),
    pick(/<w:bCs\b[^>]*?\/>/),
    pick(/<w:i\b[^>]*?\/>/),
    pick(/<w:iCs\b[^>]*?\/>/),
    pick(/<w:sz\b[^>]*?\/>/),
    pick(/<w:szCs\b[^>]*?\/>/),
    pick(/<w:strike\b[^>]*?\/>/),
    pick(/<w:dstrike\b[^>]*?\/>/),
    opts.color ? `<w:color w:val="${opts.color}"/>` : '',
    opts.underline ? '<w:u w:val="single"/>' : '',
  ]
  return `<w:rPr>${parts.join('')}</w:rPr>`
}

function delXml(runXml: string, text: string): string {
  return `<w:del w:id="${nextId()}" w:author="${esc(CHANGE_AUTHOR)}" w:date="${nowIso()}">`
    + `<w:r>${styledRPr(runXml, { color: 'C00000' })}`
    + `<w:delText xml:space="preserve">${esc(text)}</w:delText></w:r></w:del>`
}

function insXml(runXml: string, text: string): string {
  return `<w:ins w:id="${nextId()}" w:author="${esc(CHANGE_AUTHOR)}" w:date="${nowIso()}">`
    + `<w:r>${styledRPr(runXml, { color: '1D4ED8', underline: true })}`
    + `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:ins>`
}

/** 仅替换 run 内第一个 w:t 的文本（rPr、tab、br 等其他节点完整保留），用于切分后的纯文本片段 */
function cloneRunWithText(runXml: string, text: string): string {
  return runXml.replace(/<w:t(\s[^>]*)?>[\s\S]*?<\/w:t>/, `<w:t xml:space="preserve">${esc(text)}</w:t>`)
}

const RUN_RE = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g
const T_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
// 这些容器内的 run 被修订包裹可能违反 schema，命中段落整体放弃硬改
const SKIP_PARA_RE = /<w:sdt\b|<w:smartTag\b|<w:fldSimple\b|<w:subDoc\b/

/** 去掉首尾省略号（风险 quote 引用校验后可能带 …） */
function coreQuote(quote: string): string {
  return quote.replace(/^…+|…+$/g, '').trim()
}

/** 空白归一化匹配：返回 quote 在 raw 中的 [start,end)，找不到返回 null */
function locate(raw: string, quote: string): [number, number] | null {
  const direct = raw.indexOf(quote)
  if (direct >= 0) return [direct, direct + quote.length]

  // 归一化映射：norm 字符下标 -> raw 字符下标（连续空白压缩成一个空格）
  const norm: string[] = []
  const map: number[] = []
  let prevWs = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    const ws = /\s/.test(ch)
    if (ws) {
      if (!prevWs) { norm.push(' '); map.push(i) }
      prevWs = true
    } else {
      norm.push(ch); map.push(i); prevWs = false
    }
  }
  const normRaw = norm.join('')
  const normQuote = quote.replace(/\s+/g, ' ').trim()
  const at = normRaw.indexOf(normQuote)
  if (at < 0) return null
  const s = map[at]
  let e = map[at + normQuote.length - 1] + 1
  // 若结尾在 raw 中是空白，把连续空白一并纳入（删除痕迹覆盖整段空白更自然）
  while (e < raw.length && /\s/.test(raw[e])) e++
  return [s, e]
}

interface Range { start: number; end: number; edit: DocxEdit }

/** 重建一个纯文本 run：单 w:t 时克隆原 run（完整保留 rPr/tab/br），多 w:t 时用 rPr 关键属性重建 */
function plainRun(runXml: string, text: string, leafCount: number): string {
  if (!text) return ''
  if (leafCount === 1) return cloneRunWithText(runXml, text)
  return `<w:r>${styledRPr(runXml, {})}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
}

/**
 * 在一个段落 XML 内应用修订区间（坐标均为段内全部 w:t 拼接文本的字符偏移，已确认互不重叠），
 * 返回新段落 XML。
 */
function rewriteParagraph(paraInner: string, ranges: Range[], mode: DocxMode): string {
  interface RunInfo { outer: string; start: number; end: number; leafCount: number }
  const runs: RunInfo[] = []
  let m: RegExpExecArray | null
  RUN_RE.lastIndex = 0
  // 全局字符坐标 = 段内各 run 的 w:t 顺序拼接
  while ((m = RUN_RE.exec(paraInner))) {
    const outer = m[0]
    let leafCount = 0
    T_RE.lastIndex = 0
    while (T_RE.exec(outer)) { leafCount++ }
    if (!leafCount) continue
    runs.push({ outer, start: m.index, end: m.index + outer.length, leafCount })
  }

  const located = [...ranges].sort((a, b) => a.start - b.start)

  // 计算每个 run 的全局字符区间（第二遍，依赖 runs 顺序）
  const bounds = new Map<RunInfo, { gStart: number; gEnd: number; text: string }>()
  let gOff = 0
  for (const r of runs) {
    const texts: string[] = []
    let tm: RegExpExecArray | null
    T_RE.lastIndex = 0
    while ((tm = T_RE.exec(r.outer))) texts.push(unesc(tm[1]))
    const text = texts.join('')
    bounds.set(r, { gStart: gOff, gEnd: gOff + text.length, text })
    gOff += text.length
  }

  const parts: string[] = []
  let paraCursor = 0
  for (const r of runs) {
    parts.push(paraInner.slice(paraCursor, r.start))
    const { gStart, gEnd, text: runText } = bounds.get(r)!
    const here = located.filter((x) => x.start < gEnd && x.end > gStart)
    if (!here.length) {
      parts.push(r.outer)
    } else {
      let cur = gStart
      const segs: string[] = []
      for (const h of here) {
        const s = Math.max(h.start, gStart)
        const e = Math.min(h.end, gEnd)
        if (s > cur) segs.push(plainRun(r.outer, runText.slice(cur - gStart, s - gStart), r.leafCount))
        if (mode === 'clean') {
          // clean（修订后新合同）：直接以改写文本顶替原句，不留任何修订痕迹，沿用原 run 的字体格式
          if (h.start >= gStart && h.start < gEnd) segs.push(plainRun(r.outer, h.edit.ins, r.leafCount))
        } else {
          const delText = runText.slice(s - gStart, e - gStart)
          if (delText) segs.push(delXml(r.outer, delText))
          // 插入文本只在区间起点所在的那个 run 输出一次
          if (h.start >= gStart && h.start < gEnd) segs.push(insXml(r.outer, h.edit.ins))
        }
        cur = Math.max(cur, e)
      }
      if (cur < gEnd) segs.push(plainRun(r.outer, runText.slice(cur - gStart), r.leafCount))
      parts.push(segs.join(''))
    }
    paraCursor = r.end
  }
  parts.push(paraInner.slice(paraCursor))
  return parts.join('')
}

/** 文末附录节（未在原文定位到的修订），插入 sectPr 之前。clean 模式用纯文本列出，不产生修订痕迹 */
function appendixXml(unmatched: DocxEdit[], mode: DocxMode): string {
  const p = (inner: string) => `<w:p>${inner}</w:p>`
  const run = (text: string, rPr: string) => `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
  const heading = mode === 'clean'
    ? '以下采纳的修订未能自动定位到原文位置，请在定稿前人工确认并手动修改'
    : '附加修订建议（以下原句未在原文中精确定位，请人工对照修改；红划线为建议删除、蓝下划线为建议替换内容）'
  let xml = p('<w:pPr><w:pageBreakBefore/></w:pPr>'
    + run(heading, '<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>'))
  for (const u of unmatched) {
    if (mode === 'clean') {
      xml += p(run('原文：', '<w:rPr><w:b/><w:color w:val="C00000"/></w:rPr>')
        + run(u.quote, '<w:rPr><w:color w:val="C00000"/></w:rPr>'))
      xml += p(run('改写：', '<w:rPr><w:b/><w:color w:val="1D4ED8"/></w:rPr>')
        + run(u.ins, '<w:rPr><w:color w:val="1D4ED8"/></w:rPr>'))
      continue
    }
    xml += p(run('原文：', '<w:rPr><w:b/><w:color w:val="C00000"/></w:rPr>')
      + `<w:del w:id="${nextId()}" w:author="${esc(CHANGE_AUTHOR)}" w:date="${nowIso()}">`
      + `<w:r><w:rPr><w:color w:val="C00000"/></w:rPr><w:delText xml:space="preserve">${esc(u.quote)}</w:delText></w:r></w:del>`)
    xml += p(run('改写：', '<w:rPr><w:b/><w:color w:val="1D4ED8"/></w:rPr>')
      + `<w:ins w:id="${nextId()}" w:author="${esc(CHANGE_AUTHOR)}" w:date="${nowIso()}">`
      + `<w:r><w:rPr><w:color w:val="1D4ED8"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${esc(u.ins)}</w:t></w:r></w:ins>`)
  }
  return xml
}

/**
 * 在 docx Buffer 上应用修订。
 * @param mode redline=注入 Word 修订痕迹（w:del/w:ins）；clean=直接应用为最终正文，输出修订后新合同
 * @returns 新 Buffer + 应用条数/未命中清单
 */
export async function injectTrackedChanges(
  docxBuffer: Buffer,
  edits: DocxEdit[],
  mode: DocxMode = 'redline',
): Promise<DocxInjectResult> {
  const zip = await JSZip.loadAsync(docxBuffer)
  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('docx 中缺少 word/document.xml，无法注入修订')
  const xml = await docFile.async('string')

  const pending = edits.map((edit) => ({ edit, done: false }))
  const PARA_RE = /(<w:p\b[^>]*>)([\s\S]*?)(<\/w:p>)/g
  const body: string[] = []
  let last = 0
  let pm: RegExpExecArray | null
  while ((pm = PARA_RE.exec(xml))) {
    body.push(xml.slice(last, pm.index))
    const [whole, open, inner, close] = pm
    const remaining = pending.filter((p) => !p.done)
    // 段落纯文本（跨 run），用于预判该段可能包含哪些原句
    let paraText = ''
    if (remaining.length && !SKIP_PARA_RE.test(inner)) {
      T_RE.lastIndex = 0
      let tm: RegExpExecArray | null
      while ((tm = T_RE.exec(inner))) paraText += unesc(tm[1])
    }
    const ranges: Range[] = []
    if (paraText) {
      const candidates: Array<{ pos: [number, number]; p: (typeof pending)[number] }> = []
      for (const p of remaining) {
        const core = coreQuote(p.edit.quote)
        if (!core) continue
        const pos = locate(paraText, core)
        if (pos) candidates.push({ pos, p })
      }
      // 同一段内重叠的原句只保留先命中的一条，其余留给后续段落/附加节
      candidates.sort((a, b) => a.pos[0] - b.pos[0])
      for (const c of candidates) {
        if (ranges.some((r) => c.pos[0] < r.end && c.pos[1] > r.start)) continue
        ranges.push({ start: c.pos[0], end: c.pos[1], edit: c.p.edit })
        c.p.done = true
      }
    }
    body.push(ranges.length ? open + rewriteParagraph(inner, ranges, mode) + close : whole)
    last = pm.index + whole.length
  }
  body.push(xml.slice(last))

  const unmatched = pending.filter((p) => !p.done).map((p) => p.edit)
  let outXml = body.join('')
  if (unmatched.length) {
    const addendum = appendixXml(unmatched, mode)
    // sectPr 必须保持为 body 最后一个子元素
    outXml = outXml.replace(/(<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>)/, `${addendum}$1`)
  }

  zip.file('word/document.xml', outXml)
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  return { buffer, applied: edits.length - unmatched.length, unmatched }
}
