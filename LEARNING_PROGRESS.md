# ClauseMind 十二天吃透计划 · 进度档案

> 用途：跨会话保存学习进度，防止上下文丢失。每天说"继续"时，AI 先读本文件，再从当前板块续讲。
> 规则：**每个板块结束有闭卷测验，80 分及格；不及格明令禁止进入下一板块，只允许复习重测（最多 3 次）。**
> 阅读口径：不读 CSS、锁文件、openapi 生成物；JSX 只看逻辑（hooks/handler/渲染条件），样式跳过。

## 验收总目标

不看代码能讲清：① 每层职责与数据流 ② 每个外部依赖为什么存在 ③ 核心机制的因果链（为什么这样设计、不这样会怎样）
最终验收（D12）：脱稿画完整架构图 + 顺"注册→登录→上传合同→解析→双轨审查→SSE→终审→导出 Word"主链路讲一遍 + 答完 README 的 7 个面试 Q&A（≥85 分才算吃透）。

## 最高效的学习方法（必须照做）

0. **【学员风格，最高优先级】任务清单 + 自测问答**：学员自己读，AI 只负责给「当天任务清单（模块+文件顺序）+ 针对性问答题」，不逐行带读；学员答完后，只在答错/不懂处深入讲对应代码。每个模块读完仍要求能用一句话说出模块职责。
1. **按请求链路读，不按目录读**：每板块先找到 HTTP 入口，顺着 controller→service→Prisma/外部调用→返回读。
2. **带运行时证据读**：本地服务起着，读哪块就操作哪个功能，对照 SSE 帧、日志、trace 瀑布、数据库行变化看代码。
3. **先复述再测验**：每读完一个文件，合上讲给自己听（30 秒以内说清"这个文件解决什么问题、被谁调、调谁"）。
4. **主动踩坑验证**：每个"如果不这样会怎样"都在本地试一次（如停 Redis、不带 tenantId、无 API Key），记忆效率 x3。
5. **每个板块产出一张"面试话术卡"**：3 句话版本（30 秒）+ 深挖版本（2 分钟），含取舍与踩坑。
6. **测验闭卷**：测验时不许翻代码；错题对应的文件在档案里记下来，D12 总验收前只复习错题文件。

## 门禁规则（2026-10-20 学员调整）

- **取消各板块中间门禁测验**，改为轻量检查点：每读完一个文件，学员用自己的话复述一句"这个文件干什么、被谁调、调谁"，不设分数、不设卡点。
- **验收只在 D12 集中做一次**（脱稿架构图 + 主链路串讲 + README 面试 Q&A）。
- 学习方式：一个模块一个模块推进；模块内顺序 module.ts → controller → service → utils；每个文件从第 1 行到最后一行逐行讲，不跳读。
- 总量控制：核心模块（Auth / Contract / Billing / Review）精读；外围模块（Feishu/Dingtalk/Wework/Analytics/Feedback 等）只报目录与职责。
- 原四类题型标准（因果/定位/数据流/反事实）保留，仅用于 D12 总验收。

## 日程总览（12 天，全职每天约 8 小时）

| 日 | 板块 | 关键文件 | 状态 | 成绩 |
|---|---|---|---|---|
| D1 | 0. 启动与架构地图 ＋ 1a. 地基（config / 多租户模型 / Redis / 全局中间件 / 异常过滤 / 审计脱敏） | main.ts、app.module.ts、config/index.ts、middleware/*、filters/app-exception.filter.ts、schema.prisma、App.jsx | 🔶 进行中（main.ts/app.module/schema/App.jsx 已过，测验改为 D2 开场口头复述 3 题） | - |
| D2 | 1b. 认证体系（注册 persona / 密码与验证码登录 / 双 JWT tenant+platform / refresh 轮转 / 守卫 / 邮箱 / 忘记密码） | auth/*、strategies/jwt.strategy.ts、guards/roles.guard.ts、mailer.service.ts、verification-code.service.ts | ⬜ 未开始 | - |
| D3 | 2a. 合同上传→BullMQ 解析→OCR→切条款（含文件安全、中文文件名、原件保留、场景识别、retention） | contract.controller.ts、parsing/*、clause-parser.ts、scene-classifier.ts、queue/queue.service.ts、utils/file-guard.ts、utils/filename.ts、retention/*、archive.ts | ⬜ 未开始 | - |
| D4 | 2b. 规则引擎（16 条规则 / scope 三域 / 正则+关键词语义）+ 企业 Playbook 与范本提炼 | rules/rule.engine.ts、rules.seed.ts、playbook/*、tenant-templates/* | ⬜ 未开始 | - |
| D5 | 2c. Agent 轨（LangGraph ReAct / 工具 / 有界并发 / SSE 帧 / 402·429 中断 / HITL interrupt） | review/review.agent.ts、checkpointer.ts、structured.service.ts、utils/sse.ts、review/report.ts | ⬜ 未开始 | - |
| D6 | 3. 法规 RAG 问答（切片入库 / embedding 降级 / 混合召回 / 会话隔离） | services/rag/*、services/model.ts、services/vision-ocr.ts、knowledge/* | ⬜ 未开始 | - |
| D7 | 4. 改稿台 ＋ 5. Word 红划线 / PDF 导出 | review/revision.service.ts、docx-revision.ts、revision-anchor.ts、pdf-export.service.ts | ⬜ 未开始 | - |
| D8 | 6. 计费与权益（套餐 / 试用 2 次 / 月度配额 / 转账订单 / 到期降级 / 退款工单） | billing/*、refunds/*、plans.config.ts、subscription-lifecycle.service.ts | ⬜ 未开始 | - |
| D9 | 7. 可观测 / 离线评测 / 配额计价 / 任务 Agent | observability/*、scripts/run-eval.ts、services/agent/*、monitor/* | ⬜ 未开始 | - |
| D10 | 8. 平台超管 ＋ 团队协作 ＋ 横切模块（通知 / 集成 / 台账 / 仪表盘 / 范本 / 埋点 / 反馈） | platform/*、team/*、invite/*、notifications/*、integrations/*、ledger/*、dashboard/*、templates/*、analytics/*、feedback/*、services/{feishu,dingtalk,wework}/* | ⬜ 未开始 | - |
| D11 | 10a. 前端基建 + 合同核心页（http 拦截器逐行 / stores 逐行 / persona / App.jsx+Layout+AuthGuard+navigation 复查 → ContractListView → ReviewWorkbench 逐行） | utils/http.js、stores/auth.js+app.js+contract.js+agent.js、utils/persona.js、components/layout/*、config/navigation.jsx、views/contract/ContractListView.jsx+ReviewWorkbench.jsx | ⬜ 未开始 | - |
| D12 | 10b. 前端收尾（RagChat / 企业页代表 PlaybookView / 付费墙 Checkout+TeamBilling 结构 / PlatformConsole 报结构）＋ 总验收：脱稿架构图 + 主链路串讲 + 面试 Q&A 演练 + 错题复习 | views/contract/ReviewWorkbench.jsx（收尾）、components/rag/RagChat.jsx、views/team/PlaybookView.jsx、views/personal/CheckoutView.jsx、views/platform/PlatformConsole.jsx、README「面试 Q&A」、docs/adr/001~005 | ⬜ 未开始 | - |

## 门禁状态

- 当前位置：**D1 · 板块 0 → D2 交界**
- 板块 0 是否放行：条件放行（2026-10-20 学员疲劳，8 题闭卷改为「当晚发答案 + D2 开场口头复述 3 题」，通过后正式进 D2）
- D2 开场复述题（已定）：Q1 上传请求的关卡顺序 · Q6 双轨全流程 · Q8 persona 分流与自愈刷新
- 重测次数：0 / 3

## 学习记录（每天结束追加）

- 2026-10-13：建立十天计划，开始板块 0。
- 2026-10-19：升级为十二天计划，细化板块边界与门禁题型标准（因果/定位/数据流/反事实）。
- 2026-10-20：D1 完成 main.ts（中间件顺序/SSE 不压缩/trust proxy）、app.module.ts（30 模块分组/全局守卫默认拒绝/按路由挂 multer 与限流）、schema.prisma（多租户/双轨/Risk.quote 防幻觉/threadId @unique/PlatformAdmin 独立表）、App.jsx（persona 由后端 workspaceType 驱动/三套布局壳/自愈刷新）。学员疲劳，测验改期。已发 D1 测验答案（见会话，答案 8 题版）。

<!-- 板块测验错题对应文件（累计，D12 复习用） -->
## 错题文件清单

（暂无）
