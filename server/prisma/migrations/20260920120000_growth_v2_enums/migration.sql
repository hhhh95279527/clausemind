-- ClauseMind 产品化改造 v2 · 枚举扩展
-- PG 限制：ALTER TYPE ... ADD VALUE 新增的枚举值在同一事务内不可使用，
-- 因此老套餐数据 PRO→TEAM、ENT→ENTERPRISE 的映射放在下一条迁移（20260920120100_growth_v2_data）。

-- 套餐四档：FREE 已存在；新增 PERSONAL（个人版）/ TEAM（团队版）/ ENTERPRISE（企业版）
-- 历史值 PRO、ENT 保留在物理枚举中（PG 不支持 DROP VALUE），数据映射后不再被业务使用。
ALTER TYPE "TenantPlan" ADD VALUE IF NOT EXISTS 'PERSONAL';
ALTER TYPE "TenantPlan" ADD VALUE IF NOT EXISTS 'TEAM';
ALTER TYPE "TenantPlan" ADD VALUE IF NOT EXISTS 'ENTERPRISE';

-- 工作空间类型：PERSONAL=个人单成员空间，TEAM=企业团队空间
CREATE TYPE "WorkspaceType" AS ENUM ('PERSONAL', 'TEAM');

-- 合同台账状态：ACTIVE=履行中，RENEWED=已续签（原记录），TERMINATED=已解除/终止
CREATE TYPE "LedgerStatus" AS ENUM ('ACTIVE', 'RENEWED', 'TERMINATED');

-- Playbook 规则分区：FORBIDDEN=红线规则，PREFERENCE=偏好口径，STANDARD=标准合同库，INDUSTRY=行业专项包
CREATE TYPE "PlaybookKind" AS ENUM ('FORBIDDEN', 'PREFERENCE', 'STANDARD', 'INDUSTRY');

-- Playbook 规则来源：MANUAL=手写，AI=自然语言生成，SEED_PACK=行业包复制
CREATE TYPE "PlaybookSource" AS ENUM ('MANUAL', 'AI', 'SEED_PACK');

-- 模拟订单类型：SUBSCRIPTION=订阅月/年，COUPON_PACK=深度券包，UPGRADE=团队升级
CREATE TYPE "OrderKind" AS ENUM ('SUBSCRIPTION', 'COUPON_PACK', 'UPGRADE');

-- 订单周期：MONTH=月付，YEAR=年付，NONE=券包等无周期
CREATE TYPE "OrderPeriod" AS ENUM ('MONTH', 'YEAR', 'NONE');

-- 订单状态：PENDING=待支付（模拟收银台），PAID=已支付立即生效，CANCELLED=已取消
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- 集成提供方：P0 仅 FEISHU
CREATE TYPE "IntegrationProvider" AS ENUM ('FEISHU');

-- 集成状态：NOT_CONFIGURED=未配置，ACTIVE=已配置可用
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'ACTIVE');
