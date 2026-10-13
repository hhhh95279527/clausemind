// server/src/contract/parsing/clause-parser.ts
// 合同条款切分："第 X 条"正则保底切分 + 标题词典初判类型；
// LLM 结构化输出（withStructuredOutput）做类型精修，任何失败都回退到词典结果——无 key 也能跑。
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { z } from 'zod'
import type { ClauseType } from '@prisma/client'
import { createChatModel } from '../../services/model.js'
import { config, isValidAiKey } from '../../config/index.js'
import { logger } from '../../utils/logger.js'

interface ParsedClause {
  title: string
  content: string
  clauseType: ClauseType
}

// ── 中文数字转阿拉伯（覆盖合同常见范围 1~99）────────────────────
const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function cnToInt(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (!s) return null
  if (s === '十') return 10
  // 处理"十X"=10+X、"X十"=X*10、"X十Y"=X*10+Y
  let n = 0
  if (s.startsWith('十')) {
    n = 10
    const rest = s.slice(1)
    if (rest && CN_DIGITS[rest] !== undefined) n += CN_DIGITS[rest]
    return n
  }
  const shiIdx = s.indexOf('十')
  if (shiIdx > 0) {
    const tens = CN_DIGITS[s[shiIdx - 1]]
    if (tens === undefined) return null
    n = tens * 10
    const rest = s.slice(shiIdx + 1)
    if (rest) {
      if (CN_DIGITS[rest] === undefined) return null
      n += CN_DIGITS[rest]
    }
    return n
  }
  // 纯单字
  if (s.length === 1 && CN_DIGITS[s] !== undefined) return CN_DIGITS[s]
  return null
}

// 条款标记：第X条（中文/阿拉伯数字），允许行首或行内出现
const CLAUSE_MARKER = /第\s*([一二三四五六七八九十两〇零\d]{1,5})\s*条[^\n]{0,60}/g

function cleanTitle(raw: string): string {
  return raw
    .replace(/^[\s、:：.．·\-—_【】\[\]（）()]+/, '')
    .replace(/[【】\[\]]/g, '')
    .trim()
}

/**
 * 切分合同全文为条款。
 * 第一条之前的大段文字作为"缔约信息"条款（甲乙方信息对审查同样关键）。
 */
export function splitClauses(fullText: string): ParsedClause[] {
  const text = fullText.replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/\t/g, ' ')
  const markers: { idx: number; num: number; headLength: number; title: string }[] = []

  let m: RegExpExecArray | null
  CLAUSE_MARKER.lastIndex = 0
  while ((m = CLAUSE_MARKER.exec(text)) !== null) {
    const num = cnToInt(m[1])
    if (num === null) continue
    // 标题：标记同行内"第X条"之后到句末标点/换行之间的短语
    const head = m[0]
    const after = head.replace(new RegExp(`^第\\s*[一二三四五六七八九十两〇零\\d]{1,5}\\s*条`), '')
    const lineEnd = after.search(/[。；;]/)
    let titleRaw = lineEnd >= 0 ? after.slice(0, lineEnd) : after
    let title = cleanTitle(titleRaw)
    if (title.length > 30 || /[，,]/.test(title)) {
      // 标题位置其实是正文长句：不强行命名
      title = `第${num}条`
    }
    markers.push({ idx: m.index, num, headLength: head.length, title: title || `第${num}条` })
  }

  const clauses: ParsedClause[] = []

  // 前言（缔约信息）
  if (markers.length) {
    const preamble = text.slice(0, markers[0].idx).trim()
    if (preamble.length >= 20) {
      clauses.push({ title: '缔约信息', content: preamble, clauseType: 'PARTIES' })
    }
  }

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].idx
    const end = i + 1 < markers.length ? markers[i + 1].idx : text.length
    let body = text.slice(start, end).trim()
    const title = markers[i].title
    clauses.push({ title, content: body, clauseType: classifyType(title, body) })
  }

  // 未切出任何条款：整体作为一条，仍可走规则 + Agent 审查
  if (!clauses.length && text.trim()) {
    clauses.push({ title: '合同全文', content: text.trim(), clauseType: 'OTHER' })
  }
  return clauses
}

// ── 标题/正文关键词 → 条款类型词典（确定性保底）────────────────
const TYPE_KEYWORDS: Array<{ type: ClauseType; words: string[] }> = [
  { type: 'CONFIDENTIALITY', words: ['保密', '商业秘密'] },
  { type: 'IP', words: ['知识产权', '著作权', '版权', '专利', '商标'] },
  { type: 'GOVERNING_LAW', words: ['争议', '管辖', '仲裁', '诉讼', '适用法律', '法院'] },
  { type: 'TERMINATION', words: ['解除', '终止', '合同结束'] },
  { type: 'BREACH', words: ['违约', '赔偿', '罚则', '责任'] },
  { type: 'AMOUNT', words: ['价款', '报酬', '租金', '工资', '金额', '支付', '费用', '定金', '报价', '结算'] },
  { type: 'TERM', words: ['期限', '交付', '完工', '服务期', '履行期', '工期', '起止'] },
  { type: 'PARTIES', words: ['甲方', '乙方', '用人单位', '劳动者', '双方信息'] },
]

function classifyType(title: string, content: string): ClauseType {
  const head = title + ' ' + content.slice(0, 120)
  for (const { type, words } of TYPE_KEYWORDS) {
    if (words.some((w) => head.includes(w))) return type
  }
  return 'OTHER'
}

const TYPE_VALUES = ['PARTIES', 'AMOUNT', 'TERM', 'BREACH', 'TERMINATION', 'GOVERNING_LAW', 'CONFIDENTIALITY', 'IP', 'OTHER'] as const

/**
 * LLM 结构化精修条款类型（只发标题 + 首句，成本极低）。
 * 失败（无 key/限流/解析错）一律保留词典分类，不阻断解析任务。
 */
export async function refineTypesWithLlm(
  clauses: ParsedClause[],
  callbacks?: BaseCallbackHandler[],
): Promise<number> {
  if (!isValidAiKey(config.ai.deepseekKey)) return 0
  if (clauses.length < 2) return 0

  const TypeArray = z.object({
    types: z.array(z.enum(TYPE_VALUES)).min(clauses.length).max(clauses.length),
  })

  const items = clauses
    .map((c, i) => `${i}. ${c.title}｜${c.content.slice(0, 60).replace(/\s+/g, ' ')}`)
    .join('\n')

  try {
    // 微型分类任务走非思考轻量模型（v4-pro 做这件事要 30~60s，轻量模型 1~3s）
    const model = createChatModel({ temperature: 0, streaming: false, model: config.ai.lightModel })
    const structured = model.withStructuredOutput(TypeArray, { method: 'jsonMode' })
    const { types } = await structured.invoke(
      [
        ['system', '你是合同结构解析器。根据每条条款的标题与开头，从给定枚举中选择最准确的条款类型，按输入顺序返回等长数组。'],
        ['human', `条款列表：\n${items}\n\n可选类型：${TYPE_VALUES.join('、')}`],
      ] as any,
      // 30s 看门狗：超时直接回退词典分类，不阻塞解析
      { callbacks, signal: AbortSignal.timeout(30_000) },
    )
    let changed = 0
    types.forEach((t, i) => {
      if (clauses[i] && clauses[i].clauseType !== t) {
        clauses[i].clauseType = t
        changed++
      }
    })
    logger.info('clause-parser: llm type refine done', { total: clauses.length, changed })
    return changed
  } catch (e) {
    logger.warn('clause-parser: llm refine failed, keep dictionary types', { error: (e as Error).message })
    return 0
  }
}
