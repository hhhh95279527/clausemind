// server/src/ledger/ledger.controller.ts
// 合同台账接口（FR-16，/api/ledger）：
//   GET    /                    列表（分页/搜索/分桶筛选 + 统计卡）
//   POST   /                    新建（FREE/PERSONAL ≤10 拦截）
//   PATCH  /:id                 编辑
//   POST   /:id/renew           续签（原 RENEWED + 新记录 renewedFromId）
//   POST   /:id/terminate       协商解除
//   DELETE /:id                 删除
//   POST   /extract             从审查合同 AI 抽取预填（无 Key 409）
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger'
import { LedgerService, type LedgerUpsertDto } from './ledger.service.js'

const ledgerBodySchema: SchemaObject = {
  type: 'object',
  properties: {
    employeeName: { type: 'string', description: '员工姓名（劳动类合同）' },
    dept: { type: 'string', nullable: true, description: '所属部门' },
    contractType: { type: 'string', description: '台账合同类型（固定期限/无固定期限/实习/劳务等，以服务端字典为准）' },
    position: { type: 'string', nullable: true, description: '岗位' },
    startDate: { type: 'string', format: 'date', description: '合同开始日期 YYYY-MM-DD' },
    endDate: { type: 'string', format: 'date', nullable: true, description: '合同到期日期 YYYY-MM-DD（无固定期限可空）' },
    probationEnd: { type: 'string', format: 'date', nullable: true, description: '试用期到期日期 YYYY-MM-DD' },
    remindBeforeDays: { type: 'integer', minimum: 0, description: '到期提前提醒天数' },
    linkedContractId: { type: 'string', nullable: true, description: '关联的审查合同 ID（可选）' },
    note: { type: 'string', nullable: true, description: '备注' },
  },
}

@ApiTags('ledger')
@ApiBearerAuth('bearer')
@Controller('api/ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @ApiOperation({ summary: '台账列表（分页/搜索/分桶 + 统计卡）', description: '按当前租户返回台账记录分页列表与顶部统计数据。' })
  @ApiQuery({ name: 'q', required: false, description: '关键词搜索（员工姓名等）' })
  @ApiQuery({ name: 'filter', required: false, description: '分桶筛选（如即将到期/已到期/试用期等，以服务端支持值为准）' })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数' })
  list(
    @Req() req: any,
    @Query('q') q?: string,
    @Query('filter') filter?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.ledger.list(req.user.tenantId, { q, filter, page: Number(page), pageSize: Number(pageSize) })
  }

  @Post()
  @ApiOperation({ summary: '新建台账记录', description: 'FREE/PERSONAL 空间最多 10 条，超限拦截。' })
  @ApiBody({ schema: ledgerBodySchema })
  create(@Req() req: any, @Body() body: LedgerUpsertDto) {
    return this.ledger.create(req.user.tenantId, req.user.userId, body || {})
  }

  @Patch(':id')
  @ApiOperation({ summary: '编辑台账记录' })
  @ApiParam({ name: 'id', description: '台账记录 ID' })
  @ApiBody({ schema: ledgerBodySchema })
  update(@Req() req: any, @Param('id') id: string, @Body() body: LedgerUpsertDto) {
    return this.ledger.update(req.user.tenantId, req.user.userId, id, body || {})
  }

  @Post(':id/renew')
  @ApiOperation({ summary: '合同续签', description: '原记录置为 RENEWED，新建一条记录并以 renewedFromId 关联原记录。' })
  @ApiParam({ name: 'id', description: '原台账记录 ID' })
  @ApiBody({ schema: ledgerBodySchema })
  renew(@Req() req: any, @Param('id') id: string, @Body() body: LedgerUpsertDto) {
    return this.ledger.renew(req.user.tenantId, req.user.userId, id, body || {})
  }

  @Post(':id/terminate')
  @ApiOperation({ summary: '协商解除', description: '将台账记录标记为协商解除，并触发群机器人台账变更通知。' })
  @ApiParam({ name: 'id', description: '台账记录 ID' })
  terminate(@Req() req: any, @Param('id') id: string) {
    return this.ledger.terminate(req.user.tenantId, req.user.userId, id)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除台账记录' })
  @ApiParam({ name: 'id', description: '台账记录 ID' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.ledger.remove(req.user.tenantId, req.user.userId, id)
  }

  @Post('extract')
  @ApiOperation({ summary: '从审查合同 AI 抽取台账预填项', description: '根据已审查合同内容抽取员工姓名、期限、试用期等台账字段供前端预填；未配置 AI Key 返回 409。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['contractId'],
      properties: { contractId: { type: 'string', description: '合同 ID（须属于当前租户）' } },
    },
  })
  extract(@Req() req: any, @Body() body: { contractId?: string }) {
    return this.ledger.extract(req.user.tenantId, String(body?.contractId ?? ''))
  }
}
