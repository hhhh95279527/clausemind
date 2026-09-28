// server/src/contract/assistant/contract-assistant.service.ts
// 合同助手：就「本份合同」内容的问答（FR-8）。
// - 上下文 = 合同条款 + 本次审查风险（RAG 之外的窄域问答，防跑题/幻觉）
// - FREE 每份合同仅 1 轮（前端拦 + Redis 计数后端兜底）；深度套餐/深度券解锁的审查不限轮
// - 注入用户关注偏好（立场/语气/关注项）；无 Key 时 503 降级，不伪造回答
import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { DatabaseService } from '../../database/database.service.js'
import { EntitlementsService } from '../../billing/entitlements.service.js'
import { QuotaService } from '../../observability/quota.service.js'
import { RedisService } from '../../redis/redis.service.js'
import { createChatModel } from '../../services/model.js'
import { config as appConfig, isValidAiKey } from '../../config/index.js'
import { logger } from '../../utils/logger.js'

interface AskInput {
  tenantId: string
  userId: string
  contractId: string
  question: string
}

const FREE_ASK_LIMIT = 1
const CTX_CLAUSE_CHARS = 6000

@Injectable()
export class ContractAssistantService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly quota: QuotaService,
    private readonly redisService: RedisService,
  ) {}

  private askKey(tenantId: string, contractId: string) {
    return `wm:contract-ask:${tenantId}:${contractId}`
  }

  async ask(input: AskInput) {
    const { tenantId, userId, contractId, question } = input

    const [contract, tenant, user] = await Promise.all([
      this.db.contract.findFirst({
        where: { id: contractId, tenantId },
        include: {
          clauses: { orderBy: { indexNo: 'asc' } },
          reviewTasks: { orderBy: { createdAt: 'desc' }, take: 1, include: { risks: true } },
        },
      }),
      this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
      this.db.user.findUniqueOrThrow({ where: { id: userId } }),
    ])
    if (!contract) {
      throw new NotFoundException('合同不存在')
    }

    const task = contract.reviewTasks[0]
    const deep = !!task?.isDeep || this.entitlements.isDeep(tenant.plan)

    // 预检前移：AI Key 缺失 / 月度 token 配额超限时直接失败，不消耗 FREE 追问次数
    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ServiceUnavailableException('AI 模型未配置（DEEPSEEK_API_KEY 缺失），合同助手暂不可用；规则审查结果不受影响')
    }
    await this.quota.assert(tenantId)

    // FREE 轮次兜底：计数放在扣费式 INCR（先计数，模型失败不回滚——额度极小，防刷优先）
    const redis = this.redisService.getClient()
    let used = 0
    if (!deep) {
      const key = this.askKey(tenantId, contractId)
      used = await redis.incr(key).catch(() => FREE_ASK_LIMIT + 1)
      if (used === 1) await redis.expire(key, 90 * 86400).catch(() => {})
      if (used > FREE_ASK_LIMIT) {
        return {
          locked: true as const,
          remaining: 0,
          deep: false,
          answer: '继续追问、帮我改这条、模拟对方反驳为个人版 / 深度券权益。',
        }
      }
    }

    // ── 组装窄域上下文 ──
    const risks = task?.risks ?? []
    const clauseText = contract.clauses
      .map((c) => `【${c.indexNo === 0 ? '前言' : `第${c.indexNo}条`}｜${c.title}】${c.content}`)
      .join('\n')
      .slice(0, CTX_CLAUSE_CHARS)
    const riskText = risks
      .map((r, i) => `${i + 1}. [${r.severity}] ${r.title}｜原文：${r.quote}｜分析：${r.analysis}`)
      .join('\n')
      .slice(0, 3000)

    const prefs = (user.metadata as any)?.reviewPrefs || {}
    const stanceText = prefs.stance === 'LESSOR'
      ? '用户立场：出租方/用人单位等强势一方，回答需合法且兼顾其可执行性'
      : '用户立场：承租方/劳动者等弱势一方，回答优先提示对其不利之处与协商空间'
    const toneText = prefs.tone === 'PLAIN' ? '表达偏好：大白话，少用法言法语' : '表达偏好：严谨，必要时引用法条原文'
    const followText = Array.isArray(prefs.followRisks) && prefs.followRisks.length
      ? `用户特别关注：${prefs.followRisks.join('、')}，相关问题可多展开`
      : ''

    const system = `你是 WorkMind 合同助手，只回答与当前这份合同相关的问题（条款含义、合法性、协商/修改思路）。
要求：
1. 只能依据下面给出的合同原文与风险清单作答，原文没有的事实不要编造；涉及具体法条时说法条名称要谨慎，不确定就说"建议以当地最新规定/执业律师意见为准"。
2. 回答控制在 250 字以内，先给结论再讲依据；如果问题与本合同无关，礼貌说明你只回答本合同相关问题。
3. 不输出"作为 AI"之类的元话语。末尾用一句小字提示：以上为风险提示，不构成法律意见。
${stanceText}
${toneText}
${followText}

《${contract.title}》条款：
${clauseText || '（无条款文本）'}

${riskText ? `本次审查发现的风险：\n${riskText}` : '本份合同尚未完成审查。'}`

    const model = createChatModel({ temperature: 0.2, streaming: false })
    const reply = await model.invoke([
      new SystemMessage(system),
      new HumanMessage(question),
    ])

    return {
      locked: false,
      deep,
      remaining: deep ? null : Math.max(0, FREE_ASK_LIMIT - used),
      answer: String(reply.content || '').trim(),
    }
  }
}
