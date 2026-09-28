// server/src/templates/template-catalog.ts
// 合同范本目录（FR-20，与 prisma/fixtures/legal.ts 的 TEMPLATE_DOCS 一一对应）。
// 这是范本元数据（标题/分类/场景/卡片描述/排序）的唯一事实源；fixtures 引用本目录入库。
export type TemplateScene = 'LABOR' | 'LEASE' | 'SERVICE' | 'NDA' | 'CUSTOM'

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
  { docId: 'tpl_labor_fixed', title: '标准劳动合同（固定期限）', fileName: '标准劳动合同（固定期限）.txt', category: '劳动合同类', scene: 'LABOR', summary: '合规条款齐全，含合同期限、试用期、社保、保密等必备约定。', order: 1 },
  { docId: 'tpl_labor_open', title: '无固定期限劳动合同', fileName: '无固定期限劳动合同.txt', category: '劳动合同类', scene: 'LABOR', summary: '适用于连续工作满十年或二次续签等法定情形。', order: 2 },
  { docId: 'tpl_intern', title: '实习协议（在校生）', fileName: '实习协议（在校生）.txt', category: '劳动合同类', scene: 'LABOR', summary: '明确实习性质、不构成劳动关系、实习补贴与安全责任。', order: 3 },
  { docId: 'tpl_labor_service', title: '劳务协议', fileName: '劳务协议.txt', category: '劳动合同类', scene: 'SERVICE', summary: '适用于退休返聘、项目外包等非劳动关系用工场景。', order: 4 },
  { docId: 'tpl_offer', title: '录用通知书 Offer', fileName: '录用通知书Offer.txt', category: '劳动合同类', scene: 'LABOR', summary: '岗位、薪资、报到时间与材料清单，附录用失效条件。', order: 5 },
  { docId: 'tpl_renew_notice', title: '劳动合同续签通知书', fileName: '劳动合同续签通知书.txt', category: '劳动合同类', scene: 'LABOR', summary: '配合台账到期提醒使用，载明续签条件与答复期限。', order: 6 },
  { docId: 'tpl_termination_notice', title: '解除 / 终止劳动合同通知书', fileName: '解除终止劳动合同通知书.txt', category: '劳动合同类', scene: 'LABOR', summary: '覆盖协商解除、到期终止等情形，载明事由与结算安排。', order: 7 },
  { docId: 'tpl_house_lease', title: '房屋租赁合同（个人居住）', fileName: '房屋租赁合同（个人居住）.txt', category: '租赁类', scene: 'LEASE', summary: '押金不超过 2 个月租金、维修责任与转租限制，适配个人居住场景。', isNew: true, order: 8 },
  { docId: 'tpl_office_lease', title: '办公场地租赁合同', fileName: '办公场地租赁合同.txt', category: '租赁类', scene: 'LEASE', summary: '企业办公 / 共享空间租赁，含物业费、免租期、违约与退场条款。', order: 9 },
  { docId: 'tpl_parttime', title: '兼职劳务协议', fileName: '兼职劳务协议.txt', category: '兼职与通用', scene: 'SERVICE', summary: '按小时 / 按任务结算的非全日制用工协议，明确工时与报酬口径。', isNew: true, order: 10 },
  { docId: 'tpl_nda', title: '保密与竞业限制协议 NDA', fileName: '保密与竞业限制协议NDA.txt', category: '兼职与通用', scene: 'NDA', summary: '保密范围、竞业期限与补偿标准、违约金一体化版本。', isNew: true, order: 11 },
  { docId: 'tpl_confidentiality', title: '保密协议', fileName: '保密协议.txt', category: '兼职与通用', scene: 'NDA', summary: '商业秘密范围、保密义务期限与违约责任的通用版本。', order: 12 },
]

export const TEMPLATE_CATEGORIES = ['劳动合同类', '租赁类', '兼职与通用'] as const
