// server/src/auth/mailer.service.ts
// 邮件发送通道：
// - dev（MAILER_CONSOLE 默认仅非生产开启）：不连 SMTP，验证码打印后端控制台，配合固定码 123456 演示
// - 生产：固定码通道硬禁用；配置 SMTP_HOST 走 nodemailer，未配置时降级为 console 打印（发信失败不阻断注册/登录主链路）
import { Injectable, Logger } from '@nestjs/common'
import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config/index.js'

export interface SendMailInput {
  to: string
  subject: string
  text: string
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger('Mailer')
  private transporter: Transporter | null = null
  private readonly consoleMode: boolean

  constructor() {
    this.consoleMode = config.mailer.console || !config.mailer.smtp.host
    if (!this.consoleMode) {
      this.transporter = nodemailer.createTransport({
        host: config.mailer.smtp.host,
        port: config.mailer.smtp.port,
        secure: config.mailer.smtp.secure,
        auth: config.mailer.smtp.user
          ? { user: config.mailer.smtp.user, pass: config.mailer.smtp.pass }
          : undefined,
      })
      this.logger.log('SMTP 邮件通道已启用')
    } else {
      this.logger.warn('邮件走 console 演示通道（验证码见后端日志，或使用固定码）')
    }
  }

  /** 发送邮件；console 模式直接打印。任何失败只记日志、不抛出，避免阻断认证主链路 */
  async send(mail: SendMailInput): Promise<void> {
    if (this.consoleMode || !this.transporter) {
      // eslint-disable-next-line no-console
      console.log(
        `\n📮 [MailerService:console] → ${mail.to}\n   主题：${mail.subject}\n   ${mail.text}\n`,
      )
      return
    }
    try {
      await this.transporter.sendMail({ from: config.mailer.smtp.from, ...mail })
    } catch (err) {
      this.logger.error(`SMTP 发送失败（已降级，不阻断主流程）：${(err as Error).message}`)
    }
  }

  /** 发送登录/注册验证码 */
  async sendVerificationCode(to: string, code: string, ttlMinutes: number): Promise<void> {
    await this.send({
      to,
      subject: '【WorkMind】登录验证码',
      text: `你的 WorkMind 验证码为 ${code}，${ttlMinutes} 分钟内有效，请勿泄露给他人。如非本人操作请忽略本邮件。`,
    })
  }
}
