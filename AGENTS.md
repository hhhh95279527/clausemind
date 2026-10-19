# AGENTS.md

> 本文件面向 AI 编程助手 / 新接手开发者：读完即可动手改代码。人类读者的完整介绍见 [README.md](./README.md)，架构决策记录见 [docs/adr/](./docs/adr/)。

## 1. 这是什么项目

**ClauseMind** —— 面向中小企业 HR 的 **AI 合同风险审查 SaaS**（演示/作品集项目）。核心能力：

1. **合同双轨审查**：规则轨（16 条声明式规则，按域 `ALL/LABOR/INTERNSHIP` 生效）+ Agent 轨（LangGraph ReAct，调用法规 RAG 做语义判断），风险合并去重（`detected_by = RULE / AGENT / BOTH`），最终由**人工终审（HITL）**拍板。合同场景 `ReviewScene` 共 9 类：免费五场景 LABOR/INTERNSHIP/LEASE/SERVICE/NDA，付费四场景 SALE/LOAN/EQUITY/CUSTOM（改场景枚举要同步：prisma enum 迁移、contract.controller 的 SCENES、plans.config 的 FREE_SCENES、me.controller、playbook、template-catalog、rule-admin SCOPES、前端 plans.js/scene.js/NewReviewView 等白名单）。
2. **法规知识库 RAG**：文档切片 → embedding（无 Key 时降级关键词检索）→ PG 应用层余弦/关键词混合召回。
3. **多租户**：共享库 + 行级 `tenant_id` 隔离；JWT access/refresh（refresh 轮转）。
4. **可观测与运营**：LangChain callback 落 `traces/spans`（Trace 瀑布页）、Eval 离线评测（43 case）、租户月度配额与峰谷计价账单、规则管理后台、人工反馈飞轮。
5. **图片合同 OCR**：`.jpg/.png` 走 DeepSeek 视觉模型（`deepseek-flash`）转录后复用同一审查管线。
6. **AI 改稿台与红划线导出**：风险可生成「原句→改写→理由」（DeepSeek，深度权益：个人版及以上或深度券），逐条接受/拒绝后导出 Word。docx 上传件在**原 OOXML 上注入 `w:ins/w:del` 修订痕迹**（版式 100% 保留，Word 中可接受/拒绝修订）；其他来源走 docx 库文本重建。

## 2. 技术栈

| 层       | 选型                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 后端     | NestJS 10 + TypeScript 5.7（**ESM 风格**）、Prisma 5、PostgreSQL 16、BullMQ + ioredis / Redis 7                              |
| AI       | LangChain 0.3 / LangGraph 0.2（PostgresSaver checkpointer）、DeepSeek（OpenAI 兼容）、可选智谱/SiliconFlow embedding、Tavily |
| 前端     | React 19 + Vite 6 + Ant Design 5 + Zustand + react-router 7 + axios（纯 JS，无 TS）                                          |
| 基础设施 | Docker Compose（postgres/redis/server/nginx）、GitHub Actions CI                                                             |

## 3. 仓库布局

```
.
├── server/                # NestJS 后端
│   ├── src/
│   │   ├── main.ts / app.module.ts        # 启动入口、helmet CSP、trust proxy
│   │   ├── auth/                          # 登录/JWT/refresh 轮转/角色守卫
│   │   ├── contract/
│   │   │   ├── parsing/                   # 上传→BullMQ→文本抽取→切条款（原件保留不删）
│   │   │   ├── rules/                     # 规则引擎 + 16 条种子规则（ALL/LABOR/INTERNSHIP 三域）
│   │   │   ├── retention/                 # FREE 合同 TTL 清理（同步删 uploads 原件）
│   │   │   └── review/                    # LangGraph 审查图、checkpointer、意见书、改稿导出
│   │   │       ├── revision.service.ts    # 改稿台 CRUD + exportDocx（原件注入/文本重建双分支）
│   │   │       └── docx-revision.ts       # jszip 在原 docx 上注入 w:ins/w:del（不依赖 Word）
│   │   ├── services/
│   │   │   ├── model.ts                   # 所有 LLM/embedding 单例（无 Key 延迟失败）
│   │   │   ├── vision-ocr.ts              # 图片合同视觉 OCR
│   │   │   ├── rag/                       # ingest(切片入库) / pg-store(召回) / query
│   │   │   ├── agent/                     # ReAct agent + tools
│   │   │   └── chat/memory.ts             # Redis 会话记忆
│   │   ├── observability/                 # trace、quota、pricing、langchain callback
│   │   ├── admin/                         # 规则后台、Eval、用户管理
│   │   ├── middleware/                    # 上传白名单（defParamCharset=utf8）、限流、zod
│   │   └── utils/
│   │       ├── file-guard.ts              # 文件真实类型（魔数）校验
│   │       └── filename.ts                # multipart 中文名 latin1→utf8 mojibake 兜底修复
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

**合同审查**：上传 `POST /api/contracts/upload`（multipart；粘贴文本走 `POST /api/contracts/text`；multer 落盘随机 ASCII 文件名 → 展示名经 `decodeOriginalName` 修复后存 `contracts.file_name`，磁盘路径存 `storage_path` → file-guard 魔数校验）→ BullMQ 队列 `contract-parse` → Worker：`ingest.extractText`（txt/md/docx/pdf/图片OCR，60s 超时、2MB 截断；**解析后保留原件**）→ `clause-parser` 切条款 → `POST /api/contracts/:id/reviews`（**SSE**）跑规则轨 + LangGraph Agent 轨（图在终审节点 **interrupt**，状态由 PostgresSaver 持久化）→ 风险落 `risks` → 前端 `ReviewWorkbench` 展示 → 人工通过/驳回 → 生成意见书。

**AI 改稿/导出**：`/api/contracts/:id/revisions`（GET 列表/POST generate 批量改写/POST accept-all）、`/api/risks/:riskId/revision`（单条接受拒绝/重写/模拟反驳）、`GET /api/contracts/:id/revisions/docx` 导出。导出分支：`fileType=docx && storagePath` 且磁盘文件在 → `injectTrackedChanges` 原件注入（按段落拼接 `w:t` 文本、空白归一化定位 quote，跨 run 切分；未命中原句进文末「附加修订建议」节，绝不丢失）；原件缺失或非 docx → docx 库文本重建。文件生命周期跟随合同：`DELETE /api/contracts/:id` 与 retention TTL 清理时同步 unlink。

**RAG 问答**：`chat/stream`（**SSE，成功状态码 201**）→ `pg-store` 向量余弦 + 关键词 OR 混合召回 → LLM 流式生成；配额超限经 SSE error 帧透传。

## 5. 开发命令

```bash
# 后端（server/）
npm install --legacy-peer-deps   # 必须 --legacy-peer-deps，否则 ERESOLVE
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
12. **中文文件名**：multer 必须带 `defParamCharset:'utf8'`（@types/multer 1.4.x 未声明该选项，用 `declare module 'multer'` 增强，勿升 2.x），业务层再用 `utils/filename.ts` 的 `decodeOriginalName` 兜底；下载响应头同时给 `filename="ascii.docx"; filename*=UTF-8''<encodeURIComponent 名>`，前端 `stores/revision.js` 优先解析 filename*。磁盘文件名永远只用时间戳随机 ASCII 名。
13. **上传原件是导出保真的数据源**：解析 Worker 不得删除 `filePath`（历史上 finally 里 unlink 过）；合同删除（接口/retention）必须同步删 `storage_path` 文件。操作 docx 一律用 jszip（已在依赖中；装包遇 ERESOLVE 一律加 `--legacy-peer-deps`）。
14. **改 OOXML 必须保结构合法**：`w:ins/w:del` 只能包 `w:r`，放 `w:hyperlink` 内合法，但不要放进 sdt/smartTag/fldSimple/subDoc；`w:rPr` 子元素有严格顺序（rStyle→rFonts→b/i→sz→strike→color→u）；改完用 .NET XmlDocument/Word 实际打开验证，不能只靠正则看标签。

## 7. 评测与验收

- `npm run eval -- --no-llm`：离线跑 RISK_DETECT（28）+ RAG_RECALL（8），CI 门禁；历史基线：RISK precision 98% / recall 100%，RAG recall@3 100%。
- 完整 `npm run eval`（需 Key）：另含 7 个 FAITHFULNESS（LLM-as-Judge）。
- 改了规则引擎/召回逻辑后**必须重跑 eval**；改了合同解析/上传/模型调用后，至少端到端走一遍：上传 → 解析 → 审查 → 意见书。
- 双端 `npm run build` 必须 EXIT=0；GetDiagnostics 无错误再交付。

## 8. 演示/测试账号（seed 数据，仅本地与演示）

- `testboss / Test1234`：主租户，8 份埋雷劳动合同；`boss2 / Test1234`：第二租户（隔离验证用，1 份合同）。
- 库内另有 16 条规则（含 4 条实习专规）、43 个 eval case；6.4/6.5 产生的 `BILLING_DEMO*` traces 与 `demo_quota_%` 用量是**有意保留**的账单页演示数据。

## 9. 常见坑速查

- **"改了代码不生效"**：先看 `dist/main.js` 是否存在（见规则 4 的 rootDir 回归），dev 模式确认 ts-node-dev 窗口已重启。
- **prisma generate 后 dev 仍报旧字段错（如 Unknown argument）**：ts-node-dev 的**软重启不清 node_modules 缓存**，必须让 `--respawn` 父进程拉起全新 node 子进程——杀掉 `wrap.js` 子进程后再 `touch src/main.ts`；仅 touch 文件可能不够。
- **psql 调用（PowerShell）**：参数用数组传 `@('-h','localhost','-U','workmind','-d','workmind','-t','-A','-c',$sql)`，内联多参数会被吞。
- **psql 执行含中文的 SQL**：禁止 `-c "中文"`（GBK 控制台会报"无效 UTF8"）。写成 UTF-8 的 .sql 文件（首行 `SET client_encoding TO 'UTF8';`），先 `$env:PGPASSWORD='Workmind123'` 再 `psql -f 文件`；snake_case 列名要加引号（如 `"fileType"`→实际列 `"file_name"`）。
- **PG 客户端**：本机无 `postgres` 角色，库/用户均为 `workmind`，端口 5432；部分安装是 trust 免密、部分需要密码 `Workmind123`（以 `server/.env` 的 DATABASE_URL 为准，psql 前设 PGPASSWORD）；DBeaver 连不上先查用户名/库名是否都填了 workmind。
- **Node 脚本测 multipart 上传**：用全局 `FormData` + `new Blob([buf])`（undici 原生，自动算 Content-Length）；第三方 `form-data` 包配全局 fetch 会让 busboy 报 `Unexpected end of form`。
- **导出文件出问题先看响应头 `X-Revision-Applied/-Unmatched`**：存在即走了原件注入分支（值为定位命中/未命中条数），不存在即文本重建兜底（原件被删/非 docx/readFile 失败，日志有 warn）。
- **embedding 0 命中**：无 embedding Key 时关键词兜底依赖字面 contains，口语化提问可能召回为空（eval 题面内嵌条文原句锚点），这是已知降级局限非 bug。
- 项目统一用 **npm**（CI 是 `npm ci --legacy-peer-deps`），以 package-lock.json 为准，勿引入 pnpm/yarn 锁文件。

## 10. 提交约定

- 提交信息用中文，前缀沿用：`feat:` / `fix(ci):` / `chore:` / `feat(security):`。
- **不要主动 commit/push**，等用户明确指令；不要 `prisma migrate dev`、不要 force push、不要改写历史。
- CI 在 push 后运行；网络不通时推送可能失败，重试即可，勿改 remote URL。
