// frontend/src/config/recommendations.js
// 场景化推荐（FR-23）：纯前端静态规则，不耗模型。
// 合同结果页按 scene 给出「避坑指南 + 相关范本」，
// 范本 docId 必须与 server/src/templates/template-catalog.ts 的 12 个 id 对齐。

export const RECOMMENDATIONS = {
  LABOR: {
    guide: {
      title: '劳动合同避坑要点',
      bullets: [
        '试用期最长 6 个月（3 年以上合同），且同一单位只能约定一次',
        '试用期工资不得低于转正工资的 80%，也不得低于当地最低工资',
        '社保必须依法缴纳，"自愿放弃社保"的约定无效',
        '单位违法解除要付 2N，合同到期不续签一般也要付 N',
      ],
    },
    templates: [
      { docId: 'tpl_labor_fixed', title: '标准劳动合同（固定期限）' },
      { docId: 'tpl_renew_notice', title: '劳动合同续签通知书' },
      { docId: 'tpl_offer', title: '录用通知书 Offer' },
    ],
  },
  INTERNSHIP: {
    guide: {
      title: '实习协议避坑要点',
      bullets: [
        '在校生实习不构成劳动关系，协议里不应约定"试用期"，可改为实习考核',
        '单位不得安排实习生加班、夜班和通宵作业，跟岗实习每日不超 8 小时',
        '实习单位应为你投保实习责任保险，保险费用不能甩给学生',
        '高空、井下、有毒有害、易燃易爆等高危岗位实习可直接拒绝',
      ],
    },
    templates: [
      { docId: 'tpl_intern', title: '实习协议（在校生）' },
    ],
  },
  LEASE: {
    guide: {
      title: '租房签约避坑',
      bullets: [
        '押金通常不超过 1 个月租金，退还条件与时间要写进合同',
        '维修义务、维修费用由谁承担要提前约定',
        '转租、提前退租的违约金条款双方应对等',
        '签约时留存房东产权证明与身份证照片',
      ],
    },
    templates: [
      { docId: 'tpl_house_lease', title: '房屋租赁合同（个人居住）' },
      { docId: 'tpl_office_lease', title: '办公场地租赁合同' },
    ],
  },
  SERVICE: {
    guide: {
      title: '劳务 / 外包签约要点',
      bullets: [
        '劳务关系不缴社保，但报酬口径与个税承担要说清楚',
        '按成果或按工时结算时，验收标准要尽量具体',
        '别漏了保密义务与成果知识产权归属的约定',
      ],
    },
    templates: [
      { docId: 'tpl_labor_service', title: '劳务协议' },
      { docId: 'tpl_parttime', title: '兼职劳务协议' },
    ],
  },
  NDA: {
    guide: {
      title: '保密 / 竞业避坑',
      bullets: [
        '保密信息范围与保密期限要具体，避免"一切信息"式笼统表述',
        '竞业限制期限最多 2 年，且单位必须按月支付经济补偿',
        '无补偿的竞业条款可能不生效，违约金要与损失相称',
      ],
    },
    templates: [
      { docId: 'tpl_nda', title: '保密与竞业限制协议 NDA' },
      { docId: 'tpl_confidentiality', title: '保密协议' },
    ],
  },
  SALE: {
    guide: {
      title: '买卖合同避坑要点',
      bullets: [
        '标的物名称、规格、数量与质量标准要写具体，避免"按样品"却不留存样品',
        '约定明确的检验期间与质量异议期，超期未提异议可能被视为合格',
        '定金不超过合同总额 20%，定金与违约金原则上只能择一主张',
        '交付时间、地点与风险转移节点要和运费承担条款对应清楚',
      ],
    },
    templates: [
      { docId: 'tpl_sale', title: '货物买卖合同（通用版）' },
    ],
  },
  LOAN: {
    guide: {
      title: '借款合同避坑要点',
      bullets: [
        '约定利率不得超过合同成立时一年期 LPR 的四倍，超出部分法院不支持',
        '利息不得预先在本金中扣除（砍头息按实际出借金额算本金）',
        '大额借款建议银行转账并备注"借款"，保留对方身份信息',
        '有保证人的要写明"连带保证"还是"一般保证"及保证期间',
      ],
    },
    templates: [
      { docId: 'tpl_loan', title: '民间借贷合同' },
    ],
  },
  EQUITY: {
    guide: {
      title: '股权转让避坑要点',
      bullets: [
        '对外转让需书面通知其他股东，注意其他股东 30 日优先购买权',
        '核实转让股权是否已实缴出资，认缴出资义务通常由受让方承继',
        '约定转让款分期与工商变更登记的先后顺序，防止"钱股两空"',
        '交割前的公司债务、或有负债与税务责任要设赔偿兜底条款',
      ],
    },
    templates: [
      { docId: 'tpl_equity_transfer', title: '股权转让协议' },
    ],
  },
  CUSTOM: {
    guide: {
      title: '通用合同检查清单',
      bullets: [
        '双方权利义务是否对等，有无只约束一方的条款',
        '违约责任、解除条件是否明确可执行',
        '争议解决方式（诉讼/仲裁）与管辖地是否约定清楚',
        '签字盖章主体与合同抬头是否一致',
      ],
    },
    templates: [
      { docId: 'tpl_confidentiality', title: '保密协议' },
      { docId: 'tpl_labor_service', title: '劳务协议' },
    ],
  },
}

/** 取某场景的推荐；未知场景兜底 CUSTOM */
export function getRecommendation(scene) {
  return RECOMMENDATIONS[scene] || RECOMMENDATIONS.CUSTOM
}
