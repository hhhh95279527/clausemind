// server/src/services/notify/notify-broadcast.service.ts
// 三通道广播：同一内容并行推送飞书卡片 + 钉钉 markdown + 企微 markdown。
// 租户配了哪个通道推哪个，未配置/单通道失败均静默，绝不向业务链路抛异常。
import { Injectable } from '@nestjs/common'
import { FeishuNotifyService } from '../feishu/feishu-notify.service.js'
import { DingtalkNotifyService } from '../dingtalk/dingtalk-notify.service.js'
import { WeworkNotifyService } from '../wework/wework-notify.service.js'
import { logger } from '../../utils/logger.js'

export interface BroadcastSpec {
  /** 飞书卡片头配色 */
  template: 'blue' | 'red' | 'green' | 'orange'
  title: string
  /** 正文行（三通道共用；支持 markdown 加粗） */
  lines: string[]
  /** 可选跳转链接（飞书渲染为按钮，钉钉/企微渲染为链接行） */
  url?: string | null
}

@Injectable()
export class NotifyBroadcastService {
  constructor(
    private readonly feishu: FeishuNotifyService,
    private readonly dingtalk: DingtalkNotifyService,
    private readonly wework: WeworkNotifyService,
  ) {}

  /** 广播一条消息；返回成功通道数（0=均未配置或全部失败） */
  async send(tenantId: string, spec: BroadcastSpec): Promise<number> {
    const dtLines = spec.url ? [...spec.lines, '', `[查看详情](${spec.url})`] : spec.lines
    const results = await Promise.all([
      this.feishu.sendCard(tenantId, {
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          header: { template: spec.template, title: { tag: 'plain_text', content: spec.title } },
          elements: [
            { tag: 'div', text: { tag: 'lark_md', content: spec.lines.join('\n') } },
            ...(spec.url
              ? [
                  { tag: 'hr' },
                  {
                    tag: 'action',
                    actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看详情' }, url: spec.url, type: 'primary' }],
                  },
                ]
              : []),
          ],
        },
      }),
      this.dingtalk.sendMarkdown(tenantId, spec.title, dtLines),
      this.wework.sendMarkdown(tenantId, spec.title, dtLines),
    ])
    const okCount = results.filter((r) => r.ok).length
    // 全部失败且并非因为"都没配置"时记一条日志，便于排查凭证失效
    if (okCount === 0 && results.some((r) => r.reason && r.reason !== 'not_configured')) {
      logger.warn('notify broadcast: all channels failed', {
        tenantId, reasons: results.map((r) => r.reason).join(','),
      })
    }
    return okCount
  }
}
