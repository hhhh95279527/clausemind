# AGENTS.md

> 本文件面向 AI 编程助手 / 新接手开发者：读完即可动手改代码。人类读者的完整介绍见 [README.md](./README.md)，架构决策记录见 [docs/adr/](./docs/adr/)。

## 1. 这是什么项目

**ClauseMind** —— 面向中小企业 HR 的 **AI 合同风险审查 SaaS**（演示/作品集项目）。核心能力：

1. **合同双轨审查**：规则轨（12 条声明式劳动法规则，确定性命中）+ Agent 轨（LangGraph ReAct，调用法规 RAG 做语义判断），风险合并去重（`detected_by = RULE / AGENT / BOTH`），最终由**人工终审（HITL）**拍板。
2. **法规知识库 RAG**：文档切片 → embedding（无 Key 时降级关键词检索）→ PG 应用层余弦/关键词混合召回。
3. **多租户**：共享库 + 行级 `tenant_id` 隔离；JWT access/refresh（refresh 轮转）。
4. **可观测与运营**：LangChain callback 落 `traces/spans`（Trace 瀑布页）、Eval 离线评测（43 case）、租户月度配额与峰谷计价账单、规则管理后台、人工反馈飞轮。
5. **图片合同 OCR**：`.jpg/.png` 走 DeepSeek 视觉模型（`deepseek-flash`）转录后复用同一审查管线。

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 后端 | NestJS 10 + TypeScript 5.7（**ESM 风格**）、Prisma 5、PostgreSQL 16、BullMQ + ioredis / Redis 7 |
| AI | LangChain 0.3 / LangGraph 0.2（PostgresSaver checkpointer）、DeepSeek（OpenAI 兼容）、可选智谱/SiliconFlow embedding、Tavily |
| 前端 | React 19 + Vite 6 + Ant Design 5 + Zustand + react-router 7 + axios（纯 JS，无 TS） |
| 基础设施 | Docker Compose（postgres/redis/server/nginx）、GitHub Actions CI |

## 3. 仓库布局

```
.
├── server/                # NestJS 后端
│   ├── src/
│   │   ├── main.ts / app.module.ts        # 启动入口、helmet CSP、trust proxy
│   │   ├── auth/                          # 登录/JWT/refresh 轮转/角色守卫
│   │   ├── contract/
│   │   │   ├── parsing/                   # 上传→BullMQ→文本抽取→切条款
│   │   │   ├── rules/                     # 规则引擎 + 12 条种子规则
│   │   │   └── review/                    # LangGraph 审查图、checkpointer、意见书
│   │   ├── services/
│   │   │   ├── model.ts                   # 所有 LLM/embedding 单例（无 Key 延迟失败）
│   │   │   ├── vision-ocr.ts              # 图片合同视觉 OCR
│   │   │   ├── rag/                       # ingest(切片入库) / pg-store(召回) / query
│   │   │   ├── agent/                     # ReAct agent + tools
│   │   │   └── chat/memory.ts             # Redis 会话记忆
│   │   ├── observability/                 # trace、quota、pricing、langchain callback
│   │   ├── admin/                         # 规则后台、Eval、用户管理
│   │   ├── middleware/                    # 上传白名单、限流、zod 校验、安全检查
│   │   └── utils/file-guard.ts            # 文件真实类型（魔数）校验
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/                    # ★手写 SQL 迁移，禁用 prisma migrate dev
│   │   ├── seed.ts                        # 规则/法规/8份埋雷合同/演示账号
│   │   └── fixtures/                      # seed 与 eval 数据（tsconfig.build 已排除）
│   ├── scripts/run-eval.ts                # 评测入口（--no-llm 离线模式）
│   └── register-js-ext.cjs                # dev 期 import 路径 .js→.ts 解析桥
├── frontend/src/
│   ├── views/                             # 页面（contract/monitor/admin 等）
│   ├── components/                        # 组件；stores/ 为 Zustand
│   └── utils/http.js                      # axios 实例（自动带 token、401 刷新）
├── docs/adr/001~005                       # 架构决策记录
├── docker-compose.yml
├── .github/workflows/ci.yml               # Server(seed+build+离线eval) + Frontend(build)
├── start-dev.ps1 / .bat                   # Windows 一键拉起 PG/Redis/前后端
└── README.md
```

## 4. 核心请求链路

**合同审查**：`POST /api/contracts`（multer 落盘 → file-guard 魔数校验）→ BullMQ 队列 `contract-parse` → Worker：`ingest.extractText`（txt/md/docx/xlsx/pdf/pptx/图片OCR，60s 超时、2MB 截断）→ `clause-parser` 切条款 → `runRuleEngine` 规则轨 + LangGraph Agent 轨（图在终审节点 **interrupt**，状态由 PostgresSaver 持久化）→ 风险落 `risks` → 前端 `ReviewWorkbench` 展示 → 人工通过/驳回（`resumeReview`）→ 生成意见书。

**RAG 问答**：`chat/stream`（**SSE，成功状态码 201**）→ `pg-store` 向量余弦 + 关键词 OR 混合召回 → LLM 流式生成；配额超限经 SSE error 帧透传。

## 5. 开发命令

```bash
# 后端（server/）
npm install --legacy-peer-deps
npm run dev                 # ts-node-dev 热重载，http://localhost:3000
npx prisma migrate deploy   # 仅新环境/拉到新迁移时
npm run seed                # 仅全新库灌演示数据
npm run build               # prisma generate + tsc -p tsconfig.build.json
npm run eval                # 43 case；加 --no-llm 跑可离线的 RISK/RAG 部分
npm run sync:feedback       # 人工反馈 → eval 集/规则的同步飞轮

# 前端（frontend/）
npm install
npm run dev                 # http://localhost:5173
npm run build
```

本地依赖本机 PostgreSQL（`postgresql://workmind@localhost:5432/workmind`，trust 免密）与 Redis（6379）。Windows 下直接双击根目录 `start-dev.bat` 一键启动（注意脚本顶部 PG/Redis 路径是机器相关的）。

**环境变量**（见 `server/.env`，该文件已 gitignore，勿把真实 Key 写进任何入库文件）：
`DEEPSEEK_API_KEY`（无 Key 系统可启动：Agent 轨发 agent_skip、embedding 降级关键词）、`ZHIPU_API_KEY`/`OPENAI_API_KEY`+`EMBED_BASE_URL`（embedding 二选一）、`TAVILY_API_KEY`（联网搜索，缺省隐藏该工具）、`DATABASE_URL`、`REDIS_URL`、`JWT_SECRET`、`JWT_REFRESH_SECRET`、`ALLOWED_ORIGINS`、`PRIMARY_MODEL`、`FEISHU_WEBHOOK`（可选告警）。

## 6. 改代码必须遵守的硬规则

1. **import 路径保留 `.js` 后缀**：后端是 ESM 写法（`import { x } from './foo.js'`），dev 由 `register-js-ext.cjs` 桥接到 `.ts`，tsc 也按 NodeNext 编译。删后缀会直接炸。
2. **改 Prisma schema 后手写迁移**：新建 `prisma/migrations/<时间戳>_<名>/migration.sql`，**禁止 `prisma migrate dev`**（会生成不可控迁移/重置库）。LangGraph 的 `checkpoints/checkpoint_blobs/checkpoint_writes/checkpoint_migrations` 四表由 PostgresSaver 自动建，不属于 Prisma 迁移。
3. **同一文件禁止并行 Edit**，必须串行（并行补丁会互相覆盖丢改动）。
4. **后端 build 前删干净产物**：`Remove-Item dist -Recurse -Force; Remove-Item *.tsbuildinfo`，再 `npm run build`；构建后确认 `dist/main.js` 存在。`tsconfig.build.json` 必须保持 exclude `prisma/`——否则 fixtures 被编译会把 rootDir 推断成 server 根，产物落到 `dist/src/`，`npm start` 跑旧代码。
5. **给 `chat/stream` body 加字段必须同步改 zod**：`middleware/chat-validator.middleware.ts` 里 `req.body = result.data` 会**静默剥离** schema 未声明的字段（历史上 `contractId` 因此被吞）。
6. **多租户查询必须带 `tenantId`**：所有 Prisma find/findFirst 显式带租户条件；`pg-store` 检索层默认拒绝（LEGAL/TEMPLATE 平台共享，其余必须显式 tenantId，否则只看 tenantId=null）。新增跨租户资源时沿用此模式。
7. **LLM 一律走 `services/model.ts` 的单例**，不要在业务代码里 `new ChatOpenAI`：无 Key 时构造给占位串、失败推迟到调用期（业务链路靠 `isValidAiKey` 预检，漏网的用 SSE 错误帧兜底）。这是 CI（空 Key）能通过的关键。
8. 上传白名单在 `middleware/file-upload.middleware.ts`（知识库 txt/md/pdf；合同追加 docx/jpg/jpeg/png），落盘后必须过 `utils/file-guard.ts` 魔数校验；新增格式两处都要改。
9. API 返回形状有两个易踩点：合同列表是 `{ contracts: [...] }`（非 items/data）；SSE 成功是 **201**，合同归属校验必须在 `initSse` 之前抛 `ForbiddenException` 才会返回 403。
10. 前端 markdown 渲染统一走 `utils/markdown.js`（highlight.js 仅注册 12 种语言，chunk 已裁到 ~115KB）；大块渲染用动态 `import()`，别在页面顶部静态引入。
11. 审计日志写 detail 前会过 `AuditService.sanitizeDetail` 递归脱敏；新增敏感字段命名匹配 password|secret|token|api_key|credential|private_key 等才会被遮，勿用怪异命名。

## 7. 评测与验收

- `npm run eval -- --no-llm`：离线跑 RISK_DETECT（28）+ RAG_RECALL（8），CI 门禁；历史基线：RISK precision 98% / recall 100%，RAG recall@3 100%。
- 完整 `npm run eval`（需 Key）：另含 7 个 FAITHFULNESS（LLM-as-Judge）。
- 改了规则引擎/召回逻辑后**必须重跑 eval**；改了合同解析/上传/模型调用后，至少端到端走一遍：上传 → 解析 → 审查 → 意见书。
- 双端 `npm run build` 必须 EXIT=0；GetDiagnostics 无错误再交付。

## 8. 演示/测试账号（seed 数据，仅本地与演示）

- `testboss / Test1234`：主租户，8 份埋雷劳动合同；`boss2 / Test1234`：第二租户（隔离验证用，1 份合同）。
- 库内另有 12 条规则、43 个 eval case；6.4/6.5 产生的 `BILLING_DEMO*` traces 与 `demo_quota_%` 用量是**有意保留**的账单页演示数据。

## 9. 常见坑速查

- **"改了代码不生效"**：先看 `dist/main.js` 是否存在（见规则 4 的 rootDir 回归），dev 模式确认 ts-node-dev 窗口已重启。
- **psql 调用（PowerShell）**：参数用数组传 `@('-h','localhost','-U','workmind','-d','workmind','-t','-A','-c',$sql)`，内联多参数会被吞。
- **PG 客户端**：本机无 `postgres` 角色，只有 `workmind`，trust 免密；DBeaver 连不上先查用户名/库名是否都填了 workmind。
- **embedding 0 命中**：无 embedding Key 时关键词兜底依赖字面 contains，口语化提问可能召回为空（eval 题面内嵌条文原句锚点），这是已知降级局限非 bug。
- `server/pnpm-lock.yaml` 是历史遗留，项目实际用 **npm**（CI 也是 `npm ci --legacy-peer-deps`），以 package-lock.json 为准。

## 10. 提交约定

- 提交信息用中文，前缀沿用：`feat:` / `fix(ci):` / `chore:` / `feat(security):`。
- **不要主动 commit/push**，等用户明确指令；不要 `prisma migrate dev`、不要 force push、不要改写历史。
- CI 在 push 后运行；网络不通时推送可能失败，重试即可，勿改 remote URL。
