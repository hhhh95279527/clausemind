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
