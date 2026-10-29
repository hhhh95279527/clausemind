// server/src/me/me.controller.ts
// 个人空间资料接口：权益快照 / 审查偏好 / 个人条款库（FR-11）。
// 偏好与条款库轻量落在 users.metadata JSONB，不建表；FREE 条款库限 3 条。
import {
  Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req,
} from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { randomUUID } from 'crypto'
import { DatabaseService } from '../database/database.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { PlanLimitException } from '../billing/plan-limit.exception.js'

/** 关注项可选值（与原型一致，不接受自由文本以防脏数据） */
const FOLLOW_RISK_OPTIONS = ['押金', '定金 / 订金', '违约金', '试用期', '社保', '竞业限制', '争议管辖']
const TONES = ['RIGOROUS', 'PLAIN'] as const
const STANCES = ['LESSEE', 'LESSOR'] as const
const SCENES = ['LABOR', 'INTERNSHIP', 'LEASE', 'SERVICE', 'NDA', 'SALE', 'LOAN', 'EQUITY', 'CUSTOM']
const FREE_LIBRARY_LIMIT = 3

/** 审查偏好默认值（未设置/缺字段时回填；只读使用，不修改） */
const DEFAULT_PREFS = {
  followRisks: ['押金', '定金 / 订金', '违约金', '试用期'],
  tone: 'RIGOROUS',
  stance: 'LESSEE',
}

interface ClauseLibraryItem {
  id: string
  title: string
  content: string
  scene: string
  createdAt: string
}

interface PersonalMeta {
  reviewPrefs?: { followRisks?: string[]; tone?: string; stance?: string }
  clauseLibrary?: ClauseLibraryItem[]
}

@ApiTags('me')
@ApiBearerAuth('bearer')
@Controller('api/me')
export class MeController {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private readMeta(metadata: unknown): PersonalMeta {
    return (metadata ?? {}) as PersonalMeta
  }

  // ── 权益快照（工作台额度卡 / 付费墙数据）──
  @Get('entitlements')
  @ApiOperation({ summary: '当前空间权益快照', description: '返回套餐、深度券余额、月度额度用量、功能开关等，供工作台额度卡与付费墙使用。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async getEntitlements(@Req() req: any) {
    const snapshot = await this.entitlements.getEntitlementSnapshot(req.user.tenantId)
    if (!snapshot) throw new NotFoundException('工作空间不存在')
    return snapshot
  }

  // ── 审查偏好 + 条款库 ──
  @Get('preferences')
  @ApiOperation({ summary: '审查偏好与个人条款库', description: '返回当前用户的审查关注项、审查语气、立场及收藏的个人条款。' })
  @ApiOkResponse({ schema: { type: 'object', properties: { reviewPrefs: { type: 'object', additionalProperties: true }, clauseLibrary: { type: 'array', items: { type: 'object', additionalProperties: true } } } } })
  async preferences(@Req() req: any) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: req.user.userId } })
    const meta = this.readMeta(user.metadata)
    return {
      reviewPrefs: { ...DEFAULT_PREFS, ...(meta.reviewPrefs || {}) },
      clauseLibrary: meta.clauseLibrary || [],
    }
  }

  @Patch('preferences')
  @ApiOperation({ summary: '更新审查偏好', description: '关注项仅接受固定白名单值（去重、最多 10 项）；tone=RIGOROUS 严谨 / PLAIN 通俗；stance=LESSEE 承租方 / LESSOR 出租方。非法字段回退默认/原值。' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        followRisks: { type: 'array', maxItems: 10, items: { type: 'string', enum: FOLLOW_RISK_OPTIONS }, description: '重点关注的风险项' },
        tone: { type: 'string', enum: ['RIGOROUS', 'PLAIN'], description: '审查/改稿语气' },
        stance: { type: 'string', enum: ['LESSEE', 'LESSOR'], description: '审查立场（承租方/出租方）' },
      },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', properties: { reviewPrefs: { type: 'object', additionalProperties: true }, clauseLibrary: { type: 'array', items: { type: 'object', additionalProperties: true } } } } })
  async patchPreferences(
    @Req() req: any,
    @Body() body: { followRisks?: string[]; tone?: string; stance?: string },
  ) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: req.user.userId } })
    const meta = this.readMeta(user.metadata)

    const followRisks = Array.isArray(body.followRisks)
      ? [...new Set(body.followRisks)].filter((x) => FOLLOW_RISK_OPTIONS.includes(x)).slice(0, 10)
      : meta.reviewPrefs?.followRisks ?? DEFAULT_PREFS.followRisks
    const tone = TONES.includes(body.tone as any) ? body.tone : (meta.reviewPrefs?.tone ?? DEFAULT_PREFS.tone)
    const stance = STANCES.includes(body.stance as any) ? body.stance : (meta.reviewPrefs?.stance ?? DEFAULT_PREFS.stance)

    const nextMeta: PersonalMeta = {
      ...meta,
      reviewPrefs: { followRisks, tone, stance },
    }
    await this.db.user.update({ where: { id: user.id }, data: { metadata: nextMeta as any } })
    return { reviewPrefs: nextMeta.reviewPrefs, clauseLibrary: nextMeta.clauseLibrary || [] }
  }

  // ── 个人条款库：收藏（FREE ≤3，个人版及以上不限）──
  @Post('clause-library')
  @ApiOperation({
    summary: '收藏个人条款',
    description: '标题 ≤100 字、内容 ≤2000 字。FREE 空间最多 3 条，超限返回套餐拦截错误（DEEP_FEATURE）。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string', maxLength: 100, description: '条款标题' },
        content: { type: 'string', maxLength: 2000, description: '条款内容' },
        scene: { type: 'string', enum: SCENES, description: '适用场景，缺省 CUSTOM', default: 'CUSTOM' },
      },
    },
  })
  @ApiResponse({ status: 201, schema: { type: 'object', properties: { clauseLibrary: { type: 'array', items: { type: 'object', additionalProperties: true } } } } })
  async addClause(
    @Req() req: any,
    @Body() body: { title?: string; content?: string; scene?: string },
  ) {
    const title = (body.title || '').trim().slice(0, 100)
    const content = (body.content || '').trim().slice(0, 2000)
    if (!title || !content) {
      throw new NotFoundException('条款标题与内容不能为空')
    }
    const scene = SCENES.includes(body.scene || '') ? body.scene! : 'CUSTOM'

    const user = await this.db.user.findUniqueOrThrow({ where: { id: req.user.userId } })
    const meta = this.readMeta(user.metadata)
    const library = meta.clauseLibrary || []

    if (!this.entitlements.can((await this.tenantPlan(req.user.tenantId)), 'clauseLibrary') && library.length >= FREE_LIBRARY_LIMIT) {
      throw new PlanLimitException(
        'DEEP_FEATURE',
        `免费版最多收藏 ${FREE_LIBRARY_LIMIT} 条个人条款，升级个人版可无限收藏并在改稿时一键插入`,
        'clauseLibrary',
      )
    }

    const item: ClauseLibraryItem = {
      id: randomUUID(),
      title,
      content,
      scene,
      createdAt: new Date().toISOString(),
    }
    const nextLib = [item, ...library]
    const nextMeta = { ...meta, clauseLibrary: nextLib }
    await this.db.user.update({ where: { id: user.id }, data: { metadata: nextMeta as any } })
    return { clauseLibrary: nextLib }
  }

  @Delete('clause-library/:id')
  @ApiOperation({ summary: '删除收藏的个人条款' })
  @ApiParam({ name: 'id', description: '条款条目 ID' })
  @ApiOkResponse({ schema: { type: 'object', properties: { clauseLibrary: { type: 'array', items: { type: 'object', additionalProperties: true } } } } })
  async removeClause(@Req() req: any, @Param('id') id: string) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: req.user.userId } })
    const meta = this.readMeta(user.metadata)
    const nextLib = (meta.clauseLibrary || []).filter((c) => c.id !== id)
    await this.db.user.update({
      where: { id: user.id },
      data: { metadata: { ...meta, clauseLibrary: nextLib } as any },
    })
    return { clauseLibrary: nextLib }
  }

  private async tenantPlan(tenantId: string) {
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    return tenant.plan
  }
}
