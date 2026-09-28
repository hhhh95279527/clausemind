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
import { LedgerService, type LedgerUpsertDto } from './ledger.service.js'

@Controller('api/ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
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
  create(@Req() req: any, @Body() body: LedgerUpsertDto) {
    return this.ledger.create(req.user.tenantId, req.user.userId, body || {})
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: LedgerUpsertDto) {
    return this.ledger.update(req.user.tenantId, req.user.userId, id, body || {})
  }

  @Post(':id/renew')
  renew(@Req() req: any, @Param('id') id: string, @Body() body: LedgerUpsertDto) {
    return this.ledger.renew(req.user.tenantId, req.user.userId, id, body || {})
  }

  @Post(':id/terminate')
  terminate(@Req() req: any, @Param('id') id: string) {
    return this.ledger.terminate(req.user.tenantId, req.user.userId, id)
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.ledger.remove(req.user.tenantId, req.user.userId, id)
  }

  @Post('extract')
  extract(@Req() req: any, @Body() body: { contractId?: string }) {
    return this.ledger.extract(req.user.tenantId, String(body?.contractId ?? ''))
  }
}
