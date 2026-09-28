// server/src/playbook/playbook.pack.ts
// 行业专项包种子（FR-17）：内置行业风险库，一键启用即复制为租户 Playbook 规则。
// 规则全部为确定性关键词/正则（不依赖模型 Key），文案与 docs/prototype/playbook.html 对齐。
import type { PlaybookKind, Severity } from '@prisma/client'

export interface PackRuleSeed {
  kind: PlaybookKind
  title: string
  description: string
  naturalPrompt: string
  contractTypes: string[]
  pattern: {
    keywords: string[]
    regex: string | null
    severity: Severity
    suggestion: string
  }
}

export interface IndustryPack {
  code: string
  name: string
  team: string
  ruleCount: number
  desc: string
  features: string[]
  /** live=false 对应原型「即将上线，敬请期待」，不提供启用接口 */
  live: boolean
  rules: PackRuleSeed[]
}

export const INDUSTRY_PACKS: IndustryPack[] = [
  {
    code: 'INTERNET_LABOR',
    name: '互联网用工风险包',
    team: '人力资源团队',
    ruleCount: 12,
    desc: '针对互联网公司高频用工场景预置的规则组，启用后自动并入红线 / 偏好规则。',
    features: [
      '加班费与工时制度（标准 / 综合 / 不定时）',
      '试用期录用条件与解除口径',
      '竞业限制补偿与违约金平衡',
      '灵活用工 / 外包 / 实习的关系认定',
    ],
    live: true,
    rules: [
      {
        kind: 'FORBIDDEN',
        title: '每月加班不得超过 36 小时',
        description: '标准工时下延长工作时间一般每日不超 1 小时、每月不超 36 小时；约定「无条件超时加班」无效。',
        naturalPrompt: '公司安排员工每月加班时间不得超过法律规定的 36 小时上限',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['加班', '36'],
          regex: '加班.{0,30}(超过|超出|不限|自愿).{0,10}(36|三十六)',
          severity: 'HIGH',
          suggestion: '将加班约定改为「经与工会和劳动者协商后延长，每日不超过 1 小时、每月不超过 36 小时」。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '加班费计算基数不得低于正常工作时间工资',
        description: '加班费基数按劳动合同约定的劳动者本人工资标准确定，约定按最低工资为基数存在补差风险。',
        naturalPrompt: '加班费计算基数不能约定为当地最低工资，应按劳动者正常工作时间工资确定',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['加班费', '最低工资'],
          regex: '加班费?.{0,20}(基数|标准).{0,20}(最低工资|基本工资)',
          severity: 'HIGH',
          suggestion: '明确加班费基数为劳动者正常出勤月工资（不含已发加班费），不得径行约定为最低工资。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '法定节假日加班不得以调休替代 300% 加班费',
        description: '法定休假日安排工作的，必须支付不低于工资 300% 的报酬，不能用补休冲抵。',
        naturalPrompt: '法定节假日加班必须支付三倍工资，不能只安排调休',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['法定节假日', '调休'],
          regex: '法定节?假日?.{0,20}(调休|补休|不支付|免予支付).{0,10}加班',
          severity: 'HIGH',
          suggestion: '删除「节假日加班一律调休」表述，改为法定节假日支付 300% 工资、休息日加班可优先调休。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '综合工时 / 不定时工作制须经劳动行政部门审批',
        description: '综合计算工时与不定时工作制非双方约定即可生效，须报劳动行政部门审批后实行。',
        naturalPrompt: '合同直接约定实行不定时工作制但没有行政审批的，条款无效',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['不定时工作制'],
          regex: '(综合计算工时|不定时工作制).{0,30}(无需审批|双方约定即生效|免审批)',
          severity: 'HIGH',
          suggestion: '补充「以劳动行政部门审批批复为准，未获批前实行标准工时制」，并留存批文。',
        },
      },
      {
        kind: 'PREFERENCE',
        title: '试用期录用条件必须书面明确并经确认',
        description: '以「不符合录用条件」解除的前提是录用条件具体、明示且经劳动者签收，避免违法解除。',
        naturalPrompt: '试用期解除依据的录用条件要书面写明并让员工签收确认',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['试用期', '录用条件'],
          regex: '试用期?.{0,20}(不符合录用条件).{0,20}(解除|辞退)',
          severity: 'MED',
          suggestion: '附件列明岗位录用条件与考核标准，入职时由劳动者签收；解除时留存考核与告知证据。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '试用期约定必须符合法定上限',
        description: '合同期 1~3 年试用期不超 2 个月、3 年以上及无固定期限不超 6 个月；超期部分违法。',
        naturalPrompt: '一年期劳动合同试用期不能超过 2 个月，三年以上及无固定期限不超过 6 个月',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['试用期'],
          regex: '试用期.{0,12}(七|八|九|十|1[0-2])\\s*个月',
          severity: 'HIGH',
          suggestion: '按合同期限重定试用期：三个月以上不满一年不超 1 个月，一年以上不满三年不超 2 个月。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '同一劳动者只能约定一次试用期',
        description: '续签合同、调岗或再次入职约定第二次试用期的，第二次试用期约定无效。',
        naturalPrompt: '续签合同或员工调岗时不能再次约定试用期',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['续签', '试用期'],
          regex: '(续签|续订|再次入职|调岗).{0,20}(约定|设置|重新).{0,6}试用期',
          severity: 'MED',
          suggestion: '续签/调岗条款删除试用期约定，岗位变化通过岗位协议与考核条款管理。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '试用期工资不得低于转正工资 80%',
        description: '试用期工资不得低于同岗位最低档工资或劳动合同约定工资的 80%，且不低于当地最低工资。',
        naturalPrompt: '试用期工资不能低于转正工资的百分之八十',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['试用期', '工资'],
          regex: '试用期?工资.{0,12}(百分之七十|70%|六成|60%)',
          severity: 'HIGH',
          suggestion: '将试用期工资调整为不低于约定转正工资的 80%，并注明不低于当地最低工资标准。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '竞业限制期限不得超过二年',
        description: '竞业限制期限约定超过 2 年的，超过部分无效。',
        naturalPrompt: '竞业限制期限最多约定两年，超过部分无效',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['竞业限制'],
          regex: '竞业限制.{0,16}(三|3|四|4|五|5)\\s*年',
          severity: 'HIGH',
          suggestion: '将竞业限制期限调整为不超过 2 年，并按岗位必要性限定适用人员范围。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '竞业限制必须按月支付经济补偿',
        description: '只约定劳动者竞业义务而不约定经济补偿，劳动者履行义务后可主张按月补偿，条款易落空。',
        naturalPrompt: '竞业限制协议不能没有经济补偿约定，应在离职后按月支付',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['竞业限制', '补偿金'],
          regex: '竞业限制.{0,40}(不支付|无需支付|放弃|不含).{0,10}(补偿金|经济补偿)',
          severity: 'HIGH',
          suggestion: '明确竞业补偿按月支付（不低于离职前 12 个月平均工资的 30% 且不低于当地最低工资）。',
        },
      },
      {
        kind: 'FORBIDDEN',
        title: '竞业违约金不得畸高于补偿与实际损失',
        description: '违约金应与补偿标准、岗位涉密程度相当；畸高违约金诉讼中会被酌减。',
        naturalPrompt: '竞业限制违约金不能约定成离职补偿的几十倍，应与补偿和损失相当',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['竞业限制', '违约金'],
          regex: '竞业限制.{0,30}违约金.{0,12}(五十|50|一百|100|二十|20)\\s*万',
          severity: 'MED',
          suggestion: '违约金建议设定为年度竞业补偿总额的 1~3 倍，并保留实际损失追偿权。',
        },
      },
      {
        kind: 'PREFERENCE',
        title: '外包 / 劳务协议不得掩盖事实劳动关系',
        description: '名为外包劳务、实为直接用工管理的，可能被认定事实劳动关系，需补缴社保与经济补偿。',
        naturalPrompt: '长期外包人员接受公司考勤和直接管理的，不能只签劳务协议规避用工责任',
        contractTypes: ['LABOR'],
        pattern: {
          keywords: ['外包', '劳动关系'],
          regex: '(外包|劳务).{0,24}(不构成|不属于|排除).{0,6}劳动关系',
          severity: 'MED',
          suggestion: '外包人员由供应商管理考勤与分派；确需直接管理的岗位应签劳动合同并缴纳社保。',
        },
      },
    ],
  },
  {
    code: 'SUPPLY_CHAIN',
    name: '供应链采购风险包',
    team: '采购与商务团队',
    ruleCount: 10,
    desc: '面向采购、供应链合同的风险规则组，覆盖账期、交付违约、验收与质量责任。',
    features: [
      '付款账期与预付款比例上限',
      '逾期交付违约金阶梯',
      '验收标准与异议期约定',
      '质量责任与追偿口径',
    ],
    live: false,
    rules: [],
  },
]

export function getPack(code: string): IndustryPack | undefined {
  return INDUSTRY_PACKS.find((p) => p.code === code)
}
