// server/src/queue/queue.service.ts
// BullMQ 统一队列入口：重活（合同解析、向量化）入队异步处理，HTTP 请求不被长任务拖死。
// Worker 与 API 同进程（单实例部署成本最低）；横向扩容时另起 worker 进程即可，代码零改动。
import { Injectable, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Queue, Worker, type Job } from 'bullmq'
import Redis from 'ioredis'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'

/** 全局队列名注册表（类型安全，避免散落字符串） */
export const QUEUES = {
  CONTRACT_PARSE: 'contract-parse',
  /** 每日清理 FREE 档过保留期合同（FR-10） */
  RETENTION_CLEANUP: 'retention-cleanup',
  /** 每日处理订阅到期：cancelAtPeriodEnd 或已过期的付费套餐降级 FREE（FR-13） */
  SUBSCRIPTION_EXPIRY: 'subscription-expiry',
  /** 每日 9:00 飞书/站内通知摘要（FR-25） */
  DAILY_DIGEST: 'daily-digest',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]
type Processor = (job: Job) => Promise<unknown>
interface RepeatableSpec { pattern: string; tz?: string }

@Injectable()
export class QueueService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private connection!: Redis
  private queues = new Map<string, Queue>()
  private workers: Worker[] = []
  private processors = new Map<string, Processor>()
  private repeatables = new Map<QueueName, RepeatableSpec>()

  onModuleInit() {
    // BullMQ 要求 maxRetriesPerRequest=null（阻塞命令 BRPOPLPUSH 等不能被重试策略打断）
    this.connection = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    })
    this.connection.on('error', (e) => logger.error('bullmq redis error', { error: e.message }))
  }

  private ensureQueue(name: QueueName): Queue {
    let q = this.queues.get(name)
    if (!q) {
      q = new Queue(name, { connection: this.connection })
      this.queues.set(name, q)
    }
    return q
  }

  /** 入队；返回 jobId，业务表可持久化用于状态回查 */
  async add(name: QueueName, data: Record<string, unknown>, opts?: { jobId?: string }): Promise<string> {
    const job = await this.ensureQueue(name).add(name, data, {
      jobId: opts?.jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    })
    return job.id as string
  }

  /**
   * 注册处理器：各业务模块在 onModuleInit 注册，
   * QueueService 在 onApplicationBootstrap 统一启动 Worker（保证注册不漏）。
   */
  processor(name: QueueName, fn: Processor) {
    this.processors.set(name, fn)
  }

  /**
   * 注册 repeatable cron（同样在 onModuleInit 注册，bootstrap 统一 upsert）。
   * BullMQ 对同 name + pattern 的调度幂等，重启不会产生重复任务。
   */
  repeatable(name: QueueName, pattern: string, tz = 'Asia/Shanghai') {
    this.repeatables.set(name, { pattern, tz })
  }

  async onApplicationBootstrap() {
    for (const [name, fn] of this.processors) {
      const worker = new Worker(name, fn, { connection: this.connection, concurrency: 3 })
      worker.on('completed', (job) => logger.info('job completed', { queue: name, jobId: job.id }))
      worker.on('failed', (job, err) =>
        logger.error('job failed', { queue: name, jobId: job?.id, attempts: job?.attemptsMade, error: err.message }))
      this.workers.push(worker)
      logger.info('worker started', { queue: name })
    }

    for (const [name, spec] of this.repeatables) {
      // BullMQ v6：repeatable 改走 Job Schedulers API（同 id + pattern 幂等 upsert）
      await this.ensureQueue(name)
        .upsertJobScheduler(name, { pattern: spec.pattern, tz: spec.tz }, {
          name,
          data: { scheduled: true },
        })
        .then(() => logger.info('repeatable scheduled', { queue: name, pattern: spec.pattern }))
        .catch((e) => logger.error('repeatable schedule failed', { queue: name, error: e.message }))
    }
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close()))
    await Promise.all([...this.queues.values()].map((q) => q.close()))
    this.connection?.disconnect()
  }
}
