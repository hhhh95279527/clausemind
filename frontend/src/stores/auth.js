// frontend/src/stores/auth.js
// 认证状态管理：Token、用户信息、登录/登出
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useAuthStore = create(
  persist(
    (set, get) => ({
      // ── 状态 ──────────────────────────────────────────────────
      user: null,             // { id, username, email, displayName, role, avatar }
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      // ── 登录 ──────────────────────────────────────────────────
      setAuth: (data) => set({
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        isAuthenticated: true,
      }),

      // ── 更新 Token（刷新后）──────────────────────────────────
      setTokens: (accessToken, refreshToken) => set({
        accessToken,
        refreshToken,
      }),

      // ── 更新用户信息 ──────────────────────────────────────────
      setUser: (user) => set({ user }),

      // ── 登出 ──────────────────────────────────────────────────
      logout: () => set({
        user: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
      }),

      // ── 检查是否某角色 ────────────────────────────────────────
      hasRole: (...roles) => {
        const { user } = get()
        return user ? roles.includes(user.role) : false
      },
    }),
    {
      name: 'clausemind-auth',
      // 只持久化 token 和用户信息
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
