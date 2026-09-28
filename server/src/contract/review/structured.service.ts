// server/src/contract/review/structured.service.ts
// 企业审查台「结构化信息」（FR-16 企业态）：
//   AI 从条款抽取金额（含红线标记）/期限/付款节点/关键义务，结果缓存到 Contract.structuredInfo；
//   无 Key 抛 409（前端隐藏卡片），条款为空抛 400。
import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common'
import { DatabaseService } from '../../database/database.service.js'
import { config as appConfig, isValidAiKey } from '../../config/index.js'
import { createChatModel } from '../../services/model.js'
import { z } from 'zod'

const StructuredSchema = z.object({
  amounts: z.array(z.object({
    name: z.string().max(40).describe('金额项名称，如：月租金 / 押金 / 试用期工资 / 违约金'),
    amount: z.string().max(80).describe('金额与计费口径的简短原文概括，如：¥8,000 / 月工资的 70%'),
    note: z.string().max(200).describe('补充说明（支付条件、退还方式等）；没有返回空字符串'),
    redline: z.boolean().describe('该金额约定是否明显违法或触发公司红线（如押金过高、试用期工资低于 80%）'),
  })).max(8).describe('合同中所有关键金额项；没有金额类条款时返回空数组'),
  term: z.object({
    duration: z.string().max(80).describe('合同期限概括，如：12 个月 / 无固定期限；无法判断返回空字符串'),
    startDate: z.string().max(20).describe('开始日期 YYYY-MM-DD；无法判断返回空字符串'),
    endDate: z.string().max(20).describe('到期日期 YYYY-MM-DD；无固定期限或无法判断返回空字符串'),
    description: z.string().max(200).describe('期限与续期约定一句话概括；无法判断返回空字符串'),
  }),
  paymentTerms: z.string().max(400).describe('付款节点、方式与账期的概括；没有相关条款返回空字符串'),
  keyObligations: z.array(z.string().max(200)).describe('双方关键义务/重大权利义务失衡条款，每条一句话；最多 8 条'),
})

export type StructuredInfo = z.infer<typeof StructuredSchema>

@Injectable()
export class StructuredService {
  constructor(private readonly db: DatabaseService) {}

  /** 读取缓存；不存在则现场 AI 抽取并落库。force=true 时忽略缓存重抽。 */
  async getOrExtract(tenantId: string, contractId: string, force = false) {
    const contract = await this.db.contract.findFirst({
      where: { id: contractId, tenantId },
      select: { id: true, title: true, scene: true, structuredInfo: true },
    })
    if (!contract) throw new NotFoundException('合同不存在或不属于当前工作空间')

    if (!force && contract.structuredInfo) {
      return { structured: contract.structuredInfo as StructuredInfo, cached: true }
    }
    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ConflictException('未配置模型 Key，无法生成结构化信息')
    }
    const clauses = await this.db.clause.findMany({
      where: { contractId },
      orderBy: { indexNo: 'asc' },
      select: { title: true, content: true },
    })
    const text = clauses.map((c) => `${c.title}\n${c.content}`).join('\n').slice(0, 9000)
    if (!text.trim()) throw new BadRequestException('该合同尚未解析出条款文本，无法抽取结构化信息')

    const model = createChatModel({ temperature: 0, streaming: false })
    const structured = model.withStructuredOutput(StructuredSchema, { name: 'contract_structured' })
    const out = await structured.invoke([
      ['human', `你是合同结构化信息抽取助手。请从下列合同条款中抽取业务方最关心的结构化字段：
- 只依据合同原文，禁止编造金额与日期；拿不准的字段返回空字符串或空数组。
- 日期统一 YYYY-MM-DD；金额保留原文口径（如 ¥8,000、月工资 80%）。
- redline=true 仅用于明显违法或严重不对等的金额约定（例如：租房押金显著过高、试用期工资低于法定 80%、畸高违约金）。
- 关键义务挑最重要的，不要罗列常识性条款。

合同标题：${contract.title}

条款：
${text}`],
    ] as any)

    const info: StructuredInfo = {
      amounts: (out.amounts ?? []).slice(0, 8).map((a) => ({
        name: String(a.name ?? '').slice(0, 40),
        amount: String(a.amount ?? '').slice(0, 80),
        note: String(a.note ?? '').slice(0, 200),
        redline: a.redline === true,
      })),
      term: {
        duration: String(out.term?.duration ?? '').slice(0, 80),
        startDate: String(out.term?.startDate ?? '').slice(0, 20),
        endDate: String(out.term?.endDate ?? '').slice(0, 20),
        description: String(out.term?.description ?? '').slice(0, 200),
      },
      paymentTerms: String(out.paymentTerms ?? '').slice(0, 400),
      keyObligations: (out.keyObligations ?? []).slice(0, 8).map((s) => String(s).slice(0, 200)),
    }
    await this.db.contract.update({ where: { id: contractId }, data: { structuredInfo: info as any } })
    return { structured: info, cached: false }
  }
}
