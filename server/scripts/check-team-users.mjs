import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
// 查企业空间（TEAM workspace）的用户，供确认白名单
const tenants = await db.tenant.findMany({
  where: { workspaceType: 'TEAM' },
  select: { id: true, name: true, plan: true, users: { select: { username: true, email: true, displayName: true, role: true } } },
})
for (const t of tenants) {
  console.log(`\n[企业空间] ${t.name} (plan=${t.plan})`)
  for (const u of t.users) console.log(`  - ${u.username} | ${u.email ?? '无邮箱'} | ${u.displayName ?? ''} | ${u.role}`)
}
await db.$disconnect()
