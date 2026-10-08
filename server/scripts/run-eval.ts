// server/scripts/run-eval.ts
// 离线评测 Runner：一键跑平台基线评测集，结果落 eval_runs / eval_results，控制台打印指标。
// 运行：
//   npm run eval                         # 跑全部组（FAITHFULNESS 无真实 key 自动 skipped）
//   npm run eval -- --type=RISK_DETECT   # 只跑某一组
//   npm run eval -- --no-llm             # 强制不调用模型（CI 场景）
//   npm run eval -- --with-feedback      # 额外纳入全部租户 source=FEEDBACK 用例（人工反馈飞轮）
//   npm run eval -- --tenant=<租户id>     # 基线 + 指定租户的 FEEDBACK 用例
//
// 指标口径：
//   - RISK_DETECT：按 (case, ruleCode) 集合算 micro TP/FP/FN → precision/recall/F1；
//                  负样本（期望 []）零命中计入 accuracy，任何误报计 FP。
//   - RAG_RECALL：top-k chunk 中出现期望 docId 即 pass，汇总 recall@k。
//   - FAITHFULNESS：LLM-as-Judge 打 0/1，judge 与标注一致即 pass（需要真实 DEEPSEEK_API_KEY）。
import { execSync } from 'node:child_process'
import { PrismaClient, EvalRunStatus } from '@prisma/client'
import { z } from 'zod'
import { splitClauses } from '../src/contract/parsing/clause-parser.js'
import { runRuleEngine } from '../src/contract/rules/rule.engine.js'
import { retrieveFromPg } from '../src/services/rag/pg-store.js'
import { createChatModel } from '../src/services/model.js'
import { config, isValidAiKey } from '../src/config/index.js'
import { TraceService } from '../src/observability/trace.service.js'
import { QuotaService } from '../src/observability/quota.service.js'
import { SAMPLE_CONTRACTS } from '../prisma/fixtures/contracts.js'

const prisma = new PrismaClient()

// 与 review.agent.ts 的用工识别保持一致（决定 scope=LABOR 规则是否参与）
const LABOR_MARKER = /劳动合同|用人单位|劳动者|试用期|竞业限制|社会保险|社保|解除劳动合同|实习生?|员工入职|工资/

// ── 命令行参数 ───────────────────────────────────────────────
const ALL_TYPES = ['RISK_DETECT', 'RAG_RECALL', 'FAITHFULNESS'] as const
type EvalGroupName = (typeof ALL_TYPES)[number]

interface CliArgs {
  types: EvalGroupName[]
  noLlm: boolean
  withAgent: boolean
  withFeedback: boolean
  tenant: string | null
}

function parseArgs(argv: string[]): CliArgs {
  const typeArg = argv.find((a) => a.startsWith('--type='))?.split('=')[1]
  const tenantArg = argv.find((a) => a.startsWith('--tenant='))?.split('=')[1]
  let types: EvalGroupName[] = [...ALL_TYPES]
  if (typeArg) {
    if (!ALL_TYPES.includes(typeArg as EvalGroupName)) {
      console.error(`未知 --type=${typeArg}，可选：${ALL_TYPES.join(', ')}`)
      process.exit(1)
    }
    types = [typeArg as EvalGroupName]
  }
  return {
    types,
    noLlm: argv.includes('--no-llm'),
    withAgent: argv.includes('--with-agent'),
    withFeedback: argv.includes('--with-feedback'),
    tenant: tenantArg || null,
  }
}

function getCommitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return null
  }
}

// ── 输出工具 ─────────────────────────────────────────────────
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function row(tag: string, ok: boolean, name: string, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} [${tag}] ${name}${detail ? `  → ${detail}` : ''}`)
}

function f1(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r)
}

interface ResultDraft {
  caseId: string
  passed: boolean
  score: number
  actual: Record<string, unknown>
  judgeReason: string
  latencyMs: number
}

type GroupSummary = Record<string, unknown>

// ── RISK_DETECT：确定性规则引擎，零成本无 key 可跑 ───────────────
async function runRiskGroup(cases: any[], rules: any[]): Promise<{ summary: GroupSummary; drafts: ResultDraft[] }> {
  console.log('\n=== RISK_DETECT（规则引擎风险检出）===')
  const drafts: ResultDraft[] = []
  let tp = 0
  let fp = 0
  let fn = 0
  let passedCases = 0

  for (const c of cases) {
    const started = Date.now()
    const input = c.input as any
    const expected = c.expected as any

    // 合同文本来源：contractRef 指向 fixtures/contracts.ts，否则用内联 text
    let text: string
    if (input.contractRef) {
      const sc = SAMPLE_CONTRACTS.find((x) => x.id === input.contractRef)
      if (!sc) throw new Error(`case ${c.id} 引用了不存在的 contractRef=${input.contractRef}`)
      text = sc.content
    } else {
      text = String(input.text ?? '')
    }
    const labor = typeof input.labor === 'boolean' ? input.labor : LABOR_MARKER.test(text)

    const parsed = splitClauses(text)
    const clauses = parsed.map((cl, i) => ({ id: String(i), indexNo: i, title: cl.title, content: cl.content }))
    const findings = runRuleEngine(clauses, rules, { labor })

    const actualSet = new Set(findings.map((f) => f.code))
    const expectedSet = new Set<string>(expected.ruleCodes as string[])
    const tpCodes = [...expectedSet].filter((code) => actualSet.has(code))
    const fpCodes = [...actualSet].filter((code) => !expectedSet.has(code))
    const fnCodes = [...expectedSet].filter((code) => !actualSet.has(code))
    const passed = fpCodes.length === 0 && fnCodes.length === 0
    const denom = tpCodes.length + fpCodes.length + fnCodes.length
    const score = denom === 0 ? 1 : tpCodes.length / denom // Jaccard

    tp += tpCodes.length
    fp += fpCodes.length
    fn += fnCodes.length
    if (passed) passedCases++

    const detail = passed
      ? `命中 ${actualSet.size} 类`
      : `FP[${fpCodes.join(',') || '无'}] FN[${fnCodes.join(',') || '无'}]`
    row('RISK', passed, c.title, detail)

    drafts.push({
      caseId: c.id,
      passed,
      score,
      latencyMs: Date.now() - started,
      actual: {
        actualCodes: [...actualSet],
        expectedCodes: [...expectedSet],
        tp: tpCodes,
        fp: fpCodes,
        fn: fnCodes,
        labor,
        clauseCount: clauses.length,
        hits: findings.map((f) => ({ code: f.code, clauseTitle: f.clauseTitle, quote: f.quote.slice(0, 160) })),
      },
      judgeReason: passed ? '规则命中集合与期望完全一致' : `误报 ${fpCodes.length} 条、漏报 ${fnCodes.length} 条`,
    })
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const summary = {
    status: 'done',
    cases: cases.length,
    passed: passedCases,
    accuracy: cases.length ? passedCases / cases.length : 0,
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: f1(precision, recall),
  }
  console.log(
    `  — micro: TP=${tp} FP=${fp} FN=${fn} | precision=${pct(precision)} recall=${pct(recall)} F1=${pct(summary.f1 as number)} | 用例通过率=${pct(summary.accuracy as number)}`,
  )
  return { summary, drafts }
}

// ── RAG_RECALL：法规检索 recall@k（无 embedding key 时走关键词降级）──
async function runRagGroup(cases: any[]): Promise<{ summary: GroupSummary; drafts: ResultDraft[] }> {
  console.log('\n=== RAG_RECALL（法规检索 recall@k）===')
  const drafts: ResultDraft[] = []
  let passedCases = 0
  const defaultK = 3

  for (const c of cases) {
    const started = Date.now()
    const input = c.input as any
    const expected = c.expected as any
    const k = Number(expected.k ?? defaultK)
    const want: string[] = expected.docIds

    const chunks = await retrieveFromPg(prisma as any, String(input.question), { k, docType: 'LEGAL' })
    const docIds = Array.from(new Set(chunks.map((x) => x.docId)))
    const matched = want.filter((id) => docIds.includes(id))
    const passed = matched.length === want.length
    if (passed) passedCases++

    row(
      'RAG',
      passed,
      c.title,
      `top${k} docIds=[${docIds.join(', ')}]${passed ? '' : ` 期望=[${want.join(', ')}]`}`,
    )

    drafts.push({
      caseId: c.id,
      passed,
      score: want.length ? matched.length / want.length : 0,
      latencyMs: Date.now() - started,
      actual: {
        k,
        retrieved: chunks.map((x) => ({ docId: x.docId, title: x.title, score: x.score, mode: x.mode })),
        expectedDocIds: want,
        matched,
      },
      judgeReason: passed ? `期望法规在 top${k} 命中` : `top${k} 未召回到期望法规`,
    })
  }

  const recallAtK = cases.length ? passedCases / cases.length : 0
  const summary = { status: 'done', cases: cases.length, passed: passedCases, k: defaultK, recallAtK }
  console.log(`  — recall@${defaultK}=${pct(recallAtK)}（${passedCases}/${cases.length}）`)
  return { summary, drafts }
}

// ── FAITHFULNESS：LLM-as-Judge（temperature=0）────────────────
const JUDGE_SCHEMA = z.object({
  score: z.union([z.literal(0), z.literal(1)]),
  reason: z.string().min(1),
})

const JUDGE_PROMPT = `你是严谨的 RAG 回答忠实度评审员。请只依据"参考依据"判断"回答"：
- 1 分：回答与参考依据一致，关键事实（数字/期限/主体）无矛盾，且没有编造依据中不存在的结论；
- 0 分：回答与参考依据矛盾，或编造了参考依据不支持的关键事实。
拿不准时按 0 分处理。只返回 JSON：{"score": 0 或 1, "reason": "一句话中文理由"}。`

async function runFaithGroup(
  cases: any[],
  callbacks: any[],
): Promise<{ summary: GroupSummary; drafts: ResultDraft[] }> {
  console.log('\n=== FAITHFULNESS（LLM-as-Judge 回答忠实度）===')
  const model = createChatModel({ temperature: 0, streaming: false }).withStructuredOutput(JUDGE_SCHEMA, {
    name: 'faithfulness_judge',
  })
  const drafts: ResultDraft[] = []
  let passedCases = 0

  for (const c of cases) {
    const started = Date.now()
    const input = c.input as any
    const expected = c.expected as any

    let judge: { score: 0 | 1; reason: string }
    try {
      judge = await model.invoke(
        [
          ['system', JUDGE_PROMPT],
          [
            'human',
            `参考依据：\n${input.context}\n\n问题：${input.question}\n\n回答：${input.answer}`,
          ],
        ] as any,
        { callbacks },
      )
    } catch (e) {
      // 单条评审失败不拖垮整组：记 0 分并写明原因
      judge = { score: 0, reason: `评审调用失败：${(e as Error).message}` }
    }

    const passed = judge.score === expected.faithful
    if (passed) passedCases++
    row('FAITH', passed, c.title, `judge=${judge.score} 标注=${expected.faithful}｜${judge.reason}`)

    drafts.push({
      caseId: c.id,
      passed,
      score: judge.score,
      latencyMs: Date.now() - started,
      actual: { judge: judge.score, expectedFaithful: expected.faithful },
      judgeReason: judge.reason,
    })
  }

  const accuracy = cases.length ? passedCases / cases.length : 0
  const summary = { status: 'done', cases: cases.length, passed: passedCases, accuracy }
  console.log(`  — judge 与标注一致率=${pct(accuracy)}（${passedCases}/${cases.length}）`)
  return { summary, drafts }
}

// ── 主流程 ───────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const withLlm = !args.noLlm && isValidAiKey(config.ai.deepseekKey)
  const commitSha = getCommitSha()

  console.log('ClauseMind 离线评测')
  console.log(`  分组：${args.types.join(', ')}｜LLM：${withLlm ? '启用' : '关闭（无有效 DEEPSEEK_API_KEY 或 --no-llm）'}｜commit：${commitSha ?? '未知'}`)
  if (args.withAgent) {
    console.log('  提示：--with-agent 为预留参数，Agent 轨评测不在 6.1 范围，本次跳过。')
  }

  // 默认只跑平台基线集（tenantId=null，CI 确定性）；--with-feedback / --tenant 纳入人工反馈集
  const feedbackScope = args.tenant
    ? { tenantId: args.tenant }
    : args.withFeedback
      ? {} // 全部租户的 FEEDBACK 用例
      : null
  const cases = await prisma.evalCase.findMany({
    where: {
      active: true,
      type: { in: args.types },
      OR: [{ tenantId: null }, ...(feedbackScope ? [{ source: 'FEEDBACK' as const, ...feedbackScope }] : [])],
    },
    // nulls first：平台基线用例排在租户反馈用例之前
    orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
  })
  const baselineCount = cases.filter((c) => c.tenantId === null).length
  const feedbackCount = cases.length - baselineCount
  if (!baselineCount) {
    console.error('未取到 active 的基线评测用例（tenantId=null），请先执行 npm run seed。')
    process.exit(1)
  }
  console.log(
    `  载入用例 ${cases.length} 条（平台基线 ${baselineCount}${
      feedbackScope ? `，人工反馈 ${feedbackCount}${args.tenant ? `（租户 ${args.tenant}）` : '（全部租户）'}` : ''
    }）`,
  )

  const run = await prisma.evalRun.create({
    data: { status: EvalRunStatus.RUNNING, commitSha, caseCount: 0, passCount: 0 },
  })

  // TraceService 脱离 Nest 容器手工装配；评测过程的 RETRIEVER/LLM 调用同样落 Trace/Span
  const tracer = new TraceService(prisma as any, new QuotaService(prisma as any))
  tracer.onModuleInit()

  const groupSummaries: Record<string, GroupSummary> = {}
  const allDrafts: ResultDraft[] = []

  try {
    await tracer.run({ feature: 'eval', name: `eval-run ${args.types.join('+')}` }, async (handle) => {
      for (const type of args.types) {
        const groupCases = cases.filter((c) => c.type === type)
        if (!groupCases.length) {
          groupSummaries[type] = { status: 'skipped', cases: 0, reason: '该分组无用例' }
          continue
        }

        if (type === 'RISK_DETECT') {
          const rules = await prisma.reviewRule.findMany({ where: { enabled: true } })
          const { summary, drafts } = await runRiskGroup(groupCases, rules)
          groupSummaries[type] = summary
          allDrafts.push(...drafts)
        } else if (type === 'RAG_RECALL') {
          const { summary, drafts } = await runRagGroup(groupCases)
          groupSummaries[type] = summary
          allDrafts.push(...drafts)
        } else if (type === 'FAITHFULNESS') {
          if (!withLlm) {
            const reason = args.noLlm ? '指定了 --no-llm' : '未配置有效 DEEPSEEK_API_KEY'
            groupSummaries[type] = { status: 'skipped', cases: groupCases.length, reason }
            console.log(`\n=== FAITHFULNESS 跳过（${reason}，不阻塞其余分组）===`)
          } else {
            const { summary, drafts } = await runFaithGroup(groupCases, handle.callbacks)
            groupSummaries[type] = summary
            allDrafts.push(...drafts)
          }
        }
      }
    })

    // 明细落库
    for (const d of allDrafts) {
      await prisma.evalResult.create({
        data: {
          runId: run.id,
          caseId: d.caseId,
          passed: d.passed,
          score: d.score,
          actual: d.actual as any,
          judgeReason: d.judgeReason,
          latencyMs: d.latencyMs,
        },
      })
    }

    const passCount = allDrafts.filter((d) => d.passed).length
    const totals = {
      executed: allDrafts.length,
      passed: passCount,
      accuracy: allDrafts.length ? passCount / allDrafts.length : 0,
    }
    const summary = {
      types: args.types,
      withLlm,
      commitSha,
      includeFeedback: feedbackScope !== null,
      feedbackTenant: args.tenant,
      caseCounts: { baseline: baselineCount, feedback: feedbackCount },
      groups: groupSummaries,
      totals,
    }

    await prisma.evalRun.update({
      where: { id: run.id },
      data: {
        status: EvalRunStatus.DONE,
        summary: summary as any,
        caseCount: allDrafts.length,
        passCount,
        finishedAt: new Date(),
      },
    })

    console.log('\n========== 评测汇总 ==========')
    console.log(`  runId=${run.id}`)
    if (groupSummaries.RISK_DETECT?.status === 'done') {
      const s = groupSummaries.RISK_DETECT as any
      console.log(`  RISK_DETECT : precision=${pct(s.precision)} recall=${pct(s.recall)} F1=${pct(s.f1)} (TP=${s.tp} FP=${s.fp} FN=${s.fn})`)
    }
    if (groupSummaries.RAG_RECALL?.status === 'done') {
      const s = groupSummaries.RAG_RECALL as any
      console.log(`  RAG_RECALL  : recall@${s.k}=${pct(s.recallAtK)} (${s.passed}/${s.cases})`)
    }
    if (groupSummaries.FAITHFULNESS) {
      const s = groupSummaries.FAITHFULNESS as any
      console.log(
        s.status === 'done'
          ? `  FAITHFULNESS: judge 一致率=${pct(s.accuracy)} (${s.passed}/${s.cases})`
          : `  FAITHFULNESS: skipped（${s.reason}）`,
      )
    }
    console.log(`  合计通过 ${totals.passed}/${totals.executed}（${pct(totals.accuracy)}）`)
    console.log('EVAL_DONE')
  } catch (err) {
    await prisma.evalRun
      .update({
        where: { id: run.id },
        data: {
          status: EvalRunStatus.FAILED,
          summary: { error: (err as Error).message } as any,
          finishedAt: new Date(),
        },
      })
      .catch(() => {})
    console.error('EVAL_FAILED:', err)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main()
