// server/src/contract/review/review.agent.ts
// 合同审查双轨工作流（LangGraph + PostgresSaver）：
//   load_clauses → rule_scan（零成本规则保底）→ agent_review（分批语义审查 + 法规工具）
//   → aggregate → [interrupt: 人工终审] → human_review（采纳/忽略/驳回落库）→ finalize（意见书）
// 双轨设计：规则保召回底线且可解释，Agent 抓语义风险并强制引用原文；两者同条命中合并为 BOTH。
import { StateGraph, START, Annotation, interrupt, Command } from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { z } from 'zod'
import type {
  Contract, ReviewTask, Risk, RiskStatus, Severity,
} from '@prisma/client'
import type { DatabaseService } from '../../database/database.service.js'
import { createChatModel } from '../../services/model.js'
import { config as appConfig, isValidAiKey } from '../../config/index.js'
import { legalSearchTool, calculateTool, setToolsDatabase } from '../../services/agent/tools.js'
import { runRuleEngine } from '../rules/rule.engine.js'
import type { EngineRule } from '../rules/rule.engine.js'
import { getCheckpointer } from './checkpointer.js'
import { buildOpinionMarkdown } from './report.js'
import { getFeishuMcpTools } from '../../services/feishu/mcp-client.js'
import { logger } from '../../utils/logger.js'

let db: DatabaseService | null = null
export function setReviewDatabase(client: DatabaseService) {
  db = client
  setToolsDatabase(client)
}

export type ReviewEventFn = (type: string, data: unknown) => void

// ── 图状态 ─────────────────────────────────────────────────────
interface ClauseSnapshot {
  id: string
  indexNo: number
  title: string
  content: string
  clauseType: string
}

interface ReviewState {
  reviewTaskId: string
  contractId: string
  tenantId: string
  reviewerId: string | null
  /** 本次审查是否解锁 Agent 深度轨（深度套餐 / 深度券）；false=仅规则轨（FR-6/12） */
  deep: boolean
  clauses: ClauseSnapshot[]
  decisions: Record<string, { status: RiskStatus; comment: string | null }>
  finalDecision: 'APPROVED' | 'REJECTED' | null
}

const State = Annotation.Root({
  reviewTaskId: Annotation<string>({ reducer: (_: string, n: string) => n, default: () => '' }),
  contractId: Annotation<string>({ reducer: (_: string, n: string) => n, default: () => '' }),
  tenantId: Annotation<string>({ reducer: (_: string, n: string) => n, default: () => '' }),
  reviewerId: Annotation<string | null>({ reducer: (_: unknown, n: string | null) => n, default: () => null }),
  deep: Annotation<boolean>({ reducer: (_: boolean, n: boolean) => n, default: () => false }),
  clauses: Annotation<ClauseSnapshot[]>({ reducer: (_: unknown, n: ClauseSnapshot[]) => n, default: () => [] }),
  decisions: Annotation<Record<string, { status: RiskStatus; comment: string | null }>>({
    reducer: (_: unknown, n: Record<string, { status: RiskStatus; comment: string | null }>) => n,
    default: () => ({}),
  }),
  finalDecision: Annotation<'APPROVED' | 'REJECTED' | null>({
    reducer: (_: unknown, n: 'APPROVED' | 'REJECTED' | null) => n,
    default: () => null,
  }),
})

const BATCH_SIZE = 6
const REVIEW_TOOLS = [legalSearchTool, calculateTool]
const reviewToolNode = new ToolNode(REVIEW_TOOLS)

// 确定性风险评分辅助（个人结果页评分卡，FR-7）
function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}
function scoreLevel(score: number): string {
  if (score >= 85) return '风险较低'
  if (score >= 75) return '存在风险'
  return '风险较高'
}

function emit(cfg: any, type: string, data: unknown) {
  cfg.configurable?.onEvent?.(type, data)
}

// ── 节点1：加载条款（合同条款结构化遍历，零遗漏，不入向量库）──────
async function loadClauses(state: ReviewState) {
  const clauses = await db!.clause.findMany({
    where: { contractId: state.contractId },
    orderBy: { indexNo: 'asc' },
  })
  if (!clauses.length) throw new Error('合同尚未完成条款解析，无法审查')
  return {
    clauses: clauses.map((c) => ({
      id: c.id, indexNo: c.indexNo, title: c.title, content: c.content, clauseType: c.clauseType,
    })),
  }
}

// ── 节点2：规则引擎保底扫描 ───────────────────────────────────
/** 用工类合同识别：决定 LABOR 域规则是否参与（标题或正文出现强用工特征词） */
const LABOR_MARKER = /劳动合同|用人单位|劳动者|试用期|竞业限制|社会保险|社保|解除劳动合同|实习生?|员工入职|工资/

async function ruleScan(state: ReviewState, cfg: any) {
  const [rules, contract, playbookRules] = await Promise.all([
    db!.reviewRule.findMany({ where: { enabled: true } }),
    db!.contract.findUniqueOrThrow({ where: { id: state.contractId }, select: { title: true, scene: true, tenantId: true } }),
    // Playbook 规则严格租户隔离；仅规则拥有方租户的合同受其约束
    db!.playbookRule.findMany({ where: { tenantId: state.tenantId, enabled: true } }),
  ])
  const haystack = contract.title + state.clauses.map((c) => c.title + c.content).join('')
  const labor = LABOR_MARKER.test(haystack)
  const findings = runRuleEngine(
    state.clauses.map((c) => ({ id: c.id, indexNo: c.indexNo, title: c.title, content: c.content })),
    rules,
    { labor },
  )

  // ── Playbook 公司红线/偏好规则并行扫描（FR-17）─────────────────────
  // 合同场景过滤：contractTypes 为空=全类型；'ALL' 通用；否则须包含合同 scene
  const scene = contract.scene || 'LABOR'
  const pbApplicable = playbookRules.filter(
    (r) => !r.contractTypes.length || r.contractTypes.includes('ALL') || r.contractTypes.includes(scene),
  )
  const pbEngineRules: EngineRule[] = pbApplicable.map((r) => {
    const p = (r.pattern ?? {}) as {
      keywords?: string[]; regex?: string | null; severity?: Severity; suggestion?: string
    }
    return {
      id: r.id,
      code: `PB_${r.kind}`,
      name: r.title,
      severity: p.severity ?? (r.kind === 'FORBIDDEN' ? 'HIGH' : 'LOW'),
      category: r.kind === 'FORBIDDEN' ? '公司红线' : '偏好口径',
      description: r.description || r.title,
      suggestion: p.suggestion ?? null,
      legalBasis: null,
      pattern: p.regex ?? null,
      keywords: p.keywords ?? [],
      scope: null,
      sortOrder: 0,
      enabled: true,
    }
  })
  const pbFindings = runRuleEngine(
    state.clauses.map((c) => ({ id: c.id, indexNo: c.indexNo, title: c.title, content: c.content })),
    pbEngineRules,
    { labor: true },
    'PLAYBOOK',
  )
  // 同一规则本次审查命中多条条款，hitCount 只 +1
  const pbHitRuleIds = [...new Set(pbFindings.map((f) => f.ruleId))]

  // 幂等：同一任务重跑时先清旧风险
  await db!.risk.deleteMany({ where: { reviewTaskId: state.reviewTaskId } })
  if (findings.length) {
    await db!.risk.createMany({
      data: findings.map((f) => ({
        reviewTaskId: state.reviewTaskId,
        contractId: state.contractId,
        clauseId: f.clauseId,
        clauseTitle: f.clauseTitle,
        quote: f.quote,
        severity: f.severity,
        category: f.category,
        title: f.title,
        analysis: f.analysis,
        suggestion: f.suggestion,
        legalBasis: f.legalBasis,
        detectedBy: 'RULE' as const,
        ruleId: f.ruleId,
        confidence: 0.95,
      })),
    })
  }
  if (pbFindings.length) {
    await db!.risk.createMany({
      data: pbFindings.map((f) => ({
        reviewTaskId: state.reviewTaskId,
        contractId: state.contractId,
        clauseId: f.clauseId,
        clauseTitle: f.clauseTitle,
        quote: f.quote,
        severity: f.severity,
        category: f.category,
        title: f.title,
        analysis: f.analysis,
        suggestion: f.suggestion,
        legalBasis: null,
        detectedBy: 'PLAYBOOK' as const,
        ruleId: f.ruleId,
        confidence: 0.95,
      })),
    })
    // 命中次数累计（每条规则每次审查 +1，与命中条款数无关）
    await Promise.all(
      pbHitRuleIds.map((id) => db!.playbookRule.updateMany({ where: { id, tenantId: state.tenantId }, data: { hitCount: { increment: 1 } } })),
    )
  }
  emit(cfg, 'stage', { stage: 'rule_scan', message: `规则引擎扫描完成，通用规则命中 ${findings.length} 项、公司红线规则命中 ${pbFindings.length} 项` })
  logger.info('review: rule scan done', {
    taskId: state.reviewTaskId, findings: findings.length, playbookFindings: pbFindings.length,
  })
  return {}
}

// ── 节点3：Agent 语义审查（分批；工具核法条；结构化输出；引用校验）─
const FindingSchema = z.object({
  clauseIndex: z.number().describe('条款序号（输入中的第 N 条，前言为 0）'),
  title: z.string().max(100).describe('风险点的简短标题'),
  severity: z.enum(['HIGH', 'MED', 'LOW']).describe('HIGH=违法/可能导致条款无效或重大损失，MED=权利义务明显失衡，LOW=建议完善'),
  category: z.string().describe('问题分类，从给定分类中选择'),
  quote: z.string().min(10).describe('必须逐字摘自条款原文的连续片段（15~150字），严禁改写或编造'),
  analysis: z.string().describe('为什么构成风险，结合条款原文分析'),
  suggestion: z.string().describe('具体可落地的修改建议'),
  legalBasis: z.string().optional().describe('通过 legal_search 核实到的法条名称与条款号；没检索到就留空，禁止编造'),
})
const FindingsSchema = z.object({ findings: z.array(FindingSchema) })

const CATEGORIES = ['劳动用工', '违约责任', '格式条款', '争议解决', '合同解除', '价款支付', '保密与知识产权', '其他']
const MERGE_KEYWORDS = ['试用期', '工资', '违约金', '押金', '保证金', '证件', '社会保险', '社保', '竞业', '解释权', '管辖', '解除', '免责', '定金', '补偿', '赔偿', '知识产权', '保密']

/** 去空白后定位原文，提取真实引用；模型给的 quote 不落在原文中则判幻觉丢弃 */
function extractVerifiedQuote(original: string, rawQuote: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, '')
  const buildMap = (s: string) => {
    let out = ''
    const map: number[] = []
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) continue
      out += s[i]
      map.push(i)
    }
    return { text: out, map }
  }
  const needle = norm(rawQuote)
  if (needle.length < 8) return null
  const { text, map } = buildMap(original)

  const pos = text.indexOf(needle)
  if (pos >= 0) return original.slice(map[pos], map[pos + needle.length - 1] + 1)

  // 模糊：寻找最长连续公共子串（≥10 字），容忍模型漏字/多字
  for (let len = Math.min(needle.length, 40); len >= 10; len--) {
    for (let i = 0; i <= needle.length - len; i++) {
      const sub = needle.slice(i, i + len)
      const p = text.indexOf(sub)
      if (p >= 0) return '…' + original.slice(map[p], map[p + len - 1] + 1) + '…'
    }
  }
  return null
}

async function agentReview(state: ReviewState, cfg: any) {
  // FREE 未解锁深度：只跑规则轨，不调用模型（不伪造 AI 结论；FR-6/12）
  if (!state.deep) {
    emit(cfg, 'stage', {
      stage: 'agent_skip',
      message: '免费版本次仅运行规则引擎审查；AI 语义审查、法条依据与逐条改稿为个人版/深度券权益',
    })
    return {}
  }

  if (!isValidAiKey(appConfig.ai.deepseekKey)) {
    emit(cfg, 'stage', { stage: 'agent_skip', message: '未配置有效的 DEEPSEEK_API_KEY，本次仅输出规则引擎审查结果（规则轨不受影响）' })
    return {}
  }

  const rules = await db!.reviewRule.findMany({ where: { enabled: true }, orderBy: { sortOrder: 'asc' } })
  const ruleHints = rules.map((r) => `- 【${r.severity}】${r.name}：${r.prompt}`).join('\n')
  const ruleRisks = await db!.risk.findMany({ where: { reviewTaskId: state.reviewTaskId, detectedBy: 'RULE' } })

  const model = createChatModel({ temperature: 0.1, streaming: false })
  const structuredModel = model.withStructuredOutput(FindingsSchema, { name: 'contract_risks' })
  const callbacks: BaseCallbackHandler[] = cfg.configurable?.traceCallbacks ?? []

  // 飞书 P1 MCP 工具：无凭证/加载失败返回 []，不影响审查主链路
  const feishuTools = await getFeishuMcpTools()
  const runTools = [...REVIEW_TOOLS, ...feishuTools]
  const runToolNode = new ToolNode(runTools)

  const systemPrompt = `你是中国执业律师视角的合同风险审查专家。你的输出将用于商业决策，必须极度保守、杜绝编造。

## 审查重点（规则关注面，你需要做语义级判断，而非字面匹配）
${ruleHints}

## 硬性要求
1. 只报告真实存在、对委托方（通常是乙方/劳动者/承租方等弱势一方，依合同角色判断）不利的风险；没问题的条款一律不输出，宁缺毋滥
2. quote 必须逐字复制输入条款中的连续原文片段，严禁改写、拼接或脑补；系统会逐字校验，编造的条目会被丢弃
3. 凡涉及法律强制性规定（期限上限、比例、必备条款、无效情形）必须先调用 legal_search 检索真实法条，把查到的法条名称与条款号写入 legalBasis；检索不到就留空，禁止凭记忆杜撰
4. category 只能从以下分类选择：${CATEGORIES.join('、')}
5. 同一条款可有多个不同风险，但不要重复报告同一问题`

  let accepted = 0
  let dropped = 0

  for (let i = 0; i < state.clauses.length; i += BATCH_SIZE) {
    const batch = state.clauses.slice(i, i + BATCH_SIZE).filter((c) => c.content.trim().length >= 10)
    if (!batch.length) continue

    const batchText = batch
      .map((c) => `【第${c.indexNo}条｜${c.title}｜${c.clauseType}】\n${c.content.slice(0, 1500)}`)
      .join('\n\n')
    emit(cfg, 'stage', {
      stage: 'agent_review',
      message: `AI 语义审查中（${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(state.clauses.length / BATCH_SIZE)} 批）`,
    })

    try {
      // ── 研究循环：模型可调用 legal_search / calculate（最多 3 轮）──
      const messages: any[] = [
        new SystemMessage(systemPrompt),
        new HumanMessage(`请审查以下合同条款，需要法条依据时先检索：\n\n${batchText}`),
      ]
      for (let round = 0; round < 3; round++) {
        const aiMsg = await model.bindTools(runTools).invoke(messages, { callbacks })
        messages.push(aiMsg)
        if (!(aiMsg as any).tool_calls?.length) break
        const toolResult = await runToolNode.invoke({ messages: [aiMsg] }, { callbacks })
        messages.push(...toolResult.messages)
      }

      // ── 结构化抽取 ──
      messages.push(new HumanMessage(
        '现在把你确认的风险按结构化格式输出。只输出经原文核实的风险，每条 quote 必须能在上面的条款原文中逐字找到；没有风险就返回空数组。',
      ))
      const parsed = await structuredModel.invoke(messages, { callbacks }) as z.infer<typeof FindingsSchema>

      for (const f of parsed.findings || []) {
        const clause = batch.find((c) => c.indexNo === f.clauseIndex)
        if (!clause) { dropped++; continue }

        const quote = extractVerifiedQuote(clause.content, f.quote)
        if (!quote) {
          dropped++
          logger.warn('review: agent finding dropped (quote mismatch)', { taskId: state.reviewTaskId, title: f.title })
          continue
        }

        const severity: Severity = ['HIGH', 'MED', 'LOW'].includes(f.severity) ? f.severity : 'MED'
        const category = CATEGORIES.includes(f.category) ? f.category : '其他'

        // 与规则轨去重合并：同条款 + 同分类/同主题词 → 升级为 BOTH
        const dup = ruleRisks.find((r) => r.clauseId === clause.id && (
          r.category === category
          || MERGE_KEYWORDS.some((k) => (r.title + f.title).includes(k) && r.clauseId === clause.id && (r.title.includes(k) || f.title.includes(k)))
        ))
        if (dup && (dup.detectedBy === 'RULE' || dup.detectedBy === 'BOTH')) {
          await db!.risk.update({
            where: { id: dup.id },
            data: {
              detectedBy: 'BOTH',
              confidence: 0.95,
              // AI 提供了更具体的建议/依据时补全规则条目
              suggestion: dup.suggestion || f.suggestion,
              legalBasis: dup.legalBasis || (f.legalBasis || null),
            },
          })
          ruleRisks.splice(ruleRisks.indexOf(dup), 1)
          accepted++
          continue
        }

        const created: Risk = await db!.risk.create({
          data: {
            reviewTaskId: state.reviewTaskId,
            contractId: state.contractId,
            clauseId: clause.id,
            clauseTitle: clause.title,
            quote,
            severity,
            category,
            title: f.title.slice(0, 200),
            analysis: f.analysis,
            suggestion: f.suggestion || null,
            legalBasis: f.legalBasis || null,
            detectedBy: 'AGENT',
            confidence: f.legalBasis ? 0.9 : 0.7,
          },
        })
        accepted++
        emit(cfg, 'risk', serializeRisk(created))
      }
    } catch (e) {
      // 单批失败不拖垮整份审查：规则结果仍可交付
      logger.warn('review: agent batch failed, keep rule results', {
        taskId: state.reviewTaskId, batch: Math.floor(i / BATCH_SIZE) + 1, error: (e as Error).message,
      })
      emit(cfg, 'stage', { stage: 'agent_batch_error', message: `第 ${Math.floor(i / BATCH_SIZE) + 1} 批 AI 审查失败，已跳过` })
    }
  }

  logger.info('review: agent review done', { taskId: state.reviewTaskId, accepted, dropped })
  emit(cfg, 'stage', {
    stage: 'agent_done',
    message: `AI 语义审查完成：新增/确认 ${accepted} 项，引用校验拦截 ${dropped} 项不可靠结论`,
  })
  return {}
}

// ── 节点4：汇总并挂起等待人工终审 ─────────────────────────────
async function aggregate(state: ReviewState, cfg: any) {
  const risks = await db!.risk.findMany({ where: { reviewTaskId: state.reviewTaskId } })
  const stats = {
    total: risks.length,
    high: risks.filter((r) => r.severity === 'HIGH').length,
    med: risks.filter((r) => r.severity === 'MED').length,
    low: risks.filter((r) => r.severity === 'LOW').length,
    rule: risks.filter((r) => r.detectedBy === 'RULE').length,
    agent: risks.filter((r) => r.detectedBy === 'AGENT').length,
    both: risks.filter((r) => r.detectedBy === 'BOTH').length,
    // 确定性风险评分（无模型成本，FREE 可看）：HIGH 扣 14 / MED 扣 8 / LOW 扣 4
    score: clampScore(100 - risks.reduce((s, r) => s + (r.severity === 'HIGH' ? 14 : r.severity === 'MED' ? 8 : 4), 0)),
    scoreLevel: scoreLevel(
      clampScore(100 - risks.reduce((s, r) => s + (r.severity === 'HIGH' ? 14 : r.severity === 'MED' ? 8 : 4), 0)),
    ),
    // 大白话摘要：取高→中最多 3 条，标题 + 规则分析（确定性，不调模型）
    summary: risks
      .slice()
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'HIGH' ? -1 : a.severity === 'MED' && b.severity !== 'HIGH' ? -1 : 1))
      .slice(0, 3)
      .map((r) => ({ title: r.title, text: r.analysis, severity: r.severity })),
    deep: state.deep,
  }
  await db!.reviewTask.update({ where: { id: state.reviewTaskId }, data: { stats: stats as any } })
  await db!.contract.update({ where: { id: state.contractId }, data: { status: 'WAITING_REVIEW' } })
  await db!.reviewTask.update({ where: { id: state.reviewTaskId }, data: { status: 'WAITING_REVIEW' } })
  emit(cfg, 'waiting', { stats })
  return {}
}

// ── 节点5：人工决策落库（interrupt 挂起；Command(resume) 后继续执行本节点）──
interface HumanDecisionPayload {
  actions: Array<{ riskId: string; status: RiskStatus; comment?: string | null }>
  finalDecision: 'APPROVED' | 'REJECTED'
  reviewerId: string
}

async function humanReview(state: ReviewState, cfg: any) {
  // interrupt() 在首次执行时挂起图；恢复时返回 Command({ resume }) 携带的终审数据。
  const payload = interrupt({ stage: 'awaiting_human_decision', reviewTaskId: state.reviewTaskId }) as HumanDecisionPayload

  for (const [riskId, decision] of Object.entries(
    Object.fromEntries((payload.actions || []).map((a) => [a.riskId, { status: a.status, comment: a.comment ?? null }])),
  )) {
    await db!.risk.updateMany({
      where: { id: riskId, reviewTaskId: state.reviewTaskId },
      data: { status: decision.status, reviewerComment: decision.comment },
    })
  }
  const finalDecision = payload.finalDecision
  await db!.reviewTask.update({
    where: { id: state.reviewTaskId },
    data: { status: finalDecision, reviewerId: payload.reviewerId },
  })
  // 驳回 = 退回修改，合同回到可再次发起审查状态
  await db!.contract.update({
    where: { id: state.contractId },
    data: { status: finalDecision === 'APPROVED' ? 'COMPLETED' : 'READY' },
  })
  emit(cfg, 'stage', { stage: 'human_review', message: `人工终审完成：${finalDecision === 'APPROVED' ? '通过' : '驳回'}` })
  return {}
}

// ── 节点6：生成意见书并归档 ───────────────────────────────────
async function finalize(state: ReviewState, cfg: any) {
  const [contract, task, risks] = await Promise.all([
    db!.contract.findUniqueOrThrow({ where: { id: state.contractId } }),
    db!.reviewTask.findUniqueOrThrow({ where: { id: state.reviewTaskId } }),
    db!.risk.findMany({ where: { reviewTaskId: state.reviewTaskId } }),
  ])
  const reportMd = buildOpinionMarkdown(contract, task, risks)
  await db!.contract.update({ where: { id: state.contractId }, data: { reportMd } })
  emit(cfg, 'done', { stats: task.stats, riskCount: risks.length })
  return {}
}

// ── 图编译（checkpointer 单例；interruptBefore 实现持久化 HITL）──
let graphPromise: Promise<any> | null = null
function getGraph() {
  if (!graphPromise) {
    graphPromise = (async () => {
      const checkpointer = await getCheckpointer()
      return new StateGraph(State as any)
        .addNode('load_clauses', loadClauses)
        .addNode('rule_scan', ruleScan)
        .addNode('agent_review', agentReview)
        .addNode('aggregate', aggregate)
        .addNode('human_review', humanReview)
        .addNode('finalize', finalize)
        .addEdge(START, 'load_clauses')
        .addEdge('load_clauses', 'rule_scan')
        .addEdge('rule_scan', 'agent_review')
        .addEdge('agent_review', 'aggregate')
        .addEdge('aggregate', 'human_review')
        .addEdge('human_review', 'finalize')
        // HITL 由节点内 interrupt() 挂起（比 interruptBefore 更精确：恢复时本节点函数会真正执行）
        .compile({ checkpointer } as any)
    })()
  }
  return graphPromise
}

export interface StartReviewParams {
  contract: Contract
  reviewTask: ReviewTask
  /** 是否走 Agent 深度轨（FREE 未解锁时 false→仅规则轨） */
  deep?: boolean
  traceCallbacks?: BaseCallbackHandler[]
  onEvent?: ReviewEventFn
}

/** 发起审查：跑到人工终审节点前挂起（状态持久化在 PG checkpoint） */
export async function startReview(params: StartReviewParams): Promise<void> {
  if (!db) throw new Error('审查模块数据库未初始化')
  const graph = await getGraph()
  const { contract, reviewTask } = params

  await db.contract.update({ where: { id: contract.id }, data: { status: 'REVIEWING' } })

  const stream = await graph.stream(
    {
      reviewTaskId: reviewTask.id,
      contractId: contract.id,
      tenantId: contract.tenantId,
      deep: params.deep ?? reviewTask.isDeep,
    },
    {
      configurable: {
        thread_id: reviewTask.threadId,
        onEvent: params.onEvent ?? (() => {}),
        traceCallbacks: params.traceCallbacks ?? [],
      },
      callbacks: params.traceCallbacks,
      streamMode: 'updates',
    },
  )
  for await (const _chunk of stream) {
    // 进度通过 onEvent 实时推送；chunk 本身无需处理
  }
}

export interface ResumeReviewParams {
  reviewTask: ReviewTask
  actions: Array<{ riskId: string; status: RiskStatus; comment?: string | null }>
  finalDecision: 'APPROVED' | 'REJECTED'
  reviewerId: string
  traceCallbacks?: BaseCallbackHandler[]
  onEvent?: ReviewEventFn
}

/** 恢复审查：把人工决策写入 checkpoint 状态，继续执行 human_review → finalize */
export async function resumeReview(params: ResumeReviewParams): Promise<void> {
  if (!db) throw new Error('审查模块数据库未初始化')
  const graph = await getGraph()
  const config: any = {
    configurable: {
      thread_id: params.reviewTask.threadId,
      onEvent: params.onEvent ?? (() => {}),
      traceCallbacks: params.traceCallbacks ?? [],
    },
  }

  // Command({ resume }) 把终审数据作为 interrupt() 的返回值送入，human_review 节点函数恢复执行
  const stream = await graph.stream(
    new Command({
      resume: {
        actions: params.actions,
        finalDecision: params.finalDecision,
        reviewerId: params.reviewerId,
      },
    }),
    { ...config, callbacks: params.traceCallbacks, streamMode: 'updates' },
  )
  for await (const _chunk of stream) {
    // 同上
  }
}

/** 风险行序列化（Prisma Decimal/Date 安全转 JSON） */
export function serializeRisk(r: Risk) {
  return {
    id: r.id,
    clauseId: r.clauseId,
    clauseTitle: r.clauseTitle,
    quote: r.quote,
    severity: r.severity,
    category: r.category,
    title: r.title,
    analysis: r.analysis,
    suggestion: r.suggestion,
    legalBasis: r.legalBasis,
    rewritten: r.rewritten,
    revisionStatus: r.revisionStatus,
    detectedBy: r.detectedBy,
    confidence: r.confidence,
    status: r.status,
    reviewerComment: r.reviewerComment,
  }
}
