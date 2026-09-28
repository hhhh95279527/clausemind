// server/src/filters/app-exception.filter.ts
// 全局异常过滤器：统一错误格式 + 404 处理
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, NotFoundException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { classifyError } from '../utils/errors.js'
import { QuotaExceededException } from '../observability/quota.service.js'
import { PlanLimitException } from '../billing/plan-limit.exception.js'
import { logger } from '../utils/logger.js'

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const req = ctx.getRequest<Request>()

    // 租户月度配额超额：429 + 业务错误码，前端可引导升级套餐
    if (exception instanceof QuotaExceededException) {
      return res.status(429).json({
        error: { code: 'QUOTA_EXCEEDED', message: exception.message, retryable: false },
      })
    }

    // 套餐权益拦截：403 PLAN_LIMIT + reason/blocked，前端弹统一付费墙
    if (exception instanceof PlanLimitException) {
      return res.status(403).json({
        error: {
          code: 'PLAN_LIMIT',
          reason: exception.reason,
          blocked: exception.blocked,
          message: exception.message,
        },
      })
    }

    // 路由不存在：保持与原 Express 404 处理一致的格式
    if (exception instanceof NotFoundException) {
      return res.status(404).json({ error: { message: '接口不存在' } })
    }

    // Nest 内置 HTTP 异常（如 BadRequestException）：保持 { error: { message } } 格式
    if (exception instanceof HttpException) {
      const response = exception.getResponse()
      const message = typeof response === 'string'
        ? response
        : (response as any).message || exception.message
      return res.status(exception.getStatus()).json({
        error: { message: Array.isArray(message) ? message[0] : message },
      })
    }

    const appErr = classifyError(exception)
    logger.error('request error', {
      code:    appErr.code,
      msg:     appErr.message,
      path:    req.path,
      traceId: (req as any).traceId,
    })
    res.status(appErr.statusCode).json({
      error: { code: appErr.code, message: appErr.userMessage, retryable: appErr.retryable },
    })
  }
}
