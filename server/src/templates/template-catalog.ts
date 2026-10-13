// server/src/templates/template-catalog.ts
// 合同范本目录（FR-20，与 prisma/fixtures/legal.ts 的 TEMPLATE_DOCS 一一对应）。
// 这是范本元数据（标题/分类/场景/卡片描述/排序）的唯一事实源；fixtures 引用本目录入库。
type TemplateScene = 'LABOR' | 'INTERNSHIP' | 'LEASE' | 'SERVICE' | 'NDA' | 'SALE' | 'LOAN' | 'EQUITY' | 'CUSTOM'

export interface TemplateCatalogItem {
  docId: string
  title: string
  fileName: string
  /** 原型分类标签 */
  category: string
  /** 采用后生成合同的审查场景 */
  scene: TemplateScene
  /** 卡片一句话描述（原型文案） */
  summary: string
  /** 原型「新」角标 */
  isNew?: boolean
  order: number
}

export const TEMPLATE_CATALOG: TemplateCatalogItem[] = [
  // ── 劳动用工（8）─────────────────────────────────────────────
  { docId: 'tpl_labor_fixed', title: '标准劳动合同（固定期限）', fileName: '标准劳动合同（固定期限）.txt', category: '劳动合同类', scene: 'LABOR', summary: '十九条完整版，覆盖合同期限、试用期、社保公积金、劳动保护、服务期、竞业、解除补偿等法定必备条款。', order: 1 },
  { docId: 'tpl_labor_open', title: '无固定期限劳动合同', fileName: '无固定期限劳动合同.txt', category: '劳动合同类', scene: 'LABOR', summary: '适用于连续工作满十年、连续二次续签等法定情形，含无固定期限情形确认与解除补偿条款。', order: 2 },
  { docId: 'tpl_parttime', title: '非全日制用工劳动合同', fileName: '非全日制用工劳动合同.txt', category: '劳动合同类', scene: 'LABOR', summary: '小时计酬、日均不超4小时周不超24小时、15日支付周期、不得约定试用期，符合非全日制规定。', order: 3 },
  { docId: 'tpl_intern', title: '实习协议（在校生）', fileName: '实习协议（在校生）.txt', category: '劳动合同类', scene: 'INTERNSHIP', summary: '明确实习性质不构成劳动关系，约定实习时长、补贴、实习责任保险与安全管理责任。', order: 4 },
  { docId: 'tpl_labor_service', title: '劳务协议（退休返聘/独立承揽）', fileName: '劳务协议.txt', category: '劳动合同类', scene: 'SERVICE', summary: '适用于退休返聘、独立承揽等非劳动关系场景，明确风险承担、税务处理与成果验收。', order: 5 },
  { docId: 'tpl_offer', title: '录用通知书 Offer', fileName: '录用通知书Offer.txt', category: '劳动合同类', scene: 'LABOR', summary: '岗位薪酬、试用期法定上限提示、报到材料、录用失效条件与签收回执，防范缔约过失纠纷。', order: 6 },
  { docId: 'tpl_renew_notice', title: '劳动合同续签通知书', fileName: '劳动合同续签通知书.txt', category: '劳动合同类', scene: 'LABOR', summary: '载明续签条件、无固定期限情形提示与答复期限，固定"维持或提高条件"证据。', order: 7 },
  { docId: 'tpl_termination_notice', title: '解除 / 终止劳动合同通知书', fileName: '解除终止劳动合同通知书.txt', category: '劳动合同类', scene: 'LABOR', summary: '覆盖协商解除、到期终止、过失性/无过失性解除、裁员等情形，载明补偿结算与交接安排。', order: 8 },

  // ── 租赁（2）─────────────────────────────────────────────────
  { docId: 'tpl_house_lease', title: '房屋租赁合同（个人居住）', fileName: '房屋租赁合同（个人居住）.txt', category: '租赁类', scene: 'LEASE', summary: '二十条完整版，对齐《住房租赁条例》（2025年施行）：押金返还、非居住空间禁租、登记备案、禁止暴力逼迁、买卖不破租赁。', isNew: true, order: 9 },
  { docId: 'tpl_office_lease', title: '办公场地租赁合同', fileName: '办公场地租赁合同.txt', category: '租赁类', scene: 'LEASE', summary: '企业办公租赁十八条，含免租装修期、租金递增、物业费、消防报批、转租限制与征收补偿。', order: 10 },

  // ── 买卖借贷（2）─────────────────────────────────────────────
  { docId: 'tpl_sale', title: '货物买卖合同（通用版）', fileName: '货物买卖合同.txt', category: '买卖借贷类', scene: 'SALE', summary: '对齐民法典买卖合同章：检验期间、质量异议、所有权保留、风险转移、定金与违约金择一等十九条。', isNew: true, order: 11 },
  { docId: 'tpl_loan', title: '民间借贷合同', fileName: '民间借贷合同.txt', category: '买卖借贷类', scene: 'LOAN', summary: '对齐最高法民间借贷司法解释：利率不超合同成立时一年期LPR四倍、禁止预扣利息、担保与送达条款。', isNew: true, order: 12 },

  // ── 股权与技术服务（2）───────────────────────────────────────
  { docId: 'tpl_equity_transfer', title: '股权转让协议', fileName: '股权转让协议.txt', category: '股权服务类', scene: 'EQUITY', summary: '对齐2024年施行的新《公司法》：股东对外转让通知、30日优先购买权、出资义务承继、名册变更与登记。', isNew: true, order: 13 },
  { docId: 'tpl_tech_service', title: '技术服务合同', fileName: '技术服务合同.txt', category: '股权服务类', scene: 'SERVICE', summary: '对齐民法典技术服务合同章：里程碑验收、质保、新技术成果归属、背景知识产权与数据安全。', isNew: true, order: 14 },

  // ── 保密（2）─────────────────────────────────────────────────
  { docId: 'tpl_nda', title: '保密与竞业限制协议 NDA', fileName: '保密与竞业限制协议NDA.txt', category: '保密协议类', scene: 'NDA', summary: '十五条完整版：商业秘密范围、竞业期限不超2年、按月经济补偿不低于30%、违约金与继续履行。', isNew: true, order: 15 },
  { docId: 'tpl_confidentiality', title: '保密协议（通用版）', fileName: '保密协议.txt', category: '保密协议类', scene: 'NDA', summary: '适用于商务合作/劳动关系双方：保密信息界定、例外情形、资料返还销毁、个人信息保护与独立有效。', order: 16 },
]
