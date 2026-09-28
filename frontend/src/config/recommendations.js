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
