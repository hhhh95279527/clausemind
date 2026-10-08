// server/src/services/agent/agent.ts
// ReAct Agent：Reason + Act 循环（LangGraph 编排）
// 模型自主决定：思考 → 选工具 → 执行 → 观察 → 继续 → 完成
// 可观测：streamEvents 注入 trace callbacks，每步 LLM/工具调用自动落 Span。
import { StateGraph, END, START, Annotation, messagesStateReducer } from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { createChatModel } from '../model.js'
import { buildTools, TOOL_LABELS } from './tools.js'
import { logger } from '../../utils/logger.js'

const AGENT_SYSTEM = `你是 ClauseMind AI 任务助手，处理办公与法务场景的复杂任务。

工作原则：
1. 先理解完整需求，想清楚需要哪些步骤
2. 用最少的工具调用完成任务，禁止重复查询
3. 法律结论必须基于 legal_search 检索到的真实条文，引用时写明法条出处，禁止编造
4. 数值结果必须用 calculate 计算，不要心算
5. 信息充分后立刻给出完整最终回答`

// ── LangGraph 状态 ─────────────────────────────────────────────
const State = Annotation.Root({
  messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
  steps: Annotation({ reducer: (_: number, n: number) => n, default: () => 0 }),
})

interface AgentState {
  messages: BaseMessage[]
  steps: number
}

// 工具按环境能力动态构建（未配置 Tavily key 时无 web_search）
const allTools = buildTools()
const agentModel = createChatModel({ temperature: 0, streaming: true })
const toolNode = new ToolNode(allTools)

async function agentNode(state: AgentState) {
  const response = await agentModel.bindTools(allTools).invoke([
    new SystemMessage(AGENT_SYSTEM),
    ...state.messages,
  ])
  return { messages: [response], steps: state.steps + 1 }
}

// 路由：有工具调用且未超步数 → 继续；否则结束
function shouldContinue(state: AgentState): string {
  const last = state.messages[state.messages.length - 1] as any
  if (state.steps >= 8) {
    logger.warn('agent: max steps reached', { steps: state.steps })
    return END
  }
  return last.tool_calls?.length ? 'tools' : END
}

const agentGraph = new StateGraph(State as any)
  .addNode('agent', agentNode)
  .addNode('tools', toolNode)
  .addEdge(START, 'agent')
  .addConditionalEdges('agent', shouldContinue, { tools: 'tools', [END]: END } as any)
  .addEdge('tools', 'agent')
  .compile()

export interface AgentRunOptions {
  callbacks?: BaseCallbackHandler[]
}

/**
 * 流式执行 Agent
 * onEvent: 'tool_call' | 'tool_result' | 'token' | 'done' | 'error'
 */
export async function runAgent(
  task: string,
  options: AgentRunOptions,
  onEvent: (type: string, data: unknown) => void,
): Promise<void> {
  logger.info('agent: start', { task: task.slice(0, 60), tools: allTools.map((t) => t.name) })

  try {
    let stepCount = 0

    for await (const event of agentGraph.streamEvents(
      { messages: [new HumanMessage(task)], steps: 0 },
      { version: 'v2' as const, callbacks: options.callbacks },
    )) {
      const { event: eventType, name, data } = event

      if (eventType === 'on_tool_start') {
        stepCount++
        onEvent('tool_call', {
          step: stepCount,
          toolName: name,
          args: data?.input,
          label: TOOL_LABELS[name] || name,
        })
      }

      if (eventType === 'on_tool_end') {
        let result = data?.output
        if (typeof result === 'string') {
          try { result = JSON.parse(result) } catch { /* 纯文本结果保持原样 */ }
        }
        onEvent('tool_result', {
          toolName: name,
          result,
          resultText: typeof result === 'string' ? result : JSON.stringify(result),
        })
      }

      // 最终回答阶段的流式 token（排除工具调用决策帧）
      if (
        eventType === 'on_chat_model_stream' &&
        (data as any)?.chunk?.content &&
        !(data as any).chunk.tool_call_chunks?.length
      ) {
        onEvent('token', { token: (data as any).chunk.content })
      }
    }

    onEvent('done', { steps: stepCount })
    logger.info('agent: done', { steps: stepCount })
  } catch (err) {
    // 不在此吞错：向上抛由控制器转 SSE error 事件，同时让 Trace 正确记为 ERROR
    logger.error('agent: error', { error: (err as Error).message })
    throw err
  }
}

/** 前端展示当前实际可用的工具（随环境能力变化） */
export function getToolList() {
  return allTools.map((t) => ({
    name: t.name,
    label: TOOL_LABELS[t.name] || t.name,
    description: t.description,
  }))
}
