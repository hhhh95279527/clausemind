// frontend/src/utils/persona.js
// persona 解析与首页跳转：登录/注册后按空间类型分流到个人 / 企业首页
import { useAuthStore } from '@/stores/auth.js'

/**
 * 解析当前用户 persona：
 * 后端返回 workspaceType 优先；缺失时按 role 兜底（ADMIN→TEAM，保证演示账号可见企业入口）。
 */
export function resolvePersona(user) {
  if (!user) return 'PERSONAL'
  if (user.workspaceType === 'TEAM' || user.workspaceType === 'PERSONAL') {
    return user.workspaceType
  }
  return user.role === 'ADMIN' ? 'TEAM' : 'PERSONAL'
}

/** persona 对应首页路径 */
export function homePath(user) {
  return resolvePersona(user) === 'TEAM' ? '/dashboard' : '/home'
}

/** hook 形式：组件中直接取当前 persona */
export function usePersona() {
  const user = useAuthStore((s) => s.user)
  return resolvePersona(user)
}
