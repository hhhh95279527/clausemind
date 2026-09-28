// server/src/contract/rules/rule.engine.ts
// 声明式规则引擎：对每条条款零成本确定性扫描，产出 RULE 来源风险，保证召回底线。
// 命中必须带原文句子作为 quote —— 规则轨同样不允许"无中生有"。
import type { ReviewRule, Severity } from '@prisma/client'

export interface EngineClause {
  id: string
  indexNo: number
  title: string
  content: string
}

export interface RuleFinding {
  ruleId: string
  code: string
  severity: Severity
  category: string
  title: string
  clauseId: string
  clauseTitle: string
  quote: string
  analysis: string
  suggestion: string | null
  legalBasis: string | null
  /** GENERAL=平台通用规则；PLAYBOOK=租户公司红线/偏好（FR-17） */
  source: 'GENERAL' | 'PLAYBOOK'
}

/**
 * 声明式扫描所需的最小规则结构（ReviewRule 天然满足；
 * Playbook 规则由适配层把 pattern JSON 摊平成该形状后并行入引擎）。
 */
export interface EngineRule {
  id: string
  code: string
  name: string
  severity: Severity
  category: string
  description?: string | null
  suggestion?: string | null
  legalBasis?: string | null
  pattern?: string | null
  keywords?: string[] | null
  scope?: string | null
  sortOrder?: number
  enabled: boolean
}

const MAX_QUOTE = 220

/** 取命中位置所在句子（中文按句号/分号/换行切分），作为原文引用 */
function quoteSentence(content: string, matchIndex: number): string {
  const breaks = new Set(['。', '；', '！', '？', '\n', '!', ';'])
  let start = matchIndex
  let end = matchIndex
  while (start > 0 && !breaks.has(content[start - 1])) start--
  while (end < content.length && !breaks.has(content[end])) end++
  const sentence = content.slice(start, end === content.length ? end : end + 1).trim()
  if (sentence.length <= MAX_QUOTE) return sentence
  // 过长：以命中点为中心截取
  const center = Math.max(0, matchIndex - start - 80)
  return '…' + sentence.slice(center, center + MAX_QUOTE) + '…'
}

function ruleHits(rule: ReviewRule, content: string): number {
  if (rule.pattern) {
    try {
      const re = new RegExp(rule.pattern, 'm')
      const m = re.exec(content)
      if (m) return m.index
    } catch {
      // 规则配置错误不拖垮整份审查，降级为关键词判定
    }
  }
  if (rule.keywords?.length) {
    const allPresent = rule.keywords.every((kw) => kw && content.includes(kw))
    if (allPresent) {
      return content.indexOf(rule.keywords.find((kw) => content.includes(kw))!)
    }
  }
  return -1
}

export interface EngineOptions {
  /** 合同是否属于劳动/用工类（决定 scope=LABOR 规则是否参与） */
  labor?: boolean
}

export interface RuleTryMatch {
  index: number
  quote: string
}

export interface RuleTryResult {
  hit: boolean
  /** 实际命中方式：pattern=正则命中；keywords=正则缺失/未命中后关键词全包含命中；null=未命中 */
  mode: 'pattern' | 'keywords' | null
  /** 正则编译错误（此时引擎在线上会静默降级为关键词判定，试运行显式暴露） */
  regexError: string | null
  matches: RuleTryMatch[]
}

/**
 * 试运行单条规则（不落库）：对一段文本扫描，返回全部命中位置与原文引用。
 * 命中优先级与线上 runRuleEngine 完全一致：pattern 优先；正则非法/未命中则降级关键词。
 */
export function tryRuleOnText(
  rule: Pick<ReviewRule, 'pattern' | 'keywords'>,
  content: string,
): RuleTryResult {
  const result: RuleTryResult = { hit: false, mode: null, regexError: null, matches: [] }

  if (rule.pattern) {
    let re: RegExp | null = null
    try {
      re = new RegExp(rule.pattern, 'gm')
    } catch (e) {
      result.regexError = (e as Error).message
    }
    if (re) {
      const indexes: number[] = []
      let m: RegExpExecArray | null
      let guard = 0
      while ((m = re.exec(content)) !== null && guard < 200) {
        indexes.push(m.index)
        if (m.index === re.lastIndex) re.lastIndex++ // 防零宽匹配死循环
        guard++
      }
      if (indexes.length) {
        result.hit = true
        result.mode = 'pattern'
        result.matches = indexes.map((index) => ({ index, quote: quoteSentence(content, index) }))
        return result
      }
    }
  }

  if (rule.keywords?.length) {
    const kws = rule.keywords.filter((kw) => kw)
    if (kws.length && kws.every((kw) => content.includes(kw))) {
      result.hit = true
      result.mode = 'keywords'
      result.matches = kws
        .map((kw) => content.indexOf(kw))
        .filter((i) => i >= 0)
        .map((index) => ({ index, quote: quoteSentence(content, index) }))
    }
  }

  return result
}

export function runRuleEngine(
  clauses: EngineClause[],
  rules: EngineRule[],
  opts: EngineOptions = {},
  source: 'GENERAL' | 'PLAYBOOK' = 'GENERAL',
): RuleFinding[] {
  const findings: RuleFinding[] = []
  const enabled = rules
    .filter((r) => r.enabled && (r.scope !== 'LABOR' || opts.labor))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))

  for (const clause of clauses) {
    for (const rule of enabled) {
      const idx = ruleHits(rule as ReviewRule, clause.content)
      if (idx < 0) continue

      findings.push({
        ruleId: rule.id,
        code: rule.code,
        severity: rule.severity,
        category: rule.category,
        title: rule.name,
        clauseId: clause.id,
        clauseTitle: clause.title,
        quote: quoteSentence(clause.content, idx),
        analysis: rule.description || rule.name,
        suggestion: rule.suggestion ?? null,
        legalBasis: rule.legalBasis ?? null,
        source,
      })
    }
  }
  return findings
}
