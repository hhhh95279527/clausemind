// server/src/health/health.controller.ts
// 健康检查（公开，供容器探针/负载均衡使用）
import { Controller, Get } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public } from '../auth/decorators/public.decorator'

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  private readonly startTime = Date.now()

  @Get('live')
  @ApiOperation({ summary: '存活探针（liveness）', description: '公开接口，供容器/负载均衡探活。返回 status 与进程 uptime（秒）。' })
  live() {
    return { status: 'ok', uptime: Math.floor((Date.now() - this.startTime) / 1000) }
  }

  @Get()
  @ApiOperation({ summary: '健康检查', description: '公开接口，返回服务状态、uptime 与版本号。' })
  health() {
    return {
      status: 'healthy',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: '2.0.0',
    }
  }
}
