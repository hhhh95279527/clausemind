// server/src/templates/template.service.ts
// 合同范本库（FR-20，/api/templates）：
//   GET  /                      范本列表（分类/搜索，仅返回已上架即已入库的目录项）
//   GET  /:docId/preview        在线预览（FREE 可看全文）
//   POST /:docId/adopt          采用：在本人/本租户名下生成 READY 文本合同并切条款（PERSONAL+）
//   GET  /:docId/download       下载 Word（PERSONAL+）
import { Injectable, NotFoundException } from '@nestjs/common'
import type { Response } from 'express'
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import { DatabaseService } from '../database/database.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { PlanLimitException } from '../billing/plan-limit.exception.js'
import { AuditService } from '../audit/audit.service.js'
import { splitClauses } from '../contract/parsing/clause-parser.js'
import { TEMPLATE_CATALOG, type TemplateCatalogItem } from './template-catalog.js'
import { TEMPLATE_CONTENTS } from './template-contents.js'

export interface TemplateListQuery {
  category?: string
  q?: string
}

@Injectable()
export class TemplateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /** 目录项 + 上架文档（docType=TEMPLATE）联合校验，未入库的范本不返回 */
  private async catalogWithDocs(): Promise<Array<TemplateCatalogItem & { chars: number; createdAt: Date }>> {
    const docs = await this.db.document.findMany({
      where: { docType: 'TEMPLATE' },
      select: { id: true, charCount: true, createdAt: true },
    })
    const docMap = new Map(docs.map((d) => [d.id, d]))
    return TEMPLATE_CATALOG
      .filter((item) => docMap.has(item.docId) && !!TEMPLATE_CONTENTS[item.docId])
      .map((item) => ({
        ...item,
        chars: docMap.get(item.docId)!.charCount || TEMPLATE_CONTENTS[item.docId].length,
        createdAt: docMap.get(item.docId)!.createdAt,
      }))
      .sort((a, b) => a.order - b.order)
  }

  private requireCatalogItem(docId: string): TemplateCatalogItem {
    const item = TEMPLATE_CATALOG.find((t) => t.docId === docId)
    if (!item || !TEMPLATE_CONTENTS[docId]) throw new NotFoundException('范本不存在')
    return item
  }

  /** FREE 仅可预览；采用/下载为 PERSONAL+ 付费能力（wordExport 档位恰好一致） */
  private assertAdoptAllowed(plan: string): void {
    if (!this.entitlements.can(plan, 'wordExport')) {
      throw new PlanLimitException(
        'EXPORT',
        '免费版仅可在线预览，采用范本生成可编辑合同、下载 Word 请升级个人版或使用深度审查券',
        'template.adopt',
      )
    }
  }

  async list(tenantId: string, query: TemplateListQuery) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    const plan = tenant?.plan ?? 'FREE'
    const canAdopt = this.entitlements.can(plan, 'wordExport')

    let items = await this.catalogWithDocs()
    if (query.category) items = items.filter((t) => t.category === query.category)
    const kw = query.q?.trim().toLowerCase()
    if (kw) {
      items = items.filter(
        (t) =>
          t.title.toLowerCase().includes(kw) ||
          t.summary.toLowerCase().includes(kw) ||
          TEMPLATE_CONTENTS[t.docId].toLowerCase().includes(kw),
      )
    }
    return {
      templates: items.map(({ createdAt, ...t }) => ({ ...t, updatedAt: createdAt })),
      total: items.length,
      canAdopt,
    }
  }

  async preview(tenantId: string, docId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    const canAdopt = this.entitlements.can(tenant?.plan ?? 'FREE', 'wordExport')
    const item = this.requireCatalogItem(docId)
    const doc = await this.db.document.findUnique({ where: { id: docId } })
    if (!doc || doc.docType !== 'TEMPLATE') throw new NotFoundException('范本尚未上架')

    const content = TEMPLATE_CONTENTS[docId]
    return {
      docId: item.docId,
      title: item.title,
      category: item.category,
      scene: item.scene,
      summary: item.summary,
      isNew: !!item.isNew,
      content,
      chars: content.length,
      clauses: splitClauses(content).length,
      canAdopt,
    }
  }

  /** 采用范本：生成归属当前用户/租户的 READY 文本合同，条款同步切好，可直接发起审查 */
  async adopt(tenantId: string, userId: string, docId: string, titleOverride?: string) {
    const item = this.requireCatalogItem(docId)
    const doc = await this.db.document.findUnique({ where: { id: docId } })
    if (!doc || doc.docType !== 'TEMPLATE') throw new NotFoundException('范本尚未上架')

    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    this.assertAdoptAllowed(tenant.plan)

    const content = TEMPLATE_CONTENTS[docId]
    const parsed = splitClauses(content)
    const title = (titleOverride || item.title).trim().slice(0, 200) || item.title

    const contract = await this.db.$transaction(async (tx) => {
      const created = await tx.contract.create({
        data: {
          tenantId,
          uploadedBy: userId,
          title,
          fileName: item.fileName,
          status: 'READY',
          progress: 100,
          fileType: 'txt',
          scene: item.scene,
          charCount: content.length,
          clausesCount: parsed.length,
        },
      })
      if (parsed.length) {
        await tx.clause.createMany({
          data: parsed.map((c, i) => ({
            contractId: created.id,
            indexNo: i,
            title: c.title.slice(0, 200),
            content: c.content,
            clauseType: c.clauseType,
            metadata: { adoptedFromTemplate: docId },
          })),
        })
      }
      return created
    })

    await this.audit.log({
      userId,
      action: 'TEMPLATE_ADOPT',
      resource: 'template',
      resourceId: docId,
      detail: { contractId: contract.id, title, scene: item.scene },
      tenantId,
    })

    return {
      contract: {
        id: contract.id,
        title: contract.title,
        status: contract.status,
        scene: contract.scene,
        charCount: contract.charCount,
        clausesCount: contract.clausesCount,
      },
    }
  }

  /** 下载范本 Word（PERSONAL+） */
  async downloadDocx(tenantId: string, userId: string, docId: string, res: Response) {
    const item = this.requireCatalogItem(docId)
    const doc = await this.db.document.findUnique({ where: { id: docId } })
    if (!doc || doc.docType !== 'TEMPLATE') throw new NotFoundException('范本尚未上架')

    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    this.assertAdoptAllowed(tenant.plan)

    const content = TEMPLATE_CONTENTS[docId]
    const children: Paragraph[] = [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: 'center',
        children: [new TextRun({ text: item.title, bold: true, size: 32 })],
      }),
      new Paragraph({
        alignment: 'center',
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: `由 WorkMind 范本库提供 · ${new Date().toLocaleDateString('zh-CN')} · 使用前请结合实际情况调整`,
            color: '6b7280',
            size: 18,
          }),
        ],
      }),
    ]
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line) {
        children.push(new Paragraph({ children: [new TextRun('')] }))
        continue
      }
      if (/^第[一二三四五六七八九十两〇零\d]{1,5}条/.test(line)) {
        children.push(new Paragraph({
          spacing: { before: 160 },
          children: [new TextRun({ text: line, bold: true })],
        }))
      } else {
        children.push(new Paragraph({ children: [new TextRun(line)] }))
      }
    }

    const word = new Document({
      creator: 'WorkMind',
      title: item.title,
      sections: [{ properties: {}, children }],
    })
    const buffer = await Packer.toBuffer(word)

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName.replace(/\.txt$/, '.docx'))}`,
    )
    res.end(buffer)

    await this.audit.log({
      userId,
      action: 'TEMPLATE_DOWNLOAD',
      resource: 'template',
      resourceId: docId,
      detail: { title: item.title },
      tenantId,
    })
  }
}
