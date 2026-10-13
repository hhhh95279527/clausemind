// server/src/swagger.ts
// Swagger/OpenAPI 文档配置：在线 /api/docs 与离线导出（scripts/gen-openapi.ts）共用同一份配置，
// 避免两处标签/鉴权定义漂移。
import type { INestApplication } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

export function buildSwaggerDocument(app: INestApplication) {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ClauseMind API')
    .setDescription(
      [
        'ClauseMind 企业智能办公助手 API 文档。',
        '',
        '## 通用约定',
        '- 除注册/登录/埋点/健康检查等显式公开接口外，所有接口均需在请求头携带 `Authorization: Bearer <accessToken>`。',
        '- 路径中的 `/api` 前缀为实际路径的一部分。',
        '- 合同审查与 AI 问答类接口为 **SSE（Server-Sent Events）** 流：`Content-Type: text/event-stream`，成功状态码 **201**，事件帧格式为 `event: <类型>\\ndata: <JSON>\\n\\n`，错误经 error 帧透传。',
        '- 文件上传接口为 `multipart/form-data`；Word 导出接口返回二进制流（`.docx`），文件名在 `Content-Disposition` 中以 UTF-8 编码给出。',
        '- 常见错误码：400 参数错误 / 401 未登录或 Token 失效 / 403 无权限（含跨租户、套餐/试用额度拦截）/ 404 资源不存在（跨租户访问统一 404）/ 429 月度 AI 配额超限或触发限流。',
      ].join('\n'),
    )
    .setVersion('1.0')
    // 两套 Bearer 鉴权方案：租户用户 token（type:user）与平台超管 token（type:platform），
    // 账号体系、存储表与签发逻辑完全隔离；由各 Controller 分别挂接
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '租户用户 accessToken（JWT，type=user）' },
      'bearer',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '平台超级管理员 accessToken（JWT，type=platform，仅 /api/platform/* 使用）' },
      'platform',
    )
    // 标签顺序即文档页展示顺序
    .addTag('auth', '认证：注册 / 登录 / 验证码 / Token / 改密')
    .addTag('contract', '合同审查：上传 / 列表 / SSE 审查 / 人工终审 / 意见书 / AI 改稿')
    .addTag('knowledge', '法规知识库：多会话 RAG 问答（SSE） / 文档管理')
    .addTag('agent', '任务 Agent：自然语言任务执行（SSE）')
    .addTag('billing', '套餐与订单：收银台 / 模拟支付 / 转账 / 订阅 / 企业留资')
    .addTag('me', '个人空间：权益快照 / 审查偏好 / 个人条款库')
    .addTag('playbook', '企业红线（Playbook）：禁写/偏好规则与行业专项包')
    .addTag('ledger', '合同台账：全生命周期登记 / 续签 / 解除 / AI 预填')
    .addTag('dashboard', '合规仪表盘：风险与到期聚合统计')
    .addTag('team', '团队成员与席位管理')
    .addTag('integrations', '集成中心：飞书 / 钉钉 / 企微群机器人与开通留资')
    .addTag('templates', '合同范本库：预览 / 采用 / 下载')
    .addTag('notifications', '站内通知')
    .addTag('analytics', '埋点事件接收（支持匿名与 sendBeacon）')
    .addTag('monitor', '租户用量监控：配额 / 账单 / Trace 链路')
    .addTag('admin', '租户管理后台：成员 / 评测 / 规则配置（本租户 ADMIN）')
    .addTag('platform', '平台超级管理员：租户 / 转账审核 / 跨租户链路 / 漏斗（独立账号体系）')
    .addTag('health', '健康检查（公开）')
    .build()
  return SwaggerModule.createDocument(app, swaggerConfig)
}
