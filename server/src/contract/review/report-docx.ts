// server/src/contract/review/report-docx.ts
// 审查意见书 Word 导出（FR-21）：标题 / 风险表 / 分级 / 分析 / 建议 / 依据齐全。
// 纯 JS（docx）服务端生成，规避中文字体与无头浏览器依赖；内容口径与 report.ts 的 Markdown 版一致。
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import type { Contract, ReviewTask, Risk } from '@prisma/client'

const SEVERITY_LABEL: Record<string, string> = { HIGH: '高风险', MED: '中风险', LOW: '低风险' }
const SOURCE_LABEL: Record<string, string> = {
  RULE: '规则引擎', AGENT: 'AI 语义审查', BOTH: '规则 + AI 双重确认',
  PLAYBOOK: '公司红线（Playbook）',
}
const STATUS_LABEL: Record<string, string> = {
  PENDING: '待确认', ACCEPTED: '已采纳', IGNORED: '已忽略', EDITED: '已修改采纳',
}
const ORDER: Record<string, number> = { HIGH: 0, MED: 1, LOW: 2 }

const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'BFC4CC' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BFC4CC' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'BFC4CC' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'BFC4CC' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D9DCE1' },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'D9DCE1' },
}

function p(text: string, opts: { bold?: boolean; color?: string; size?: number; spacing?: number } = {}) {
  return new Paragraph({
    spacing: { after: opts.spacing ?? 80 },
    children: [new TextRun({ text, bold: !!opts.bold, color: opts.color, size: opts.size })],
  })
}

function cell(text: string, opts: { bold?: boolean; shade?: boolean; width?: number } = {}) {
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.shade ? { fill: 'EEF2FF' } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: !!opts.bold, size: 20 })] })],
  })
}

/** 生成审查意见书 .docx Buffer（调用方负责归属/状态/权益校验） */
export async function buildOpinionDocx(
  contract: Contract,
  task: ReviewTask,
  risks: Risk[],
): Promise<Buffer> {
  const sorted = [...risks].sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9))
  const high = risks.filter((r) => r.severity === 'HIGH').length
  const med = risks.filter((r) => r.severity === 'MED').length
  const low = risks.filter((r) => r.severity === 'LOW').length
  const accepted = risks.filter((r) => r.status === 'ACCEPTED' || r.status === 'EDITED').length
  const conclusion = task.status === 'APPROVED'
    ? '审查通过（签署前请处理下列已采纳风险）'
    : task.status === 'REJECTED'
      ? '审查不通过，请依据下列风险修改后重新提交'
      : '待人工终审'

  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: '合同风险审查意见书', bold: true, size: 36 })],
    }),
    p(`合同名称：${contract.title}`, { spacing: 40 }),
    p('审查方式：规则引擎保底扫描 + AI 语义审查（双轨）+ 人工终审', { spacing: 40 }),
    p(`生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`, { spacing: 40 }),
    p(`审查结论：${conclusion}`, { bold: true, spacing: 200 }),

    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('一、风险概览')] }),
    p(`共发现 ${risks.length} 项风险：高风险 ${high} 项、中风险 ${med} 项、低风险 ${low} 项；人工采纳 ${accepted} 项。`),
  ]

  if (sorted.length) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200 },
        children: [new TextRun('二、风险清单')],
      }),
    )
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: TABLE_BORDERS,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            cell('序号', { bold: true, shade: true, width: 8 }),
            cell('分级', { bold: true, shade: true, width: 12 }),
            cell('风险点', { bold: true, shade: true, width: 34 }),
            cell('所在条款', { bold: true, shade: true, width: 24 }),
            cell('发现方式 / 处置', { bold: true, shade: true, width: 22 }),
          ],
        }),
        ...sorted.map((r, i) => new TableRow({
          children: [
            cell(String(i + 1)),
            cell(SEVERITY_LABEL[r.severity] || r.severity),
            cell(r.title),
            cell(r.clauseTitle || '—'),
            cell(`${SOURCE_LABEL[r.detectedBy] || r.detectedBy} / ${STATUS_LABEL[r.status] || r.status}`),
          ],
        })),
      ],
    }))

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 280 },
      children: [new TextRun('三、风险分析与修改建议')],
    }))

    sorted.forEach((r, i) => {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 160 },
        children: [new TextRun({ text: `${i + 1}. 【${SEVERITY_LABEL[r.severity] || r.severity}】${r.title}`, bold: true })],
      }))
      if (r.clauseTitle) children.push(p(`所在条款：${r.clauseTitle}`, { spacing: 40 }))
      children.push(p(`问题分类：${r.category}`, { spacing: 40 }))
      children.push(p(`发现方式：${SOURCE_LABEL[r.detectedBy] || r.detectedBy}　人工处置：${STATUS_LABEL[r.status] || r.status}`, { spacing: 80 }))
      children.push(p(`原文摘录：${r.quote.replace(/\n+/g, ' ')}`, { color: '6B4F00' }))
      children.push(p(`风险分析：${r.analysis}`))
      if (r.suggestion) children.push(p(`修改建议：${r.suggestion}`))
      if (r.legalBasis) children.push(p(`法律依据：${r.legalBasis}`))
      if (r.reviewerComment) children.push(p(`终审备注：${r.reviewerComment}`))
    })
  } else {
    children.push(p('本次审查未发现明显风险点。注意：自动审查不能替代专业法律意见，重大合同仍建议法务复核。'))
  }

  children.push(
    new Paragraph({ spacing: { before: 320 }, children: [] }),
    p('本意见书由 WorkMind 合同风险审查平台自动生成并经人工终审，仅供内部决策参考，不构成正式法律意见。', {
      color: '6B7280',
      size: 18,
    }),
  )

  const doc = new Document({
    creator: 'WorkMind',
    title: `审查意见书 · ${contract.title}`,
    sections: [{ properties: {}, children }],
  })
  return Packer.toBuffer(doc)
}
