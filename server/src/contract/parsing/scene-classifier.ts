// server/src/contract/parsing/scene-classifier.ts
// 合同类型（场景）自动识别纯函数：
//   有 AI Key → 结构化分类（jsonMode），置信度 < 0.6 视为不可靠，回落关键词规则；
//   无 Key / 调用失败 → 关键词规则兜底；全不命中 → DEFAULT（调用方保持原 scene 不变）。
// 刻意不做成 Nest Provider：解析 worker 与审查 agent（模块级函数 + setReviewDatabase）都要能直接 import。
import { z } from 'zod'
import { config as appConfig, isValidAiKey } from '../../config/index.js'
import { createChatModel } from '../../services/model.js'
import { logger } from '../../utils/logger.js'
import type { ReviewScene } from '../../billing/plans.config.js'

export type SceneSourceTag = 'AI' | 'RULE' | 'DEFAULT'

export interface SceneClassifyResult {
  scene: ReviewScene
  confidence: number
  source: SceneSourceTag
  reason?: string
}

const SCENES = ['LABOR', 'INTERNSHIP', 'LEASE', 'SERVICE', 'NDA', 'SALE', 'LOAN', 'EQUITY', 'CUSTOM'] as const

const ClassifySchema = z.object({
  scene: z.enum(SCENES).describe(
    '合同类型：LABOR=劳动合同 / INTERNSHIP=实习协议（在校生，不构成劳动关系）/ LEASE=房屋租赁 / '
    + 'SERVICE=劳务·兼职·外包 / NDA=保密协议 / SALE=买卖·采购 / LOAN=借款·民间借贷 / EQUITY=股权转让 / CUSTOM=以上都不属于',
  ),
  confidence: z.number().min(0).max(1).describe('对判断结果的置信度 0~1；证据不足或合同类型混杂时给出低分（<0.6）'),
  reason: z.string().max(200).describe('判断依据（引用合同标题或正文中的关键特征，一句话）'),
})

/**
 * 关键词兜底规则。顺序敏感：
 *   实习必须先于劳动/劳务判定（"实习协议"常含"工资/用人单位"等字面）；
 *   劳务置于最后，避免"劳务外包"里出现的用工特征词抢走判定。
 */
const SCENE_RULES: Array<{ scene: ReviewScene; test: RegExp }> = [
  { scene: 'INTERNSHIP', test: /实习|在校生|三方协议/ },
  { scene: 'LABOR', test: /劳动合同|用人单位|劳动者|试用期|社会保险|社保|竞业限制|员工入职|劳动报酬|薪酬/ },
  { scene: 'LEASE', test: /租赁|出租|承租|租金|房屋|押金|业主|物业/ },
  { scene: 'NDA', test: /保密协议|商业秘密|不可披露|不得披露|保密信息|NDA/ },
  { scene: 'LOAN', test: /借款|贷款|民间借贷|出借|还款|本金|利息/ },
  { scene: 'EQUITY', test: /股权|股份|股东|增资|出资|期权|股权转让/ },
  { scene: 'SALE', test: /买卖|采购|购销|供货|商品|标的物|货款/ },
  { scene: 'SERVICE', test: /劳务|兼职|临时用工|外包|承揽|服务费/ },
]

/** 关键词兜底：返回命中的场景；全不命中返回 matched=false */
function ruleClassify(sample: string): { scene: ReviewScene; matched: boolean } {
  for (const r of SCENE_RULES) {
    if (r.test.test(sample)) return { scene: r.scene, matched: true }
  }
  return { scene: 'LABOR', matched: false }
}

/**
 * 识别合同类型。永远不抛异常（失败即回落），调用方无需 try。
 * @param text  合同正文（内部截取前 4000 字送模型）
 * @param title 合同标题（作为强特征参与判定）
 */
export async function classifyScene(text: string, title?: string): Promise<SceneClassifyResult> {
  const sample = `${title ?? ''}\n${(text ?? '').slice(0, 4000)}`.trim()
  if (!sample) return { scene: 'LABOR', confidence: 0, source: 'DEFAULT' }

  if (isValidAiKey(appConfig.ai.deepseekKey)) {
    try {
      const model = createChatModel({ temperature: 0, streaming: false })
      const structured = model.withStructuredOutput(ClassifySchema, { method: 'jsonMode' })
      const out = await structured.invoke([
        ['human', `你是合同类型识别助手。请根据合同标题与正文判断它属于哪一种合同类型（只输出 JSON 字段，不要解释）。

判定要点：
- 以"协议的实际法律性质"为准，不要被个别字面词误导：例如在校生与单位签的实习协议属于 INTERNSHIP（不构成劳动关系），
  而正式员工的劳动合同属于 LABOR；"劳务/兼职/外包/承揽"属于 SERVICE。
- 标题往往最能说明类型，正文中的定义、主体身份、核心权利义务作为佐证。
- 证据不足或合同类型混杂时，给出较低的 confidence（如 0.4~0.5），不要硬猜。

合同标题：${title || '（无）'}

合同正文（截断）：
${(text ?? '').slice(0, 4000)}`],
      ] as any)
      if (out?.confidence >= 0.6 && SCENES.includes(out.scene as ReviewScene)) {
        return {
          scene: out.scene as ReviewScene,
          confidence: out.confidence,
          source: 'AI',
          reason: out.reason,
        }
      }
      logger.info('scene-classifier: low confidence, fallback to keyword rules', {
        scene: out?.scene, confidence: out?.confidence,
      })
    } catch (e) {
      logger.warn('scene-classifier: ai classify failed, fallback to keyword rules', {
        error: (e as Error).message,
      })
    }
  }

  const { scene, matched } = ruleClassify(sample)
  return matched
    ? { scene, confidence: 0.7, source: 'RULE' }
    : { scene: 'LABOR', confidence: 0, source: 'DEFAULT' }
}

/** 从条款快照拼出识别用正文（审查轨兜底用） */
export function clausesToText(clauses: Array<{ title: string; content: string }>): string {
  return clauses.map((c) => `${c.title}\n${c.content}`).join('\n')
}
