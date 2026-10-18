// server/src/services/agent/tools.ts
// Agent 工具集：只保留"真工具"——能搜索就真搜索，没配 key 就不暴露给模型；
// 绝不提供"假装发送/假装保存"的工具（模型会学会说谎）。
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { TavilySearchResults } from '@langchain/community/tools/tavily_search'
import { z } from 'zod'
import { evaluate } from 'mathjs'
import type { DatabaseService } from '../../database/database.service.js'
import { config } from '../../config/index.js'
import { logger } from '../../utils/logger.js'
import { getPlanDef } from '../../billing/plans.config.js'

// 函数式模块的 Prisma 句柄（legal_search 用），由 AgentModule 初始化注入
let db: DatabaseService | null = null
export function setToolsDatabase(client: DatabaseService) {
  db = client
}

// ── 工具1：联网搜索（Tavily 真实检索，未配置 key 时不注册）────────
function buildWebSearch(): StructuredToolInterface | null {
  if (!config.ai.tavilyKey) return null
  const t = new TavilySearchResults({ maxResults: 5 })
  // Tavily 默认名/描述对模型不友好，实例化后覆盖为稳定短名
  t.name = 'web_search'
  t.description = '搜索互联网获取最新资讯、法规动态、版本信息。需要最新信息或不确定事实时使用。'
  return t
}

// ── 工具2：知识库检索（公司内部文档）──────────────────────────
const readDocTool = tool(
  async ({ question }) => {
    logger.info('tool:read_doc', { question })
    try {
      const { retrieveDocs } = await import('../rag/query.js')
      const { activeContext } = await import('../../observability/trace-context.js')
      // 显式带出租户，避免工具在异步上下文丢失时退化为全库检索
      const docs = await retrieveDocs(question, { k: 3, tenantId: activeContext()?.tenantId ?? null })
      if (!docs.length) return `知识库中未找到关于"${question}"的相关内容。`
      return docs.map((doc: any, i: number) => `[文档${i + 1}] ${doc.title}：${doc.content}`).join('\n\n')
    } catch {
      return '知识库暂时不可用，请稍后重试。'
    }
  },
  {
    name: 'read_doc',
    description: '从公司知识库检索内部文档。涉及公司规定、产品手册、内部制度时优先使用。',
    schema: z.object({ question: z.string().describe('要查询的问题或关键词') }),
  }
)

// ── 工具3：法规库检索（平台共享法规文本，向量优先/关键词兜底）────
export const legalSearchTool = tool(
  async ({ query }) => {
    logger.info('tool:legal_search', { query })
    if (!db) return '法规库未初始化。'

    // 走统一 PG 检索层（docType=LEGAL 平台共享），检索过程自动落 RETRIEVER Span
    const { retrieveDocs } = await import('../rag/query.js')
    const docs = await retrieveDocs(query, { docType: 'LEGAL' as any, k: 3, tenantId: null })
    if (!docs.length) return `法规库中未检索到与"${query}"相关的条文。`
    return docs
      .map((d: any, i: number) => `[法条${i + 1}] 出自《${d.title}》\n${d.content.slice(0, 600)}`)
      .join('\n\n')
  },
  {
    name: 'legal_search',
    description: '检索平台法规库（民法典、劳动合同法等条文原文）。合同条款合法性、法定上限、强制性规定问题必须先用它查条文，禁止凭记忆引用法条。',
    schema: z.object({ query: z.string().describe('法规关键词，如：违约金 调整、试用期 期限、经济补偿') }),
  }
)

// ── 工具4：数学计算（mathjs 自包含解析，无沙箱逃逸面）──────────
export const calculateTool = tool(
  async ({ expression }) => {
    logger.info('tool:calculate', { expression })
    const safeExpr = expression.trim()
    if (!safeExpr || safeExpr.length > 200) return '无效的数学表达式'
    if (!/^[\d\s+\-*/().,%^a-zA-Z]+$/.test(safeExpr)) return '表达式包含非法字符'
    try {
      return `计算结果：${safeExpr} = ${evaluate(safeExpr)}`
    } catch (e) {
      return `计算失败：${(e as Error).message}`
    }
  },
  {
    name: 'calculate',
    description: '执行精确数学计算（金额合计、比例、百分比、工期）。需要数值结果时使用，不要心算。',
    schema: z.object({ expression: z.string().describe('数学表达式，如 "1500 + 800 * 0.8"' ) }),
  }
)

// ── 工具5：日期计算 ──────────────────────────────────────────
const getDateTool = tool(
  async ({ operation, date1, date2 }) => {
    logger.info('tool:get_date', { operation, date1, date2 })
    const now = new Date()
    if (operation === 'today') {
      return `今天是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日，星期${['日','一','二','三','四','五','六'][now.getDay()]}`
    }
    if (operation === 'diff' && date1 && date2) {
      const d1 = new Date(date1)
      const d2 = new Date(date2)
      if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return '日期格式不正确，请使用 YYYY-MM-DD'
      const diffDays = Math.ceil(Math.abs(d2.getTime() - d1.getTime()) / 86_400_000)
      let workdays = 0
      const [start, end] = d1 < d2 ? [d1, d2] : [d2, d1]
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d.getDay() !== 0 && d.getDay() !== 6) workdays++
      }
      return `${date1} 到 ${date2}：共 ${diffDays} 天，其中工作日 ${workdays} 天`
    }
    if (operation === 'add_days' && date1 && date2) {
      const d = new Date(date1)
      d.setDate(d.getDate() + parseInt(date2, 10))
      return `${date1} 加 ${date2} 天后是 ${d.toISOString().slice(0, 10)}`
    }
    return `今天是 ${now.toISOString().slice(0, 10)}`
  },
  {
    name: 'get_date',
    description: '日期查询与计算：今天日期、两日期间隔（含工作日）、日期加减。',
    schema: z.object({
      operation: z.enum(['today', 'diff', 'add_days']),
      date1: z.string().optional().nullable().describe('YYYY-MM-DD'),
      date2: z.string().optional().nullable().describe('结束日期或天数'),
    }),
  }
)

// ── 业务标签映射（工具输出用中文展示）──────────────────────────
const SCENE_LABELS: Record<string, string> = {
  LABOR: '劳动合同', INTERNSHIP: '实习协议', LEASE: '房屋租赁', SERVICE: '兼职/劳务',
  NDA: '保密协议', SALE: '买卖合同', LOAN: '借款/民间借贷', EQUITY: '股权转让', CUSTOM: '非标合同',
}
const CONTRACT_STATUS_LABELS: Record<string, string> = {
  UPLOADED: '已上传', PARSING: '解析中', READY: '解析完成', REVIEWING: '审查中',
  WAITING_REVIEW: '待人工终审', COMPLETED: '已完成', FAILED: '失败',
}
const SEVERITY_LABELS: Record<string, string> = { HIGH: '高风险', MED: '中风险', LOW: '低风险' }
const RISK_STATUS_LABELS: Record<string, string> = {
  PENDING: '待终审', ACCEPTED: '已确认', IGNORED: '已忽略', EDITED: '已修改',
}
const LEDGER_TYPE_LABELS: Record<string, string> = {
  FIXED_TERM_LABOR: '固定期限劳动合同', OPEN_ENDED_LABOR: '无固定期限劳动合同', SERVICE: '劳务协议',
  INTERNSHIP: '实习协议', NDA: '保密协议', NON_COMPETE: '竞业限制协议', OTHER: '其他',
}

// 取当前租户 ID；业务数据查询必须带租户隔离，取不到就拒绝（不退化为全库）
async function requireTenantId(): Promise<string | null> {
  const { activeContext } = await import('../../observability/trace-context.js')
  return activeContext()?.tenantId ?? null
}

// 枚举参数宽松归一化：模型可能传枚举值、中文标签或大小写变体，统一转标准枚举；无法识别返回 undefined
function normalizeEnum(input: string | null | undefined, aliases: Record<string, string>): string | undefined {
  if (!input) return undefined
  const trimmed = String(input).trim()
  const key = trimmed.toUpperCase()
  if (aliases[key]) return key
  const byLabel = Object.entries(aliases).find(([, label]) => label === trimmed)
  return byLabel?.[0]
}

// ── 工具6：合同档案查询（当前租户的审查记录）────────────────────
const contractQueryTool = tool(
  async ({ keyword, scene, status }) => {
    logger.info('tool:contract_query', { keyword, scene, status })
    if (!db) return '数据库未初始化。'
    const tenantId = await requireTenantId()
    if (!tenantId) return '无法识别当前企业身份，暂时不能查询合同数据。'
    const sceneVal = normalizeEnum(scene, SCENE_LABELS)
    const statusVal = normalizeEnum(status, CONTRACT_STATUS_LABELS)
    if (scene && !sceneVal) return `无法识别的审查场景：${scene}，可选：${Object.values(SCENE_LABELS).join('/')}`
    if (status && !statusVal) return `无法识别的审查状态：${status}，可选：${Object.values(CONTRACT_STATUS_LABELS).join('/')}`
    const where: any = { tenantId }
    if (keyword) where.title = { contains: keyword, mode: 'insensitive' }
    if (sceneVal) where.scene = sceneVal
    if (statusVal) where.status = statusVal
    const rows = await db.contract.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { title: true, scene: true, status: true, clausesCount: true, charCount: true, createdAt: true },
    })
    if (!rows.length) return '没有符合条件的合同档案。'
    const lines = rows.map((c, i) =>
      `${i + 1}. 《${c.title}》[${SCENE_LABELS[c.scene] || c.scene}] 状态：${CONTRACT_STATUS_LABELS[c.status] || c.status}，${c.clausesCount} 条款 / ${c.charCount} 字，上传于 ${c.createdAt.toISOString().slice(0, 10)}`,
    )
    return `共查到 ${rows.length} 份合同（最多展示 20 份）：\n${lines.join('\n')}`
  },
  {
    name: 'contract_query',
    description: '查询当前企业已上传的合同档案清单（标题/审查场景/审查状态/条款数）。用户问"我有哪些合同""某某合同审完了吗"等自有合同时必须用它查真实数据。',
    schema: z.object({
      keyword: z.string().optional().describe('合同标题关键词，可选；不确定时不要传'),
      scene: z.string().optional().describe('按审查场景过滤，可选，如 LABOR/劳动合同、LEASE/房屋租赁'),
      status: z.string().optional().describe('按审查状态过滤，可选，如 WAITING_REVIEW/待人工终审、COMPLETED/已完成'),
    }),
  },
)

// ── 工具7：审查风险查询（跨合同汇总/按合同下钻）─────────────────
const riskQueryTool = tool(
  async ({ contractKeyword, severity, status }) => {
    logger.info('tool:risk_query', { contractKeyword, severity, status })
    if (!db) return '数据库未初始化。'
    const tenantId = await requireTenantId()
    if (!tenantId) return '无法识别当前企业身份，暂时不能查询风险数据。'
    const sevVal = normalizeEnum(severity, SEVERITY_LABELS)
    const statusVal = normalizeEnum(status, RISK_STATUS_LABELS)
    if (severity && !sevVal) return `无法识别的严重程度：${severity}，可选：高/MED/中/低`
    if (status && !statusVal) return `无法识别的处理状态：${status}，可选：${Object.values(RISK_STATUS_LABELS).join('/')}`
    const contractWhere: any = { tenantId }
    if (contractKeyword) contractWhere.title = { contains: contractKeyword, mode: 'insensitive' }
    const where: any = { contract: contractWhere }
    if (sevVal) where.severity = sevVal
    if (statusVal) where.status = statusVal
    const [all, rows] = await Promise.all([
      db.risk.findMany({ where, select: { severity: true } }),
      db.risk.findMany({
        where,
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        take: 20,
        select: {
          severity: true, category: true, title: true, status: true,
          clauseTitle: true, quote: true, contract: { select: { title: true } },
        },
      }),
    ])
    const total = all.length
    if (!total) return '没有符合条件的风险记录（可能尚未审查或风险已全部处理）。'
    // 高中低分布统计，便于模型直接给出概览
    const bySev: Record<string, number> = { HIGH: 0, MED: 0, LOW: 0 }
    for (const r of all) bySev[r.severity] = (bySev[r.severity] || 0) + 1
    const summary = `风险分布：高 ${bySev.HIGH || 0} / 中 ${bySev.MED || 0} / 低 ${bySev.LOW || 0}，共 ${total} 条${total > 20 ? '（以下展示前 20 条）' : ''}：`
    const lines = rows.map((r, i) =>
      `${i + 1}. [${SEVERITY_LABELS[r.severity] || r.severity}] 《${r.contract.title}》${r.clauseTitle || ''}：${r.title}（${RISK_STATUS_LABELS[r.status] || r.status}）｜原文：${r.quote.slice(0, 60)}`,
    )
    return `${summary}\n${lines.join('\n')}`
  },
  {
    name: 'risk_query',
    description: '查询当前企业合同审查发现的风险清单（按严重程度/处理状态/合同关键词过滤，含分布统计）。用户问"有哪些高风险""风险处理完了吗"时使用。',
    schema: z.object({
      contractKeyword: z.string().optional().describe('合同标题关键词，不传则统计全部合同'),
      severity: z.string().optional().describe('按严重程度过滤，可选：HIGH/高、MED/中、LOW/低'),
      status: z.string().optional().describe('按处理状态过滤，可选：PENDING/待终审、ACCEPTED/已确认、IGNORED/已忽略、EDITED/已修改'),
    }),
  },
)

// ── 工具8：员工合同台账查询（到期预警）─────────────────────────
const ledgerQueryTool = tool(
  async ({ days, keyword }) => {
    logger.info('tool:ledger_query', { days, keyword })
    if (!db) return '数据库未初始化。'
    const tenantId = await requireTenantId()
    if (!tenantId) return '无法识别当前企业身份，暂时不能查询台账数据。'
    const where: any = { tenantId, status: 'ACTIVE' }
    if (keyword) {
      where.OR = [
        { employeeName: { contains: keyword, mode: 'insensitive' } },
        { dept: { contains: keyword, mode: 'insensitive' } },
        { position: { contains: keyword, mode: 'insensitive' } },
      ]
    }
    const daysVal = typeof days === 'string' ? parseInt(days, 10) : days
    if (daysVal && daysVal > 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      where.endDate = { gte: now, lte: new Date(now.getTime() + daysVal * 86_400_000) }
    }
    const rows = await db.contractLedger.findMany({
      where,
      orderBy: { endDate: 'asc' },
      take: 30,
      select: { employeeName: true, dept: true, position: true, contractType: true, startDate: true, endDate: true },
    })
    if (!rows.length) return '没有符合条件的台账记录。'
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const lines = rows.map((r, i) => {
      const left = r.endDate ? Math.ceil((r.endDate.getTime() - today.getTime()) / 86_400_000) : null
      return `${i + 1}. ${r.employeeName}${r.dept ? `（${r.dept}${r.position ? '/' + r.position : ''}）` : ''} ${LEDGER_TYPE_LABELS[r.contractType] || r.contractType}，${r.startDate.toISOString().slice(0, 10)} 起${r.endDate ? `，${r.endDate.toISOString().slice(0, 10)} 到期（剩 ${left} 天）` : '，无固定期限'}`
    })
    return `共查到 ${rows.length} 条在职台账（最多展示 30 条）：\n${lines.join('\n')}`
  },
  {
    name: 'ledger_query',
    description: '查询当前企业员工合同台账（姓名/部门/合同类型/起止日期），支持"未来 N 天到期"过滤。用户问"哪些合同快到期""某某的合同什么时候到期"时使用。',
    schema: z.object({
      days: z.union([z.number(), z.string()]).optional().describe('查询未来 N 天内到期的记录，如 30/60/90；不传则查全部在职台账'),
      keyword: z.string().optional().describe('员工姓名/部门/岗位关键词，可选；不确定时不要传'),
    }),
  },
)

// ── 工具9：审查规则查询（平台内置规则 + 企业 Playbook 红线）─────
const ruleLookupTool = tool(
  async ({ keyword }) => {
    logger.info('tool:rule_lookup', { keyword })
    if (!db) return '数据库未初始化。'
    const tenantId = await requireTenantId()
    const kw = keyword ? { contains: keyword, mode: 'insensitive' } : null
    const ruleWhere: any = { enabled: true }
    if (kw) ruleWhere.OR = [{ name: kw }, { description: kw }, { category: kw }]
    const rules = await db.reviewRule.findMany({
      where: ruleWhere,
      orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }],
      take: 30,
      select: { name: true, severity: true, category: true, scope: true, description: true },
    })
    const parts: string[] = []
    if (rules.length) {
      parts.push(`【平台内置审查规则】共 ${rules.length} 条：\n${rules.map((r, i) =>
        `${i + 1}. ${r.name}[${SEVERITY_LABELS[r.severity] || r.severity}]（${r.category}，适用：${r.scope === 'ALL' ? '全部合同' : r.scope === 'LABOR' ? '劳动/用工类' : r.scope}）${r.description || ''}`,
      ).join('\n')}`)
    }
    if (tenantId) {
      const pbWhere: any = { tenantId, enabled: true }
      if (kw) pbWhere.OR = [{ title: kw }, { description: kw }]
      const playbooks = await db.playbookRule.findMany({
        where: pbWhere, orderBy: { createdAt: 'asc' }, take: 20,
        select: { kind: true, title: true, description: true, contractTypes: true },
      })
      if (playbooks.length) {
        const KIND_LABELS: Record<string, string> = {
          FORBIDDEN: '红线规则', PREFERENCE: '偏好口径', STANDARD: '企业标准库', INDUSTRY: '行业专项',
        }
        parts.push(`【本企业自定义规则（Playbook）】共 ${playbooks.length} 条：\n${playbooks.map((p, i) =>
          `${i + 1}. [${KIND_LABELS[p.kind] || p.kind}] ${p.title}${p.description ? `：${p.description}` : ''}`,
        ).join('\n')}`)
      }
    }
    if (!parts.length) return '没有匹配的审查规则。'
    return parts.join('\n\n')
  },
  {
    name: 'rule_lookup',
    description: '查询平台内置的合同审查规则与企业自定义红线规则（Playbook）。用户问"平台会检查哪些问题""我们公司的红线规则"时使用。',
    schema: z.object({
      keyword: z.string().optional().describe('规则名称/类别关键词，如"试用期""违约金"；不传则查全部'),
    }),
  },
)

// ── 工具10：合同范本目录查询（平台标准范本 + 本企业上传的自有范本）──
const templateSearchTool = tool(
  async ({ keyword, scene }) => {
    logger.info('tool:template_search', { keyword, scene })
    const { TEMPLATE_CATALOG } = await import('../../templates/template-catalog.js')
    const sceneVal = normalizeEnum(scene, SCENE_LABELS)
    if (scene && !sceneVal) return `无法识别的场景：${scene}，可选：${Object.values(SCENE_LABELS).join('/')}`
    let items = TEMPLATE_CATALOG
    if (keyword) {
      const k = keyword.toLowerCase()
      items = items.filter((t) =>
        t.title.toLowerCase().includes(k) || t.summary.toLowerCase().includes(k) || t.category.includes(keyword))
    }
    if (sceneVal) items = items.filter((t) => t.scene === sceneVal)

    const parts: string[] = []
    if (items.length) {
      parts.push(`【平台标准范本】共 ${items.length} 份匹配：\n${items.map((t) =>
        `${t.title}（${t.category} / ${SCENE_LABELS[t.scene] || t.scene}）：${t.summary}`,
      ).join('\n')}`)
    }

    // 企业自有范本（tenant_templates）：仅当前租户，标题或正文命中关键词
    if (db) {
      const tenantId = await requireTenantId()
      if (tenantId) {
        const where: any = { tenantId }
        if (keyword) {
          where.OR = [
            { title: { contains: keyword, mode: 'insensitive' } },
            { content: { contains: keyword, mode: 'insensitive' } },
          ]
        }
        const own = await db.tenantTemplate.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { title: true, charCount: true, createdAt: true },
        })
        if (own.length) {
          parts.push(`【本企业自有范本】共 ${own.length} 份匹配：\n${own.map((t, i) =>
            `${i + 1}. ${t.title}（${t.charCount} 字，${t.createdAt.toISOString().slice(0, 10)} 上传）`,
          ).join('\n')}`)
        }
      }
    }

    if (!parts.length) {
      return keyword
        ? `平台范本库与本企业自有范本中都没有匹配"${keyword}"的范本。`
        : '暂无可用的合同范本。'
    }
    return parts.join('\n\n')
  },
  {
    name: 'template_search',
    description: '查询合同范本：平台 16 份标准范本（劳动合同/实习/租赁/买卖/借贷/股权/NDA 等）+ 当前企业自己上传的自有范本。用户问"有没有某某合同范本""推荐个模板""我们公司上传过哪些范本"时使用。',
    schema: z.object({
      keyword: z.string().optional().describe('范本名称/用途关键词，如"实习""租赁""采购"；不传则列全部'),
      scene: z.string().optional().describe('按审查场景过滤（仅对平台范本生效），可选，如 INTERNSHIP/实习协议、LEASE/房屋租赁'),
    }),
  },
)

// 工具10：平台功能与套餐权益问答（数据源 platform_docs 表，按当前租户套餐过滤可见范围）
const platformHelpTool = tool(
  async ({ topic }) => {
    logger.info('tool:platform_help', { topic })
    if (!db) return '平台文档库未初始化。'
    const tenantId = await requireTenantId()
    if (!tenantId) return '无法识别当前身份，暂时不能查询平台文档。'
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } })
    const plan = tenant?.plan ?? 'FREE'
    const docs = await db.platformDoc.findMany({
      where: { enabled: true, plans: { contains: plan } },
      orderBy: { sortOrder: 'asc' },
    })
    if (!docs.length) return '平台文档库为空，请联系管理员运行数据播种。'
    // 关键词匹配：整句包含 或 分词任一命中；无命中时返回目录引导
    const kw = topic.trim().toLowerCase()
    const terms = kw.split(/[\s,，、?？!！.。]+/).filter((t) => t.length >= 2)
    const matched = docs.filter((d) => {
      const hay = `${d.category} ${d.title} ${d.keywords} ${d.content}`.toLowerCase()
      return hay.includes(kw) || terms.some((t) => hay.includes(t))
    })
    const planLabel = getPlanDef(plan).label
    if (!matched.length) {
      return `没有找到与「${topic}」直接相关的文档。以下是${planLabel}可见的全部功能板块目录，可从这些方向继续提问：\n` +
        docs.map((d) => `- 【${d.category}】${d.title}`).join('\n')
    }
    return `以下是${planLabel}下与「${topic}」相关的平台文档（${matched.length} 篇命中，已按相关度展示前 4 篇）：\n\n` +
      matched.slice(0, 4).map((d, i) => `[${i + 1}] 【${d.category}】${d.title}\n${d.content}`).join('\n\n')
  },
  {
    name: 'platform_help',
    description: '查询本平台的功能说明与当前套餐权益（数据来自平台文档库，按用户所在租户的套餐过滤：免费/个人/团队/企业版看到的内容不同）。用户问"XX功能怎么用""我的套餐有什么权益""和 XX 版有什么区别""平台有哪些功能"时使用。',
    schema: z.object({
      topic: z.string().describe('功能/板块/权益关键词，如：台账、深度改写、导出、席位、套餐、法规库'),
    }),
  },
)

/**
 * 构建当前可用工具列表：按环境能力动态注册。
 * 模型看不到不存在能力的工具，避免幻觉调用。
 */
export function buildTools(): StructuredToolInterface[] {
  const tools: (StructuredToolInterface | null)[] = [
    buildWebSearch(),
    readDocTool,
    legalSearchTool,
    contractQueryTool,
    riskQueryTool,
    ledgerQueryTool,
    ruleLookupTool,
    templateSearchTool,
    platformHelpTool,
    calculateTool,
    getDateTool,
  ]
  return tools.filter((t): t is StructuredToolInterface => t !== null)
}

export const TOOL_LABELS: Record<string, string> = {
  web_search: '联网搜索',
  read_doc: '知识库检索',
  legal_search: '法规库检索',
  contract_query: '合同档案查询',
  risk_query: '审查风险查询',
  ledger_query: '合同台账查询',
  rule_lookup: '审查规则查询',
  template_search: '合同范本查询',
  platform_help: '平台功能查询',
  calculate: '数学计算',
  get_date: '日期计算',
}
