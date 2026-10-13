// server/scripts/gen-openapi.ts
// 离线导出 OpenAPI 文档：不监听端口，实例化 Nest 容器扫描全部 Controller 的路由元数据，
// 生成 server/docs/openapi.json。
// 产物用途：
//   - 导入 Apifox / Postman / Insomnia 调试
//   - npm run docs:html 用 redoc-cli 打包成单文件离线 HTML
// 用法：npm run docs:json
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../src/app.module.js'
import { buildSwaggerDocument } from '../src/swagger.js'

async function main() {
  // 关闭启动日志：仅导出元数据。PG/Redis 均为懒连接，不 listen、不触发真实查询
  const app = await NestFactory.create(AppModule, { logger: false })

  const document = buildSwaggerDocument(app)

  // ReDoc 在未声明 x-logo 时会默认引用 https://cdn.redoc.ly 的占位 logo。
  // 注入内联 SVG data-URI，保证离线 HTML 断网打开也无裂图（SwaggerUI/Apifox 忽略该扩展字段）。
  const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#1D4ED8"/><text x="48" y="64" font-family="Segoe UI,Arial,sans-serif" font-size="52" font-weight="700" fill="#FFFFFF" text-anchor="middle">C</text></svg>`
  Object.assign(document.info, {
    'x-logo': {
      url:             `data:image/svg+xml,${encodeURIComponent(logoSvg)}`,
      altText:         'ClauseMind',
      backgroundColor: '#FFFFFF',
    },
  })

  const outFile = resolve(process.cwd(), 'docs/openapi.json')
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

  const pathCount = Object.keys(document.paths ?? {}).length
  console.log(`\n✅ OpenAPI 文档已生成: ${outFile}`)
  console.log(`   接口路径数: ${pathCount}`)

  // 不调用 app.close()：Redis 懒连接在本脚本中从未建立，onModuleDestroy 会对 undefined 调 quit。
  // 短命导出进程直接硬退出即可（ioredis/BullMQ 后台句柄也会因此一并释放）。
  process.exit(0)
}

main().catch((err) => {
  console.error('❌ 导出 OpenAPI 文档失败:', err)
  process.exit(1)
})
