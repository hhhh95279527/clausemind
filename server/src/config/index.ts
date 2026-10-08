// server/src/config/index.js
// 统一配置入口：所有环境变量从这里读取，业务代码不直接用 process.env
import 'dotenv/config'

export const config = {
  app: {
    port: Number(process.env.PORT) || 3000,
    env:  process.env.NODE_ENV || 'development',
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'],
    // 对外基础地址（飞书卡片内跳转链接）：默认本机 dev，生产由 APP_BASE_URL 注入
    baseUrl: process.env.APP_BASE_URL || `http://localhost:${Number(process.env.PORT) || 3000}`,
  },
  ai: {
    deepseekKey:   process.env.DEEPSEEK_API_KEY,
    openaiKey:     process.env.OPENAI_API_KEY,
    zhipuKey:      process.env.ZHIPU_API_KEY,
    tavilyKey:     process.env.TAVILY_API_KEY,
    primaryModel:  process.env.PRIMARY_MODEL  || 'deepseek-chat',
    // 视觉/OCR 模型：deepseek-flash 支持图片输入（同一个 DEEPSEEK_API_KEY）
    visionModel:   process.env.VISION_MODEL   || 'deepseek-flash',
    embedModel:    process.env.EMBED_MODEL    || 'BAAI/bge-m3',
    baseURL:       'https://api.deepseek.com/v1',
    embedBaseURL:  process.env.EMBED_BASE_URL || 'https://api.siliconflow.cn/v1',
  },
  chroma: {
    url: process.env.CHROMA_URL || 'http://localhost:8000',
  },
  cache: {
    ttl: Number(process.env.CACHE_TTL) || 1800000,  // 30 分钟
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://workmind:workmind123@localhost:5432/workmind?schema=public',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  jwt: {
    secret:          process.env.JWT_SECRET || 'workmind-jwt-secret',
    expiresIn:       process.env.JWT_EXPIRES_IN || '7d',
    refreshSecret:   process.env.JWT_REFRESH_SECRET || 'workmind-refresh-secret',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  mailer: {
    // dev 演示通道：验证码打印控制台 + 接受固定码。
    // 未显式设置时：仅非生产环境默认开启；生产环境必须显式 MAILER_CONSOLE=false（且固定码通道硬禁用）
    console: process.env.MAILER_CONSOLE !== undefined
      ? process.env.MAILER_CONSOLE === 'true'
      : (process.env.NODE_ENV || 'development') !== 'production',
    fixedCode: process.env.EMAIL_CODE_FIXED || '123456',
    smtp: {
      host:   process.env.SMTP_HOST || '',
      port:   Number(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE !== 'false',
      user:   process.env.SMTP_USER || '',
      pass:   process.env.SMTP_PASS || '',
      from:   process.env.SMTP_FROM || 'ClauseMind <no-reply@clausemind.example>',
    },
  },
}

/** Key 是否像真 key（ASCII 可打印字符，DeepSeek/OpenAI 兼容格式均以 sk- 开头） */
export function isValidAiKey(key?: string): boolean {
  return !!key && /^sk-[\x21-\x7e]{10,}$/.test(key)
}

export function validateConfig() {
  // P0 安全门禁：生产环境禁止控制台固定码通道，否则等同认证后门
  if (config.app.env === 'production' && config.mailer.console) {
    throw new Error(
      '安全校验失败：生产环境（NODE_ENV=production）禁止 MAILER_CONSOLE=true，请设置 MAILER_CONSOLE=false 并配置 SMTP',
    )
  }
  // 无 key 也允许启动（注册/登录/管理页可正常演示），仅 AI 调用时返回明确出口错误
  if (!config.ai.deepseekKey) {
    console.warn('⚠ 未配置 DEEPSEEK_API_KEY：服务可启动，但 AI 对话/审查功能不可用')
  } else if (!isValidAiKey(config.ai.deepseekKey)) {
    console.warn('⚠ DEEPSEEK_API_KEY 格式异常（疑似占位文本而非真实密钥）：AI 调用将失败，请替换为 https://platform.deepseek.com 申请的真实 key')
  }
  if (config.mailer.console && config.app.env !== 'production') {
    console.warn(`⚠ 邮箱验证码控制台通道已开启：固定码 ${config.mailer.fixedCode} 可直接通过校验，仅限本地开发`)
  }
  console.log('✓ 配置校验通过')
}
