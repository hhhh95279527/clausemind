// server/src/auth/guards/roles.guard.ts
// 角色守卫：基于 RBAC 的接口级权限控制
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from '../decorators/roles.decorator'
import type { UserRole } from '@prisma/client'

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])

    // 没有设置 @Roles() 装饰器，则不限制角色
    if (!requiredRoles?.length) return true

    const { user } = context.switchToHttp().getRequest()
    if (!user) return false

    return requiredRoles.includes(user.role)
  }
}
