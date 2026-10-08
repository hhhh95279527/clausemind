// server/src/main.ts
// NestJS 入口：配置校验、全局中间件、异常过滤、Swagger 文档、优雅退出
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import helmet from 'helmet'
import compression from 'compression'
import cors from 'cors'
import { json } from 'express'
import { AppModule } from './app.module'
import { config, validateConfig } from './config/index.js'
import { AppExceptionFilter } from './filters/app-exception.filter'
import { logger } from './utils/logger.js'

async function bootstrap() {
  // 启动前校验配置
  validateConfig()

  const app = await NestFactory.create(AppModule)

  // nginx 反代后需信任代理，req.ip 才能取到真实客户端 IP（审计/登录记录依赖）
  app.getHttpAdapter().getInstance().set('trust proxy', 1)

  // ── 基础中间件 ─────────────────────────────────────────────────
  // helmet 默认安全头保留；CSP 按响应类型分级：
  // - 纯 JSON API：default-src 'none'（接口文档不需要加载任何子资源，最严格）
  // - /api/docs Swagger UI：放开同源脚本/样式及内联（其初始化脚本与样式为内联注入）
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use((req: any, res: any, next: () => void) => {
    const csp = req.path?.startsWith('/api/docs')
      ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'"
      : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    res.setHeader('Content-Security-Policy', csp)
    next()
  })
  app.use(cors({
    origin: config.app.allowedOrigins,
    credentials: true,
  }))
  app.use(compression())
  app.use(json({ limit: '5mb' }))

  // 统一错误处理（404 也在这里处理）
  app.useGlobalFilters(new AppExceptionFilter())

  // ── Swagger API 文档 ──────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ClauseMind API')
    .setDescription('ClauseMind 企业智能办公助手 API 文档')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth', '认证相关（登录/注册/Token）')
    .addTag('chat', '对话助手')
    .addTag('knowledge', '知识库管理')
    .addTag('agent', '任务 Agent')
    .addTag('monitor', '监控统计')
    .addTag('audit', '审计日志')
    .build()
  const document = SwaggerModule.createDocument(app, swaggerConfig)
  SwaggerModule.setup('api/docs', app, document)

  // 优雅退出（SIGTERM / SIGINT）
  app.enableShutdownHooks()

  await app.listen(config.app.port)
  logger.info('server started', {
    port: config.app.port,
    env:  config.app.env,
  })
  console.log(`\n🚀 ClauseMind Server 已启动`)
  console.log(`   地址: http://localhost:${config.app.port}`)
  console.log(`   健康检查: http://localhost:${config.app.port}/health`)
  console.log(`   API 文档: http://localhost:${config.app.port}/api/docs\n`)
}

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message })
  process.exit(1)
})

bootstrap()
