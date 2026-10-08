// server/src/contract/review/revision.service.ts
// AI 改稿台（FR-9）：基于本次审查风险生成「原句 / 改写 / 理由」结构化修订建议。
// - 复用 risks 表：rewritten + revisionStatus(NONE/PENDING/ACCEPTED/REJECTED)，不新增表
// - 深度权益：深度套餐或本份审查以深度券解锁（task.isDeep）才可生成/导出
// - 无 DEEPSEEK Key 时 503 降级提示；Word 导出走 docx 真·修订模式（w:ins/w:del 痕迹）
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import type { Response } from 'express'
import { z } from 'zod'
import {
  Document, Packer, Paragraph, HeadingLevel, TextRun,
  InsertedTextRun, DeletedTextRun,
} from 'docx'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { Risk, ReviewTask } from '@prisma/client'
import { DatabaseService } from '../../database/database.service.js'
import { EntitlementsService } from '../../billing/entitlements.service.js'
import { QuotaService } from '../../observability/quota.service.js'
import { createChatModel } from '../../services/model.js'
import { config as appConfig, isValidAiKey } from '../../config/index.js'
import { PlanLimitException } from '../../billing/plan-limit.exception.js'
import { logger } from '../../utils/logger.js'

const RevisionItemSchema = z.object({
  index: z.number().describe('风险序号（输入中的第 N 条，从 0 开始）'),
  original: z.string().describe('需要替换的原句，必须摘自输入中的风险原文片段'),
  rewritten: z.string().describe('可直接替换进合同的改写句，正式书面中文，一句话到一段话'),
  reason: z.string().max(120).describe('修改理由，60 字以内，可点出法条依据'),
})
const RevisionsSchema = z.object({ items: z.array(RevisionItemSchema) })

export type RevisionStatusValue = 'NONE' | 'PENDING' | 'ACCEPTED' | 'REJECTED'

@Injectable()
export class RevisionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly quota: QuotaService,
  ) {}

  /** 取合同最近一次审查任务（含风险） */
  private async load(tenantId: string, contractId: string) {
    const contract = await this.db.contract.findFirst({
      where: { id: contractId, tenantId },
      include: {
        clauses: { orderBy: { indexNo: 'asc' } },
        reviewTasks: { orderBy: { createdAt: 'desc' }, take: 1, include: { risks: { orderBy: { createdAt: 'asc' } } } },
      },
    })
    if (!contract) throw new NotFoundException('合同不存在')
    const task = contract.reviewTasks[0]
    return { contract, task: task ?? null, risks: task?.risks ?? [], clauses: contract.clauses }
  }

  /** 深度门禁：个人版及以上，或本份审查用深度券解锁 */
  private assertDeep(task: ReviewTask | null, plan: string) {
    if (task?.isDeep || this.entitlements.isDeep(plan)) return
    throw new PlanLimitException('DEEP_FEATURE', 'AI 多轮改稿为个人版权益，请开通个人版或使用 1 张深度券解锁本份合同', 'deep')
  }

  /** 取风险项并经 reviewTask→contract 校验租户归属（risks 表无 tenantId 列） */
  private async loadRiskForTenant(tenantId: string, riskId: string) {
    const risk = await this.db.risk.findFirst({
      where: {
        id: riskId,
        reviewTask: { contract: { tenantId } },
      },
    })
    if (!risk) throw new NotFoundException('风险项不存在')
    const task = await this.db.reviewTask.findUniqueOrThrow({ where: { id: risk.reviewTaskId } })
    return { risk, task }
  }

  /** 改稿台数据：合同/任务/风险（含修订字段） */
  async list(tenantId: string, contractId: string, plan: string) {
    const { contract, task, risks } = await this.load(tenantId, contractId)
    return {
      deep: !!(task?.isDeep || this.entitlements.isDeep(plan)),
      contract: { id: contract.id, title: contract.title, status: contract.status },
      reviewTaskId: task?.id ?? null,
      generated: risks.some((r) => !!r.rewritten),
      acceptedCount: risks.filter((r) => r.revisionStatus === 'ACCEPTED').length,
      revisions: risks.map((r, i) => ({
        index: i,
        id: r.id,
        severity: r.severity,
        clauseTitle: r.clauseTitle,
        quote: r.quote,
        title: r.title,
        analysis: r.analysis,
        suggestion: r.suggestion,
        legalBasis: r.legalBasis,
        rewritten: r.rewritten,
        reason: r.revisionStatus === 'NONE' ? null : (r.suggestion || r.legalBasis || r.analysis).slice(0, 120),
        revisionStatus: r.revisionStatus,
      })),
    }
  }

  /** 为全部风险生成修订建议（幂等：已生成则直接返回，除非 force） */
  async generate(tenantId: string, contractId: string, plan: string, force = false) {
    const { task, risks } = await this.load(tenantId, contractId)
    this.assertDeep(task, plan)
    const targets = risks.filter((r) => force || !r.rewritten)
    if (!risks.length) {
      throw new NotFoundException('本次审查未发现风险，无需生成修订稿')
    }
    if (!targets.length) return this.list(tenantId, contractId, plan)
    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ServiceUnavailableException('AI 模型未配置（DEEPSEEK_API_KEY 缺失），无法生成改写建议；规则审查结果不受影响')
    }
    await this.quota.assert(tenantId)

    const parsed = await this.invokeRevisions(
      targets.map((r) => ({
        clauseTitle: r.clauseTitle || '',
        quote: r.quote,
        suggestion: r.suggestion || '',
        legalBasis: r.legalBasis || '',
      })),
    )

    for (const item of parsed.items || []) {
      const risk = targets[item.index]
      if (!risk || !item.rewritten?.trim() || !item.original?.trim()) continue
      // 原文必须与风险 quote 高度一致（防模型编造锚点）
      if (!risk.quote.replace(/\s+/g, '').includes(item.original.replace(/\s+/g, '').slice(0, 12))) continue
      await this.db.risk.update({
        where: { id: risk.id },
        data: {
          rewritten: item.rewritten.slice(0, 1000),
          revisionStatus: 'PENDING',
          // 把理由并入 suggestion（复用既有字段，供导出与结果页展示）
          suggestion: item.reason ? `修改建议：${item.reason}` : risk.suggestion,
        },
      })
    }
    logger.info('revision: generated', { contractId, count: parsed.items?.length ?? 0 })
    return this.list(tenantId, contractId, plan)
  }

  /** 接受 / 拒绝 / 重置单条修订 */
  async setStatus(tenantId: string, riskId: string, status: RevisionStatusValue) {
    if (!['PENDING', 'ACCEPTED', 'REJECTED'].includes(status)) {
      throw new BadRequestException('修订状态不合法')
    }
    const { risk } = await this.loadRiskForTenant(tenantId, riskId)
    if (!risk.rewritten) throw new BadRequestException('该风险尚未生成改写建议')
    await this.db.risk.update({ where: { id: riskId }, data: { revisionStatus: status } })
    return { id: riskId, revisionStatus: status }
  }

  /** 全部接受（仅 PENDING/REJECTED → ACCEPTED） */
  async acceptAll(tenantId: string, contractId: string) {
    const { task, risks } = await this.load(tenantId, contractId)
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    this.assertDeep(task, tenant.plan)
    const ids = risks.filter((r) => !!r.rewritten).map((r) => r.id)
    if (ids.length) {
      await this.db.risk.updateMany({ where: { id: { in: ids } }, data: { revisionStatus: 'ACCEPTED' } })
    }
    return { accepted: ids.length }
  }

  /** 重新生成单条（可指定语气：FIRM 更强硬 / GENTLE 更温和） */
  async regenerate(tenantId: string, riskId: string, tone: 'FIRM' | 'GENTLE' | 'NEUTRAL' = 'NEUTRAL') {
    const { risk, task } = await this.loadRiskForTenant(tenantId, riskId)
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    this.assertDeep(task, tenant.plan)
    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ServiceUnavailableException('AI 模型未配置，重新生成暂不可用')
    }
    await this.quota.assert(tenantId)

    const model = createChatModel({ temperature: 0.3, streaming: false })
      .withStructuredOutput(RevisionItemSchema, { name: 'one_revision' })
    const toneHint = tone === 'FIRM'
      ? '措辞在合法范围内更强硬、不留模糊空间'
      : tone === 'GENTLE'
        ? '措辞温和、给对方留余地，便于协商接受'
        : '措辞中立专业'
    const item = await model.invoke([
      new SystemMessage(`你是中国合同律师。把合同中对弱势一方不利的原句改写为公平合法、可直接替换的书面条款。${toneHint}。输出结构化字段。`),
      new HumanMessage(`条款：${risk.clauseTitle || ''}\n原句：${risk.quote}\n已有建议：${risk.suggestion || ''}\n法条：${risk.legalBasis || ''}\nindex 固定输出 0。`),
    ])
    if (item.rewritten?.trim()) {
      await this.db.risk.update({
        where: { id: riskId },
        data: { rewritten: item.rewritten.slice(0, 1000), revisionStatus: 'PENDING' },
      })
      return { id: riskId, rewritten: item.rewritten, revisionStatus: 'PENDING' as const }
    }
    // 模型未返回改写内容：不能返回假 PENDING 让前端以为成功
    throw new ServiceUnavailableException('重新生成未返回有效内容，请稍后重试')
  }

  /** 模拟对方反驳（谈判演练，不落库） */
  async rebuttal(tenantId: string, riskId: string) {
    const { risk, task } = await this.loadRiskForTenant(tenantId, riskId)
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    this.assertDeep(task, tenant.plan)
    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ServiceUnavailableException('AI 模型未配置，模拟反驳暂不可用')
    }
    await this.quota.assert(tenantId)

    const model = createChatModel({ temperature: 0.5, streaming: false })
    const reply = await model.invoke([
      new SystemMessage(
        '你是合同中强势一方（房东/用人单位/发包方）的扮演者，听到对方要修改条款后，用 100 字以内说出一个真实、带点强硬但符合该角色口吻的反驳理由。只输出反驳台词，不要解释。',
      ),
      new HumanMessage(`争议点：${risk.title}\n原条款：${risk.quote}\n对方主张：${risk.suggestion || risk.analysis}`),
    ])
    return { text: String(reply.content || '').trim() }
  }

  /** 导出 Word 红划线修订稿（w:ins/w:del 真修订痕迹；未接受的修订不计入） */
  async exportDocx(tenantId: string, contractId: string, plan: string, res: Response) {
    const { contract, task, risks, clauses } = await this.load(tenantId, contractId)
    this.assertDeep(task, plan)
    const accepted = risks.filter((r) => r.revisionStatus === 'ACCEPTED' && r.rewritten)
    if (!accepted.length) {
      throw new NotFoundException('还没有已接受的修订，请先在改稿台接受至少一条')
    }

    const children: Paragraph[] = [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: `修订稿 · ${contract.title}`, bold: true })],
      }),
      new Paragraph({
        children: [new TextRun({
          text: `由 ClauseMind 生成 · ${new Date().toLocaleDateString('zh-CN')} · 共接受 ${accepted.length} 条修订（修订痕迹可在 Word 中接受/拒绝）`,
          color: '6b7280', size: 20,
        })],
        spacing: { after: 240 },
      }),
    ]

    const acceptedByClause = new Map<string | null, Risk[]>()
    for (const r of accepted) {
      const list = acceptedByClause.get(r.clauseId) ?? []
      list.push(r)
      acceptedByClause.set(r.clauseId, list)
    }

    for (const clause of clauses) {
      const revs = acceptedByClause.get(clause.id) || []
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: clause.indexNo === 0 ? clause.title : `第${clause.indexNo}条 ${clause.title}`, bold: true })],
      }))
      if (!revs.length) {
        children.push(new Paragraph({ children: [new TextRun(clause.content)] }))
        continue
      }
      // 有修订：原句删除痕迹（红） + 改写插入痕迹（蓝），作者 ClauseMind AI
      const nowIso = new Date().toISOString()
      for (const r of revs) {
        children.push(new Paragraph({
          spacing: { before: 80, after: 80 },
          children: [
            new DeletedTextRun({ id: nextChangeId(), author: 'ClauseMind AI', date: nowIso, text: r.quote, color: 'C00000' }),
          ],
        }))
        children.push(new Paragraph({
          spacing: { before: 80, after: 160 },
          children: [
            new InsertedTextRun({ id: nextChangeId(), author: 'ClauseMind AI', date: nowIso, text: r.rewritten!, color: '1D4ED8' }),
          ],
        }))
      }
    }

    const doc = new Document({
      creator: 'ClauseMind',
      title: `修订稿 · ${contract.title}`,
      sections: [{ properties: {}, children }],
    })
    const buffer = await Packer.toBuffer(doc)

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`修订稿_${contract.title}.docx`)}`,
    )
    res.end(buffer)
  }

  // ── 内部：一次性结构化生成多条修订 ──
  private async invokeRevisions(inputs: Array<{ clauseTitle: string; quote: string; suggestion: string; legalBasis: string }>) {
    const model = createChatModel({ temperature: 0.2, streaming: false })
    const structured = model.withStructuredOutput(RevisionsSchema, { name: 'clause_revisions' })
    const payload = inputs
      .slice(0, 12)
      .map((x, i) => `${i}. 条款：${x.clauseTitle}\n   原句：${x.quote}\n   修改建议：${x.suggestion}\n   法条：${x.legalBasis}`)
      .join('\n')
    return structured.invoke([
      new SystemMessage(`你是中国合同律师。针对每条风险，输出：
- original：需要替换的原句（逐字摘自输入原句）
- rewritten：公平合法、双方权利义务对等、可直接替换进合同的正式书面条款（不要加"建议"等前缀，直接给条款文本）
- reason：60 字内修改理由，优先点出法条依据，没有法条就讲公平原则
务必逐条输出，index 与输入序号一致。`),
      new HumanMessage(payload),
    ]) as Promise<z.infer<typeof RevisionsSchema>>
  }
}

let changeSeq = 1
function nextChangeId() {
  return changeSeq++
}
