// server/src/knowledge/knowledge.controller.ts
// 知识库控制器：文档管理（上传/列表/删除）+ 多会话 RAG 问答（流式）
//
// 文档范围（scope）：
//   mine      仅当前租户自己上传的 GENERAL 文档（问答默认，不混入平台内容）
//   platform  平台共享的 LEGAL 法规库（只读）
//
// 会话持久化：复用 ChatSession(role='knowledge') / Message(feature='knowledge')，
// 按 userId 属主校验，天然做到每轮会话相互隔离、刷新不丢失。
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, OnModuleInit, Param, Post, Query, Req, Res } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { assertRealFileType } from '../utils/file-guard.js'
import { ingestDocument, ingestText, getDocRegistry, deleteDocument, setDatabase } from '../services/rag/ingest.js'
import { ragQueryStream, type HistoryTurn } from '../services/rag/query.js'
import { logger } from '../utils/logger.js'
import { initSse } from '../utils/sse'
import { DatabaseService } from '../database/database.service.js'
import { TraceService } from '../observability/trace.service.js'
import { QuotaService } from '../observability/quota.service.js'

const SESSION_ROLE = 'knowledge'
const DEFAULT_TITLE = '新会话'

type Scope = 'mine' | 'platform'

function normalizeScope(raw: any): Scope {
  return raw === 'platform' ? 'platform' : 'mine'
}

/** scope → 检索参数 */
function scopeRetrieve(scope: Scope, tenantId: string, category?: string, sessionId?: string) {
  if (scope === 'platform') {
    // 平台法规库：LEGAL 共享文档（pg-store 对 LEGAL 不做租户过滤）
    return { docType: 'LEGAL' as const, category }
  }
  // 我的文档：严格只检索当前会话上传的 GENERAL 文档（会话级隔离）
  return { docType: 'GENERAL' as const, ownOnly: true, tenantId, category, sessionId }
}

@ApiTags('knowledge')
@ApiBearerAuth('bearer')
@Controller('api/knowledge')
export class KnowledgeController implements OnModuleInit {
  constructor(
    private db: DatabaseService,
    private tracer: TraceService,
    private quota: QuotaService,
  ) {}

  onModuleInit() {
    // 注入数据库服务到 RAG 模块
    setDatabase(this.db)
    logger.info('KnowledgeController: Database injected into RAG module')
  }

  // ── 会话管理 ─────────────────────────────────────────────────

  /** 校验会话属于当前用户，返回会话实体 */
  private async requireOwnedSession(userId: string, sessionId: string) {
    const session = await this.db.chatSession.findFirst({
      where: { id: sessionId, userId, role: SESSION_ROLE },
    })
    if (!session) throw new NotFoundException('会话不存在')
    return session
  }

  // GET /api/knowledge/sessions —— 当前用户的知识问答会话列表
  @Get('sessions')
  @ApiOperation({ summary: '知识问答会话列表', description: '返回当前用户全部知识问答会话（按更新时间倒序）及消息数。' })
  async listSessions(@Req() req: Request) {
    const userId: string = (req as any).user.userId
    const sessions = await this.db.chatSession.findMany({
      where: { userId, role: SESSION_ROLE },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    })
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        messageCount: s._count.messages,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
    }
  }

  // POST /api/knowledge/sessions —— 新建会话
  @Post('sessions')
  @ApiOperation({ summary: '新建知识问答会话', description: '创建后才能在「我的文档」范围上传文档与提问。标题缺省为「新会话」，首轮提问后自动改写。' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { title: { type: 'string', maxLength: 200, description: '会话标题（可选）' } },
    },
  })
  async createSession(@Req() req: Request, @Body() body: { title?: string } | undefined) {
    const userId: string = (req as any).user.userId
    const title = (body?.title || '').trim().slice(0, 200) || DEFAULT_TITLE
    const session = await this.db.chatSession.create({
      data: { userId, title, role: SESSION_ROLE },
    })
    return { session: { id: session.id, title: session.title, createdAt: session.createdAt.toISOString() } }
  }

  // GET /api/knowledge/sessions/:id —— 会话详情（含消息，切换会话时懒加载）
  @Get('sessions/:id')
  @ApiOperation({ summary: '会话详情（含历史消息）', description: '切换会话时懒加载，最多返回最近 200 条消息，助理消息附带检索来源 sources。仅会话属主可查。' })
  @ApiParam({ name: 'id', description: '会话 ID' })
  async sessionDetail(@Req() req: Request, @Param('id') id: string) {
    const session = await this.requireOwnedSession((req as any).user.userId, id)
    const messages = await this.db.message.findMany({
      where: { sessionId: id, feature: 'knowledge' },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    return {
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt.toISOString(),
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role === 'USER' ? 'user' : 'assistant',
        content: m.content,
        time: m.createdAt.toISOString(),
        sources: (m.metadata as any)?.sources || [],
      })),
    }
  }

  // DELETE /api/knowledge/sessions/:id — 删除整个会话（消息与本会话上传的文档均由外键级联删除）
  @Delete('sessions/:id')
  @ApiOperation({ summary: '删除会话', description: '删除会话，消息与本会话上传的文档经外键级联一并删除。仅会话属主可操作。' })
  @ApiParam({ name: 'id', description: '会话 ID' })
  async removeSession(@Req() req: Request, @Param('id') id: string) {
    await this.requireOwnedSession((req as any).user.userId, id)
    await this.db.chatSession.delete({ where: { id } })
    return { success: true }
  }

  /** 取会话最近的问答历史（不含当前问题），用于多轮改写与上下文 */
  private async loadHistory(sessionId: string, max = 10): Promise<HistoryTurn[]> {
    const rows = await this.db.message.findMany({
      where: { sessionId, feature: 'knowledge' },
      orderBy: { createdAt: 'desc' },
      take: max,
      select: { role: true, content: true },
    })
    return rows.reverse().map((r) => ({
      role: r.role === 'USER' ? 'user' as const : 'assistant' as const,
      content: r.content,
    }))
  }

  /** 保存一条知识问答消息（来源片段存 metadata） */
  private async saveKnowledgeMessage(args: {
    sessionId: string
    userId: string
    role: 'USER' | 'ASSISTANT'
    content: string
    sources?: any[]
  }) {
    return this.db.message.create({
      data: {
        sessionId: args.sessionId,
        userId: args.userId,
        role: args.role,
        content: args.content,
        feature: 'knowledge',
        metadata: args.sources ? { sources: args.sources } : undefined,
      },
    })
  }

  // ── 文档管理 ─────────────────────────────────────────────────

  // ── POST /api/knowledge/documents ─────────────────────────────
  // 上传文档并入库（文件 / 纯文本两种方式，均归本租户私有）
  @Post('documents')
  @ApiOperation({
    summary: '上传/录入知识文档',
    description: '文档归属于指定会话（会话级隔离，必须是本人会话）。支持两种入参：multipart 上传文件（txt/md/pdf，魔数校验），或 application/json 直接提交文本内容。入库后切片并生成 embedding（无 Key 时降级关键词检索）。',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['sessionId', 'file'],
          properties: {
            file: { type: 'string', format: 'binary', description: '文档文件（txt/md/pdf）' },
            sessionId: { type: 'string', description: '归属的知识问答会话 ID' },
            title: { type: 'string', description: '文档标题，缺省取文件名' },
            category: { type: 'string', description: '分类，缺省「通用」' },
          },
        },
        {
          type: 'object',
          required: ['sessionId', 'content'],
          properties: {
            content: { type: 'string', description: '直接录入的文本内容' },
            sessionId: { type: 'string', description: '归属的知识问答会话 ID' },
            title: { type: 'string', description: '文档标题，缺省「未命名文档」' },
            category: { type: 'string', description: '分类，缺省「通用」' },
          },
        },
      ],
    },
  })
  async uploadDocument(@Req() req: Request, @Body() body: any) {
    try {
      let docMeta

      const tenantId: string = (req as any).user.tenantId
      const userId: string = (req as any).user.userId

      // 会话级隔离：上传文档必须归属到用户自己的一个知识问答会话
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (!sessionId) throw new BadRequestException('请先新建会话后再上传文档')
      await this.requireOwnedSession(userId, sessionId)

      if ((req as any).file) {
        // 方式1：上传文件（magic number 校验通过后才入库，不通过删除临时文件）
        const file = (req as any).file
        try {
          await assertRealFileType(file.path, path.extname(file.originalname).toLowerCase())
        } catch (e) {
          await fs.unlink(file.path).catch(() => {})
          throw e
        }
        docMeta = await ingestDocument({
          filePath:   file.path,
          fileName:   file.originalname,
          title:      body.title || file.originalname.replace(/\.[^.]+$/, ''),
          category:   body.category || '通用',
          docType:    'GENERAL',
          tenantId,
          uploadedBy: userId,
          sessionId,
        })
      } else if (body.content) {
        // 方式2：直接传文本（前端粘贴内容），走 ingestText 统一入库流程
        docMeta = await ingestText({
          title:      body.title || '未命名文档',
          content:    body.content,
          category:   body.category || '通用',
          docType:    'GENERAL',
          tenantId,
          uploadedBy: userId,
          sessionId,
        })
      } else {
        throw new BadRequestException('请上传文件或提供文本内容')
      }

      return { success: true, document: docMeta }
    } catch (err) {
      if (err instanceof BadRequestException) throw err
      logger.error('knowledge: ingest error', { error: (err as Error).message })
      throw err
    }
  }

  // ── GET /api/knowledge/documents ──────────────────────────────
  // 文档列表。scope=mine（默认）：本租户上传的私有文档；scope=platform：平台法规库
  @Get('documents')
  @ApiOperation({
    summary: '文档列表',
    description: 'scope=mine（默认）：当前会话/租户的私有文档（需带 sessionId）；scope=platform：平台共享法规库（只读）。可按 category 过滤。',
  })
  @ApiQuery({ name: 'scope', required: false, enum: ['mine', 'platform'], description: '文档范围，默认 mine' })
  @ApiQuery({ name: 'sessionId', required: false, description: '【scope=mine】知识问答会话 ID，仅返回该会话文档' })
  @ApiQuery({ name: 'category', required: false, description: '分类精确过滤' })
  async listDocuments(
    @Req() req: Request,
    @Query('category') category?: string,
    @Query('scope') scopeRaw?: string,
    @Query('sessionId') sessionId?: string,
  ) {
    const tenantId: string = (req as any).user.tenantId
    const scope = normalizeScope(scopeRaw)
    const docs = await getDocRegistry({ tenantId, scope, sessionId })
    const filtered = category
      ? docs.filter((d: any) => d.category === category)
      : docs
    return { documents: filtered, scope }
  }

  // ── DELETE /api/knowledge/documents/:docId ─────────────────────
  // 删除文档（只能删本租户私有文档；平台共享文档 deleteDocument 会以无权拒绝）
  @Delete('documents/:docId')
  @ApiOperation({ summary: '删除文档', description: '仅可删除本会话/租户的私有文档；平台共享文档无权删除。不区分「不存在/无权」，统一 404 以防 ID 枚举。' })
  @ApiParam({ name: 'docId', description: '文档 ID' })
  async removeDocument(@Req() req: Request, @Param('docId') docId: string) {
    try {
      const userId: string = (req as any).user.userId
      // 防护：文档若归属于某个知识问答会话，须确认会话属主是当前用户
      const doc = await this.db.document.findUnique({
        where: { id: docId },
        select: { tenantId: true, sessionId: true },
      })
      if (doc?.sessionId) await this.requireOwnedSession(userId, doc.sessionId)
      await deleteDocument(docId, (req as any).user.tenantId)
      return { success: true }
    } catch (err) {
      const msg = (err as Error).message
      // 不向调用方区分"不存在/无权"，避免文档 id 枚举
      throw new NotFoundException(msg.includes('无权') ? '文档不存在' : msg)
    }
  }

  // ── POST /api/knowledge/query/stream ──────────────────────────
  // RAG 问答（流式）：先推送来源，再流式推送回答；消息落库、会话隔离
  @Post('query/stream')
  @ApiOperation({
    summary: 'RAG 知识问答（SSE 流式）',
    description: [
      '成功返回 201 + `text/event-stream`。事件帧顺序：`session`（会话信息）→ `status`（阶段提示）→ `sources`（命中的参考片段）→ 可选 `rewritten`（多轮改写后的问题）→ 多个 `token`（回答增量）→ `done`；失败发 `error` 帧。',
      'scope=mine 必须携带已存在且属于本人的 sessionId（先建会话再提问）；scope=platform 不传 sessionId 时隐式创建会话。问答消息持久化，按会话/用户隔离。',
    ].join('\n'),
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: '问题内容（不能为空）' },
        scope: { type: 'string', enum: ['mine', 'platform'], description: '检索范围：mine=我的文档（需 sessionId），platform=平台法规库', default: 'mine' },
        sessionId: { type: 'string', description: '知识问答会话 ID（mine 必填）' },
        category: { type: 'string', description: '限定检索分类（可选）' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'SSE 事件流（text/event-stream）',
    content: { 'text/event-stream': { schema: { type: 'string', description: 'event: session|status|sources|rewritten|token|done|error\\ndata: { JSON }' } } },
  })
  async queryStream(
    @Req() req: Request,
    @Body() body: { question: string; category?: string; scope?: string; sessionId?: string },
    @Res() res: Response,
  ) {
    const question = body.question?.trim()
    const scope = normalizeScope(body.scope)
    const userId: string = (req as any).user.userId
    const tenantId: string = (req as any).user.tenantId

    if (!question) {
      throw new BadRequestException('问题不能为空')
    }
    // "我的文档"必须在已创建的会话内提问（文档随会话隔离，不允许隐式会话绕过）
    if (scope === 'mine' && !body.sessionId?.trim()) {
      throw new BadRequestException('请先新建会话并上传文档后再提问')
    }

    const sse = initSse(res)
    const send = sse.send

    try {
      await this.tracer.run(
        { feature: 'knowledge', name: `知识库问答：${question.slice(0, 30)}`, tenantId, userId },
        async (handle) => {
          await this.quota.assert(tenantId)

          // 会话：我的文档范围必须由前端先建会话；平台法规库允许首轮提问隐式创建
          let sessionId = body.sessionId
          if (sessionId) {
            await this.requireOwnedSession(userId, sessionId)
          } else {
            const created = await this.db.chatSession.create({
              data: { userId, title: DEFAULT_TITLE, role: SESSION_ROLE },
            })
            sessionId = created.id
          }

          const history = await this.loadHistory(sessionId)

          // 当前问题先落库；默认标题的会话用首轮问题作为标题
          await this.saveKnowledgeMessage({ sessionId, userId, role: 'USER', content: question })
          const session = await this.db.chatSession.findUnique({ where: { id: sessionId }, select: { title: true } })
          if (session?.title === DEFAULT_TITLE) {
            await this.db.chatSession.update({
              where: { id: sessionId },
              data: { title: question.slice(0, 20) },
            })
          }
          send('session', { sessionId, title: question.slice(0, 20) })

          send('status', { message: '正在检索相关文档...' })

          const { sources, streamAnswer, rewrittenQuestion } = await ragQueryStream(question, {
            ...scopeRetrieve(scope, tenantId, body.category, sessionId),
            history,
            callbacks: handle.callbacks,
          })

          send('sources', { sources })
          if (rewrittenQuestion && rewrittenQuestion !== question) {
            send('rewritten', { original: question, rewritten: rewrittenQuestion })
          }

          if (!sources.length) {
            const emptyAnswer = scope === 'platform'
              ? '平台法规库中未找到相关内容，请尝试换一种提问方式。'
              : '当前会话还没有上传文档。请先在左侧上传文档（仅本会话可用）后再提问。'
            await this.saveKnowledgeMessage({ sessionId, userId, role: 'ASSISTANT', content: emptyAnswer })
            send('token', { token: emptyAnswer })
            send('done', {})
            return
          }

          send('status', { message: '正在生成回答...' })
          let fullAnswer = ''
          for await (const token of streamAnswer()) {
            fullAnswer += token
            send('token', { token })
          }
          const savedSources = sources.map((s: any) => ({
            chunkId: s.chunkId,
            docId: s.docId,
            title: s.title,
            score: s.score,
            content: s.content,
          }))
          await this.saveKnowledgeMessage({
            sessionId,
            userId,
            role: 'ASSISTANT',
            content: fullAnswer,
            sources: savedSources,
          })
          send('done', {})
          logger.info('knowledge: query done', { sessionId, scope, question: question.slice(0, 40), sources: sources.length })
        },
      )
    } catch (err) {
      logger.error('knowledge: query error', { error: (err as Error).message })
      sse.error(err)
    } finally {
      sse.end()
    }
  }

  // ── GET /api/knowledge/categories ─────────────────────────────
  // 当前范围下可见分类（前端筛选用）
  @Get('categories')
  @ApiOperation({ summary: '可见文档分类列表', description: '返回当前范围下全部分类（含「全部文档」空选项），供前端筛选下拉使用。' })
  @ApiQuery({ name: 'scope', required: false, enum: ['mine', 'platform'], description: '文档范围，默认 mine' })
  @ApiQuery({ name: 'sessionId', required: false, description: '【scope=mine】会话 ID' })
  async categories(
    @Req() req: Request,
    @Query('scope') scopeRaw?: string,
    @Query('sessionId') sessionId?: string,
  ) {
    const scope = normalizeScope(scopeRaw)
    const docs = await getDocRegistry({
      tenantId: (req as any).user.tenantId,
      scope,
      sessionId,
    })
    const categories = [...new Set(docs.map((d: any) => d.category))]
    return {
      scope,
      categories: [
        { value: '', label: '全部文档' },
        ...categories.map((c) => ({ value: c, label: c })),
      ],
    }
  }
}
