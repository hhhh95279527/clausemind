// frontend/src/views/personal/scene.js
// 个人曲线场景映射（原型文案）：后端 code ↔ 原型标签 ↔ /new 锚点
export const SCENE_LABELS = {
  LABOR: '劳动合同',
  LEASE: '房屋租赁',
  SERVICE: '兼职劳务',
  NDA: '保密与 NDA',
  CUSTOM: '非标合同',
}

export const SCENE_ANCHORS = {
  LABOR: 'scene-labor',
  LEASE: 'scene-rent',
  SERVICE: 'scene-parttime',
  NDA: 'scene-nda',
}

export const ANCHOR_TO_SCENE = {
  'scene-labor': 'LABOR',
  'scene-rent': 'LEASE',
  'scene-parttime': 'SERVICE',
  'scene-nda': 'NDA',
}

export function sceneLabel(code) {
  return SCENE_LABELS[code] || '非标合同'
}

export function fmtDate(d) {
  if (!d) return ''
  const dt = new Date(d)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

export function fmtDateCN(d) {
  if (!d) return ''
  const dt = new Date(d)
  return `${dt.getFullYear()} 年 ${dt.getMonth() + 1} 月 ${dt.getDate()} 日`
}

/** 剩余整天数（当天记为 N 天） */
export function daysUntil(d) {
  if (!d) return null
  return Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000))
}

export function riskCountOf(item) {
  return item?.review?.stats?.total ?? item?.review?.riskCount ?? 0
}
