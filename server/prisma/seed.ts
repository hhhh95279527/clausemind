// server/prisma/seed.ts
// 种子数据：幂等执行（可重复跑）
//  1. 内置审查规则（ReviewRule）
//  2. 平台法规库 / 合同模板（Document + DocChunk，供 legal_search 检索）
//  3. 8 份样例合同 + 切分好的条款（Contract + Clause）
//  4. 演示租户与账号（已存在则跳过）
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { BUILTIN_RULES } from '../src/contract/rules/rules.seed.js'
import { splitClauses } from '../src/contract/parsing/clause-parser.js'
import { setDatabase, ingestText } from '../src/services/rag/ingest.js'
import { LEGAL_DOCS, TEMPLATE_DOCS } from './fixtures/legal.js'
import { SAMPLE_CONTRACTS } from './fixtures/contracts.js'
import { EVAL_CASES } from './fixtures/eval-cases.js'
import { INDUSTRY_PACKS } from '../src/playbook/playbook.pack.js'

const prisma = new PrismaClient()
setDatabase(prisma as any)

/** 演示账号画像（growth v2 双曲线） */
interface DemoAccount {
  username: string
  orgName: string
  displayName: string
  email: string
  plan: 'FREE' | 'PERSONAL' | 'TEAM' | 'ENTERPRISE'
  workspaceType: 'PERSONAL' | 'TEAM'
  couponBalance?: number
  planExpiresAt?: Date
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    username: 'testboss', orgName: '测试科技', displayName: '测试老板',
    email: 'testboss@workmind.demo', plan: 'ENTERPRISE', workspaceType: 'TEAM',
  },
  {
    username: 'boss2', orgName: '另一家公司', displayName: '二号老板',
    email: 'boss2@workmind.demo', plan: 'FREE', workspaceType: 'PERSONAL',
  },
  {
    username: 'demo_personal', orgName: '个人演示空间', displayName: '个人演示',
    email: 'demo_personal@workmind.demo', plan: 'PERSONAL', workspaceType: 'PERSONAL',
    couponBalance: 1,
    planExpiresAt: new Date('2027-09-20T23:59:59+08:00'),
  },
]

/**
 * 幂等确保演示账号存在：
 * - 用户不存在 → 按画像建租户 + 用户；
 * - 用户已存在 → 校正其租户 plan/workspaceType/couponBalance 到演示口径（重跑 seed 可修复迁移后的旧 FREE 数据）。
 */
async function ensureUser(account: DemoAccount): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { username: account.username },
    include: { tenant: true },
  })

  if (existing) {
    // 校正租户套餐口径（迁移后老租户默认 FREE/PERSONAL，需按画像修正）
    if (
      existing.tenant.plan !== account.plan ||
      existing.tenant.workspaceType !== account.workspaceType ||
      existing.tenant.couponBalance !== (account.couponBalance ?? 0) ||
      (account.planExpiresAt && existing.tenant.planExpiresAt?.getTime() !== account.planExpiresAt.getTime())
    ) {
      await prisma.tenant.update({
        where: { id: existing.tenantId },
        data: {
          plan: account.plan,
          workspaceType: account.workspaceType,
          couponBalance: account.couponBalance ?? 0,
          planUpdatedAt: new Date(),
          ...(account.planExpiresAt ? { planExpiresAt: account.planExpiresAt } : {}),
        },
      })
      console.log(`  校正账号套餐：${account.username} → ${account.plan}/${account.workspaceType}`)
    } else {
      console.log(`  用户已存在：${account.username}`)
    }
    // 演示账号预置引导完成、邮箱已验证，避免演示登录时弹新手引导
    if (!existing.onboardingCompleted || !existing.emailVerified) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { onboardingCompleted: true, emailVerified: true },
      })
    }
    return existing.tenantId
  }

  const tenant = await prisma.tenant.create({
    data: {
      name: account.orgName,
      plan: account.plan,
      workspaceType: account.workspaceType,
      couponBalance: account.couponBalance ?? 0,
      planUpdatedAt: new Date(),
      ...(account.planExpiresAt ? { planExpiresAt: account.planExpiresAt } : {}),
      monthlyTokenQuota: 500000,
    },
  })
  await prisma.user.create({
    data: {
      username: account.username,
      email: account.email,
      passwordHash: await bcrypt.hash('Test1234', 10),
      displayName: account.displayName,
      role: 'ADMIN',
      tenantId: tenant.id,
      emailVerified: true,
      onboardingCompleted: true,
    },
  })
  console.log(`  创建用户：${account.username} / Test1234（${account.orgName} · ${account.plan}）`)
  return tenant.id
}

async function seedRules() {
  for (const r of BUILTIN_RULES) {
    const id = `rule_${r.code.toLowerCase()}`
    const data = {
      code: r.code,
      name: r.name,
      severity: r.severity,
      category: r.category,
      scope: r.scope,
      pattern: r.pattern ?? null,
      keywords: r.keywords ?? [],
      prompt: r.prompt,
      suggestion: r.suggestion,
      legalBasis: r.legalBasis,
      description: r.description,
      sortOrder: r.sortOrder,
      enabled: true,
    }
    await prisma.reviewRule.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    })
  }
  console.log(`✓ 审查规则 ${BUILTIN_RULES.length} 条`)
}

async function seedDocs() {
  for (const d of LEGAL_DOCS) {
    await ingestText({
      docId: d.docId,
      title: d.title,
      fileName: d.fileName,
      category: d.category,
      docType: 'LEGAL',
      content: d.content,
      tenantId: null,
    })
  }
  console.log(`✓ 法规库文档 ${LEGAL_DOCS.length} 份`)

  for (const d of TEMPLATE_DOCS) {
    await ingestText({
      docId: d.docId,
      title: d.title,
      fileName: d.fileName,
      category: d.category,
      docType: 'TEMPLATE',
      content: d.content,
      tenantId: null,
    })
  }
  console.log(`✓ 合同模板 ${TEMPLATE_DOCS.length} 份`)
}

async function seedContracts() {
  for (const sc of SAMPLE_CONTRACTS) {
    const owner = await prisma.user.findUnique({ where: { username: sc.tenantUser } })
    if (!owner) {
      console.warn(`  跳过 ${sc.title}：归属用户 ${sc.tenantUser} 不存在`)
      continue
    }

    // 级联清理旧任务/风险/条款
    await prisma.contract.deleteMany({ where: { id: sc.id } })

    const parsed = splitClauses(sc.content)
    await prisma.contract.create({
      data: {
        id: sc.id,
        tenantId: owner.tenantId,
        uploadedBy: owner.id,
        title: sc.title,
        fileName: sc.fileName,
        fileType: 'txt',
        status: 'READY',
        progress: 100,
        charCount: sc.content.length,
        clausesCount: parsed.length,
        clauses: {
          create: parsed.map((c, i) => ({
            indexNo: i,
            title: c.title.slice(0, 200),
            content: c.content,
            clauseType: c.clauseType,
          })),
        },
      },
    })
    console.log(`  合同：${sc.title}（${parsed.length} 条）`)
  }
  console.log(`✓ 样例合同 ${SAMPLE_CONTRACTS.length} 份`)
}

async function seedEvalCases() {
  for (const c of EVAL_CASES) {
    const data = {
      type: c.type,
      title: c.title,
      input: c.input as any,
      expected: c.expected as any,
      tags: c.tags,
      source: 'MANUAL' as const,
      active: true,
      tenantId: null, // 平台基线集
    }
    await prisma.evalCase.upsert({
      where: { id: c.id },
      create: { id: c.id, ...data },
      update: data,
    })
  }
  console.log(`✓ 离线评测用例 ${EVAL_CASES.length} 条`)
}

/**
 * demo_personal 演示订单（与 personal-billing 原型订单记录一致，幂等）：
 * 个人版年付 ¥99 已支付（2026-09-18）+ 深度券包 ×10 ¥99 已取消（2026-09-17）。
 */
async function seedBillingDemo(tenantId: string) {
  const user = await prisma.user.findFirst({ where: { tenantId, username: 'demo_personal' } })
  if (!user) return

  const yearly = await prisma.order.findFirst({
    where: { tenantId, kind: 'SUBSCRIPTION', period: 'YEAR', status: 'PAID' },
  })
  if (!yearly) {
    const paidAt = new Date('2026-09-18T21:04:00+08:00')
    await prisma.order.create({
      data: {
        tenantId, createdById: user.id,
        kind: 'SUBSCRIPTION', period: 'YEAR', targetPlan: 'PERSONAL',
        amountFen: 9900, status: 'PAID',
        createdAt: paidAt, paidAt,
      },
    })
    console.log('  播种演示订单：demo_personal 个人版年付 ¥99 已支付')
  }

  const cancelled = await prisma.order.findFirst({
    where: { tenantId, kind: 'COUPON_PACK', status: 'CANCELLED' },
  })
  if (!cancelled) {
    const at = new Date('2026-09-17T19:36:00+08:00')
    await prisma.order.create({
      data: {
        tenantId, createdById: user.id,
        kind: 'COUPON_PACK', period: 'NONE', couponQty: 10,
        amountFen: 9900, status: 'CANCELLED',
        createdAt: at,
      },
    })
    console.log('  播种演示订单：demo_personal 深度券包 已取消')
  }
}

async function seedPlaybook(tenantId: string) {
  const user = await prisma.user.findFirst({ where: { tenantId, username: 'testboss' } })
  if (!user) return
  const pack = INDUSTRY_PACKS.find((p) => p.code === 'INTERNET_LABOR')
  if (!pack) return
  const existing = await prisma.playbookRule.findMany({
    where: { tenantId, source: 'SEED_PACK' },
    select: { title: true },
  })
  const owned = new Set(existing.map((r) => r.title))
  const fresh = pack.rules.filter((r) => !owned.has(r.title))
  if (!fresh.length) return
  await prisma.playbookRule.createMany({
    data: fresh.map((r) => ({
      tenantId, createdById: user.id,
      kind: r.kind,
      title: r.title,
      description: r.description,
      naturalPrompt: r.naturalPrompt,
      contractTypes: r.contractTypes,
      pattern: r.pattern as any,
      enabled: true,
      source: 'SEED_PACK' as const,
    })),
  })
  console.log(`  播种 Playbook 行业包：互联网用工风险包 ${fresh.length} 条（testboss）`)
}

async function seedLedger(tenantId: string) {
  const user = await prisma.user.findFirst({ where: { tenantId, username: 'testboss' } })
  if (!user) return
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
  // 原型 docs/prototype/ledger.html 同款演示台账 9 行（含 RENEWED/TERMINATED，其中 ACTIVE 7）
  // 日期对齐 2026-09 视角的分桶效果
  type Row = {
    key: string; employeeName: string; dept: string; contractType: string; position: string
    startDate: string; endDate?: string; probationEnd?: string; status?: 'ACTIVE' | 'RENEWED' | 'TERMINATED'
    remindBeforeDays?: number; linkedContractId?: string | null; renewedKey?: string; note?: string
  }
  const rows: Row[] = [
    // key 仅为占位 ID（幂等去重/续签关联用），非数据库主键
    { key: 'zhao', employeeName: '赵某', dept: '研发部', contractType: 'FIXED_TERM_LABOR', position: '前端工程师', startDate: '2024-09-11', endDate: '2026-09-10', linkedContractId: 'seed_contract_labor_risky' },
    { key: 'qian', employeeName: '钱某', dept: '研发部', contractType: 'FIXED_TERM_LABOR', position: '前端工程师', startDate: '2024-09-30', endDate: '2026-09-30' },
    { key: 'sun', employeeName: '孙某', dept: '市场部', contractType: 'NON_COMPETE', position: '市场经理', startDate: '2025-10-09', endDate: '2026-10-09' },
    { key: 'li', employeeName: '李某', dept: '设计部', contractType: 'INTERNSHIP', position: '实习生（在校）', startDate: '2026-04-24', endDate: '2026-10-24' },
    { key: 'zhou', employeeName: '周某', dept: '销售部', contractType: 'FIXED_TERM_LABOR', position: '销售代表', startDate: '2026-07-15', endDate: '2029-07-14', probationEnd: '2026-10-15' },
    { key: 'wu', employeeName: '吴某', dept: '研发部', contractType: 'OPEN_ENDED_LABOR', position: '测试工程师', startDate: '2023-03-01' },
    { key: 'zheng-old', employeeName: '郑某', dept: '原研发部', contractType: 'FIXED_TERM_LABOR', position: '后端工程师', startDate: '2023-08-01', endDate: '2026-07-31', status: 'RENEWED', renewedKey: 'zheng-new' },
    { key: 'zheng-new', employeeName: '郑某', dept: '研发部', contractType: 'FIXED_TERM_LABOR', position: '后端工程师', startDate: '2026-08-01', endDate: '2029-07-31' },
    { key: 'feng', employeeName: '冯某', dept: '原行政部', contractType: 'FIXED_TERM_LABOR', position: '', startDate: '2024-05-06', endDate: '2026-05-05', status: 'TERMINATED', note: '2026-05-06 协商解除' },
  ]
  const createdKeys = new Map<string, string>()
  let n = 0
  // 续签的新记录先建（旧记录 renewedFromId 指向它）
  for (const r of rows.filter((x) => x.key === 'zheng-new')) {
    const exist = await prisma.contractLedger.findFirst({
      where: { tenantId, employeeName: r.employeeName, startDate: d(r.startDate) },
      select: { id: true },
    })
    if (exist) { createdKeys.set(r.key, exist.id); continue }
    const row = await prisma.contractLedger.create({
      data: {
        tenantId, createdById: user.id, employeeName: r.employeeName, dept: r.dept,
        contractType: r.contractType, position: r.position || null,
        startDate: d(r.startDate),
        endDate: r.endDate ? d(r.endDate) : null,
        probationEnd: r.probationEnd ? d(r.probationEnd) : null,
        remindBeforeDays: r.remindBeforeDays ?? 30,
        status: 'ACTIVE',
      },
    })
    createdKeys.set(r.key, row.id)
    n += 1
  }
  for (const r of rows.filter((x) => x.key !== 'zheng-new')) {
    const exist = await prisma.contractLedger.findFirst({
      where: { tenantId, employeeName: r.employeeName, startDate: d(r.startDate) },
      select: { id: true },
    })
    if (exist) { createdKeys.set(r.key, exist.id); continue }
    // 关联合同若不存在（全新库未 seed 合同时）置空
    let linkedId: string | null = null
    if (r.linkedContractId) {
      const c = await prisma.contract.findFirst({ where: { id: r.linkedContractId, tenantId }, select: { id: true } })
      linkedId = c?.id ?? null
    }
    const row = await prisma.contractLedger.create({
      data: {
        tenantId, createdById: user.id, employeeName: r.employeeName, dept: r.dept,
        contractType: r.contractType, position: r.position || null,
        startDate: d(r.startDate),
        endDate: r.endDate ? d(r.endDate) : null,
        probationEnd: r.probationEnd ? d(r.probationEnd) : null,
        remindBeforeDays: r.remindBeforeDays ?? 30,
        status: r.status ?? 'ACTIVE',
        linkedContractId: linkedId,
        renewedFromId: r.renewedKey ? (createdKeys.get(r.renewedKey) ?? null) : null,
        note: r.note ?? null,
      },
    })
    createdKeys.set(r.key, row.id)
    n += 1
  }
  if (n) console.log(`  播种合同台账：${n} 条演示记录（testboss，对齐 ledger.html 原型）`)
}

// ── 平台功能文档（任务 Agent platform_help 工具的数据源，按套餐分层可见）──
const PLATFORM_DOCS = [
  // 公共（全套餐可见）
  { key: 'pd_intro', category: '平台介绍', title: 'ClauseMind 快速上手', plans: 'FREE,PERSONAL,TEAM,ENTERPRISE', keywords: '介绍,上手,开始,使用,是什么', sortOrder: 1, content: 'ClauseMind 是面向中小企业 HR 的 AI 合同风险审查平台。\n\n三步开始：\n1. 进入「合同审查」上传合同（支持 Word/PDF，建议 Word 以获得最佳解析效果）；\n2. 选择场景类型（劳动用工 / 采购 / 销售 / 通用）后开始审查；\n3. 审查完成后逐条处理风险：采纳建议、忽略或使用 AI 深度改写，最后在右侧面板整体「通过」或「驳回」。\n\n遇到不懂的功能，可以直接问本助手（小律）。' },
  { key: 'pd_review_how', category: '合同审查', title: '如何发起一次合同审查', plans: 'FREE,PERSONAL,TEAM,ENTERPRISE', keywords: '审查,上传,发起,风险,场景,双轨', sortOrder: 2, content: '路径：左侧导航「合同审查」→ 上传合同文件 → 选场景 → 开始审查。\n\n审查采用双轨架构：\n- 规则轨（所有套餐）：基于内置审查规则的本地引擎，秒级定位风险条款；\n- AI 轨（按套餐）：大模型逐条分析 + 交叉验证。\n\n免费版每周期限 3 次 AI 审查、每次最多输出 5 条风险；个人版不限次数、风险全量输出并解锁 AI 轨全能力。审查进行中会展示阶段进度与实时风险直播。' },
  { key: 'pd_review_riskcard', category: '合同审查', title: '审查结果页：风险卡操作指南', plans: 'FREE,PERSONAL,TEAM,ENTERPRISE', keywords: '风险卡,采纳,忽略,改写,通过,驳回', sortOrder: 3, content: '审查完成后每条风险以卡片展示，可执行：\n- 「采纳」：确认该风险需要处理，计入整改清单；\n- 「忽略」：标记不需要处理（可留备注）；\n- 「AI 深度改写」：由 AI 生成条款修订稿（深度权益，需个人版及以上或消耗深度券）；\n- 顶部搜索框可按风险标题/分析/原文引用过滤，配合严重程度下拉快速收敛范围。\n\n全部处理完后在右侧「整体判定」里审查通过或驳回。' },
  { key: 'pd_contract_lib', category: '合同档案', title: '合同档案库：上传与检索', plans: 'FREE,PERSONAL,TEAM,ENTERPRISE', keywords: '合同档案,上传,搜索,归档,版本', sortOrder: 4, content: '路径：左侧导航「合同档案」。\n\n- 上传：拖拽或点击上传 Word/PDF 合同，自动解析元数据（签约方、金额、期限等）；\n- 检索：支持按文件名、签约方、状态筛选，风险条数与审查状态一目了然；\n- 详情：打开合同可查看解析出的条款原文与关联的历次审查记录。\n\n团队版及以上空间里，档案在企业内共享。' },
  { key: 'pd_legal', category: '法规库', title: '法规库与法规问答', plans: 'FREE,PERSONAL,TEAM,ENTERPRISE', keywords: '法规,法条,问答,检索,劳动法', sortOrder: 5, content: '路径：左侧导航「法规问答」。\n\n内置劳动用工领域法规库（劳动合同法、社会保险法、工资支付暂行规定等），支持两种用法：\n- 直接提问：如「试用期最长多久」，回答附带条文原文与出处；\n- 会话式多轮追问，历史会话可在左侧列表找回。\n\n任务 Agent 也复用同一法规库（legal_search 工具），两处回答口径一致。' },
  { key: 'pd_agent', category: '任务 Agent', title: '任务 Agent 使用说明', plans: 'FREE,PERSONAL,TEAM,ENTERPRISE', keywords: 'agent,助手,示例任务,会话,小律,多轮', sortOrder: 6, content: '路径：左侧导航「任务 Agent」。\n\n小律不只是问答机器人：它能调用平台工具完成实际任务——查你的合同档案、盘点审查风险、核对员工台账、检索法条、算违约金、推算日期等。\n\n使用方式：\n- 直接输入任务（如「帮我盘点未处理的风险」）；\n- 或点击示例分类展开 3 条典型任务，点一条即可执行；\n- 支持多轮对话与历史会话，右下角 3D 悬浮球与本页能力完全一致。' },
  { key: 'pd_billing', category: '账单订阅', title: '套餐购买与升级', plans: 'FREE,PERSONAL,TEAM,ENTERPRISE', keywords: '套餐,价格,购买,升级,订阅,收银台,账单', sortOrder: 7, content: '路径：右上角头像 →「套餐与账单」。\n\n- 免费版：注册即用，含基础规则审查与限量 AI 能力；\n- 个人版：解锁 AI 深度改写、不限次审查、Agent 深度权益，按月/按年订阅；\n- 团队版：增加企业空间、席位管理、员工台账与 Playbook，按席位订阅；\n- 企业版：私有化与定制能力，联系商务询价。\n\n购买走站内收银台（支持微信支付），升级立即生效，账单页可下载发票凭证。' },
  { key: 'pd_assistant_bot', category: '任务 Agent', title: '3D 助手小律（悬浮球）', plans: 'FREE,PERSONAL,TEAM,ENTERPRISE', keywords: '机器人,悬浮球,3d,小律,助手', sortOrder: 8, content: '登录后所有页面右下角都有一个 3D 机器人「小律」：\n- 点击它弹出迷你聊天面板，可以直接提问或执行任务；\n- 按住机器人可拖动到屏幕任意位置；\n- 面板标题栏可拖拽移动，左侧栏是历史会话记录；\n- 它的眼睛会跟随你的鼠标移动；\n- 任务 Agent 页有完整工作台，点面板右上角 ↗ 即可跳转。\n\n它能回答平台功能问题，也能查你的真实业务数据。' },

  // 深度权益（个人版及以上）
  { key: 'pd_deep', category: '深度权益', title: '个人版及以上：AI 深度改写与 Agent 深度能力', plans: 'PERSONAL,TEAM,ENTERPRISE', keywords: '深度改写,改写,权益,个人版,深度券', sortOrder: 10, content: '个人版及以上解锁：\n- AI 深度改写：审查结果页风险卡上的「AI 改写」直接生成条款修订稿，一键替换原文；\n- 不限次 AI 审查与全量风险输出；\n- 任务 Agent 深度能力：多轮复杂任务、调用全部工具。\n\n深度券：免费版用户可用券包体验深度能力（收银台购买），每次深度改写消耗 1 张。' },
  { key: 'pd_export', category: '合同审查', title: '审查报告导出（Word 红划线 / PDF）', plans: 'PERSONAL,TEAM,ENTERPRISE', keywords: '导出,下载,word,pdf,报告,红划线', sortOrder: 11, content: '审查完成后可导出：\n- Word 红划线版：修订痕迹直接标在原文上，方便线下与对方律师沟通；\n- PDF 审查报告：含风险清单、严重程度与整改建议。\n\n入口：审查结果页右上角「导出」。个人版及以上可用，团队版支持企业水印。' },

  // 团队版及以上
  { key: 'pd_team_space', category: '团队协作', title: '企业空间与席位管理', plans: 'TEAM,ENTERPRISE', keywords: '团队,企业空间,席位,成员,邀请,协作', sortOrder: 20, content: '团队版提供企业空间：\n- 邀请成员：空间设置里按邮箱/工号邀请，分配 HR / 法务 / 管理员角色；\n- 席位计费：按激活席位数按周期计费，空间设置可随时加减席位；\n- 数据共享：企业内合同档案、台账、Playbook 全员按角色可见。\n\n路径：左侧导航「空间设置」（管理员可见）。' },
  { key: 'pd_ledger', category: '合同台账', title: '员工合同台账与到期预警', plans: 'TEAM,ENTERPRISE', keywords: '台账,到期,预警,续签,员工,合同台账', sortOrder: 21, content: '路径：左侧导航「合同台账」（团队版及以上）。\n\n- 录入/导入员工合同：姓名、岗位、合同期限、试用期、到期日；\n- 到期预警：90 天窗口倒排，30 天内标红，支持按部门筛选；\n- 批量操作：标记已续签、导出 Excel。\n\n任务 Agent 可直接查询台账（如「列出 30 天内到期的合同」）。' },
  { key: 'pd_playbook', category: '企业规则', title: 'Playbook：企业审查规则定制', plans: 'TEAM,ENTERPRISE', keywords: 'playbook,规则,红线,定制,企业规则', sortOrder: 22, content: '路径：左侧导航「审查规则」→ Playbook 标签（团队版及以上）。\n\n企业可以把内部审查口径固化为规则：\n- 预设风险点：如「试用期不得超过 6 个月」「违约金上限」；\n- 严重程度与整改建议模板；\n- 启用后企业内每次审查自动套用，命中即标注为「Playbook 命中」。\n\n管理员可增删改规则并控制启用状态。' },
  { key: 'pd_feishu', category: '集成', title: '飞书集成：审查通知与消息推送', plans: 'TEAM,ENTERPRISE', keywords: '飞书,通知,推送,集成,消息', sortOrder: 23, content: '团队版支持绑定飞书：\n- 审查完成/驳回自动推送卡片消息到指定群；\n- 台账临期提醒每日定时推送；\n- 配置入口：空间设置 → 集成 → 飞书（需管理员授权）。' },

  // 企业版
  { key: 'pd_enterprise', category: '企业版', title: '企业版专属能力', plans: 'ENTERPRISE', keywords: '企业版,私有化,定制,专属,sla', sortOrder: 30, content: '企业版在团队版基础上提供：\n- 私有化部署与数据隔离方案；\n- 定制审查规则集与行业模板；\n- 专属客户成功经理与 SLA 保障；\n- SSO 单点登录与审计日志。\n\n购买需商务询价，官网「联系我们」或邮件 business@clausemind.cn。' },
]

async function seedPlatformDocs() {
  let n = 0
  for (const d of PLATFORM_DOCS) {
    await prisma.platformDoc.upsert({
      where: { id: d.key },
      update: { category: d.category, title: d.title, content: d.content, plans: d.plans, keywords: d.keywords, sortOrder: d.sortOrder },
      create: { id: d.key, category: d.category, title: d.title, content: d.content, plans: d.plans, keywords: d.keywords, sortOrder: d.sortOrder },
    })
    n += 1
  }
  if (n) console.log(`  播种平台功能文档：${n} 篇（按套餐分层可见，任务 Agent platform_help 使用）`)
}

async function main() {
  console.log('开始播种...')
  const accountIds = new Map<string, string>()
  for (const account of DEMO_ACCOUNTS) {
    accountIds.set(account.username, await ensureUser(account))
  }
  await seedRules()
  await seedDocs()
  await seedContracts()
  await seedEvalCases()
  await seedBillingDemo(accountIds.get('demo_personal')!)
  await seedPlaybook(accountIds.get('testboss')!)
  await seedLedger(accountIds.get('testboss')!)
  await seedPlatformDocs()
  console.log('播种完成 ✓')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
