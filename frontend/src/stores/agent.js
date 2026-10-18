// frontend/src/stores/agent.js
// Agent 模块状态：多轮会话（持久化在后端 ChatSession/Message）、工具调用步骤、执行状态
// 会话模型与法规问答（knowledge.js）同构：sessions/currentSessionId/messages
import { create } from 'zustand'
import http, { fetchStream } from '@/utils/http.js'
import { useAppStore } from './app.js'

let msgId = 0

export const useAgentStore = create((set, get) => {
  // 局部更新某条消息（patchFn 接收消息对象，返回部分更新）
  const patchMsg = (id, patchFn) => set((s) => ({
    messages: s.messages.map((m) => m.id === id ? { ...m, ...patchFn(m) } : m),
  }))

  return {
    // ── 工具列表（从后端加载，默认值保证首屏可见；后端按环境能力动态下发）──
    toolList: [
      { name: 'contract_query',  label: '合同档案查询', description: '查询本企业已上传的合同与审查状态' },
      { name: 'risk_query',      label: '审查风险查询', description: '查询合同审查发现的风险清单与统计' },
      { name: 'ledger_query',    label: '合同台账查询', description: '查询员工合同台账与到期预警' },
      { name: 'rule_lookup',     label: '审查规则查询', description: '查询平台审查规则与企业红线规则' },
      { name: 'template_search', label: '合同范本查询', description: '查询平台合同范本目录' },
      { name: 'legal_search',    label: '法规库检索', description: '检索民法典、劳动法等条文原文' },
      { name: 'read_doc',        label: '知识库检索', description: '从公司知识库检索内部文档' },
      { name: 'calculate',       label: '数学计算', description: '金额、工期等精确计算' },
      { name: 'get_date',        label: '日期计算', description: '日期查询和工作日计算' },
    ],
    examples: [
      { title: '法规核查', prompts: [
        '我们准备签一份劳动合同：试用期 6 个月、月薪 8000 元且试用期按 80% 发放、约定违约金 5 万元。请逐项查法规库核实是否合法（试用期时长上限、试用期工资下限、违约金收取条件），每项给出法条出处和修改建议，最后输出一张「约定项 / 是否合法 / 依据 / 建议写法」合规对照表',
        '公司想约定「工资分 70% 基本工资 + 30% 绩效，绩效不达标不发」，这样合法吗？查法规说明工资构成的底线要求，并给出合规的约定写法',
        '入职时公司要求缴纳 2000 元岗位保证金并扣押毕业证原件，查法规说明这些要求是否违法，给出可以直接引用的法条原文',
      ] },
      { title: '合同盘点', prompts: [
        '盘点我上传过的全部合同：按合同列出名称、审查进度（是否完成人工终审）、风险总数及高中低分布；然后汇总还有风险未处理的合同，按高风险在前排序，输出一份「优先处理清单」，每项注明最该先看的那个风险点',
        '我有哪些合同是高风险且还没完成终审的？列出合同名、风险数、最严重问题的摘要，按紧急程度排序',
        '统计我上传合同的总体情况：总数、按类型的分布、审查完成率，用表格输出，并指出积压最严重的合同类型',
      ] },
      { title: '到期预警', teamOnly: true, prompts: [
        '查员工合同台账里未来 90 天内到期的合同，按剩余天数升序输出表格（员工 / 岗位 / 到期日 / 剩余天数）；其中 30 天内到期的单独标红提醒，并对每份合同给出「续签 / 不续签」的建议动作和理由',
        '有哪些员工的合同已经到期但还没处理？列出名单和各自超期天数，分别给出补签或终止的建议',
        '按季度统计未来一年每季度的合同到期数量，找出到期最集中的季度，提前给我人力续签规划建议',
      ] },
      { title: '风险复盘', prompts: [
        '统计我最近审查的合同中被标记的风险：按类别汇总数量并找出最高频的三类问题；结合平台审查规则分析每类的成因，输出一份「下次签合同前的起草检查清单」，每条检查项写明对应的规则和典型踩坑写法',
        '把我审查发现的高风险按条款位置归类，找出最容易踩雷的 3 个条款，各给一个合规写法示例',
        '对比我最近 10 份合同的审查结果：平均每份几个风险？风险是变多还是变少了？给我一份风险趋势简报',
      ] },
      { title: '范本推荐', prompts: [
        '我们要招一名在校实习生：6 月入职、实习 3 个月、每周到岗 4 天。请先从平台范本库推荐匹配的实习协议范本并说明理由；再查法规说明实习协议与劳动合同在社保、报酬、解除三方面的核心区别；最后列出签实习协议必须写清的 5 个要点',
        '我们要和一位自由设计师签合作协议，从范本库找合适的模板，说明它和劳动合同的核心区别，并提醒 3 个必须补充的条款',
        '公司要租一间办公室，范本库里有哪些可用的租赁类范本？推荐一个并说明签约前需要核实的 5 个事项',
      ] },
      { title: '竞业核查', prompts: [
        '查我上传过的合同里含竞业限制条款的合同，逐份摘录条款原文中的期限、限制范围和补偿标准；查法规说明竞业补偿的法定下限与最长期限，对照标出哪些合同的约定可能无效或过高，并给出逐份修改建议',
        '查法规说明竞业限制经济补偿按月支付时最低不能低于什么标准。我们计划按离职前月平均工资的 30% 支付，是否达标？',
        '哪些岗位才适合签竞业协议？查法规后结合我上传的合同，指出哪些合同的竞业对象约定过宽（比如覆盖了普通岗位）',
      ] },
      { title: '违约金计算', prompts: [
        '一份买卖合同约定：合同额 120 万元，逾期交付每日按合同额 0.5% 支付违约金，实际逾期 45 天。请用计算器算出违约金总额并列出计算过程；再查法规说明违约金过高的认定标准，判断该约定是否存在被调低的风险，最后给我一句对方提出异议时的应对话术',
        '员工离职只提前 3 天通知（法定 30 天），合同约定此时赔偿 1 个月工资，月薪 9000 元。算出赔偿金额，并查法规说明该约定是否有效',
        '计算逾期付款利息：本金 50 万元、约定日利率万分之五、逾期 120 天。列出算式和总额，并判断折算年化后是否受法律保护',
      ] },
      { title: '规则速查', prompts: [
        '把平台审查规则里关于保密条款、付款条件、违约责任三类的红线整理成对照表，列名为：条款类型 / 红线要求 / 常见踩坑写法 / 合规写法示例。表格后补充说明哪类问题在我们历史审查中出现得最多',
        '平台审查规则对「单方解除权」和「争议解决条款」有哪些红线？输出红线要求与常见踩坑写法的对照表',
        '查平台规则里和试用期相关的全部审查规则，按严重程度排列，告诉我哪些写法会被直接判为高风险',
      ] },
      { title: '日期推算', prompts: [
        '今天发出录用通知，要求候选人在 15 个工作日内报到（跳过周末和法定节假日）。请算出最晚报到日期；再倒排 3 个提醒节点（距截止 10 个工作日发确认邮件、5 个工作日收材料、1 个工作日备工位），输出一张带具体日期的时间表',
        '员工 3 月 10 日入职、试用期 3 个月，算出转正答辩的最晚日期，并倒排「提前 2 周发答辩通知、提前 1 周收自评表」两个节点的具体日期',
        '一份合同 6 月 30 日到期，续签协商需要提前 30 个自然日启动，算出最晚启动日期，并提醒是否需要避开五一假期',
      ] },
    ],

    loadMeta: async () => {
      try {
        const [toolsRes, examplesRes] = await Promise.all([
          http.get('/agent/tools'),
          http.get('/agent/examples'),
        ])
        const patch = {}
        if (toolsRes.tools?.length)      patch.toolList = toolsRes.tools
        if (examplesRes.examples?.length) patch.examples = examplesRes.examples
        if (Object.keys(patch).length) set(patch)
      } catch {}
    },

    // ── 会话管理（多轮对话历史持久化在后端，刷新不丢）──────────
    sessions: [],
    currentSessionId: null,
    messages: [],
    running: false,

    loadSessions: async () => {
      const data = await http.get('/agent/sessions')
      set({ sessions: data.sessions })
    },

    // 新建会话：懒创建，仅本地重置；首轮任务由后端隐式建会话并经 session 事件回填
    newSession: () => {
      if (get().running) return
      set({ currentSessionId: null, messages: [] })
    },

    // 切换会话：懒加载历史消息（assistant 消息附工具步骤）
    selectSession: async (sessionId) => {
      if (!sessionId || sessionId === get().currentSessionId || get().running) return
      const data = await http.get(`/agent/sessions/${sessionId}`)
      set({
        currentSessionId: data.session.id,
        messages: data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          time: m.time,
          steps: (m.steps || []).map((st) => ({ ...st, status: 'done' })),
          streaming: false,
        })),
      })
    },

    removeSession: async (sessionId) => {
      await http.delete(`/agent/sessions/${sessionId}`)
      set((s) => {
        const rest = s.sessions.filter((x) => x.id !== sessionId)
        const wasCurrent = s.currentSessionId === sessionId
        return {
          sessions: rest,
          currentSessionId: wasCurrent ? null : s.currentSessionId,
          messages: wasCurrent ? [] : s.messages,
        }
      })
    },

    // ── 执行任务（自动绑定当前会话；无会话时后端隐式创建）───────
    runTask: async (taskText) => {
      if (!taskText.trim() || get().running) return
      set({ running: true })

      const sessionId = get().currentSessionId

      // 本地先加 user + 流式 assistant 消息，实时更新
      const userMsg = { id: `local_${++msgId}`, role: 'user', content: taskText, time: new Date().toISOString() }
      const aiId = `local_${++msgId}`
      const aiMsg = { id: aiId, role: 'assistant', content: '', steps: [], streaming: true }
      set((s) => ({ messages: [...s.messages, userMsg, aiMsg] }))

      await fetchStream(
        '/api/agent/run',
        { task: taskText, ...(sessionId ? { sessionId } : {}) },
        {
          onEvent: (event, data) => {
            // 后端隐式建会话后回填：更新当前会话并插入会话列表
            if (event === 'session') {
              set((s) => ({
                currentSessionId: data.sessionId,
                sessions: s.sessions.some((x) => x.id === data.sessionId)
                  ? s.sessions
                  : [{ id: data.sessionId, title: data.title, updatedAt: new Date().toISOString() }, ...s.sessions],
              }))
            }

            // 工具被调用：向 assistant 消息追加步骤
            if (event === 'tool_call') {
              patchMsg(aiId, (m) => ({
                steps: [...m.steps, {
                  id:       m.steps.length + 1,
                  toolName: data.toolName,
                  label:    data.label,
                  args:     data.args,
                  result:   null,
                  status:   'running',   // running | done
                  startMs:  Date.now(),
                }],
              }))
            }

            // 工具执行完毕：更新该消息内最后一个 running 步骤
            if (event === 'tool_result') {
              patchMsg(aiId, (m) => {
                const idx = [...m.steps].reverse().findIndex(
                  (st) => st.toolName === data.toolName && st.status === 'running'
                )
                if (idx === -1) return {}
                const realIdx = m.steps.length - 1 - idx
                return {
                  steps: m.steps.map((st, i) => i === realIdx ? ({
                    ...st,
                    result:     data.resultText,
                    status:     'done',
                    durationMs: Date.now() - st.startMs,
                  }) : st),
                }
              })
            }

            // 注：'done' / 'error' 两个 SSE 事件由 fetchStream 直接路由到
            // 下方 onDone / onError，不会进入 onEvent（见 utils/http.js 分发逻辑）
          },

          onToken: (token) => {
            patchMsg(aiId, (m) => ({ content: m.content + token }))
          },

          onDone: () => {
            patchMsg(aiId, () => ({ streaming: false }))
            // 刷新会话列表（标题/排序更新）
            get().loadSessions().catch(() => {})
          },

          onError: (err) => {
            patchMsg(aiId, (m) => ({
              streaming: false,
              content: m.content || '任务执行失败，请重试。',
            }))
            useAppStore.getState().toast.error(err.message)
          },
        }
      )

      set({ running: false })
    },
  }
})
