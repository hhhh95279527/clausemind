// server/src/services/chat/memory.ts
// 会话记忆管理：短期记忆（当前对话历史）。
// 用户画像（user_profiles）已下线：相关函数与表已删除。
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { DatabaseService } from '../../database/database.service.js'

// ── Token 估算（不调 API，本地估算）────────────────────────────
function estTokens(text = '') {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length
  return Math.ceil(cn * 0.6 + (text.length - cn) * 0.25)
}

// ── 数据库服务引用（由 ChatController 注入）──────────────────────
let db: DatabaseService | null = null

export function setDatabase(database: DatabaseService) {
  db = database
}

// ── 会话历史管理（数据库持久化）──────────────────────────────────

export async function getHistory(sessionId: string) {
  if (!db) throw new Error('Database not initialized')

  // 从 DB 加载消息并转换为 LangChain Message 格式
  const messages = await db.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    take: 100, // 最多加载最近 100 条
  })

  return messages.map(msg => {
    if (msg.role === 'USER') return new HumanMessage(msg.content)
    if (msg.role === 'ASSISTANT') return new AIMessage(msg.content)
    return new HumanMessage(msg.content)
  })
}

export async function saveMessage(sessionId: string, userId: string | null, role: string, content: string, metadata?: any) {
  if (!db) throw new Error('Database not initialized')

  return db.message.create({
    data: {
      sessionId,
      userId,
      role: role === 'user' ? 'USER' : role === 'assistant' ? 'ASSISTANT' : 'SYSTEM',
      content,
      inputTokens: metadata?.inputTokens || 0,
      outputTokens: metadata?.outputTokens || 0,
      latencyMs: metadata?.latencyMs || 0,
      fromCache: metadata?.fromCache || false,
      feature: metadata?.feature || 'chat',
      metadata: metadata || {},
    },
  })
}

export async function clearHistory(sessionId: string) {
  if (!db) throw new Error('Database not initialized')

  await db.message.deleteMany({ where: { sessionId } })
}

// Token 感知截取：从最新消息往前，塞满为止
export function trimHistory(history: any[], maxTokens = 2000) {
  const result = []
  let total = 0

  for (let i = history.length - 1; i >= 0; i--) {
    const t = estTokens(history[i].content || '')
    if (total + t > maxTokens) break
    result.unshift(history[i])
    total += t
  }

  return result
}

// 返回所有会话列表（前端展示用）
export async function listSessions(userId: string) {
  if (!db) throw new Error('Database not initialized')

  const sessions = await db.chatSession.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: {
        select: { messages: true },
      },
    },
  })

  return sessions.map(s => ({
    id: s.id,
    title: s.title,
    messageCount: s._count.messages,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }))
}

// 会话详情（含消息，切换会话时懒加载）
export async function getSessionDetail(userId: string, sessionId: string) {
  if (!db) throw new Error('Database not initialized')

  const session = await db.chatSession.findFirst({
    where: { id: sessionId, userId },
    include: {
      messages: { orderBy: { createdAt: 'asc' }, take: 200 },
    },
  })
  if (!session) return null

  return {
    id: session.id,
    title: session.title,
    role: session.role,
    createdAt: session.createdAt.toISOString(),
    messages: session.messages.map((m) => ({
      id: m.id,
      role: m.role === 'USER' ? 'user' : 'assistant',
      content: m.content,
      time: m.createdAt.toISOString(),
      fromCache: m.fromCache,
    })),
  }
}

export async function createSession(userId: string, title: string, role: string) {
  if (!db) throw new Error('Database not initialized')

  return db.chatSession.create({
    data: {
      userId,
      title,
      role,
    },
  })
}
