// server/scripts/sync-feedback.ts
// 人工反馈飞轮：把终审处置沉淀为 source=FEEDBACK 的 RISK_DETECT 评测用例（按租户隔离）。
// 独立脚本，手动/定时执行，不耦合审查主链路；重复执行幂等（按 tags 中的关联标记 upsert/停用）。
//
// 沉淀规则：
//   1. 误报负样本：被 IGNORED 的规则风险（detectedBy=RULE/BOTH，ruleId 可映射 code）
//      → expected.ruleCodes 为同条款被采纳规则 code 集合（不含被忽略 code）
//   2. 漏报正样本：被反复采纳的 Agent-only 风险（detectedBy=AGENT），能按分类+关键词
//      映射到某条现有规则、且规则引擎当前确实漏命中 → expected.ruleCodes 含该 code
//
// 运行：
//   npm run sync:feedback                    # 正式执行
//   npm run sync:feedback -- --dry-run       # 只打印不落库
//   npm run sync:feedback -- --tenant=<id>   # 只处理某租户
//   npm run sync:feedback -- --min-repeat=2  # Agent 漏报需同租户同规则被采纳次数阈值（默认 2）
import { PrismaClient } from '@prisma/client'
import { runRuleEngine } from '../src/contract/rules/rule.engine.js'

const prisma = new PrismaClient()

// 与 run-eval.ts / review.agent.ts 的用工识别保持一致
const LABOR_MARKER = /劳动合同|用人单位|劳动者|试用期|竞业限制|社会保险|社保|解除劳动合同|实习生?|员工入职|工资/

const RISK_TAG = (riskId: string) => `risk:${riskId}`
const GAP_TAG = (tenantId: string, code: string) => `agentgap:${tenantId}:${code}`

interface CliArgs {
  dryRun: boolean
  tenantId: string | null
  minRepeat: number
}

function parseArgs(argv: string[]): CliArgs {
  const tenantArg = argv.find((a) => a.startsWith('--tenant='))?.split('=')[1]
  const repeatArg = argv.find((a) => a.startsWith('--min-repeat='))?.split('=')[1]
  return {
    dryRun: argv.includes('--dry-run'),
    tenantId: tenantArg || null,
    minRepeat: repeatArg ? Number(repeatArg) : 2,
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

// PG jsonb 会按键长+字典序规范化键序，比较内容时须先稳定序列化，否则每次都会误判为"有更新"
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
    }
    return val
  })
}

// 幂等关联标记：取 tags 中的 risk:/agentgap: 原始串作为对账键
function markerOf(tags: string[]): string | null {
  return tags.find((t) => t.startsWith('risk:')) ?? tags.find((t) => t.startsWith('agentgap:')) ?? null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('ClauseMind 反馈飞轮同步')
  console.log(
    `  模式：${args.dryRun ? 'DRY-RUN（不落库）' : '正式同步'}｜租户：${args.tenantId ?? '全部'}｜Agent 漏报阈值：${args.minRepeat} 次`,
  )

  // ── 1. 读取已终审风险（含条款与任务租户）─────────────────────
  const risks = await prisma.risk.findMany({
    where: {
      status: { in: ['IGNORED', 'ACCEPTED', 'EDITED'] },
      clauseId: { not: null },
      ...(args.tenantId ? { reviewTask: { tenantId: args.tenantId } } : {}),
    },
    include: { clause: true, reviewTask: true },
  })
  console.log(`  已终审且有条款的风险：${risks.length} 条`)

  if (!risks.length) {
    console.log('没有可沉淀的反馈，退出。')
    await prisma.$disconnect()
    return
  }

  const rules = await prisma.reviewRule.findMany()
  const ruleById = new Map(rules.map((r) => [r.id, r]))

  // 同任务同条款的兄弟风险，用于精确构造期望集合
  const siblingsOf = (risk: (typeof risks)[number]) =>
    risks.filter(
      (r) =>
        r.id !== risk.id &&
        r.reviewTaskId === risk.reviewTaskId &&
        r.clauseId === risk.clauseId,
    )

  // ── 2. 误报负样本：IGNORED 的规则风险 ────────────────────────
  interface DesiredCase {
    marker: string
    tenantId: string
    type: 'RISK_DETECT'
    title: string
    input: Record<string, unknown>
    expected: Record<string, unknown>
    tags: string[]
  }

  const desired = new Map<string, DesiredCase>()

  for (const risk of risks) {
    if (risk.status !== 'IGNORED') continue
    if (risk.detectedBy === 'AGENT' || !risk.ruleId) continue
    const rule = ruleById.get(risk.ruleId)
    if (!rule || !risk.clause) continue

    // 同条款被采纳的规则风险 code = 该条款真正应命中的规则集合
    const acceptedCodes = new Set<string>()
    for (const sib of siblingsOf(risk)) {
      if (sib.status === 'IGNORED' || !sib.ruleId) continue
      const sibRule = ruleById.get(sib.ruleId)
      if (sibRule) acceptedCodes.add(sibRule.code)
    }
    acceptedCodes.delete(rule.code)

    const text = risk.clause.content
    const labor = LABOR_MARKER.test(text)
    const noteParts = [`人工终审标记误报：${rule.code}`]
    if (risk.reviewerComment) noteParts.push(`备注：${risk.reviewerComment}`)
    noteParts.push(`来源风险 ${risk.id}（${risk.detectedBy}）`)

    desired.set(RISK_TAG(risk.id), {
      marker: RISK_TAG(risk.id),
      tenantId: risk.reviewTask.tenantId,
      type: 'RISK_DETECT',
      title: clip(`误报反馈·${rule.code}｜${risk.clause.title || risk.clauseTitle || '未命名条款'}`, 200),
      input: { text, labor },
      expected: { ruleCodes: [...acceptedCodes], note: noteParts.join('；') },
      tags: ['feedback', 'negative', rule.code, RISK_TAG(risk.id), `task:${risk.reviewTaskId}`],
    })
  }

  // ── 3. 漏报正样本：被反复采纳的 Agent-only 风险 ───────────────
  // 映射规则：同分类 + 规则关键词出现在风险 quote/title 中；且当前引擎对该条款确实漏报。
  const agentRisks = risks.filter((r) => r.status !== 'IGNORED' && r.detectedBy === 'AGENT')
  // (tenantId, code) → 命中该映射的风险（取最新一条的条款生成用例）
  const gapGroups = new Map<string, { tenantId: string; code: string; risks: typeof agentRisks }>()

  for (const risk of agentRisks) {
    if (!risk.clause) continue
    const text = risk.clause.content
    const labor = LABOR_MARKER.test(text)
    const haystack = `${risk.title}\n${risk.quote}\n${risk.clause.title}`

    const findings = runRuleEngine(
      [{ id: risk.clause.id, indexNo: risk.clause.indexNo, title: risk.clause.title, content: text }],
      rules,
      { labor },
    )
    const firedCodes = new Set(findings.map((f) => f.code))

    // 候选规则：同分类、启用、scope 适用、关键词命中、引擎当前漏命中
    const candidates = rules.filter((r) => {
      if (!r.enabled || r.category !== risk.category) return false
      if (r.scope === 'LABOR' && !labor) return false
      if (firedCodes.has(r.code)) return false
      return r.keywords.some((kw) => kw && haystack.includes(kw))
    })
    if (!candidates.length) continue

    // 取命中关键词数最多的规则作为映射目标
    candidates.sort(
      (a, b) =>
        b.keywords.filter((kw) => haystack.includes(kw)).length -
        a.keywords.filter((kw) => haystack.includes(kw)).length,
    )
    const code = candidates[0].code
    const key = `${risk.reviewTask.tenantId}::${code}`
    const group = gapGroups.get(key) ?? { tenantId: risk.reviewTask.tenantId, code, risks: [] }
    group.risks.push(risk)
    gapGroups.set(key, group)
  }

  for (const group of gapGroups.values()) {
    if (group.risks.length < args.minRepeat) continue
    // 最新采纳的一条
    const picked = group.risks.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b))
    if (!picked.clause) continue

    const acceptedCodes = new Set<string>()
    for (const sib of siblingsOf(picked)) {
      if (sib.status === 'IGNORED' || !sib.ruleId) continue
      const sibRule = ruleById.get(sib.ruleId)
      if (sibRule) acceptedCodes.add(sibRule.code)
    }
    acceptedCodes.add(group.code)

    const text = picked.clause.content
    desired.set(GAP_TAG(group.tenantId, group.code), {
      marker: GAP_TAG(group.tenantId, group.code),
      tenantId: group.tenantId,
      type: 'RISK_DETECT',
      title: clip(`漏报反馈·${group.code}｜${picked.clause.title || picked.clauseTitle || '未命名条款'}`, 200),
      input: { text, labor: LABOR_MARKER.test(text) },
      expected: {
        ruleCodes: [...acceptedCodes],
        note: `人工 ${group.risks.length} 次采纳 Agent 风险但规则未命中：${group.code}；来源风险 ${group.risks
          .map((r) => r.id)
          .slice(0, 5)
          .join(',')}`,
      },
      tags: ['feedback', 'positive', 'agent-gap', group.code, GAP_TAG(group.tenantId, group.code)],
    })
  }

  // ── 4. 对账：upsert 应存在的，停用已不成立的 ──────────────────
  const existing = await prisma.evalCase.findMany({
    where: {
      source: 'FEEDBACK',
      type: 'RISK_DETECT',
      ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    },
  })
  const existingByMarker = new Map<string, (typeof existing)[number]>()
  for (const c of existing) {
    const m = markerOf(c.tags)
    if (m) existingByMarker.set(m, c)
  }

  let created = 0
  let updated = 0
  let deactivated = 0

  for (const d of desired.values()) {
    const found = existingByMarker.get(d.marker)
    const payload = {
      type: d.type as const,
      title: d.title,
      input: d.input as any,
      expected: d.expected as any,
      tags: d.tags,
      source: 'FEEDBACK' as const,
      tenantId: d.tenantId,
    }
    if (!found) {
      console.log(`  + 新增 ${d.title}（${d.tags[1]}）`)
      if (!args.dryRun) await prisma.evalCase.create({ data: { ...payload, active: true } })
      created++
    } else {
      if (
        !found.active ||
        found.title !== d.title ||
        stable(found.input) !== stable(d.input) ||
        stable(found.expected) !== stable(d.expected) ||
        JSON.stringify(found.tags) !== JSON.stringify(d.tags)
      ) {
        console.log(`  ~ 更新 ${d.title}`)
        if (!args.dryRun) await prisma.evalCase.update({ where: { id: found.id }, data: { ...payload, active: true } })
        updated++
      }
    }
  }

  // 已不成立（风险被翻案/删除，或漏报采纳次数跌回阈值下）→ 停用而非删除（保留历史 EvalResult）
  for (const c of existing) {
    const marker = markerOf(c.tags)
    if (!marker || desired.has(marker)) continue
    if (c.active) {
      console.log(`  - 停用 ${c.title}（反馈前提已不成立）`)
      if (!args.dryRun) await prisma.evalCase.update({ where: { id: c.id }, data: { active: false } })
      deactivated++
    }
  }

  console.log(
    `\n同步完成：新增 ${created}，更新 ${updated}，停用 ${deactivated}（误报负样本 ${[...desired.values()].filter(
      (d) => d.tags.includes('negative'),
    ).length} 条，漏报正样本 ${[...desired.values()].filter((d) => d.tags.includes('positive')).length} 条）${
      args.dryRun ? ' [DRY-RUN]' : ''
    }`,
  )
  console.log('SYNC_FEEDBACK_DONE')
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('SYNC_FEEDBACK_FAILED:', e)
  process.exitCode = 1
})
