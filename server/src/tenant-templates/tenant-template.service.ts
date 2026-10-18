// server/src/tenant-templates/tenant-template.service.ts
// 租户自有合同范本库（个人/团队空间通用，个人页展示为「我的范本」）：
//   上传范本（同步提取全文）→ 列表/预览/删除 → AI 从范本提炼候选审查规则（不落库，人工确认后由 Playbook 导入）。
// 关键约束：
//   - 所有空间可用（上限按租户隔离），与 Playbook 同权益；
//   - 提炼是 LLM 消耗入口：无 Key 503、配额超限 429、成本进 Trace（feature=playbook_extract）；
//   - 候选只产出"关键词/正则能可靠识别"的规则，每条必须带范本原句依据 evidence。
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import { DatabaseService } from '../database/database.service.js'
import { TraceService } from '../observability/trace.service.js'
import { AuditService } from '../audit/audit.service.js'
import { config as appConfig, isValidAiKey } from '../config/index.js'
import { createChatModel } from '../services/model.js'
import { extractText } from '../services/rag/ingest.js'
import { logger } from '../utils/logger.js'

const MAX_TEMPLATES_PER_TENANT = 30
const TEMPLATE_TEXT_CHARS = 12000
const EXTRACT_MAX_RULES = 8
const MAX_TITLE = 200
/** 在线编辑正文上限（与 extractText 的 2MB 截断同量级，防止超大 body） */
const MAX_CONTENT_CHARS = 200_000

/** 在线编辑入参：标题/正文均可选，但至少传一个 */
const UpdateTemplateSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE).optional(),
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS).optional(),
})

const TYPE_CODES = ['LABOR', 'INTERNSHIP', 'LEASE', 'SERVICE', 'NDA', 'SALE', 'LOAN', 'EQUITY', 'CUSTOM', 'ALL']

/** AI 提炼候选规则（服务端归一化后的稳定结构） */
export interface CandidateRule {
  /** 短标题（列表展示用） */
  title: string
  /** 完整规则内容句：业务人员可读的规则主体 */
  content: string
  kind: 'FORBIDDEN' | 'PREFERENCE'
  contractTypes: string[]
  /** AI 自动生成的机器命中条件，默认对业务用户折叠 */
  keywords: string[]
  regex: string | null
  severity: 'HIGH' | 'MED' | 'LOW'
  suggestion: string
  /** 范本中的依据原句，供人工核对与样例测试 */
  evidence: string
}

const ExtractSchema = z.object({
  rules: z.array(z.object({
    title: z.string().min(2).max(80),
    content: z.string().min(4).max(300),
    kind: z.enum(['FORBIDDEN', 'PREFERENCE']),
    contractTypes: z.array(z.string()).max(10),
    keywords: z.array(z.string().min(1).max(40)).min(1).max(8),
    regex: z.string().max(500).nullable(),
    severity: z.enum(['HIGH', 'MED', 'LOW']),
    suggestion: z.string().max(300),
    evidence: z.string().min(1).max(200),
  })).max(EXTRACT_MAX_RULES),
})

@Injectable()
export class TenantTemplateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tracer: TraceService,
    private readonly audit: AuditService,
  ) {}

  /** 范本按租户隔离，个人/团队空间均可上传：只断言租户存在（平台超管 token 无租户上下文 403，租户不存在 404） */
  private async assertAccess(tenantId: string) {
    if (!tenantId) throw new ForbiddenException('当前账号无权访问范本库')
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    return tenant
  }

  /** 取本租户范本（跨租户/不存在统一 404，不泄露存在性） */
  private async owned(tenantId: string, id: string) {
    const tpl = await this.db.tenantTemplate.findFirst({ where: { id, tenantId } })
    if (!tpl) throw new NotFoundException('范本不存在')
    return tpl
  }

  private serialize(t: {
    id: string; title: string; fileName: string; fileType: string; fileSize: number
    charCount: number; createdAt: Date; updatedAt: Date; uploadedById: string | null
  }) {
    return {
      id: t.id,
      title: t.title,
      fileName: t.fileName,
      fileType: t.fileType,
      fileSize: t.fileSize,
      charCount: t.charCount,
      uploadedById: t.uploadedById,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }
  }

  /** 上传范本：multer 已落盘（30MB 上限、txt/md/pdf/docx）；这里同步提取全文并入库 */
  async upload(tenantId: string, userId: string, file: Express.Multer.File, titleRaw?: string) {
    await this.assertAccess(tenantId)
    if (!file) throw new BadRequestException('请选择范本文件')

    const count = await this.db.tenantTemplate.count({ where: { tenantId } })
    if (count >= MAX_TEMPLATES_PER_TENANT) {
      await fs.unlink(file.path).catch(() => {})
      throw new BadRequestException(`每个工作空间最多保存 ${MAX_TEMPLATES_PER_TENANT} 份范本，请先删除不用的范本`)
    }

    const title = (titleRaw || file.originalname.replace(/\.[^.]+$/, '')).trim().slice(0, MAX_TITLE) || '未命名范本'
    const fileType = (path.extname(file.originalname).toLowerCase().slice(1) || 'txt').slice(0, 20)

    // 同步提取：文字版 Word/PDF/TXT 通常数秒；extractText 自带 120s 超时与解压炸弹保护
    let text: string
    try {
      const extracted = await extractText(file.path)
      text = extracted.text.trim()
    } catch (e) {
      await fs.unlink(file.path).catch(() => {})
      throw new BadRequestException(`范本解析失败：${(e as Error).message}（请使用文字版 Word/PDF/TXT，不支持扫描件/图片）`)
    }
    if (!text || text.length < 50) {
      await fs.unlink(file.path).catch(() => {})
      throw new BadRequestException('未能从文件中提取到足够文本，请使用文字版 Word/PDF/TXT（不支持扫描件/图片）')
    }

    const tpl = await this.db.tenantTemplate.create({
      data: {
        tenantId,
        uploadedById: userId,
        title,
        fileName: file.originalname.slice(0, 255),
        storagePath: file.path,
        fileType,
        fileSize: file.size,
        charCount: text.length,
        content: text,
      },
    })
    await this.audit.log({
      tenantId, userId, action: 'TENANT_TEMPLATE_UPLOAD', resource: 'tenant_template', resourceId: tpl.id,
      detail: { title, charCount: text.length },
    })
    logger.info('tenant-template: uploaded', { templateId: tpl.id, tenantId, charCount: text.length })
    return { template: this.serialize(tpl) }
  }

  async list(tenantId: string) {
    await this.assertAccess(tenantId)
    const templates = await this.db.tenantTemplate.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, fileName: true, fileType: true, fileSize: true,
        charCount: true, createdAt: true, updatedAt: true, uploadedById: true,
      },
    })
    return { templates, limit: MAX_TEMPLATES_PER_TENANT }
  }

  async detail(tenantId: string, id: string) {
    await this.assertAccess(tenantId)
    const tpl = await this.owned(tenantId, id)
    return { template: { ...this.serialize(tpl), content: tpl.content } }
  }

  /**
   * 在线编辑范本（标题/正文）。
   * 注意：只改库里的在线文本（预览与 AI 提炼以此为准），磁盘上的原始上传文件不动；
   * 需要替换文件请删除后重新上传。
   */
  async update(tenantId: string, userId: string, id: string, bodyRaw: { title?: string; content?: string }) {
    await this.assertAccess(tenantId)
    const tpl = await this.owned(tenantId, id)

    const parsed = UpdateTemplateSchema.safeParse(bodyRaw ?? {})
    if (!parsed.success) {
      throw new BadRequestException('提交内容不合法：标题需 1~200 字，正文不能为空且不超过 20 万字')
    }
    const { title, content } = parsed.data
    if (title === undefined && content === undefined) {
      throw new BadRequestException('没有需要更新的内容')
    }

    const data: { title?: string; content?: string; charCount?: number } = {}
    if (title !== undefined) data.title = title
    if (content !== undefined) {
      data.content = content
      data.charCount = content.length
    }

    const updated = await this.db.tenantTemplate.update({ where: { id: tpl.id }, data })
    await this.audit.log({
      tenantId, userId, action: 'TENANT_TEMPLATE_UPDATE', resource: 'tenant_template', resourceId: id,
      detail: { title: updated.title, fields: Object.keys(data), charCount: updated.charCount },
    })
    logger.info('tenant-template: updated', {
      templateId: id, tenantId, fields: Object.keys(data), charCount: updated.charCount,
    })
    return { template: this.serialize(updated) }
  }

  async remove(tenantId: string, userId: string, id: string) {
    await this.assertAccess(tenantId)
    const tpl = await this.owned(tenantId, id)
    await this.db.tenantTemplate.delete({ where: { id: tpl.id } })
    // 文件生命周期跟随范本；已导入的规则独立保留，不随范本删除
    await fs.unlink(tpl.storagePath).catch(() => {})
    await this.audit.log({
      tenantId, userId, action: 'TENANT_TEMPLATE_DELETE', resource: 'tenant_template', resourceId: id,
      detail: { title: tpl.title },
    })
    return { ok: true }
  }

  /**
   * AI 从范本提炼候选审查规则（不落库）。
   * focus 非空时仅围绕用户关注点提炼；正文截断防止 token 膨胀。
   */
  async extractRules(tenantId: string, id: string, focusRaw?: string): Promise<{ rules: CandidateRule[] }> {
    await this.assertAccess(tenantId)
    const tpl = await this.owned(tenantId, id)

    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ServiceUnavailableException('AI 模型未配置（DEEPSEEK_API_KEY 缺失），暂时无法提炼规则')
    }
    const focus = (focusRaw ?? '').trim().slice(0, 500)

    const result = await this.tracer.run(
      {
        feature: 'playbook_extract',
        name: `范本提炼规则：${tpl.title}`,
        tenantId,
        userId: tpl.uploadedById,
      },
      async (handle) => {
        const model = createChatModel({ temperature: 0.2, streaming: false })
        const structured = model.withStructuredOutput(ExtractSchema, { method: 'jsonMode' })
        return structured.invoke(
          [['human', this.buildPrompt(tpl.title, tpl.content.slice(0, TEMPLATE_TEXT_CHARS), focus)]],
          { callbacks: handle.callbacks, signal: AbortSignal.timeout(120_000) },
        )
      },
    )

    const rules = (result?.rules ?? []).map((r) => this.normalize(r)).filter((r): r is CandidateRule => !!r)
    if (!rules.length) {
      throw new BadRequestException('未能从该范本中提炼出可靠的声明式规则，可尝试填写更具体的提炼重点后重试')
    }
    logger.info('tenant-template: rules extracted', { templateId: id, tenantId, count: rules.length })
    return { rules }
  }

  /** 归一化单条候选：content 必填、contractTypes 白名单过滤、regex 试编译、字段截断 */
  private normalize(r: z.infer<typeof ExtractSchema>['rules'][number]): CandidateRule | null {
    const content = (r.content ?? '').trim()
    if (content.length < 4) return null
    const keywords = [...new Set(r.keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 8)
    if (!keywords.length) return null
    let regex: string | null = r.regex?.trim() ? r.regex.trim() : null
    if (regex) {
      try { new RegExp(regex, 'm') } catch { regex = null }
    }
    const contractTypes = [...new Set(
      (r.contractTypes ?? []).map((t) => String(t).trim().toUpperCase()).filter((t) => TYPE_CODES.includes(t)),
    )]
    return {
      title: r.title.trim().slice(0, 80),
      content: content.slice(0, 300),
      kind: r.kind,
      contractTypes,
      keywords,
      regex,
      severity: r.severity,
      suggestion: (r.suggestion ?? '').trim().slice(0, 300),
      evidence: (r.evidence ?? '').trim().slice(0, 200),
    }
  }

  private buildPrompt(title: string, content: string, focus: string) {
    return `你是合同审查规则提炼助手。下面是用户自有合同范本《${title}》的正文（可能被截断）。
请从中提炼出 ${EXTRACT_MAX_RULES} 条以内、用户真正关心的审查规则，供今后审查对方回传合同时比对使用。

【规则类型】
- FORBIDDEN：红线/禁止性约定（如"禁止约定逾期付款无上限违约金"）
- PREFERENCE：起草偏好/必备要素（如"必须列明收款账户与发票类型"）

【每条规则必须返回的字段】
- title：不超过 20 字的短标题（如"加班时长上限""首付款比例"）。
- content：**完整的规则内容句**，用业务人员能直接读懂的一句话写清规则要求（主体+义务/禁止+具体阈值/标准），如"每月加班时间不得超过 36 小时，超过部分应依法支付加班费"。不要只写词语。
- keywords：机器命中条件（1~8 个），语义为"全部出现才命中"（AND）。
- regex：可选 JavaScript 正则（不含两侧斜杠，必须能编译）。
- severity / suggestion / evidence / contractTypes 见下。

【keywords 与 regex 的铁律——数字阈值类规则最容易配反，务必照做】
1. 先判断规则是否带具体数值阈值（小时/日/月/比例%/金额/倍数等）。
2. 带阈值的规则（如"加班不超过36小时""违约金不超过20%"）：**合规条款本身就含有阈值数字**，所以严禁把阈值数字放进 keywords（否则合规写法"不超过36小时"会被误判，而违规写法"不超过40小时"反而漏判）。这类规则：
   - keywords 只放不带数字的事实词（如"加班""小时"或"违约金""合同总额"）；
   - **必须给出 regex 匹配"超过阈值的违规写法"**（如加班超过36小时：加班[^。；\\n]{0,12}(?:3[7-9]|[4-9]\\d|[1-9]\\d{2,})\\s*小时；违约金比例超20%：(?:2[1-9]|[3-9]\\d|100)\\s*%），正则要克制、可编译、避免灾难性回溯。
3. 不带阈值的规则：keywords 必须是合同条款原文里会真实出现的事实词（如"验收期""收款账户""公章""销毁证明"）；严禁"不得超过""无效""违法"这类评价/法条措辞，违规条款不会自带这些词；不要把"劳动合同""合同"这类无区分度泛词当关键词；regex 留 null。
4. "整体表述是否公允、是否偏离我方口径"这类无法确定性识别的纯语义差异，不要产出。

【其他要求】
1. evidence 必须是从范本正文中原样摘录的一句话（200 字以内），作为该规则的依据与试命中样例，不得改写或编造。
2. 平台已内置通用法律红线（试用期上限、社保、加班费、竞业补偿等），不要重复提炼；优先提炼用户个性化口径：付款节点与比例、交付/验收标准、发票与账户、印章与审批流程、保密与数据、违约的专属约定等。
3. contractTypes 从 LABOR/INTERNSHIP/LEASE/SERVICE/NDA/SALE/LOAN/EQUITY/CUSTOM/ALL 中选择，拿不准就给 ["ALL"]。
4. suggestion 用一句话告诉业务方命中后该怎么改。
5. 规则之间不得重复；如果范本内容不足以提炼出可靠规则，返回空数组。
${focus ? `\n【本次提炼重点】用户特别关注：${focus}\n请仅围绕该重点提炼，不相关的条款忽略。` : ''}

【范本正文】
${content}`
  }
}
