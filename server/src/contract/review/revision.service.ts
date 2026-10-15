// server/src/contract/review/revision.service.ts
// AI 改稿台（FR-9）：基于本次审查风险生成「原句 / 改写 / 理由」结构化修订建议。
// - 复用 risks 表：rewritten + revisionStatus(NONE/PENDING/ACCEPTED/REJECTED)，不新增表
// - 深度权益：深度套餐或本份审查以深度券解锁（task.isDeep）才可生成/导出
// - 无 DEEPSEEK Key 时 503 降级提示；Word 导出走 docx 真·修订模式（w:ins/w:del 痕迹）
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import type { Response } from 'express'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  Document, Packer, Paragraph, HeadingLevel, TextRun,
  InsertedTextRun, DeletedTextRun,
} from 'docx'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { Clause, Risk, ReviewTask } from '@prisma/client'
import { DatabaseService } from '../../database/database.service.js'
import { EntitlementsService } from '../../billing/entitlements.service.js'
import { TrialService, type TrialFeature } from '../../billing/trial.service.js'
import { QuotaService } from '../../observability/quota.service.js'
import { createChatModel } from '../../services/model.js'
import { config as appConfig, isValidAiKey } from '../../config/index.js'
import { PlanLimitException } from '../../billing/plan-limit.exception.js'
import { logger } from '../../utils/logger.js'
import { injectTrackedChanges, type DocxMode } from './docx-revision.js'
import { archiveVersion } from './archive.js'
import { PdfExportService } from './pdf-export.service.js'
import { tokenizeEdits, type EditToken } from './revision-anchor.js'

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
    private readonly trial: TrialService,
    private readonly pdf: PdfExportService,
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

  /**
   * 深度门禁（试用放宽）：深度档/券解锁直接放行；
   * FREE 非演示租户在试用次数内放行并消耗 1 次（用尽抛 TRIAL_EXHAUSTED 付费墙）。
   * 仅在即将真实执行 LLM/导出动作前调用，避免幂等早退白耗次数。
   */
  private async assertDeepWithTrial(tenantId: string, task: ReviewTask | null, plan: string, feature: TrialFeature) {
    if (task?.isDeep || this.entitlements.isDeep(plan)) return
    await this.trial.assertTrialAvailable(tenantId, feature)
    await this.trial.consumeTrial(tenantId, feature)
  }

  /**
   * 取「已采纳的修改点」→ 可直接应用的修订列表。
   * 采纳口径包含两处：审查结果里的逐条采纳（risk.status=ACCEPTED）、改稿台的接受（revisionStatus=ACCEPTED）。
   * 替换文本优先用 AI 改写句 rewritten；未走改稿台时退回审查给出的具体修改建议 suggestion。
   * 返回的 Risk 是浅拷贝，rewritten 已填充为最终替换文本（下游 tokenizeEdits/injectTrackedChanges 统一读 rewritten）。
   */
  private acceptedEdits(risks: Risk[]): Risk[] {
    return risks
      .filter((r) => r.status === 'ACCEPTED' || r.revisionStatus === 'ACCEPTED')
      .map((r) => ({ ...r, rewritten: (r.rewritten || r.suggestion || '').trim() }))
      .filter((r) => !!r.rewritten)
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
    const targets = risks.filter((r) => force || !r.rewritten)
    if (!risks.length) {
      throw new NotFoundException('本次审查未发现风险，无需生成修订稿')
    }
    // 幂等早退不消耗试用次数
    if (!targets.length) return this.list(tenantId, contractId, plan)
    await this.assertDeepWithTrial(tenantId, task, plan, 'DRAFT')
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
    await this.assertDeepWithTrial(tenantId, task, tenant.plan, 'DRAFT')
    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ServiceUnavailableException('AI 模型未配置，重新生成暂不可用')
    }
    await this.quota.assert(tenantId)

    const model = createChatModel({ temperature: 0.3, streaming: false })
      .withStructuredOutput(RevisionItemSchema, { method: 'jsonMode' })
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
    await this.assertDeepWithTrial(tenantId, task, tenant.plan, 'DRAFT')
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

  /** 导出 Word 修订文档
   *  mode=clean（默认）：已应用采纳修订的「修订后新合同」——改写直接落为最终正文，无修订痕迹，可直接定稿
   *  mode=redline：内联 w:del 原句 + w:ins 改写，供对照复核（Word 里「接受全部修订」也得同一结果）
   *  全文完整输出（未改条款原样保留）；原件是 docx 时保留全部原始版式。导出成功即归档一版。 */
  async exportDocx(tenantId: string, contractId: string, plan: string, res: Response, mode: DocxMode = 'clean') {
    const { contract, task, risks, clauses } = await this.load(tenantId, contractId)
    await this.assertDeepWithTrial(tenantId, task, plan, 'EXPORT')
    const accepted = this.acceptedEdits(risks)
    if (!accepted.length) {
      throw new NotFoundException('还没有已采纳的修改，请先在审查结果中采纳至少一条修改建议')
    }
    const downloadName = this.buildDownloadName(contract.fileName, contract.title, mode)
    const archiveCtx = { tenantId, contractId, taskId: task?.id ?? null, createdById: contract.uploadedBy }

    // 优先原件保真：上传原件是 docx 且磁盘文件还在 → 直接在原 OOXML 上应用修订，
    // 标题层级/字体/表格/页面设置等全部版式原样保留。
    if (contract.fileType.toLowerCase() === 'docx' && contract.storagePath) {
      const result = await this.buildFromOriginalDocx(contract.storagePath, accepted, mode)
      if (result) {
        await this.archiveRevision(archiveCtx, downloadName, result.buffer, result.applied, result.unmatched.length)
        res.setHeader('X-Revision-Applied', String(result.applied))
        res.setHeader('X-Revision-Unmatched', String(result.unmatched.length))
        this.sendDocxResponse(res, downloadName, result.buffer)
        return
      }
    }

    const rebuilt = await this.buildTextRebuildDocx(contract.title, accepted, clauses, mode)
    await this.archiveRevision(archiveCtx, downloadName, rebuilt.buffer, accepted.length, rebuilt.unmatched)
    res.setHeader('X-Revision-Applied', String(accepted.length))
    res.setHeader('X-Revision-Unmatched', String(rebuilt.unmatched))
    this.sendDocxResponse(res, downloadName, rebuilt.buffer)
  }

  /** 导出修订稿 PDF（redline=红划线版 / clean=干净终版）：与 docx 导出同门禁，按需生成不重复归档 */
  async exportPdf(tenantId: string, contractId: string, plan: string, variant: 'redline' | 'clean', res: Response) {
    const { contract, task, risks, clauses } = await this.load(tenantId, contractId)
    await this.assertDeepWithTrial(tenantId, task, plan, 'EXPORT')
    const accepted = this.acceptedEdits(risks)
    if (!accepted.length) {
      throw new NotFoundException('还没有已采纳的修改，请先在审查结果中采纳至少一条修改建议')
    }
    const html = this.pdf.buildRevisionHtml({ title: contract.title, clauses, accepted, variant })
    const buffer = await this.pdf.htmlToPdf(html, { contractId: contract.id })
    const base = /^粘贴文本/.test(contract.fileName)
      ? contract.title
      : contract.fileName.replace(/\.[^.]+$/, '') || contract.title
    const downloadName = variant === 'clean' ? `${base}（修订后）.pdf` : `${base}（修订稿·红划线）.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="revised-contract.pdf"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    )
    res.end(buffer)
  }

  /** 导出成功后归档一版修订稿（archiveVersion 失败仅告警，不阻断导出） */
  private async archiveRevision(
    ctx: { tenantId: string; contractId: string; taskId: string | null; createdById?: string | null },
    fileName: string,
    buffer: Buffer,
    applied: number,
    unmatched: number,
  ) {
    await archiveVersion(this.db, { ...ctx, kind: 'REVISED', fileName, buffer, appliedCount: applied, unmatchedCount: unmatched })
  }

  /** 文件名：劳动合同.docx → 劳动合同（修订后）.docx（clean）/ 劳动合同（修订稿·红划线）.docx（redline） */
  private buildDownloadName(fileName: string, title: string, mode: DocxMode = 'clean'): string {
    const baseName = /^粘贴文本/.test(fileName)
      ? title
      : fileName.replace(/\.[^.]+$/, '') || title
    return mode === 'clean' ? `${baseName}（修订后）.docx` : `${baseName}（修订稿·红划线）.docx`
  }

  /**
   * 发送 docx 响应。buffer 为 null 时表示响应头之外的内容由调用方自行写入（原件分支用 stream）。
   * Content-Disposition 同时给 ASCII fallback 与 RFC 5987 filename*，兼容所有下载端。
   */
  private sendDocxResponse(res: Response, downloadName: string, buffer: Buffer | null) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="revised-contract.docx"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    )
    if (buffer) res.end(buffer)
  }

  /**
   * 原件注入分支。磁盘文件丢失/损坏/非 docx 时返回 null，由调用方回退到文本重建，
   * 绝不让用户因为历史数据拿不到导出文件。
   */
  private async buildFromOriginalDocx(
    storagePath: string,
    accepted: Risk[],
    mode: DocxMode,
  ): Promise<Awaited<ReturnType<typeof injectTrackedChanges>> | null> {
    try {
      const original = await readFile(storagePath)
      const result = await injectTrackedChanges(
        original,
        accepted.map((r) => ({ quote: r.quote, ins: r.rewritten! })),
        mode,
      )
      logger.info('revision: exported from original docx', {
        applied: result.applied, unmatched: result.unmatched.length,
      })
      return result
    } catch (e) {
      logger.warn('revision: original docx unavailable, fallback to text rebuild', {
        storagePath, error: (e as Error).message,
      })
      return null
    }
  }

  /** 文本重建分支（粘贴文本 / txt / md / pdf / 图片 / 原件丢失的历史合同） */
  private async buildTextRebuildDocx(title: string, accepted: Risk[], clauses: Clause[], mode: DocxMode): Promise<{ buffer: Buffer; unmatched: number }> {
    let unmatchedTotal = 0
    const subtitle = mode === 'clean'
      ? `由 ClauseMind 生成 · ${new Date().toLocaleDateString('zh-CN')} · 已采纳并应用 ${accepted.length} 条修订`
      : `由 ClauseMind 生成 · ${new Date().toLocaleDateString('zh-CN')} · 共接受 ${accepted.length} 条修订（红色删除线为原文、蓝色下划线为改写，可在 Word 中接受/拒绝）`
    const children: Paragraph[] = [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: title, bold: true })],
      }),
      new Paragraph({
        children: [new TextRun({ text: subtitle, color: '6b7280', size: 20 })],
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
        children.push(...plainParagraphs(clause.content))
        continue
      }

      // 有修订：把原句定位到条款原文中的位置，内联替换（clean=直接落为终稿；redline=红删+蓝下划线）
      const { tokens, unmatched } = tokenizeEdits(clause.content, revs)
      unmatchedTotal += unmatched.length
      children.push(...revisionParagraphs(tokens, mode))
      // 锚点重叠/找不到的修订：原文已完整保留在上方，修订痕迹作为附加建议追加，绝不静默丢失
      for (const r of unmatched) {
        children.push(new Paragraph({
          spacing: { before: 120 },
          children: [new TextRun({ text: '附加修订建议（请人工定位）：', italics: true, color: '6b7280', size: 20 })],
        }))
        children.push(new Paragraph({
          spacing: { before: 40, after: 40 },
          children: [mode === 'clean'
            ? new TextRun({ text: r.quote, color: 'C00000' })
            : buildDelRun(r.quote)],
        }))
        children.push(new Paragraph({
          spacing: { after: 120 },
          children: [mode === 'clean'
            ? new TextRun({ text: `${r.rewritten!}（建议替换为以上改写）`, color: '1D4ED8' })
            : buildInsRun(r.rewritten!)],
        }))
      }
    }

    const doc = new Document({
      creator: 'ClauseMind',
      title,
      sections: [{ properties: {}, children }],
    })
    return { buffer: await Packer.toBuffer(doc), unmatched: unmatchedTotal }
  }

  // ── 内部：一次性结构化生成多条修订 ──
  private async invokeRevisions(inputs: Array<{ clauseTitle: string; quote: string; suggestion: string; legalBasis: string }>) {
    const model = createChatModel({ temperature: 0.2, streaming: false })
    const structured = model.withStructuredOutput(RevisionsSchema, { method: 'jsonMode' })
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

const CHANGE_AUTHOR = 'ClauseMind AI'

function buildDelRun(text: string, brk = 0) {
  return new DeletedTextRun({
    id: nextChangeId(), author: CHANGE_AUTHOR, date: new Date().toISOString(),
    text, color: 'C00000', break: brk,
  })
}
function buildInsRun(text: string, brk = 0) {
  return new InsertedTextRun({
    id: nextChangeId(), author: CHANGE_AUTHOR, date: new Date().toISOString(),
    text, color: '1D4ED8', break: brk,
  })
}

/** 纯文本按换行拆为多个段落（保留原文的段落结构与空行） */
function plainParagraphs(text: string): Paragraph[] {
  return text.split('\n').map((line) => new Paragraph({
    spacing: { line: 360 },
    children: line ? [new TextRun(line)] : [],
  }))
}

/**
 * 把 token 序列渲染为段落：修订与未改文字同段混排（行内红划线效果），
 * token 内的换行同样切分为新段落，保留原文版式。
 */
function revisionParagraphs(tokens: EditToken[], mode: DocxMode = 'redline'): Paragraph[] {
  const paraRuns: any[][] = [[]]
  const appendText = (text: string, makeRun: (t: string, brk: number) => any) => {
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (i > 0) paraRuns.push([])
      if (line) paraRuns[paraRuns.length - 1].push(makeRun(line, i > 0 ? 1 : 0))
    })
  }

  for (const tk of tokens) {
    if (tk.type === 'plain') {
      appendText(tk.text, (t, brk) => new TextRun({ text: t, break: brk }))
    } else if (mode === 'clean') {
      // 修订后新合同：只呈现改写后的最终正文，不保留删除痕迹
      appendText(tk.ins, (t, brk) => new TextRun({ text: t, break: brk }))
    } else {
      appendText(tk.del, buildDelRun)
      appendText(tk.ins, buildInsRun)
    }
  }

  return paraRuns.map((runs) => new Paragraph({ spacing: { line: 360 }, children: runs }))
}
