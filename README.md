# ClauseMind AI

[![CI](https://github.com/hhhh95279527/clausemind/actions/workflows/ci.yml/badge.svg)](https://github.com/hhhh95279527/clausemind/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs)](https://nestjs.com/)
[![LangGraph](https://img.shields.io/badge/LangGraph-0.2-1C3C3C)](https://langchain-ai.github.io/langgraphjs/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis)](https://redis.io/)

> **多租户 AI 工作流平台底座 + 合同风险审查垂直业务**：规则引擎保底 + LangGraph Agent 语义双轨审查，Postgres checkpointer 持久化人工终审（HITL），产出审查意见书，反馈回流离线 Eval。

## 这个项目解决什么问题

企业法务/HR 审合同靠人工逐条看，成本高、易漏审。ClauseMind 把审查拆成两条互补的轨道：

- **规则轨（确定性、零成本）**：12 条声明式审查规则（正则/关键词、`ALL`/`LABOR` scope），毫秒级命中已知风险模式，无 AI Key 也能完整跑；
- **Agent 轨（语义、可推理）**：LangGraph StateGraph 驱动的 ReAct 循环，结合法规库 RAG 发现规则覆盖不到的隐性风险；
- **人工终审（HITL）**：每条风险可采纳/忽略/备注，图状态持久化在 Postgres，终审后一键生成可打印的《合同风险审查意见书》。

平台能力还包括：智能对话（SSE 流式 + 偏好记忆）、知识库 RAG 问答（多查询扩展）、任务 Agent（真实工具调用可视化）、用量与成本看板（Token/人民币峰谷计价/月度配额）、离线评测与审查规则管理后台。

## 架构总览（文字版）

```
┌──────────────────────────── 前端 React 19 + Vite 6 + antd 5 + Zustand ───────────────────────────┐
│  智能对话 │ 知识库问答 │ 任务Agent │ 合同风险审查(三栏工作台) │ 用量看板(Trace瀑布/配额账单) │ 管理后台 │
│  http(axios 拦截器自动刷新 token) + fetchStream(SSE Bearer 鉴权)                                  │
└──────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                               │ /api（Nginx 反代，SSE buffering off）
┌──────────────────────────── 后端 NestJS 10 + TypeScript ─────────────────────────────────────────┐
│  全局 JWT Guard + RBAC(@Roles) │ 限流(Lua令牌桶) │ helmet 分级 CSP │ zod 入参白名单 │ 统一异常过滤    │
│                                                                                                  │
│  auth        登录/注册 · JWT 双 token · refresh 服务端哈希轮转+重放全吊销 · RBAC                   │
│  chat        SSE 流式对话 · DB 化会话 · 精确缓存(Redis,租户 namespace)                            │
│  knowledge   文档上传(扩展名+magic number) · RAG 问答 · 会话按 租户+用户 隔离                     │
│  agent       ReAct Agent 工具流（web_search/read_doc/legal_search/calculate/get_date）            │
│  contract ★  上传 → BullMQ 异步解析 → 条款切分 → 双轨审查(SSE) → 终审决策 → 意见书                │
│  observability  Trace/Span(LLM·TOOL·RETRIEVER) · 配额 · 峰谷计价                                  │
│  admin       用户/配置 · 规则 CRUD+试运行 · 离线评测报告 · 租户配额账单                            │
│  audit       审计日志（敏感字段递归脱敏）                                                        │
└───────┬──────────────────────────┬───────────────────────────┬───────────────────────────────────┘
        │                          │                           │
   PostgreSQL 16              Redis 7                  外部模型（OpenAI 兼容）
   · 业务表（全部 tenant_id）    · BullMQ 合同解析队列      · DeepSeek 对话
   · doc_chunks 向量(JSON)+余弦  · 两级缓存/令牌桶          · BGE-M3 Embedding（无 key 降级关键词召回）
   · LangGraph checkpoint 4 表                              · Tavily 联网搜索（无 key 工具自动隐藏）
   · eval_* / traces / audit
```

## 快速开始

### 前置依赖

- Node.js 22+、npm
- PostgreSQL 16（创建库/用户，连接串见下）
- Redis 7（本地开发默认无密码即可）

### 启动步骤

```bash
# 1) 后端
cd server
cp .env.example .env            # 填入 DEEPSEEK_API_KEY；无 key 也可启动（规则轨与基础功能完整）
npm install --legacy-peer-deps
npx prisma migrate deploy       # 建表（手写 SQL 迁移）
npx prisma generate
npm run seed                    # 幂等种子：12 规则 + 3 法规 + 2 模板 + 8 份埋雷合同 + 演示账号
npm run dev                     # http://localhost:3000 ，健康检查 GET /health

# 2) 前端（新终端）
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

Docker 一键起依赖与全栈：`docker compose up -d`（PostgreSQL + Redis + server + Nginx，已不再包含向量库容器）。

### 演示账号

| 账号 | 密码 | 租户 | 说明 |
|---|---|---|---|
| `testboss` | `Test1234` | 测试科技 | 配额充足，名下 8 份埋雷样例合同 |
| `boss2` | `Test1234` | 另一家公司 | 用于跨租户隔离验证 |

### 无 AI Key 时的降级（刻意设计，非报错）

- 合同规则轨、条款切分（词典分类）、法规关键词检索、全部管理功能：**完整可用**；
- Agent 语义轨发 `agent_skip` 事件优雅跳过，不产生错误噪声；
- Embedding 缺失时 RAG 自动降级为中文关键词召回；
- 配真实 `DEEPSEEK_API_KEY`（[platform.deepseek.com](https://platform.deepseek.com)）后双轨全亮。

## 5 分钟演示脚本

1. **登录**：`testboss / Test1234`。
2. **合同列表**：侧边栏「合同风险审查」→ 选一份样例合同（或上传 `.txt/.pdf/.docx`，上传走扩展名 + magic number 双校验）；上传后 BullMQ 异步解析，列表轮询直到 `READY`。
3. **发起审查**：进入三栏工作台 →「开始审查」。SSE 实时推送审查阶段：左栏条款命中高亮滚动，中栏风险卡片流（规则轨秒出，Agent 轨逐条补语义风险），右栏进度与统计。
4. **人工终审**：风险卡片逐条「采纳/忽略 + 备注」→「终审」→ 确认通过（或驳回回退）。
5. **意见书**：通过后弹窗渲染 Markdown 意见书（渲染器按需动态加载，不占首屏体积），可「打印 / 另存 PDF」；也可随时点「查看意见书」回看（从 Postgres checkpoint 恢复的审查结论）。
6. **加分项演示**：用量看板 →「调用链路瀑布」看本次审查的 LLM/TOOL/RETRIEVER Span 时间轴；知识库页传文档后问答；用 `boss2` 登录验证看不到 testboss 的合同与文档。

## 离线评测（Eval）—— 改动靠数据守门

`server/prisma/fixtures/eval-cases.ts` 维护 43 条评测集（`eval_cases` 表，支持标记 active 与来源 MANUAL/FEEDBACK）：

| 类型 | 数量 | 评什么 | 无 Key |
|---|---|---|---|
| `RISK_DETECT` | 28 | 规则命中的 precision / recall / F1（对 8 份埋雷合同反推期望 code） | ✅ 可跑 |
| `RAG_RECALL` | 8 | 法规检索 recall@3 | ✅ 关键词降级可跑 |
| `FAITHFULNESS` | 7 | LLM-as-Judge 对 RAG 回答 0/1 忠实度打分 | ⏭️ 自动 skip |

```bash
cd server
npm run eval                 # 全量（无 key 环境忠实度组自动跳过）
npm run eval -- --type=RISK_DETECT --no-llm   # 只跑确定性规则组
```

每次运行创建 `eval_runs`（记录 commitSha、summary 指标）+ 逐条 `eval_results`（actual 明细、judgeReason、耗时），管理后台「离线评测报告」页可对比历次运行，失败 case 红色高亮。人工终审的「忽略」决策会回流为新的 FEEDBACK 评测样本，形成 **审查 → 反馈 → 评测 → 改规则/模型** 的闭环。

## CI

`.github/workflows/ci.yml`：PostgreSQL + Redis service 容器 → `prisma migrate deploy` → `seed` → 前后端 `build` matrix → `npm run eval -- --no-llm` 门禁。README 顶部 badge 实时显示主干状态。

## 技术栈

| 维度 | 选型 | 为什么 |
|---|---|---|
| 后端 | NestJS 10 + TypeScript 5.7 | 模块化 DI、Guard/Pipe/Middleware 分层清晰 |
| AI 编排 | LangGraph 0.2（StateGraph + PostgresSaver） | 显式状态图、`interrupt` 原生 HITL、检查点可恢复 |
| 对话模型 | DeepSeek-V3（OpenAI 兼容接口） | 中文好、成本低；接口层可平移任意兼容厂商 |
| RAG | PG 向量列（JSON embedding + 应用层余弦）+ 关键词降级 | 零额外基础设施，事务/备份与业务库统一（见 [ADR-001](docs/adr/001-pg-vector-retrieval.md)） |
| 异步队列 | BullMQ + Redis | 合同解析隔离进程，失败落 FAILED 不拖垮 API |
| 数据库 ORM | Prisma 5 + 手写 SQL 迁移 | 类型安全；迁移人工 review 后 `migrate deploy` |
| 前端 | React 19 + Vite 6 + antd 5 + Zustand 5 | 路由级懒加载；markdown/hljs 独立 chunk 且按需动态导入 |
| 可观测 | 自研 Trace（AsyncLocalStorage + LangChain Callback） | LLM/工具/检索 Span、Token、人民币费用全链路可追 |
| 认证 | JWT 双 token + 服务端 refresh 哈希轮转 | 重放检测、改密全设备登出 |

## 安全设计（多租户隔离 Checklist）

| 维度 | 机制 |
|---|---|
| 租户隔离约定 | 业务查询一律 `findFirst({ where: { id, tenantId } })`；跨租户访问回 404/403 且不区分"不存在/无权"，防 id 枚举 |
| 平台共享数据 | LEGAL/TEMPLATE/review_rules 平台级；GENERAL 文档仅"本租户 + tenantId=null 共享"可见，检索层**默认拒绝**（无租户身份只返回共享文档） |
| RAG 会话隔离 | 会话内存 key 按 `rt:{tenantId}:{userId}:{sessionId}` 命名空间隔离，清空接口同样 scoping |
| 关联资源校验 | 对话携带 `contractId` 开流前校验合同归属，否则 403 |
| JWT Refresh 轮转 | 仅存 SHA-256 哈希；刷新事务内原子轮转（条件撤销防并发双花）；旧 token 重放 → 吊销该用户全部 token；改密强制全员重登 |
| 安全响应头 | helmet 全套；CSP 分级：JSON API `default-src 'none'`，Swagger 页单独放行内联；`trust proxy=1` |
| 上传校验 | 扩展名白名单（.txt/.md/.pdf/.docx，30MB）+ 落盘后 magic number 二次校验，伪造即删即 400 |
| 解析隔离与上限 | BullMQ 独立 worker；提取统一 60s 超时、200 万字符上限，防畸形文件/解压炸弹 |
| 输入防护 | zod 路由级白名单（未声明字段不进 controller）+ Prompt 注入特征拦截 + XSS 剥离 + body 5MB |
| 审计脱敏 | `detail` 落库前递归掩码 password/token/secret/authorization/apiKey 等，含循环引用/深度/长度保护 |
| SSE 认证 | 所有流式接口与普通接口同一套 JWT Bearer 守卫 |

## 面试 Q&A

**Q1：为什么搞"规则 + Agent"双轨？只用大模型不行吗？**
规则轨提供确定性底线（同一条款永远同样命中、零成本、毫秒级、可解释到具体 code），覆盖已知风险模式；Agent 轨负责跨条款推理和法规语义比对，覆盖未知风险。二者在风险卡片流中合并去重展示，终审再由人兜底——这是企业场景对**召回率、成本、可解释性**同时有要求时的典型折中（[ADR-002](docs/adr/002-dual-track-rule-agent-review.md)）。

**Q2：人工终审如何做到"关掉页面明天再继续"？**
LangGraph 的 `interrupt` 让图在终审节点暂停，完整状态（条款、风险、已做决策）由 PostgresSaver 写入 `checkpoints` 表，`review_tasks.threadId` 即 LangGraph thread_id；`resumeReview` 带决策 payload 恢复图执行。不依赖进程内存，服务重启不丢状态（选型与教训见 [ADR-003](docs/adr/003-langgraph-interrupt-hitl.md)）。

**Q3：为什么不用专门的向量数据库？**
演示/中小规模下 PG 单库即可承载：chunk 量级 < 10 万时应用层余弦 + 关键词混合召回性能够用，省掉一个有状态依赖，备份事务统一。规模上来可平滑替换检索层（pgvector 扩展或专用向量库），业务接口不变（[ADR-001](docs/adr/001-pg-vector-retrieval.md)）。

**Q4：多租户隔离怎么保证不漏？**
三道防线：① 约定所有 Prisma where 必带 tenantId，代码评审按此 checklist 过；② RAG 这类非 Prisma 检索层在 SQL/默认参数层面默认拒绝，漏传 tenantId 只返回平台共享数据；③ 自动化冒烟用两个租户互测 IDOR。会话、缓存、文档删除均按属主命名空间或先查后比对（[ADR-004](docs/adr/004-multi-tenant-isolation.md)）。

**Q5：怎么向团队证明改一条规则不会让质量倒退？**
43 条离线评测集 + `npm run eval` 一键回归，规则组产出 precision/recall/F1，检索组 recall@3，回答组 LLM-as-Judge 忠实度；每次运行记 commitSha 入库，后台可 diff 历次结果。规则后台还有「试运行」在保存前对任意文本验证正则/关键词命中。

**Q6：成本怎么控？**
Token 级 Trace 经 LangChain Callback 聚合，按峰谷人民币单价表计费；租户月度配额硬拦截（超额经 SSE 透传 QUOTA_EXCEEDED）；精确问答走 Redis 两级缓存（30 分钟 TTL、按租户 namespace），规则轨零模型成本——能不用大模型的地方绝不用（[ADR-005](docs/adr/005-quota-and-pricing.md)）。

**Q7：SSE 流式接口怎么做鉴权和错误透传？**
不用 EventSource（不支持自定义头），前端用 fetch + ReadableStream 带 `Authorization: Bearer`；后端守卫与普通接口完全一致，配额、错误、审查阶段统一成 SSE 事件帧；Nginx 关闭该路径 buffering。

## 目录导航

- 架构决策记录：[docs/adr/](docs/adr/)（PG 检索选型 / 双轨审查 / HITL / 多租户隔离 / 配额计价）
- 后端入口：[server/src/main.ts](server/src/main.ts) ；合同核心：[server/src/contract/](server/src/contract/)
- 前端路由：[frontend/src/App.jsx](frontend/src/App.jsx) ；审查工作台：[frontend/src/views/contract/ReviewWorkbench.jsx](frontend/src/views/contract/ReviewWorkbench.jsx)
- 评测 Runner：[server/scripts/run-eval.ts](server/scripts/run-eval.ts) ；CI：[.github/workflows/ci.yml](.github/workflows/ci.yml)
