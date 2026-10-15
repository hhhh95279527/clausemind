// server/src/contract/parsing/contract-parse.service.ts
// 合同解析 Worker（BullMQ CONTRACT_PARSE）：
// 上传请求只入队不等待；Worker 提取文本 → 切条款 →（可选）LLM 类型精修 → 落库回写进度。
import { Injectable, OnModuleInit } from '@nestjs/common'
import type { Job } from 'bullmq'
import { DatabaseService } from '../../database/database.service.js'
import { QueueService, QUEUES } from '../../queue/queue.service.js'
import { TraceService } from '../../observability/trace.service.js'
import { extractText } from '../../services/rag/ingest.js'
import { splitClauses, refineTypesWithLlm } from './clause-parser.js'
import { classifyScene } from './scene-classifier.js'
import { logger } from '../../utils/logger.js'

interface ParseJobData {
  contractId: string
  filePath: string
}

@Injectable()
export class ContractParseService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: QueueService,
    private readonly tracer: TraceService,
  ) {}

  onModuleInit() {
    this.queue.processor(QUEUES.CONTRACT_PARSE, (job) => this.handle(job as Job<ParseJobData>))
  }

  /** 入队：jobId 绑定 contractId，防止同一份合同被重复解析（BullMQ 6 禁止自定义 id 含 ':'） */
  async enqueue(contractId: string, filePath: string): Promise<string> {
    return this.queue.add(
      QUEUES.CONTRACT_PARSE,
      { contractId, filePath },
      { jobId: `parse-${contractId}` },
    )
  }

  private async handle(job: Job<ParseJobData>) {
    const { contractId, filePath } = job.data
    const contract = await this.db.contract.findUnique({ where: { id: contractId } })
    if (!contract) {
      logger.warn('contract-parse: contract not found', { contractId })
      return
    }

    await this.db.contract.update({
      where: { id: contractId },
      data: { status: 'PARSING', parseError: null, progress: 10 },
    })

    try {
      // 解析也是一次完整业务链路：LLM 类型精修的 token/成本同样进 Trace + 配额
      await this.tracer.run(
        { feature: 'contract_parse', name: `合同解析：${contract.title}`, tenantId: contract.tenantId, userId: contract.uploadedBy },
        async (handle) => {
          const { text } = await extractText(filePath, handle.callbacks)
          if (!text.trim() || /扫描版/.test(text.slice(0, 100))) {
            throw new Error('未能从文件中提取到有效文本：请使用文字版 PDF/Word/TXT，扫描件可拍照或导出为 JPG/PNG 图片后上传（自动 OCR 识别）')
          }
          await this.db.contract.update({ where: { id: contractId }, data: { progress: 40 } })

          const parsed = splitClauses(text)
          await this.db.contract.update({ where: { id: contractId }, data: { progress: 60 } })

          // LLM 精修条款类型：配额不足/无 key/调用失败都静默回退词典分类
          try {
            await refineTypesWithLlm(parsed, handle.callbacks)
          } catch (e) {
            logger.warn('contract-parse: llm refine skipped', { error: (e as Error).message })
          }

          // 条款落库（同合同重解析：先清旧条款及关联风险的子句引用）
          await this.db.clause.deleteMany({ where: { contractId } })
          await this.db.$transaction(
            parsed.map((c, i) => this.db.clause.create({
              data: {
                contractId,
                indexNo: i,
                title: c.title.slice(0, 200),
                content: c.content,
                clauseType: c.clauseType,
              },
            })),
          )

          // 合同类型自动识别：仅当上传/改类型时选了「自动识别（AUTO）」才回填。
          // 独立 try：识别失败或结论不确定一律保留占位，绝不影响解析主流程。
          try {
            const fresh = await this.db.contract.findUnique({
              where: { id: contractId },
              select: { sceneSource: true, title: true },
            })
            if (fresh?.sceneSource === 'AUTO') {
              const result = await classifyScene(text, fresh.title)
              if (result.source !== 'DEFAULT') {
                await this.db.contract.update({
                  where: { id: contractId },
                  data: { scene: result.scene, sceneSource: 'AI' },
                })
                logger.info('contract-parse: scene auto-detected', {
                  contractId, scene: result.scene, source: result.source, confidence: result.confidence,
                })
              }
            }
          } catch (e) {
            logger.warn('contract-parse: scene classify failed', { contractId, error: (e as Error).message })
          }

          await this.db.contract.update({
            where: { id: contractId },
            data: {
              status: 'READY',
              progress: 100,
              charCount: text.length,
              clausesCount: parsed.length,
            },
          })
          logger.info('contract-parse: done', { contractId, clauses: parsed.length, chars: text.length })
        },
      )
    } catch (err) {
      logger.error('contract-parse: failed', { contractId, error: (err as Error).message })
      await this.db.contract.update({
        where: { id: contractId },
        data: { status: 'FAILED', progress: 0, parseError: (err as Error).message.slice(0, 1000) },
      })
    }
    // 注意：上传原件必须保留在磁盘（路径存 contracts.storage_path），
    // 导出「保留原版式的红划线 Word」时要以它为底注入 w:ins/w:del。
    // 文件生命周期跟随合同：主动删除接口与 retention TTL 清理时一并 unlink。
  }
}
