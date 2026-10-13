// server/src/observability/pricing.ts
// 模型计价表（人民币，元 / 百万 tokens）——唯一真实成本来源，业务代码不允许自行估价
//
// 定价依据：DeepSeek 官方定价页（2026-09 核对）
//   deepseek-chat（旧名，兼容映射 V4 Flash 非思考模式）
//   峰谷：北京时间工作日 09:00-12:00、14:00-18:00 为高峰，其余为空闲（半价）
//   缓存命中输入价格约为未命中的 1/50
//
// 设计为纯函数模块：无 IO、无 Nest 依赖，便于单测与面试现场手算对账。

export type ModelId = 'deepseek-chat' | 'deepseek-flash' | 'deepseek-reasoner' | 'deepseek-v4-pro'

interface ModelPrice {
  /** 每百万输入 token（缓存未命中） */
  inputMiss: number
  /** 每百万输入 token（缓存命中） */
  inputHit: number
  /** 每百万输出 token */
  output: number
}

// 高峰单价；空闲单价统一为高峰的一半
const PEAK_PRICE: Record<ModelId, ModelPrice> = {
  'deepseek-chat':    { inputMiss: 2, inputHit: 0.04, output: 8 },
  'deepseek-flash':   { inputMiss: 2, inputHit: 0.04, output: 8 },
  'deepseek-reasoner': { inputMiss: 2, inputHit: 0.04, output: 8 },
  'deepseek-v4-pro':  { inputMiss: 9, inputHit: 0.3, output: 27 },
}

/** 判断给定时刻是否为高峰时段（北京时间工作日 9-12、14-18） */
function isPeakHour(at: Date = new Date()): boolean {
  // 转换为北京时间（UTC+8），避免服务器时区影响计费
  const bj = new Date(at.getTime() + 8 * 3600_000)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = bj.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function priceOf(model: string, at: Date): ModelPrice & { peak: boolean } {
  const peak = isPeakHour(at)
  const base = PEAK_PRICE[(model || 'deepseek-chat') as ModelId] || PEAK_PRICE['deepseek-chat']
  // 空闲时段半价
  const factor = peak ? 1 : 0.5
  return {
    inputMiss: base.inputMiss * factor,
    inputHit: base.inputHit * factor,
    output: base.output * factor,
    peak,
  }
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  /** 输入中命中上下文缓存的 token 数（DeepSeek usage.prompt_cache_hit_tokens） */
  cacheHitTokens?: number
}

export interface CostResult {
  costCny: number
  peak: boolean
  detail: { inputMiss: number; inputHit: number; output: number }
}

const PER_MILLION = 1_000_000

/** 按模型、用量、时刻计算人民币成本（四舍五入到 4 位小数，与 DB Decimal(10,4) 对齐） */
export function calcCostCny(model: string, usage: TokenUsage, at: Date = new Date()): CostResult {
  const p = priceOf(model, at)
  const inputTotal = usage.inputTokens ?? 0
  const hit = Math.min(usage.cacheHitTokens ?? 0, inputTotal)
  const miss = inputTotal - hit
  const output = usage.outputTokens ?? 0

  const cMiss = (miss / PER_MILLION) * p.inputMiss
  const cHit = (hit / PER_MILLION) * p.inputHit
  const cOut = (output / PER_MILLION) * p.output

  return {
    costCny: Number((cMiss + cHit + cOut).toFixed(6)),
    peak: p.peak,
    detail: {
      inputMiss: Number(cMiss.toFixed(6)),
      inputHit: Number(cHit.toFixed(6)),
      output: Number(cOut.toFixed(6)),
    },
  }
}
