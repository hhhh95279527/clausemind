// server/src/services/feishu/mcp-client.ts
// 飞书 P1 MCP（FR-25）：通过 lark-mcp stdio 把 2 个工具挂进审查 Agent：
//   feishu_send_review_card（审查结论发群）、feishu_write_bitable_record（台账入多维表格）。
// 无 FEISHU_APP_ID/SECRET 时直接降级：不拉起子进程、返回 []，审查图零影响。
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import { logger } from '../../utils/logger.js'

/** 懒加载单例：整个进程只尝试一次，避免每次审查都拉起子进程 */
let rawToolsPromise: Promise<StructuredToolInterface[]> | null = null

/** 要挂进审查 Agent 的 lark-mcp 工具名（lark-mcp 实际命名为 mcp__lark__im_v1_message_create 这类下划线格式，用 endsWith 匹配） */
const NAME_MESSAGE_CREATE = 'im_v1_message_create'
const NAME_RECORD_CREATE = 'bitable_v1_appTableRecord_create'

/** 本地 lark-mcp cli.js 绝对路径（server cwd 下解析；避免 import.meta——ts-node-dev 按 CJS 转译不支持） */
const LARK_MCP_CLI = path.join(process.cwd(), 'node_modules/@larksuiteoapi/lark-mcp/dist/cli.js')

/** 函数内懒读 env，避开模块级 import 求值时机（dotenv 在 import 之后才跑） */
function getAppEnv() {
  return { id: process.env.FEISHU_APP_ID || '', secret: process.env.FEISHU_APP_SECRET || '' }
}

function isFeishuMcpConfigured(): boolean {
  const { id, secret } = getAppEnv()
  return !!id && !!secret
}

async function loadRawTools(): Promise<StructuredToolInterface[]> {
  if (rawToolsPromise) return rawToolsPromise
  rawToolsPromise = (async () => {
    const { id, secret } = getAppEnv()
    logger.info('feishu mcp: spawning lark-mcp', { hasId: !!id, hasSecret: !!secret })
    try {
      const client = new MultiServerMCPClient({
        throwOnLoadError: false,
        mcpServers: {
          lark: {
            transport: 'stdio',
            // 直接用本地安装的 cli.js 启动：npx 会从 npm-cache/_npx 跑一个缺依赖
            // （zod）的缓存副本导致 Connection closed，绕开 npx 才稳定。
            command: process.execPath,
            args: [LARK_MCP_CLI, 'mcp', '-a', id, '-s', secret],
            // lark-mcp 启动时会向 %LOCALAPPDATA%\lark-mcp-nodejs 写日志/缓存，
            // 无权限时直接崩溃——重定向到系统 Temp 保证可写。
            env: { ...process.env, LOCALAPPDATA: os.tmpdir() },
            restart: { enabled: true, maxAttempts: 2, delayMs: 1500 },
          },
        },
      })
      const all = await client.getTools()
      const findByName = (n: string) => all.find((t) => t.name === n || t.name.endsWith(n))
      const selected = [findByName(NAME_MESSAGE_CREATE), findByName(NAME_RECORD_CREATE)].filter(
        Boolean,
      ) as StructuredToolInterface[]
      logger.info('feishu mcp: tools loaded', {
        total: all.length,
        selected: selected.map((t) => t.name),
      })
      return selected
    } catch (err) {
      rawToolsPromise = null
      logger.warn('feishu mcp: load failed', { error: (err as Error).message })
      return []
    }
  })()
  return rawToolsPromise
}

/** 审查 Agent 调用：未配置/加载失败均返回 []，绝不抛异常 */
export async function getFeishuMcpTools(): Promise<StructuredToolInterface[]> {
  if (!isFeishuMcpConfigured()) return []
  const rawTools = await loadRawTools()
  if (!rawTools.length) return []

  const msgTool = rawTools.find((t) => t.name.includes('message.create'))
  const recTool = rawTools.find((t) => t.name.includes('appTableRecord.create'))
  const out: StructuredToolInterface[] = []

  if (msgTool) {
    out.push(new DynamicStructuredTool({
      name: 'feishu_send_review_card',
      description: '把合同审查结论以飞书交互卡片发送到指定群或用户。需要目标会话的 receive_id（群用 chat_id）。',
      schema: z.object({
        receive_id_type: z.enum(['open_id', 'user_id', 'union_id', 'email', 'chat_id'])
          .describe('receive_id 类型，群聊用 chat_id'),
        receive_id: z.string().describe('目标会话 ID'),
        contract_title: z.string().describe('合同名称'),
        high: z.number().int().default(0).describe('高风险条数'),
        med: z.number().int().default(0).describe('中风险条数'),
        low: z.number().int().default(0).describe('低风险条数'),
        conclusion: z.string().describe('一句话审查结论'),
      }),
      func: async (args) => {
        const total = args.high + args.med + args.low
        const card = {
          config: { wide_screen_mode: true },
          header: {
            template: args.high > 0 ? 'red' : args.med > 0 ? 'orange' : 'green',
            title: { tag: 'plain_text', content: `合同审查完成：${args.contract_title}` },
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `${args.conclusion}\n风险共 ${total} 条：高 ${args.high} · 中 ${args.med} · 低 ${args.low}`,
              },
            },
          ],
        }
        try {
          const res = await msgTool.invoke({
            params: { receive_id_type: args.receive_id_type },
            data: {
              receive_id: args.receive_id,
              msg_type: 'interactive',
              content: JSON.stringify(card),
            },
          })
          return typeof res === 'string' ? res : JSON.stringify(res)
        } catch (err) {
          return `发送失败：${(err as Error).message}`
        }
      },
    }))
  }

  if (recTool) {
    out.push(new DynamicStructuredTool({
      name: 'feishu_write_bitable_record',
      description: '把一条合同 / 风险记录写入飞书多维表格（Bitable），用于审查台账归档。',
      schema: z.object({
        app_token: z.string().describe('多维表格 app token（链接中 base/ 后段）'),
        table_id: z.string().describe('数据表 table id'),
        fields: z.record(z.any()).describe('字段名 → 字段值，按表结构填写'),
      }),
      func: async (args) => {
        try {
          const res = await recTool.invoke({
            path: { app_token: args.app_token, table_id: args.table_id },
            data: { fields: args.fields },
          })
          return typeof res === 'string' ? res : JSON.stringify(res)
        } catch (err) {
          return `写入失败：${(err as Error).message}`
        }
      },
    }))
  }

  return out
}
