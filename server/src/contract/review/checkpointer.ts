// server/src/contract/review/checkpointer.ts
// LangGraph 官方 PostgresSaver 单例：人工终审（HITL）状态持久化在 PG，
// 服务重启后凭 threadId 可恢复审查现场。选型与踩坑见 docs/adr/003-langgraph-interrupt-hitl.md。
import { Pool } from 'pg'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { config } from '../../config/index.js'
import { logger } from '../../utils/logger.js'

let pool: Pool | null = null
let saverPromise: Promise<any> | null = null

/** 惰性初始化：只在首次发起审查时建连接 + 建 checkpoint 表 */
export function getCheckpointer(): Promise<any> {
  if (!saverPromise) {
    saverPromise = (async () => {
      pool = new Pool({ connectionString: config.database.url, max: 5 })
      // 0.0.5 的 d.ts 未暴露 fromConnPool（运行时存在），用 any 桥接
      const saver: any = (PostgresSaver as any).fromConnPool
        ? (PostgresSaver as any).fromConnPool(pool)
        : new PostgresSaver(pool as any)
      await saver.setup()
      logger.info('review: postgres checkpointer ready')
      return saver
    })()
    saverPromise.catch((e) => {
      // 初始化失败允许下次重试
      saverPromise = null
      logger.error('review: checkpointer init failed', { error: e.message })
    })
  }
  return saverPromise
}


