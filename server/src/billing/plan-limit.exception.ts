// server/src/billing/plan-limit.exception.ts
// 套餐权益拦截统一异常：HTTP 403 + 业务码 PLAN_LIMIT + reason/blocked 负载
// 由 AppExceptionFilter 转为 { error: { code, reason, blocked, message } }，
// 前端据此弹统一付费墙（券 / 月付 / 年付三入口）。
import { HttpException } from '@nestjs/common'
import type { Feature, PlanLimitReason } from './plans.config.js'

export class PlanLimitException extends HttpException {
  readonly reason: PlanLimitReason
  readonly blocked: string

  constructor(
    reason: PlanLimitReason,
    message: string,
    blocked: Feature | string = reason,
  ) {
    // getResponse 内容会被 AppExceptionFilter 识别并展开为结构化错误体
    super(
      { code: 'PLAN_LIMIT', reason, blocked, message },
      403,
    )
    this.name = 'PlanLimitException'
    this.reason = reason
    this.blocked = blocked
  }
}
