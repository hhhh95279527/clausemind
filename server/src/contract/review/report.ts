// server/src/contract/review/report.ts
// 审查意见书（Markdown）：确定性模板生成，不花 token、可复现；
// 浏览器端渲染后可直接打印 PDF（规避服务端中文字体依赖）。
import type { Contract, ReviewTask, Risk } from '@prisma/client'

const SEVERITY_LABEL: Record<string, string> = { HIGH: '高风险', MED: '中风险', LOW: '低风险' }
const SOURCE_LABEL: Record<string, string> = { RULE: '规则引擎', AGENT: 'AI 语义审查', BOTH: '规则 + AI 双重确认' }
const STATUS_LABEL: Record<string, string> = {
  PENDING: '待确认', ACCEPTED: '已采纳', IGNORED: '已忽略', EDITED: '已修改采纳',
}
const ORDER: Record<string, number> = { HIGH: 0, MED: 1, LOW: 2 }

export function buildOpinionMarkdown(
  contract: Contract,
  task: ReviewTask,
  risks: Risk[],
): string {
  const sorted = [...risks].sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9))
  const high = risks.filter((r) => r.severity === 'HIGH').length
  const med = risks.filter((r) => r.severity === 'MED').length
  const low = risks.filter((r) => r.severity === 'LOW').length
  const accepted = risks.filter((r) => r.status === 'ACCEPTED' || r.status === 'EDITED').length
  const conclusion = task.status === 'APPROVED'
    ? '**审查通过**（签署前请处理下列已采纳风险）'
    : task.status === 'REJECTED'
      ? '**审查不通过**，请依据下列风险修改后重新提交'
      : '待人工终审'

  const lines: string[] = []
  lines.push(`# 合同风险审查意见书`)
  lines.push('')
  lines.push(`- 合同名称：${contract.title}`)
  lines.push(`- 审查方式：规则引擎保底扫描 + AI 语义审查（双轨）+ 人工终审`)
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push(`- 审查结论：${conclusion}`)
  lines.push('')
  lines.push('## 一、风险概览')
  lines.push('')
  lines.push(`共发现 **${risks.length}** 项风险：高风险 ${high} 项、中风险 ${med} 项、低风险 ${low} 项；人工采纳 ${accepted} 项。`)
  lines.push('')

  if (!sorted.length) {
    lines.push('> 本次审查未发现明显风险点。注意：自动审查不能替代专业法律意见，重大合同仍建议法务复核。')
  } else {
    lines.push('## 二、风险清单与修改建议')
    lines.push('')
    sorted.forEach((r, i) => {
      lines.push(`### ${i + 1}. 【${SEVERITY_LABEL[r.severity]}】${r.title}`)
      lines.push('')
      if (r.clauseTitle) lines.push(`- **所在条款**：${r.clauseTitle}`)
      lines.push(`- **问题分类**：${r.category}`)
      lines.push(`- **发现方式**：${SOURCE_LABEL[r.detectedBy]}`)
      lines.push(`- **人工处置**：${STATUS_LABEL[r.status]}`)
      lines.push('')
      lines.push(`> ${r.quote.replace(/\n+/g, ' ')}`)
      lines.push('')
      lines.push(`**风险分析**：${r.analysis}`)
      lines.push('')
      if (r.suggestion) lines.push(`**修改建议**：${r.suggestion}`)
      if (r.legalBasis) lines.push(`**法律依据**：${r.legalBasis}`)
      if (r.reviewerComment) lines.push(`**终审备注**：${r.reviewerComment}`)
      lines.push('')
    })
  }

  lines.push('---')
  lines.push('')
  lines.push('*本意见书由 ClauseMind 合同风险审查平台自动生成并经人工终审，仅供内部决策参考，不构成正式法律意见。*')
  return lines.join('\n')
}
