// server/src/contract/review/pdf-export.service.ts
// 服务端 PDF 导出（FR：修改后文档支持导出 docx/pdf）：Edge/Chromium 无头 print-to-pdf。
// 选型：Windows 自带 Edge，零额外安装；HTML/CSS 排版（A4 + 微软雅黑），红划线修订样式可完整保留。
// 代价：部署环境需存在 Edge 或 Chrome（可用 EDGE_PATH 指定），找不到时 503 明确提示。
import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Clause, Contract, ReviewTask, Risk } from '@prisma/client'
import { config } from '../../config/index.js'
import { logger } from '../../utils/logger.js'
import { tokenizeEdits } from './revision-anchor.js'

const SEVERITY_LABEL: Record<string, string> = { HIGH: '高风险', MED: '中风险', LOW: '低风险' }
const SOURCE_LABEL: Record<string, string> = {
  RULE: '规则引擎', AGENT: 'AI 语义审查', BOTH: '规则 + AI 双重确认', PLAYBOOK: '公司红线（Playbook）',
}
const STATUS_LABEL: Record<string, string> = {
  PENDING: '待确认', ACCEPTED: '已采纳', IGNORED: '已忽略', EDITED: '已修改采纳',
}
const ORDER: Record<string, number> = { HIGH: 0, MED: 1, LOW: 2 }

function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function textToHtml(s: string): string {
  return escapeHtml(s).replace(/\n/g, '<br/>')
}

const PAGE_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; font-size: 10.5pt; line-height: 1.75; color: #1f2937; margin: 0; }
  h1 { font-size: 16pt; text-align: center; margin: 0 0 6pt; }
  h2 { font-size: 12.5pt; border-bottom: 1px solid #d1d5db; padding-bottom: 3pt; margin: 16pt 0 6pt; }
  h3 { font-size: 11pt; margin: 10pt 0 4pt; }
  .meta { color: #6b7280; font-size: 9.5pt; margin: 2pt 0; }
  .conclusion { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 6pt 0; }
  th, td { border: 1px solid #d9dce1; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #eef2ff; }
  .clause h2 { color: #111827; }
  .quote { color: #6b4f00; }
  del { color: #c00000; text-decoration: line-through; }
  ins { color: #1d4ed8; text-decoration: underline; text-decoration-skip-ink: none; }
  .legend { color: #6b7280; font-size: 9pt; margin: 2pt 0 10pt; }
  .extra { color: #6b7280; font-style: italic; font-size: 9.5pt; }
  .footer { color: #6b7280; font-size: 8.5pt; margin-top: 20pt; border-top: 1px solid #e5e7eb; padding-top: 6pt; }
  .empty { color: #6b7280; }
`

function wrapDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style></head><body>${bodyHtml}</body></html>`
}

@Injectable()
export class PdfExportService {
  /** HTML → PDF（Edge headless print-to-pdf；60s 超时 kill；临时文件用完即删） */
  async htmlToPdf(html: string, trace: { contractId?: string } = {}): Promise<Buffer> {
    const edgePath = this.resolveEdgeBinary()
    const dir = path.join('./uploads', 'tmp_pdf')
    await mkdir(dir, { recursive: true })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const htmlPath = path.resolve(path.join(dir, `${stamp}.html`))
    const pdfPath = htmlPath.replace(/\.html$/, '.pdf')
    await writeFile(htmlPath, html, 'utf8')
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(edgePath, [
          '--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer',
          `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
        ], { windowsHide: true, stdio: 'ignore' })
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('PDF 渲染超时（60s），请重试'))
        }, 60_000)
        child.on('error', (e) => { clearTimeout(timer); reject(e) })
        child.on('exit', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`浏览器渲染进程退出码 ${code}`))
        })
      })
      const pdf = await readFile(pdfPath)
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('PDF 输出异常（缺少 %PDF 标识）')
      logger.info('pdf: rendered', { contractId: trace.contractId, bytes: pdf.length })
      return pdf
    } catch (e) {
      logger.warn('pdf: render failed', { contractId: trace.contractId, error: (e as Error).message })
      throw new ServiceUnavailableException(`PDF 渲染失败：${(e as Error).message}`)
    } finally {
      await rm(htmlPath, { force: true }).catch(() => {})
      await rm(pdfPath, { force: true }).catch(() => {})
    }
  }

  /** 探测 Edge/Chromium：config.edgePath（env EDGE_PATH）→ Windows 常见安装路径 */
  private resolveEdgeBinary(): string {
    const candidates = [
      config.app.edgePath,
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ].filter(Boolean)
    for (const c of candidates) {
      try { if (existsSync(c)) return c } catch { /* ignore */ }
    }
    throw new ServiceUnavailableException(
      '服务端未找到 Edge/Chromium 浏览器，无法导出 PDF。可在环境变量 EDGE_PATH 中指定浏览器可执行文件路径。',
    )
  }

  /**
   * 修订稿 HTML：与 docx 导出同源的锚点定位（tokenizeEdits）。
   * redline=红划线（del 红删除线 + ins 蓝下划线）；clean=干净终版（只呈现改写后正文）。
   */
  buildRevisionHtml(opts: { title: string; clauses: Clause[]; accepted: Risk[]; variant: 'redline' | 'clean' }): string {
    const { title, clauses, accepted, variant } = opts
    const acceptedByClause = new Map<string | null, Risk[]>()
    for (const r of accepted) {
      const list = acceptedByClause.get(r.clauseId) ?? []
      list.push(r)
      acceptedByClause.set(r.clauseId, list)
    }

    const body: string[] = [
      `<h1>${escapeHtml(title)}</h1>`,
      variant === 'redline'
        ? `<p class="legend">红划线修订稿 · ${new Date().toLocaleString('zh-CN', { hour12: false })} · 共应用 ${accepted.length} 处修订（<del>红色删除线</del>=原文，<ins>蓝色下划线</ins>=改写）</p>`
        : `<p class="legend">干净终版 · ${new Date().toLocaleString('zh-CN', { hour12: false })} · 已应用 ${accepted.length} 处修订（仅呈现修订后正文）</p>`,
    ]

    let unmatchedTotal = 0
    for (const clause of clauses) {
      const revs = acceptedByClause.get(clause.id) || []
      body.push(`<div class="clause"><h2>${escapeHtml(clause.indexNo === 0 ? clause.title : `第${clause.indexNo}条 ${clause.title}`)}</h2>`)
      if (!revs.length) {
        body.push(`<p>${textToHtml(clause.content)}</p></div>`)
        continue
      }
      const { tokens, unmatched } = tokenizeEdits(clause.content, revs)
      unmatchedTotal += unmatched.length
      body.push(`<p>${tokens.map((tk) => {
        if (tk.type === 'plain') return textToHtml(tk.text)
        if (variant === 'clean') return textToHtml(tk.ins)
        return `<del>${textToHtml(tk.del)}</del><ins>${textToHtml(tk.ins)}</ins>`
      }).join('')}</p>`)
      // 锚点未命中的修订：正文完整保留，修订以附加建议呈现，绝不丢失
      for (const r of unmatched) {
        body.push(`<p class="extra">附加修订建议（请人工定位）：</p>`)
        if (variant === 'redline') {
          body.push(`<p><del>${textToHtml(r.quote)}</del></p><p><ins>${textToHtml(r.rewritten!)}</ins></p>`)
        } else {
          body.push(`<p><ins>${textToHtml(r.rewritten!)}</ins></p>`)
        }
      }
      body.push('</div>')
    }
    if (unmatchedTotal) {
      body.push(`<p class="extra">注：${unmatchedTotal} 处修订未在正文中自动定位，已按附加建议列出。</p>`)
    }
    // 归属「合同全文」等无条款锚点的采纳点：条款循环之外统一呈现，保证采纳的修订一条都不丢
    const clauseIds = new Set(clauses.map((c) => c.id))
    const globals = accepted.filter((r) => !r.clauseId || !clauseIds.has(r.clauseId))
    if (globals.length) {
      body.push('<h2>其他修订建议</h2>')
      for (const r of globals) {
        if (r.clauseTitle) body.push(`<p class="meta">所在条款：${escapeHtml(r.clauseTitle)}</p>`)
        body.push(variant === 'redline'
          ? `<p><del>${textToHtml(r.quote)}</del></p><p><ins>${textToHtml(r.rewritten!)}</ins></p>`
          : `<p><ins>${textToHtml(r.rewritten!)}</ins></p>`)
      }
    }
    return wrapDocument(title, body.join('\n'))
  }

  /** 审查意见书 HTML：内容口径与 report-docx.ts 的 Word 版一致 */
  buildOpinionHtml(contract: Contract, task: ReviewTask, risks: Risk[]): string {
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

    const body: string[] = [
      '<h1>合同风险审查意见书</h1>',
      `<p class="meta">合同名称：${escapeHtml(contract.title)}</p>`,
      '<p class="meta">审查方式：规则引擎保底扫描 + AI 语义审查（双轨）+ 人工终审</p>',
      `<p class="meta">生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}</p>`,
      `<p class="conclusion">审查结论：${conclusion}</p>`,
      '<h2>一、风险概览</h2>',
      `<p>共发现 ${risks.length} 项风险：高风险 ${high} 项、中风险 ${med} 项、低风险 ${low} 项；人工采纳 ${accepted} 项。</p>`,
    ]

    if (sorted.length) {
      body.push('<h2>二、风险清单</h2>')
      body.push(`<table><tr><th style="width:6%">序号</th><th style="width:11%">分级</th><th style="width:32%">风险点</th><th style="width:23%">所在条款</th><th style="width:28%">发现方式 / 处置</th></tr>`)
      sorted.forEach((r, i) => {
        body.push(`<tr><td>${i + 1}</td><td>${escapeHtml(SEVERITY_LABEL[r.severity] || r.severity)}</td><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.clauseTitle || '—')}</td><td>${escapeHtml(`${SOURCE_LABEL[r.detectedBy] || r.detectedBy} / ${STATUS_LABEL[r.status] || r.status}`)}</td></tr>`)
      })
      body.push('</table>')

      body.push('<h2>三、风险分析与修改建议</h2>')
      sorted.forEach((r, i) => {
        body.push(`<h3>${i + 1}. 【${escapeHtml(SEVERITY_LABEL[r.severity] || r.severity)}】${escapeHtml(r.title)}</h3>`)
        if (r.clauseTitle) body.push(`<p class="meta">所在条款：${escapeHtml(r.clauseTitle)}</p>`)
        body.push(`<p class="meta">问题分类：${escapeHtml(r.category)} · 发现方式：${escapeHtml(SOURCE_LABEL[r.detectedBy] || r.detectedBy)} · 人工处置：${escapeHtml(STATUS_LABEL[r.status] || r.status)}</p>`)
        body.push(`<p class="quote">原文摘录：${textToHtml(r.quote.replace(/\n+/g, ' '))}</p>`)
        body.push(`<p>风险分析：${textToHtml(r.analysis)}</p>`)
        if (r.suggestion) body.push(`<p>修改建议：${textToHtml(r.suggestion)}</p>`)
        if (r.legalBasis) body.push(`<p>法律依据：${textToHtml(r.legalBasis)}</p>`)
        if (r.reviewerComment) body.push(`<p>终审备注：${textToHtml(r.reviewerComment)}</p>`)
      })
    } else {
      body.push('<p class="empty">本次审查未发现明显风险点。注意：自动审查不能替代专业法律意见，重大合同仍建议法务复核。</p>')
    }

    body.push('<p class="footer">本意见书由 ClauseMind 合同风险审查平台自动生成并经人工终审，仅供内部决策参考，不构成正式法律意见。</p>')
    return wrapDocument(`审查意见书 · ${contract.title}`, body.join('\n'))
  }
}
