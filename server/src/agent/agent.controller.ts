// server/src/agent/agent.controller.ts
// Agent 控制器：配额断言 → Trace 包裹 → SSE 流式推送每一步
// 多轮会话：复用 ChatSession(role='agent') / Message(feature='agent')，按 userId 属主隔离，
// 与法规问答（knowledge）同一套会话模型，刷新不丢历史。
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, OnModuleInit, Param, Post, Req, Res } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import { runAgent, getToolList } from '../services/agent/agent.js'
import { setToolsDatabase } from '../services/agent/tools.js'
import { DatabaseService } from '../database/database.service.js'
import { TraceService } from '../observability/trace.service.js'
import { QuotaService } from '../observability/quota.service.js'
import { logger } from '../utils/logger.js'
import { initSse } from '../utils/sse'

const SESSION_ROLE = 'agent'
const DEFAULT_TITLE = '新任务'
const HISTORY_MAX = 10          // 送入 LLM 的最近消息条数（约 5 轮），防 token 超限
const STEP_RESULT_MAX = 2000    // 工具步骤结果落库截断长度，防 metadata 体积爆炸

@ApiTags('agent')
@ApiBearerAuth('bearer')
@Controller('api/agent')
export class AgentController implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly tracer: TraceService,
    private readonly quota: QuotaService,
  ) {}

  onModuleInit() {
    setToolsDatabase(this.db)
  }

  // ── 会话管理（镜像 knowledge.controller）──────────────────────

  /** 校验会话属于当前用户，返回会话实体 */
  private async requireOwnedSession(userId: string, sessionId: string) {
    const session = await this.db.chatSession.findFirst({
      where: { id: sessionId, userId, role: SESSION_ROLE },
    })
    if (!session) throw new NotFoundException('会话不存在')
    return session
  }

  // GET /api/agent/sessions —— 当前用户的任务会话列表
  @Get('sessions')
  @ApiOperation({ summary: '任务会话列表', description: '返回当前用户全部任务 Agent 会话（按更新时间倒序）及消息数。' })
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

  // POST /api/agent/sessions —— 新建会话（前端默认懒创建，此端点保留作对称/调试）
  @Post('sessions')
  @ApiOperation({ summary: '新建任务会话', description: '标题缺省为「新任务」，首轮提问后自动改写为任务摘要。' })
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

  // GET /api/agent/sessions/:id —— 会话详情（含消息，切换会话时懒加载）
  @Get('sessions/:id')
  @ApiOperation({ summary: '会话详情（含历史消息）', description: '切换会话时懒加载，最多返回最近 200 条消息，助理消息附工具执行步骤 steps。仅会话属主可查。' })
  @ApiParam({ name: 'id', description: '会话 ID' })
  async sessionDetail(@Req() req: Request, @Param('id') id: string) {
    const session = await this.requireOwnedSession((req as any).user.userId, id)
    const messages = await this.db.message.findMany({
      where: { sessionId: id, feature: 'agent' },
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
        steps: m.role === 'ASSISTANT' ? (m.metadata as any)?.toolSteps || [] : [],
      })),
    }
  }

  // DELETE /api/agent/sessions/:id —— 删除整个会话（消息外键级联删除）
  @Delete('sessions/:id')
  @ApiOperation({ summary: '删除会话', description: '删除会话，消息经外键级联一并删除。仅会话属主可操作。' })
  @ApiParam({ name: 'id', description: '会话 ID' })
  async removeSession(@Req() req: Request, @Param('id') id: string) {
    await this.requireOwnedSession((req as any).user.userId, id)
    await this.db.chatSession.delete({ where: { id } })
    return { success: true }
  }

  /** 取会话最近的任务历史（不含当前输入），转为 LangChain 消息供多轮上下文 */
  private async loadHistory(sessionId: string, max = HISTORY_MAX) {
    const rows = await this.db.message.findMany({
      where: { sessionId, feature: 'agent' },
      orderBy: { createdAt: 'desc' },
      take: max,
      select: { role: true, content: true },
    })
    return rows.reverse().map((r) =>
      r.role === 'USER' ? new HumanMessage(r.content) : new AIMessage(r.content),
    )
  }

  // ── POST /api/agent/run ────────────────────────────────────────
  @Post('run')
  @ApiOperation({
    summary: '执行自然语言任务（SSE 流式，多轮会话）',
    description: 'ReAct Agent 编排业务工具（合同查询、台账、法规检索等），成功返回 201 + SSE。事件帧：`session`（会话信息）→ `start` → 若干工具执行进度帧（tool_call/tool_result/token）→ `done`；失败发 `error` 帧。携带 sessionId 时延续该会话上下文（多轮追问），不传则隐式创建新会话；消息持久化，首轮任务自动作为会话标题。任务描述上限 2000 字。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', maxLength: 2000, description: '要执行的任务描述' },
        sessionId: { type: 'string', description: '任务会话 ID（不传则隐式创建）' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'SSE 事件流（text/event-stream）',
    content: { 'text/event-stream': { schema: { type: 'string', description: 'event: session|start|tool_call|tool_result|token|done|error\\ndata: { JSON }' } } },
  })
  async run(@Req() req: Request, @Body() body: { task: string; sessionId?: string }, @Res() res: Response) {
    const { task } = body ?? {}
    const userId: string = (req as any).user.userId
    const tenantId: string = (req as any).user.tenantId

    if (!task?.trim()) throw new BadRequestException('任务不能为空')
    if (task.length > 2000) throw new BadRequestException('任务描述过长，请简洁描述')

    const sse = initSse(res)
    const send = sse.send

    try {
      await this.tracer.run(
        { feature: 'agent', name: `Agent 任务：${task.slice(0, 30)}`, tenantId, userId },
        async ({ callbacks }) => {
          await this.quota.assert(tenantId) // 放在 trace 内：被拦截的调用也留有审计痕迹

          // 会话：携带 sessionId 则校验属主延续上下文，否则隐式创建
          let sessionId = body.sessionId?.trim() || ''
          if (sessionId) {
            await this.requireOwnedSession(userId, sessionId)
          } else {
            const created = await this.db.chatSession.create({
              data: { userId, title: DEFAULT_TITLE, role: SESSION_ROLE },
            })
            sessionId = created.id
          }

          const history = await this.loadHistory(sessionId)

          // 当前任务先落库；默认标题的会话用首轮任务作为标题
          await this.db.message.create({
            data: { sessionId, userId, role: 'USER', content: task, feature: 'agent' },
          })
          const session = await this.db.chatSession.findUnique({ where: { id: sessionId }, select: { title: true } })
          if (session?.title === DEFAULT_TITLE) {
            await this.db.chatSession.update({
              where: { id: sessionId },
              data: { title: task.slice(0, 20) },
            })
          }
          send('session', { sessionId, title: task.slice(0, 20) })

          send('start', { task, timestamp: new Date().toISOString() })

          // 事件包装层：透传给前端的同时累积回答与工具步骤（runAgent 无返回值）；
          // 吞掉 runAgent 内部的 done——ASSISTANT 消息落库后由本端点统一下发，
          // 避免前端收到 done 即刷新列表时最后一轮尚未落库。
          let fullAnswer = ''
          const toolSteps: Array<Record<string, unknown>> = []
          const emit = (type: string, data: unknown) => {
            if (type === 'done') return
            send(type, data)
            const d = data as any
            if (type === 'token') {
              fullAnswer += d.token
            } else if (type === 'tool_call') {
              toolSteps.push({
                id: toolSteps.length + 1,
                toolName: d.toolName,
                label: d.label,
                args: d.args,
                result: null,
                status: 'running',
                startMs: Date.now(),
              })
            } else if (type === 'tool_result') {
              for (let i = toolSteps.length - 1; i >= 0; i--) {
                if (toolSteps[i].toolName === d.toolName && toolSteps[i].status === 'running') {
                  toolSteps[i] = {
                    ...toolSteps[i],
                    result: String(d.resultText || '').slice(0, STEP_RESULT_MAX),
                    status: 'done',
                    durationMs: Date.now() - (toolSteps[i].startMs as number),
                  }
                  break
                }
              }
            }
          }

          await runAgent(task, history, { callbacks }, emit)

          await this.db.message.create({
            data: {
              sessionId,
              userId,
              role: 'ASSISTANT',
              content: fullAnswer,
              feature: 'agent',
              metadata: { toolSteps },
            },
          })
          send('done', { steps: toolSteps.length })
        },
      )
    } catch (err) {
      logger.error('agent route error', { error: (err as Error).message, traceId: (req as any).traceId })
      sse.error(err)
    } finally {
      sse.end()
    }
  }

  // ── GET /api/agent/tools ───────────────────────────────────────
  @Get('tools')
  @ApiOperation({ summary: '获取 Agent 可用工具清单', description: '返回当前 Agent 注册的业务工具名称与说明。' })
  tools() {
    return { tools: getToolList() }
  }

  // ── GET /api/agent/examples ────────────────────────────────────
  @Get('examples')
  @ApiOperation({ summary: '获取任务示例', description: '返回分类示例及每类 3 条高频问题（prompts）。前端点击分类展开 prompts，点击某条 prompt 直接执行。teamOnly 的分类仅团队空间展示。' })
  examples() {
    return {
      examples: [
        {
          title: '法规核查', icon: '⚖️',
          prompts: [
            '我们准备签一份劳动合同：试用期 6 个月、月薪 8000 元且试用期按 80% 发放、约定违约金 5 万元。请逐项查法规库核实是否合法（试用期时长上限、试用期工资下限、违约金收取条件），每项给出法条出处和修改建议，最后输出一张「约定项 / 是否合法 / 依据 / 建议写法」合规对照表',
            '公司想约定「工资分 70% 基本工资 + 30% 绩效，绩效不达标不发」，这样合法吗？查法规说明工资构成的底线要求，并给出合规的约定写法',
            '入职时公司要求缴纳 2000 元岗位保证金并扣押毕业证原件，查法规说明这些要求是否违法，给出可以直接引用的法条原文',
          ],
        },
        {
          title: '合同盘点', icon: '📋',
          prompts: [
            '盘点我上传过的全部合同：按合同列出名称、审查进度（是否完成人工终审）、风险总数及高中低分布；然后汇总还有风险未处理的合同，按高风险在前排序，输出一份「优先处理清单」，每项注明最该先看的那个风险点',
            '我有哪些合同是高风险且还没完成终审的？列出合同名、风险数、最严重问题的摘要，按紧急程度排序',
            '统计我上传合同的总体情况：总数、按类型的分布、审查完成率，用表格输出，并指出积压最严重的合同类型',
          ],
        },
        {
          title: '到期预警', icon: '⏰', teamOnly: true,
          prompts: [
            '查员工合同台账里未来 90 天内到期的合同，按剩余天数升序输出表格（员工 / 岗位 / 到期日 / 剩余天数）；其中 30 天内到期的单独标红提醒，并对每份合同给出「续签 / 不续签」的建议动作和理由',
            '有哪些员工的合同已经到期但还没处理？列出名单和各自超期天数，分别给出补签或终止的建议',
            '按季度统计未来一年每季度的合同到期数量，找出到期最集中的季度，提前给我人力续签规划建议',
          ],
        },
        {
          title: '风险复盘', icon: '📊',
          prompts: [
            '统计我最近审查的合同中被标记的风险：按类别汇总数量并找出最高频的三类问题；结合平台审查规则分析每类的成因，输出一份「下次签合同前的起草检查清单」，每条检查项写明对应的规则和典型踩坑写法',
            '把我审查发现的高风险按条款位置归类，找出最容易踩雷的 3 个条款，各给一个合规写法示例',
            '对比我最近 10 份合同的审查结果：平均每份几个风险？风险是变多还是变少了？给我一份风险趋势简报',
          ],
        },
        {
          title: '范本推荐', icon: '📑',
          prompts: [
            '我们要招一名在校实习生：6 月入职、实习 3 个月、每周到岗 4 天。请先从平台范本库推荐匹配的实习协议范本并说明理由；再查法规说明实习协议与劳动合同在社保、报酬、解除三方面的核心区别；最后列出签实习协议必须写清的 5 个要点',
            '我们要和一位自由设计师签合作协议，从范本库找合适的模板，说明它和劳动合同的核心区别，并提醒 3 个必须补充的条款',
            '公司要租一间办公室，范本库里有哪些可用的租赁类范本？推荐一个并说明签约前需要核实的 5 个事项',
          ],
        },
        {
          title: '竞业核查', icon: '🔒',
          prompts: [
            '查我上传过的合同里含竞业限制条款的合同，逐份摘录条款原文中的期限、限制范围和补偿标准；查法规说明竞业补偿的法定下限与最长期限，对照标出哪些合同的约定可能无效或过高，并给出逐份修改建议',
            '查法规说明竞业限制经济补偿按月支付时最低不能低于什么标准。我们计划按离职前月平均工资的 30% 支付，是否达标？',
            '哪些岗位才适合签竞业协议？查法规后结合我上传的合同，指出哪些合同的竞业对象约定过宽（比如覆盖了普通岗位）',
          ],
        },
        {
          title: '违约金计算', icon: '🧮',
          prompts: [
            '一份买卖合同约定：合同额 120 万元，逾期交付每日按合同额 0.5% 支付违约金，实际逾期 45 天。请用计算器算出违约金总额并列出计算过程；再查法规说明违约金过高的认定标准，判断该约定是否存在被调低的风险，最后给我一句对方提出异议时的应对话术',
            '员工离职只提前 3 天通知（法定 30 天），合同约定此时赔偿 1 个月工资，月薪 9000 元。算出赔偿金额，并查法规说明该约定是否有效',
            '计算逾期付款利息：本金 50 万元、约定日利率万分之五、逾期 120 天。列出算式和总额，并判断折算年化后是否受法律保护',
          ],
        },
        {
          title: '规则速查', icon: '📏',
          prompts: [
            '把平台审查规则里关于保密条款、付款条件、违约责任三类的红线整理成对照表，列名为：条款类型 / 红线要求 / 常见踩坑写法 / 合规写法示例。表格后补充说明哪类问题在我们历史审查中出现得最多',
            '平台审查规则对「单方解除权」和「争议解决条款」有哪些红线？输出红线要求与常见踩坑写法的对照表',
            '查平台规则里和试用期相关的全部审查规则，按严重程度排列，告诉我哪些写法会被直接判为高风险',
          ],
        },
        {
          title: '日期推算', icon: '📅',
          prompts: [
            '今天发出录用通知，要求候选人在 15 个工作日内报到（跳过周末和法定节假日）。请算出最晚报到日期；再倒排 3 个提醒节点（距截止 10 个工作日发确认邮件、5 个工作日收材料、1 个工作日备工位），输出一张带具体日期的时间表',
            '员工 3 月 10 日入职、试用期 3 个月，算出转正答辩的最晚日期，并倒排「提前 2 周发答辩通知、提前 1 周收自评表」两个节点的具体日期',
            '一份合同 6 月 30 日到期，续签协商需要提前 30 个自然日启动，算出最晚启动日期，并提醒是否需要避开五一假期',
          ],
        },
      ],
    }
  }
}
