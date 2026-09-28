// server/src/ledger/ledger.service.ts
// 合同台账（FR-16，沿用 v1 FR-10~12）：
//   台账 CRUD + 续签（原 RENEWED + 新记录 renewedFromId）+ 解除；
//   到期分桶（已过期 / 30 天内 / 31-90 天 / 长期履行）；AI 从审查合同抽取预填（无 Key 409 手填兜底）；
//   FREE/PERSONAL ≤10 条（entitlements.assertLedgerCreate），TEAM/ENTERPRISE 不限。
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { ContractLedger } from '@prisma/client'
import { DatabaseService } from '../database/database.service.js'
import { AuditService } from '../audit/audit.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { config as appConfig, isValidAiKey } from '../config/index.js'
import { createChatModel } from '../services/model.js'
import { z } from 'zod'

// 7 类字符串枚举（schema.prisma ContractLedger.contractType 注释同源）
export const LEDGER_TYPES = {
  FIXED_TERM_LABOR: '固定期限劳动合同',
  OPEN_ENDED_LABOR: '无固定期限劳动合同',
  SERVICE: '劳务协议',
  INTERNSHIP: '实习协议',
  NDA: '保密协议',
  NON_COMPETE: '竞业限制协议',
  OTHER: '其他',
} as const
const TYPE_CODES = Object.keys(LEDGER_TYPES)
const REMIND_DAYS = [7, 30, 60, 90]

const DateStrSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')

const LedgerDtoSchema = z.object({
  employeeName: z.string().trim().min(1, '员工姓名不能为空').max(100),
  dept: z.string().max(100).nullish(),
  contractType: z.enum(TYPE_CODES as [string, ...string[]]),
  position: z.string().max(100).nullish(),
  startDate: DateStrSchema,
  endDate: DateStrSchema.nullish(),
  probationEnd: DateStrSchema.nullish(),
  remindBeforeDays: z.coerce.number().int().refine((n) => REMIND_DAYS.includes(n), '提醒天数仅支持 7/30/60/90'),
  linkedContractId: z.string().max(50).nullish(),
  note: z.string().max(2000).nullish(),
})

export interface LedgerUpsertDto {
  employeeName?: string
  dept?: string | null
  contractType?: string
  position?: string | null
  startDate?: string
  endDate?: string | null
  probationEnd?: string | null
  remindBeforeDays?: number
  linkedContractId?: string | null
  note?: string | null
}

function toDate(s?: string | null): Date | null {
  if (!s) return null
  return new Date(`${s}T00:00:00.000Z`)
}

function toDateStr(d?: Date | null): string | null {
  if (!d) return null
  // @db.Date 读出为 UTC 午夜，直接取 UTC 年月日
  return d.toISOString().slice(0, 10)
}

function startOfToday(): Date {
  const n = new Date()
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()))
}

/** 到期分桶（状态优先）：EXPIRED / DUE_30 / DUE_90 / LONG_TERM / ACTIVE_OK / RENEWED / TERMINATED */
function bucketOf(r: Pick<ContractLedger, 'status' | 'endDate'>, now: Date): string {
  if (r.status === 'RENEWED') return 'RENEWED'
  if (r.status === 'TERMINATED') return 'TERMINATED'
  if (!r.endDate) return 'LONG_TERM'
  const days = Math.floor((r.endDate.getTime() - now.getTime()) / 86400000)
  if (days < 0) return 'EXPIRED'
  if (days <= 30) return 'DUE_30'
  if (days <= 90) return 'DUE_90'
  return 'ACTIVE_OK'
}

@Injectable()
export class LedgerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private serialize(r: ContractLedger & {
    linkedContract?: { id: string; title: string; status: string } | null
    renewedFrom?: { id: string; employeeName: string } | null
    renewals?: { id: string; employeeName: string; startDate: Date }[]
  }, now: Date) {
    const bucket = bucketOf(r, now)
    return {
      id: r.id,
      employeeName: r.employeeName,
      dept: r.dept,
      contractType: r.contractType,
      contractTypeLabel: LEDGER_TYPES[r.contractType as keyof typeof LEDGER_TYPES] ?? r.contractType,
      position: r.position,
      startDate: toDateStr(r.startDate),
      endDate: toDateStr(r.endDate),
      probationEnd: toDateStr(r.probationEnd),
      probationDays: r.probationEnd
        ? Math.floor((r.probationEnd.getTime() - now.getTime()) / 86400000)
        : null,
      remindBeforeDays: r.remindBeforeDays,
      note: r.note,
      status: r.status,
      bucket,
      linkedContractId: r.linkedContractId,
      linkedContract: r.linkedContract ? { id: r.linkedContract.id, title: r.linkedContract.title, status: r.linkedContract.status } : null,
      renewedFromId: r.renewedFromId,
      renewedFrom: r.renewedFrom ? { id: r.renewedFrom.id, employeeName: r.renewedFrom.employeeName } : null,
      renewal: r.renewals?.[0] ? { id: r.renewals[0].id, employeeName: r.renewals[0].employeeName } : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  }

  /** 清洗 + 校验入参；defaults 用于续签时从原记录复制字段 */
  private async cleanDto(
    tenantId: string,
    dto: LedgerUpsertDto,
    defaults?: Partial<LedgerUpsertDto>,
  ) {
    const merged = { ...defaults, ...stripUndef(dto) }
    const parsed = LedgerDtoSchema.safeParse(merged)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? '台账信息不合法')
    }
    const d = parsed.data
    const start = toDate(d.startDate)!
    const end = toDate(d.endDate)
    const probation = toDate(d.probationEnd)
    if (end && end < start) throw new BadRequestException('到期日期不能早于开始日期')
    if (probation) {
      if (probation < start) throw new BadRequestException('试用期到期不能早于开始日期')
      if (end && probation > end) throw new BadRequestException('试用期到期不能晚于合同到期日期')
    }
    let linkedContractId: string | null = null
    if (d.linkedContractId) {
      const c = await this.db.contract.findFirst({
        where: { id: d.linkedContractId, tenantId },
        select: { id: true },
      })
      if (!c) throw new BadRequestException('关联的审查合同不存在或不属于当前工作空间')
      linkedContractId = c.id
    }
    return {
      employeeName: d.employeeName.trim(),
      dept: d.dept?.trim() || null,
      contractType: d.contractType,
      position: d.position?.trim() || null,
      startDate: start,
      endDate: end,
      probationEnd: probation,
      remindBeforeDays: d.remindBeforeDays,
      linkedContractId,
      note: d.note?.trim() || null,
    }
  }

  private async getOwned(tenantId: string, id: string) {
    const row = await this.db.contractLedger.findFirst({ where: { id, tenantId } })
    if (!row) throw new NotFoundException('台账记录不存在')
    return row
  }

  async list(
    tenantId: string,
    opts: { q?: string; filter?: string; page?: number; pageSize?: number } = {},
  ) {
    const page = Math.max(1, Math.floor(Number(opts.page) || 1))
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(opts.pageSize) || 20)))
    const now = startOfToday()
    const filter = opts.filter ?? 'ALL'

    const where: any = { tenantId }
    const q = opts.q?.trim()
    if (q) {
      where.OR = [
        { employeeName: { contains: q, mode: 'insensitive' } },
        { dept: { contains: q, mode: 'insensitive' } },
      ]
    }
    if (filter === 'ACTIVE') where.status = 'ACTIVE'
    if (filter === 'RENEWED') where.status = 'RENEWED'
    if (filter === 'DUE_30') {
      where.status = 'ACTIVE'
      where.endDate = { gte: now, lte: new Date(now.getTime() + 30 * 86400000) }
    }
    if (filter === 'EXPIRED') {
      where.status = 'ACTIVE'
      where.endDate = { lt: now }
    }

    const [rows, total, stats] = await Promise.all([
      this.db.contractLedger.findMany({
        where,
        orderBy: [{ status: 'asc' }, { endDate: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          linkedContract: { select: { id: true, title: true, status: true } },
          renewedFrom: { select: { id: true, employeeName: true } },
          renewals: { select: { id: true, employeeName: true, startDate: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      this.db.contractLedger.count({ where }),
      this.stats(tenantId),
    ])
    return {
      items: rows.map((r) => this.serialize(r, now)),
      total,
      page,
      pageSize,
      stats,
    }
  }

  /** 顶部统计卡（单条轻量查询内存聚合，无 N+1） */
  async stats(tenantId: string) {
    const now = startOfToday()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const rows = await this.db.contractLedger.findMany({
      where: { tenantId },
      select: { status: true, endDate: true, startDate: true },
    })
    let active = 0, openEnded = 0, due30 = 0, expired = 0, thisMonth = 0, lastMonth = 0
    for (const r of rows) {
      const b = bucketOf(r, now)
      if (r.status === 'ACTIVE') {
        active += 1
        if (!r.endDate) openEnded += 1
        if (b === 'DUE_30') due30 += 1
        if (b === 'EXPIRED') expired += 1
      }
      if (r.startDate >= monthStart) thisMonth += 1
      else if (r.startDate >= lastMonthStart && r.startDate < monthStart) lastMonth += 1
    }
    return { active, openEnded, due30, expired, thisMonthSigned: thisMonth, lastMonthSigned: lastMonth }
  }

  async create(tenantId: string, userId: string, dto: LedgerUpsertDto) {
    await this.entitlements.assertLedgerCreate(tenantId)
    const data = await this.cleanDto(tenantId, dto)
    const row = await this.db.contractLedger.create({
      data: { ...data, tenantId, createdById: userId, status: 'ACTIVE' },
    })
    await this.audit.log({
      tenantId, userId, action: 'LEDGER_CREATE', resource: 'contract_ledger', resourceId: row.id,
      detail: { employeeName: row.employeeName, contractType: row.contractType },
    })
    return { item: this.serialize(row, startOfToday()) }
  }

  async update(tenantId: string, userId: string, id: string, dto: LedgerUpsertDto) {
    const existing = await this.getOwned(tenantId, id)
    const data = await this.cleanDto(tenantId, dto, {
      employeeName: existing.employeeName,
      dept: existing.dept,
      contractType: existing.contractType,
      position: existing.position,
      startDate: toDateStr(existing.startDate) ?? undefined,
      endDate: toDateStr(existing.endDate),
      probationEnd: toDateStr(existing.probationEnd),
      remindBeforeDays: existing.remindBeforeDays,
      linkedContractId: existing.linkedContractId,
      note: existing.note,
    })
    const row = await this.db.contractLedger.update({ where: { id }, data })
    await this.audit.log({
      tenantId, userId, action: 'LEDGER_UPDATE', resource: 'contract_ledger', resourceId: id,
      detail: { employeeName: row.employeeName },
    })
    return { item: this.serialize(row, startOfToday()) }
  }

  /** 续签：原记录置 RENEWED，新建 ACTIVE 记录并记 renewedFromId（FR-16 生命周期） */
  async renew(tenantId: string, userId: string, id: string, dto: LedgerUpsertDto) {
    const old = await this.getOwned(tenantId, id)
    if (old.status !== 'ACTIVE') throw new BadRequestException('仅履行中的记录可以续签')
    await this.entitlements.assertLedgerCreate(tenantId)
    const data = await this.cleanDto(tenantId, dto, {
      employeeName: old.employeeName,
      dept: old.dept,
      contractType: old.contractType,
      position: old.position,
      linkedContractId: old.linkedContractId,
      remindBeforeDays: old.remindBeforeDays,
    })
    const [, row] = await this.db.$transaction([
      this.db.contractLedger.update({ where: { id }, data: { status: 'RENEWED' } }),
      this.db.contractLedger.create({
        data: { ...data, tenantId, createdById: userId, status: 'ACTIVE', renewedFromId: id },
      }),
    ])
    await this.audit.log({
      tenantId, userId, action: 'LEDGER_RENEW', resource: 'contract_ledger', resourceId: row.id,
      detail: { employeeName: row.employeeName, renewedFrom: id },
    })
    return { item: this.serialize(row, startOfToday()) }
  }

  /** 协商解除 */
  async terminate(tenantId: string, userId: string, id: string) {
    const existing = await this.getOwned(tenantId, id)
    if (existing.status === 'TERMINATED') return { ok: true }
    if (existing.status !== 'ACTIVE') throw new BadRequestException('仅履行中的记录可以解除')
    await this.db.contractLedger.update({ where: { id }, data: { status: 'TERMINATED' } })
    await this.audit.log({
      tenantId, userId, action: 'LEDGER_TERMINATE', resource: 'contract_ledger', resourceId: id,
      detail: { employeeName: existing.employeeName },
    })
    return { ok: true }
  }

  async remove(tenantId: string, userId: string, id: string) {
    const existing = await this.getOwned(tenantId, id)
    await this.db.contractLedger.delete({ where: { id } })
    await this.audit.log({
      tenantId, userId, action: 'LEDGER_DELETE', resource: 'contract_ledger', resourceId: id,
      detail: { employeeName: existing.employeeName },
    })
    return { ok: true }
  }

  /**
   * AI 从审查合同抽取台账字段（FR-16 预填）。
   * 无 Key：409 Conflict，前端黄条提示手填，不阻塞。
   */
  async extract(tenantId: string, contractId: string) {
    const contract = await this.db.contract.findFirst({
      where: { id: contractId, tenantId },
      select: { id: true, title: true, status: true, createdAt: true },
    })
    if (!contract) throw new NotFoundException('合同不存在或不属于当前工作空间')
    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ConflictException('未配置模型 Key，无法自动识别，请手动填写台账信息')
    }
    const clauses = await this.db.clause.findMany({
      where: { contractId },
      orderBy: { indexNo: 'asc' },
      select: { title: true, content: true },
    })
    const text = clauses.map((c) => `${c.title}\n${c.content}`).join('\n').slice(0, 8000)
    if (!text.trim()) throw new BadRequestException('该合同尚未解析出条款文本，无法识别')

    const ExtractSchema = z.object({
      employeeName: z.string().max(100).describe('劳动者/员工姓名；无法判断返回空字符串'),
      dept: z.string().max(100).describe('所属部门；无法判断返回空字符串'),
      position: z.string().max(100).describe('岗位/职务；无法判断返回空字符串'),
      contractType: z.enum(TYPE_CODES as [string, ...string[]])
        .describe('FIXED_TERM_LABOR=固定期限劳动合同, OPEN_ENDED_LABOR=无固定期限劳动合同, SERVICE=劳务协议, INTERNSHIP=实习协议, NDA=保密协议, NON_COMPETE=竞业限制协议, OTHER=其他'),
      startDate: z.string().describe('合同开始日期 YYYY-MM-DD；无法判断返回空字符串'),
      endDate: z.string().describe('合同到期日期 YYYY-MM-DD；无固定期限返回空字符串'),
      probationEnd: z.string().describe('试用期到期日期 YYYY-MM-DD；无试用期或无法判断返回空字符串'),
      remindBeforeDays: z.enum(['7', '30', '60', '90']).describe('到期提前提醒天数，拿不准用 30'),
      note: z.string().max(500).describe('需要 HR 关注的事项，一句话；没有返回空字符串'),
    })
    const model = createChatModel({ temperature: 0, streaming: false })
    const structured = model.withStructuredOutput(ExtractSchema, { name: 'ledger_extract' })
    const out = await structured.invoke([
      ['human', `你是劳动用工合同台账录入助手。请从下列合同条款中抽取台账字段，只依据合同原文，禁止编造姓名与日期；
拿不准的字段一律返回空字符串。日期统一输出 YYYY-MM-DD。

合同标题：${contract.title}

条款：
${text}`],
    ] as any)

    const normDate = (s?: string) => {
      const m = String(s ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})/)
      if (!m) return null
      const [y, mo, d] = m[1].split('-').map(Number)
      if (!mo || mo < 1 || mo > 12 || d < 1 || d > 31) return null
      return m[1]
    }
    const fields = {
      employeeName: String(out.employeeName ?? '').trim().slice(0, 100),
      dept: String(out.dept ?? '').trim().slice(0, 100) || null,
      position: String(out.position ?? '').trim().slice(0, 100) || null,
      contractType: TYPE_CODES.includes(out.contractType) ? out.contractType : 'FIXED_TERM_LABOR',
      startDate: normDate(out.startDate),
      endDate: normDate(out.endDate),
      probationEnd: normDate(out.probationEnd),
      remindBeforeDays: REMIND_DAYS.includes(Number(out.remindBeforeDays)) ? Number(out.remindBeforeDays) : 30,
      note: String(out.note ?? '').trim().slice(0, 500) || null,
    }
    const latestTask = await this.db.reviewTask.findFirst({
      where: { contractId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, createdAt: true },
    })
    return {
      fields,
      contract: {
        id: contract.id,
        title: contract.title,
        status: contract.status,
        reviewedAt: latestTask?.createdAt ?? null,
        reviewStatus: latestTask?.status ?? null,
      },
    }
  }
}

function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
