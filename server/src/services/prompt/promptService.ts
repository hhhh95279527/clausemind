// server/src/services/prompt/promptService.js
// Prompt 调试：模板管理、A/B 测试评分
import { z } from 'zod'
import { createChatModel } from '../model.js'

// 评分模型用 temperature=0，结果稳定
const scoreModel = createChatModel({ temperature: 0 })

// ── Prompt 模板存储（生产用数据库）────────────────────────────
const templateStore = new Map()
let templateIdSeq = 1

// 内置示例模板
const defaultTemplates = [
  {
    id: 't_default_1',
    name: '前端助手',
    systemPrompt: '你是前端开发专家，精通 Vue3、React、TypeScript。回答简洁准确，必要时给代码示例。',
    description: '通用前端技术问答',
    tags: ['前端', '技术'],
    createdAt: new Date().toISOString(),
    versions: [],
  },
  {
    id: 't_default_2',
    name: '代码 Review',
    systemPrompt: `你是资深代码评审专家。审查代码时，按以下顺序输出：
1. 【总体评价】一句话概括
2. 【问题列表】按严重程度排序，每条格式：[严重/一般/建议] 具体问题
3. 【优化建议】具体的改进代码示例
语气专业，直指问题，不废话。`,
    description: '代码审查专用',
    tags: ['代码', '审查'],
    createdAt: new Date().toISOString(),
    versions: [],
  },
  {
    id: 't_default_3',
    name: '简洁问答',
    systemPrompt: '用最简洁的语言回答问题，不超过3句话，不用废话开场。',
    description: '简短精准的回答风格',
    tags: ['简洁'],
    createdAt: new Date().toISOString(),
    versions: [],
  },
]

defaultTemplates.forEach(t => templateStore.set(t.id, t))

// ── 模板 CRUD ─────────────────────────────────────────────────
export function listTemplates() {
  return [...templateStore.values()].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}

export function getTemplate(id) {
  return templateStore.get(id) || null
}

export function saveTemplate({ name, systemPrompt, description = '', tags = [], existingId }) {
  const id = existingId || `t_${Date.now()}_${templateIdSeq++}`
  const existing = templateStore.get(id)

  const template = {
    id,
    name,
    systemPrompt,
    description,
    tags,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // 保存版本历史（最多保留 10 个版本）
    versions: [
      ...(existing?.versions || []),
      {
        version:      (existing?.versions?.length || 0) + 1,
        systemPrompt: existing?.systemPrompt || systemPrompt,
        savedAt:      new Date().toISOString(),
      },
    ].slice(-10),
  }

  templateStore.set(id, template)
  return template
}

export function deleteTemplate(id) {
  // 默认模板不允许删除
  if (id.startsWith('t_default_')) throw new Error('内置模板不能删除')
  const existed = templateStore.delete(id)
  if (!existed) throw new Error('模板不存在')
}

// ── A/B 测试：AI 自动评分 ──────────────────────────────────────
const EvalSchema = z.object({
  relevance:   z.number().min(1).max(5).describe('回答与问题的相关性'),
  accuracy:    z.number().min(1).max(5).describe('内容的准确性'),
  clarity:     z.number().min(1).max(5).describe('表达的清晰度'),
  conciseness: z.number().min(1).max(5).describe('是否简洁，不啰嗦'),
  overall:     z.number().min(1).max(5).describe('综合评分'),
  winner:      z.enum(['A', 'B', 'tie']).describe('哪个回答更好，相差不大就选 tie'),
  reason:      z.string().describe('判断理由，一句话，不超过40字'),
})

export async function scoreAbTest({ question, answerA, answerB }) {
  const evalModel = scoreModel.withStructuredOutput(EvalSchema, { method: 'jsonMode' })

  // 同时对 A、B 各自评分
  const [evalA, evalB] = await Promise.all([
    evalModel.invoke([
      { role: 'system', content: '你是 AI 回答质量评估专家，客观评分，不偏袒任何一方。' },
      { role: 'user',   content: `问题：${question}\n\n回答：${answerA}` },
    ]),
    evalModel.invoke([
      { role: 'system', content: '你是 AI 回答质量评估专家，客观评分，不偏袒任何一方。' },
      { role: 'user',   content: `问题：${question}\n\n回答：${answerB}` },
    ]),
  ])

  // 综合对比，判断胜者
  const compareModel = scoreModel.withStructuredOutput(z.object({
    winner: z.enum(['A', 'B', 'tie']),
    reason: z.string().describe('对比理由，30字以内'),
  }), { method: 'jsonMode' })

  const comparison = await compareModel.invoke([
    { role: 'system', content: '比较两个回答，选出更好的那个。评分相差0.5分以内视为平局。' },
    { role: 'user',   content: `
问题：${question}

回答A：${answerA}
A的评分：相关性${evalA.relevance} 准确性${evalA.accuracy} 清晰度${evalA.clarity} 简洁性${evalA.conciseness} 综合${evalA.overall}

回答B：${answerB}
B的评分：相关性${evalB.relevance} 准确性${evalB.accuracy} 清晰度${evalB.clarity} 简洁性${evalB.conciseness} 综合${evalB.overall}

哪个回答更好？` },
  ])

  return {
    scoreA: evalA,
    scoreB: evalB,
    winner: comparison.winner,
    reason: comparison.reason,
  }
}
