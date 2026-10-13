// server/src/services/model.ts
// 模型工厂：统一创建模型实例，业务代码不直接 new ChatOpenAI
import { ChatOpenAI } from '@langchain/openai'
import { OpenAIEmbeddings } from '@langchain/openai'
import { ZhipuAIEmbeddings } from '@langchain/community/embeddings/zhipuai'
import { RunnableLambda } from '@langchain/core/runnables'
import { BaseMessage, SystemMessage, HumanMessage, coerceMessageLikeToMessage } from '@langchain/core/messages'
import { toJsonSchema } from '@langchain/core/utils/json_schema'
import { config } from '../config/index.js'

/**
 * 修补 ChatOpenAI.withStructuredOutput 的 jsonMode 分支。
 * 背景：DeepSeek（OpenAI 兼容）开启 response_format=json_object 时硬性要求：
 *   1) prompt 中必须出现 "json" 字样，否则 400
 *      ("Prompt must contain the word 'json'...")；
 *   2) jsonMode 不会像 functionCalling 那样把字段 schema 下发给模型，
 *      不额外说明字段结构会导致模型自由发挥、解析失败。
 * 统一在模型层注入一条 system 提示（含 JSON 字样 + JSON Schema 字段定义），
 * 所有业务调用点（审查/抽取/改稿/台账/Playbook/评测）零改动。
 */
function patchJsonMode(instance: ChatOpenAI): ChatOpenAI {
  const original = instance.withStructuredOutput.bind(instance)
  ;(instance as any).withStructuredOutput = (schema: any, params?: any) => {
    if (params?.method !== 'jsonMode') return original(schema, params)
    const inner = original(schema, params)
    let schemaBlock = ''
    try {
      schemaBlock = JSON.stringify(toJsonSchema(schema))
      if (schemaBlock.length > 6000) schemaBlock = schemaBlock.slice(0, 6000)
    } catch {
      schemaBlock = ''
    }
    const hint = new SystemMessage(
      '输出要求：你必须且只能输出一个 JSON 对象（不要 markdown、不要代码块围栏、不要任何解释或前后缀文字）。' +
      (schemaBlock ? `\n输出的 JSON 必须严格符合以下 JSON Schema 的字段与类型：\n${schemaBlock}` : ''),
    )
    const toMessages = (input: any): BaseMessage[] => {
      if (typeof input === 'string') return [hint, new HumanMessage(input)]
      const arr = Array.isArray(input) ? input : [input]
      const msgs = arr.map((m: any) =>
        m instanceof BaseMessage ? m : coerceMessageLikeToMessage(m),
      )
      return [hint, ...msgs]
    }
    return RunnableLambda.from(async (input: any, options?: any) =>
      inner.invoke(toMessages(input), options),
    )
  }
  return instance
}

/**
 * 创建对话模型
 * @param {object} options
 * @param {number}  options.temperature  - 随机性，0=确定，1=创意
 * @param {boolean} options.streaming    - 是否流式输出
 * @param {array}   options.callbacks    - LangChain 回调（如成本追踪）
 * @param {string}  options.model        - 覆盖默认主力模型（如轻量模型做分类等微型任务）
 */
export function createChatModel({ temperature = 0.7, streaming = false, callbacks = [], model }: {
  temperature?: number; streaming?: boolean; callbacks?: any[]; model?: string,
} = {}) {
  // ChatOpenAI 构造期只校验 key「是否存在」，无 key 时给占位串，避免模块加载（import 副作用）
  // 直接抛错导致 seed / build / eval 等不发起调用的场景崩溃；真实调用前各链路用 isValidAiKey
  // 预检跳过，漏网的调用在请求期失败，由 SSE 错误帧与既有降级逻辑处理
  const instance = new ChatOpenAI({
    model:         model || config.ai.primaryModel,
    apiKey:        config.ai.deepseekKey || 'sk-missing-key-placeholder',
    configuration: { baseURL: config.ai.baseURL },
    temperature,
    streaming,
    callbacks,
    // v4-pro 等 thinking 模型单轮（含推理链）可能 30s+，给到 120s
    timeout: 120000,
    // 只重试 1 次：429/5xx 由上层提示用户，避免错误请求长时间挂起
    maxRetries: 1,
  })
  // modelName 仅用于 tiktoken token 计数查表，不影响实际 API 调用的 model 字段
  // DeepSeek 与 gpt-3.5-turbo 同用 cl100k_base 编码，数量级估算是准确的
  instance.modelName = 'gpt-3.5-turbo'
  return patchJsonMode(instance)
}

/**
 * 创建 Embedding 模型（向量化文本，RAG 必用）
 * 注意：DeepSeek 暂无 embedding 模型，这里用 OpenAI 的
 * 如果没有 OpenAI Key，可以换成本地 Ollama 的 embedding 模型
 */
function createEmbeddings() {
  // 优先使用智谱 AI（key 格式 xxxx.xxxx）
  if (config.ai.zhipuKey) {
    return new ZhipuAIEmbeddings({
      apiKey:    config.ai.zhipuKey,
      modelName: 'embedding-3',
    })
  }
  // 其次使用 SiliconFlow / OpenAI 兼容接口
  if (config.ai.openaiKey) {
    return new OpenAIEmbeddings({
      model:         config.ai.embedModel,
      apiKey:        config.ai.openaiKey,
      configuration: { baseURL: config.ai.embedBaseURL },
    })
  }
  console.warn('⚠️  未配置 ZHIPU_API_KEY 或 OPENAI_API_KEY，RAG 功能将不可用')
  return null
}

/**
 * 创建视觉模型（图片合同 OCR）：deepseek-flash 接受 JPEG/PNG 等图片输入
 * OCR 要的是稳定转录而非创意，temperature=0
 */
function createVisionModel() {
  const instance = new ChatOpenAI({
    model:         config.ai.visionModel,
    apiKey:        config.ai.deepseekKey || 'sk-missing-key-placeholder',
    configuration: { baseURL: config.ai.baseURL },
    temperature: 0,
    streaming: false,
    timeout: 90000,
    maxRetries: 1,
  })
  instance.modelName = 'gpt-3.5-turbo'
  return instance
}

// 单例：应用启动时创建一次，全局复用
// 不每次请求都 new，节省内存
export const chatModel = createChatModel({ temperature: 0.7, streaming: true })
export const visionModel = createVisionModel()
export const embeddings = createEmbeddings()
