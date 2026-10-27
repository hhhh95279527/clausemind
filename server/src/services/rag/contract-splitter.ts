// server/src/services/rag/contract-splitter.ts
// 合同结构感知切分器：按条款边界（第X条）切分，而非按字符数硬切。
// 设计目标：
//   1. 一个条款 = 一个 chunk（合同语义的最小完整单元），不与其他条款合并；
//   2. 单条款超长（>1500字）才二次切分，每段重复条款号+标题做上下文自包含；
//   3. 前言（缔约信息）、附件、签署页各成独立 chunk；
//   4. 每个 chunk 携带结构化元数据（条款号/标题/段落类型/页码范围），
//      供检索层精确定位、回答层做条款级引用。
// 复用 clause-parser.ts 的条款标记正则，保持合同审查与知识库两条链路的切分口径一致。

export interface ContractChunk {
  /** 切分后的正文内容（含条款号+标题前缀，便于 embedding 捕获结构信号） */
  content: string
  /** 元数据：供 pg-store 透传到检索结果与回答引用 */
  metadata: ChunkMetadata
}

export interface ChunkMetadata {
  /** 条款号，如 "第七条"；前言/附件/签署页为 null */
  clauseNo: string | null
  /** 条款标题，如 "违约责任"；无则与 clauseNo 相同 */
  clauseTitle: string
  /** 段落类型：preamble(缔约信息) / body(正文条款) / attachment(附件) / signature(签署页) */
  section: 'preamble' | 'body' | 'attachment' | 'signature'
  /** 原文中的起止字符偏移（用于回溯定位） */
  startOffset: number
  endOffset: number
  /** 页码范围（扫描件/OCR 场景有值，原生文字 PDF 可能为 null） */
  pageRange: [number, number] | null
  /** 来源类型：native(原生文字) / ocr(OCR转录) */
  sourceType: 'native' | 'ocr'
  /** 是否含表格 */
  hasTable: boolean
  /** 是否含金额/数字（需重点校验） */
  hasAmount: boolean
  /** 若为长条款二次切分，此为第几段（0-based）；完整条款为 0 */
  subIndex: number
  /** 长条款二次切分时的总段数；完整条款为 1 */
  subTotal: number
}

// ── 条款标记：第X条（中文/阿拉伯数字），允许行首或行内出现 ──────────────
const CLAUSE_MARKER = /第\s*([一二三四五六七八九十两〇零\d]{1,5})\s*条[^\n]{0,80}/g

// 附件标记：附件一/附件1/附录一 等（边界扫描见 collectSectionBoundaries）
// 签署页标记：签字/盖章/签署 页（同上）

// 中文数字转阿拉伯（覆盖合同常见范围 1~99）
const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function cnToInt(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (!s) return null
  if (s === '十') return 10
  if (s.startsWith('十')) {
    const rest = s.slice(1)
    return 10 + (rest && CN_DIGITS[rest] !== undefined ? CN_DIGITS[rest] : 0)
  }
  const shiIdx = s.indexOf('十')
  if (shiIdx > 0) {
    const tens = CN_DIGITS[s[shiIdx - 1]]
    if (tens === undefined) return null
    let n = tens * 10
    const rest = s.slice(shiIdx + 1)
    if (rest) {
      if (CN_DIGITS[rest] === undefined) return null
      n += CN_DIGITS[rest]
    }
    return n
  }
  if (s.length === 1 && CN_DIGITS[s] !== undefined) return CN_DIGITS[s]
  return null
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/^[\s、:：.．·\-—_【】\[\]（）()]+/, '')
    .replace(/[【】\[\]]/g, '')
    .trim()
}

/** 从条款标记行提取标题（第X条之后到句末标点/换行之间的短语） */
function extractClauseTitle(markerText: string, defaultNo: string): string {
  const after = markerText.replace(/^第\s*[一二三四五六七八九十两〇零\d]{1,5}\s*条/, '')
  const lineEnd = after.search(/[。；;]/)
  let titleRaw = lineEnd >= 0 ? after.slice(0, lineEnd) : after
  let title = cleanTitle(titleRaw)
  if (title.length > 30 || /[，,]/.test(title)) {
    // 标题位置其实是正文长句：不强行命名
    title = defaultNo
  }
  return title || defaultNo
}

/** 检测文本是否含金额/数字（合同审查命门） */
function hasAmountOrNumber(text: string): boolean {
  // 金额（¥/￥/元/万元/人民币）+ 百分比 + 期限数字 + 比例（万分之X/百分之X）+ 阿拉伯数字
  return /[¥￥$]|人民币|\d+\s*(?:万?元|万元|块)|百分之?\d+|万分之[一二三四五六七八九十\d]|\d+\s*(?:年|个月|月|日|天|小时)|万分之?\d/.test(text)
}

/** 检测文本是否含表格结构（管道符或制表符分隔的多列） */
function hasTableStructure(text: string): boolean {
  return /\t/.test(text) || /\|.*\|/.test(text)
}

/**
 * 合同结构感知切分主入口。
 * @param fullText 合同全文（已去除 \r 统一换行）
 * @param opts 切分选项
 */
export function splitContract(
  fullText: string,
  opts: {
    sourceType?: 'native' | 'ocr'
    pageCount?: number
    /** 每页大约字符数，用于估算页码范围（OCR 场景已知页数时用） */
    pageBreakMarkers?: string[]
  } = {},
): ContractChunk[] {
  const text = fullText.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/\t/g, ' ')
  const sourceType = opts.sourceType || 'native'
  const pageCount = opts.pageCount || 0

  // 估算每页字符数，用于推导页码范围
  const charsPerPage = pageCount > 0 ? Math.ceil(text.length / pageCount) : 0

  const offsetToPage = (offset: number): number => {
    if (charsPerPage <= 0) return 0
    return Math.min(pageCount, Math.floor(offset / charsPerPage) + 1)
  }

  const chunks: ContractChunk[] = []

  // ── 1. 扫描所有条款标记位置 ────────────────────────────────────
  const markers: { idx: number; num: number; markerText: string; title: string; clauseNo: string }[] = []
  let m: RegExpExecArray | null
  CLAUSE_MARKER.lastIndex = 0
  while ((m = CLAUSE_MARKER.exec(text)) !== null) {
    const num = cnToInt(m[1])
    if (num === null) continue
    const clauseNo = `第${m[1]}条`
    const title = extractClauseTitle(m[0], clauseNo)
    markers.push({ idx: m.index, num, markerText: m[0], title, clauseNo })
  }

  // ── 2. 前言（第一条之前的缔约信息）──────────────────────────────
  if (markers.length > 0) {
    const preambleEnd = markers[0].idx
    const preamble = text.slice(0, preambleEnd).trim()
    if (preamble.length >= 20) {
      chunks.push({
        content: `[缔约信息]\n${preamble}`,
        metadata: {
          clauseNo: null,
          clauseTitle: '缔约信息',
          section: 'preamble',
          startOffset: 0,
          endOffset: preambleEnd,
          pageRange: charsPerPage > 0 ? [1, offsetToPage(preambleEnd)] : null,
          sourceType,
          hasTable: hasTableStructure(preamble),
          hasAmount: hasAmountOrNumber(preamble),
          subIndex: 0,
          subTotal: 1,
        },
      })
    }
  }

  // ── 3. 正文条款 ───────────────────────────────────────────────
  // 附件/签署页可能出现在最后一条条款的跨度内，必须先收集其边界，在条款跨度内切断，
  // 否则「附件一」「甲方（盖章）」会被错误并入上一条条款并整块改标 section。
  const boundaries = collectSectionBoundaries(text)

  for (let i = 0; i < markers.length; i++) {
    const clauseStart = markers[i].idx
    const clauseEnd = i + 1 < markers.length ? markers[i + 1].idx : text.length
    const { clauseNo, title } = markers[i]

    // 本条款跨度内的附件/签署页边界（按位置升序）
    const inner = boundaries.filter((b) => b.idx > clauseStart && b.idx < clauseEnd)

    // 段1：条款本体（clauseStart → 第一个边界或条款结束）
    const clauseBodyEnd = inner.length ? inner[0].idx : clauseEnd
    const clauseBody = text.slice(clauseStart, clauseBodyEnd).trim()
    if (clauseBody) {
      chunks.push(...splitLongClause(clauseBody, clauseNo, title, 'body', clauseStart, clauseBodyEnd, sourceType, charsPerPage, pageCount))
    }

    // 段2..N：附件 / 签署页各自独立成块
    for (let j = 0; j < inner.length; j++) {
      const segStart = inner[j].idx
      const segEnd = j + 1 < inner.length ? inner[j + 1].idx : clauseEnd
      const segBody = text.slice(segStart, segEnd).trim()
      if (!segBody) continue
      chunks.push(...splitLongClause(segBody, '', inner[j].type === 'signature' ? '签署页' : '附件', inner[j].type, segStart, segEnd, sourceType, charsPerPage, pageCount))
    }
  }

  // ── 4. 无任何条款标记：整体作为一个 chunk（兜底）─────────────────
  if (!markers.length && text.trim()) {
    chunks.push({
      content: text.trim(),
      metadata: {
        clauseNo: null,
        clauseTitle: '合同全文',
        section: 'body',
        startOffset: 0,
        endOffset: text.length,
        pageRange: charsPerPage > 0 ? [1, pageCount || 1] : null,
        sourceType,
        hasTable: hasTableStructure(text),
        hasAmount: hasAmountOrNumber(text),
        subIndex: 0,
        subTotal: 1,
      },
    })
  }

  return chunks
}

/**
 * 收集附件 / 签署页的起始边界（全局扫描，按位置升序）。
 * 附件：行首「附件一/附录1/附页二：」；签署页：行内出现「（盖章）」「（签字）」「盖章：」等。
 * 返回的 idx 指向该行的行首（含前置换行的下一字符），用于把上一段与附件/签署页切开。
 */
function collectSectionBoundaries(text: string): { idx: number; type: 'attachment' | 'signature' }[] {
  const result: { idx: number; type: 'attachment' | 'signature' }[] = []

  const attRe = /(^|\n)[ \t]*(?:附件|附录|附页)\s*[一二三四五六七八九十两〇零\d]{1,5}[：:\s、]/gm
  let m: RegExpExecArray | null
  while ((m = attRe.exec(text)) !== null) {
    result.push({ idx: m.index + (m[1] ? m[1].length : 0), type: 'attachment' })
  }

  const sigRe = /(^|\n)[ \t]*[^\n]*(?:（\s*(?:盖章|签字|签署|签章)\s*）|(?:盖章|签字)\s*[:：])[^\n]*/gm
  while ((m = sigRe.exec(text)) !== null) {
    result.push({ idx: m.index + (m[1] ? m[1].length : 0), type: 'signature' })
  }

  return result.sort((a, b) => a.idx - b.idx)
}

/** 单条款切分阈值：超过此长度才二次切分（合同条款通常 200~800 字，1500 已是长条款） */
const LONG_CLAUSE_THRESHOLD = 1500
/** 二次切分的单段目标长度 */
const SUB_CHUNK_TARGET = 1000
/** 二次切分的重叠长度（按句号边界对齐，不硬切字符） */
const SUB_CHUNK_OVERLAP_SENTENCES = 1

/**
 * 长条款二次切分：按句号/分号边界切，每段前置条款号+标题保证自包含。
 * 短条款直接返回单个 chunk。
 */
function splitLongClause(
  body: string,
  clauseNo: string,
  title: string,
  section: 'body' | 'attachment' | 'signature',
  startOffset: number,
  endOffset: number,
  sourceType: 'native' | 'ocr',
  charsPerPage: number,
  pageCount: number,
): ContractChunk[] {
  const offsetToPage = (offset: number): number => {
    if (charsPerPage <= 0) return 0
    return Math.min(pageCount, Math.floor(offset / charsPerPage) + 1)
  }

  if (body.length <= LONG_CLAUSE_THRESHOLD) {
    return [{
      content: `[${clauseNo} ${title}]\n${body}`,
      metadata: {
        clauseNo,
        clauseTitle: title,
        section,
        startOffset,
        endOffset,
        pageRange: charsPerPage > 0 ? [offsetToPage(startOffset), offsetToPage(endOffset)] : null,
        sourceType,
        hasTable: hasTableStructure(body),
        hasAmount: hasAmountOrNumber(body),
        subIndex: 0,
        subTotal: 1,
      },
    }]
  }

  // 按句号/分号/问号/感叹号切句子（保留标点），同时追踪每句在 body 中的偏移
  const sentenceMatches = [...body.matchAll(/[^。；;!?！？]+[。；;!?！？]?/g)]
  const sentences = sentenceMatches.length ? sentenceMatches.map((m) => ({ text: m[0], offset: m.index || 0 })) : [{ text: body, offset: 0 }]
  const segments: { text: string; start: number; end: number }[] = []
  let current = ''
  let currentStart = 0

  for (const { text: sent, offset } of sentences) {
    if ((current + sent).length > SUB_CHUNK_TARGET && current.length > 0) {
      segments.push({ text: current.trim(), start: currentStart, end: offset })
      // 重叠：保留最后 N 个句子作为下一段的开头
      const lastSents = current.match(/[^。；;!?！？]+[。；;!?！？]?/g) || []
      const overlap = lastSents.slice(-SUB_CHUNK_OVERLAP_SENTENCES).join('')
      current = overlap + sent
      // 下一段起始偏移 = 当前段结束位置 - 重叠长度
      currentStart = Math.max(0, offset - overlap.length)
    } else {
      if (current.length === 0) currentStart = offset
      current += sent
    }
  }
  if (current.trim()) {
    segments.push({ text: current.trim(), start: currentStart, end: body.length })
  }

  const total = segments.length
  return segments.map((seg, idx) => ({
    content: `[${clauseNo} ${title}]（${idx + 1}/${total}）\n${seg.text}`,
    metadata: {
      clauseNo,
      clauseTitle: title,
      section,
      startOffset: startOffset + seg.start,
      endOffset: startOffset + seg.end,
      pageRange: charsPerPage > 0 ? [offsetToPage(startOffset + seg.start), offsetToPage(startOffset + seg.end)] : null,
      sourceType,
      hasTable: hasTableStructure(seg.text),
      hasAmount: hasAmountOrNumber(seg.text),
      subIndex: idx,
      subTotal: total,
    },
  }))
}
