// server/src/contract/review/archive.ts
// 合同文档版本归档（FR：修改前后文档归档 + 时间线展示）：
// - REVISED：每次导出红划线修订稿归档一版；OPINION：终审通过时归档意见书 docx
// - ORIGINAL：不插行，list 接口用 contract.storagePath 动态合成（存量/新建合同零写入成本）
// - 纯函数不依赖 Nest DI：review.agent 的 finalize 用模块级 db，revision.service 走构造注入，两种调用方共用
// - 归档失败只告警不抛异常：绝不能阻断导出/终审主流程
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseService } from '../../database/database.service.js'
import { logger } from '../../utils/logger.js'

export type VersionKind = 'ORIGINAL' | 'REVISED' | 'OPINION'

export interface ArchiveVersionInput {
  tenantId: string
  contractId: string
  taskId?: string | null
  kind: Exclude<VersionKind, 'ORIGINAL'>
  fileName: string
  buffer: Buffer
  appliedCount?: number
  unmatchedCount?: number
  createdById?: string | null
}

/** 修订稿/意见书 docx 落盘 uploads/versions/{contractId}/ 并登记 contract_versions */
export async function archiveVersion(db: DatabaseService, input: ArchiveVersionInput) {
  try {
    const dir = path.join('./uploads', 'versions', input.contractId)
    await mkdir(dir, { recursive: true })
    const ext = path.extname(input.fileName) || '.docx'
    const storagePath = path.join(dir, `${Date.now()}-${input.kind.toLowerCase()}${ext}`)
    await writeFile(storagePath, input.buffer)
    const row = await db.contractVersion.create({
      data: {
        tenantId: input.tenantId,
        contractId: input.contractId,
        taskId: input.taskId ?? undefined,
        kind: input.kind,
        fileName: input.fileName.slice(0, 300),
        storagePath,
        sizeBytes: input.buffer.length,
        appliedCount: input.appliedCount,
        unmatchedCount: input.unmatchedCount,
        createdById: input.createdById ?? undefined,
      },
    })
    logger.info('archive: version stored', { kind: input.kind, contractId: input.contractId, file: storagePath })
    return row
  } catch (e) {
    logger.warn('archive: version store failed', {
      kind: input.kind, contractId: input.contractId, error: (e as Error).message,
    })
    return null
  }
}

/** 合同删除 / 到期清理时一并移除该合同的归档目录（DB 版本行由外键级联删除），避免 uploads 孤儿文件 */
export async function removeContractVersions(contractId: string) {
  await rm(path.join('./uploads', 'versions', contractId), { recursive: true, force: true }).catch(() => {})
}

/** 归档文件 Content-Type */
export function versionContentType(fileName: string): string {
  return fileName.toLowerCase().endsWith('.pdf')
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

/** Content-Disposition：ASCII fallback + RFC5987 filename*，中文文件名全端可读 */
export function versionDisposition(fileName: string): string {
  const ext = path.extname(fileName) || '.bin'
  return `attachment; filename="download${ext}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
