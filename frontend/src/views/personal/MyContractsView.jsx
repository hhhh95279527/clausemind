// frontend/src/views/personal/MyContractsView.jsx
// 我的合同：审查历史 / 个人条款库 / 我的关注（偏好存 users.metadata）
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LockOutlined, PlusOutlined, DeleteOutlined, CreditCardOutlined,
  BankOutlined, FileProtectOutlined, DisconnectOutlined, ToolOutlined,
} from '@ant-design/icons'
import { Modal, Form, Input, Select, Spin } from 'antd'
import { useContractStore } from '@/stores/contract.js'
import { useMeStore, FOLLOW_RISK_OPTIONS } from '@/stores/me.js'
import { useAppStore } from '@/stores/app.js'
import Paywall from '@/components/billing/Paywall.jsx'
import { SCENE_LABELS, sceneLabel, fmtDate, daysUntil, riskCountOf } from './scene.js'
import styles from './personal.module.css'

const TABS = [
  { key: 'history', label: '审查历史' },
  { key: 'clauses', label: '个人条款库' },
  { key: 'follow', label: '我的关注' },
]

export default function MyContractsView() {
  const navigate = useNavigate()
  const toast = useAppStore((s) => s.toast)
  const { contracts, loadContracts } = useContractStore()
  const {
    entitlement, loadEntitlement,
    preferences, clauseLibrary, loadPreferences, savePreferences, addClause, removeClause,
  } = useMeStore()

  const [tab, setTab] = useState('history')
  const [paywall, setPaywall] = useState(false)
  const [lockedContractId, setLockedContractId] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [form] = Form.useForm()
  const [savingPref, setSavingPref] = useState(false)

  // 关注偏好本地草稿（保存才落库）
  const [followRisks, setFollowRisks] = useState([])
  const [tone, setTone] = useState('RIGOROUS')
  const [stance, setStance] = useState('LESSEE')

  useEffect(() => {
    loadEntitlement()
    loadContracts()
    loadPreferences()
  }, [])

  useEffect(() => {
    if (preferences) {
      setFollowRisks(preferences.followRisks || [])
      setTone(preferences.tone || 'RIGOROUS')
      setStance(preferences.stance || 'LESSEE')
    }
  }, [preferences])

  const deep = !!entitlement?.features?.deep
  const couponBalance = entitlement?.couponBalance ?? 0

  const toggleFollow = (name) => {
    setFollowRisks((arr) => (arr.includes(name) ? arr.filter((x) => x !== name) : [...arr, name]))
  }

  const doSavePrefs = async () => {
    setSavingPref(true)
    try {
      await savePreferences({ followRisks, tone, stance })
      toast.success('偏好已保存')
    } finally {
      setSavingPref(false)
    }
  }

  const doAddClause = async () => {
    const v = await form.validateFields()
    try {
      await addClause({ title: v.title, content: v.content, scene: v.scene })
      toast.success('已收藏到个人条款库')
      setAddOpen(false)
      form.resetFields()
    } catch (e) {
      if (e.response?.status === 403 && e.response?.data?.error?.code === 'PLAN_LIMIT') {
        setAddOpen(false)
        setPaywall(true)
      }
    }
  }

  const renderHistory = () => (
    <div>
      <table className={styles.tbl}>
        <thead>
          <tr><th>合同名</th><th>类型</th><th>风险数</th><th>审查日期</th><th>存档状态</th><th style={{ textAlign: 'right' }}>操作</th></tr>
        </thead>
        <tbody>
          {contracts.map((c) => {
            const n = riskCountOf(c)
            const left = daysUntil(c.retainUntil)
            const itemDeep = !!(c.review?.isDeep || deep)
            return (
              <tr key={c.id}>
                <td>
                  <a style={{ fontWeight: 600, cursor: 'pointer' }} onClick={() => navigate(`/review/${c.id}`)}>{c.title}</a>
                  <div className={styles.cellSub}>{(c.charCount || 0).toLocaleString()} 字</div>
                </td>
                <td><span className={`${styles.tag} ${styles.tagBlue}`}>{sceneLabel(c.scene)}</span></td>
                <td>
                  {c.review
                    ? <span className={`${styles.tag} ${n === 0 ? styles.tagGreen : styles.tagOrange}`}>{n} 条</span>
                    : <span className={`${styles.tag} ${styles.tagGray}`}>未审查</span>}
                </td>
                <td>{fmtDate(c.createdAt)}</td>
                <td>
                  {c.retainUntil
                    ? <span className={`${styles.tag} ${styles.tagOrange}`}>{left} 天后清除</span>
                    : <span className={`${styles.tag} ${styles.tagGreen}`}>永久存档</span>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className={styles.rowActions} style={{ justifyContent: 'flex-end' }}>
                    <a className={styles.btnText} onClick={() => navigate(`/review/${c.id}`)}>查看</a>
                    {itemDeep ? (
                      <a className={styles.btnText} onClick={() => navigate(`/draft/${c.id}`)}>继续改稿</a>
                    ) : (
                      <a className={styles.btnText} style={{ color: 'var(--color-text-muted)' }}
                         onClick={() => { setLockedContractId(c.id); setPaywall(true) }}>
                        <LockOutlined style={{ verticalAlign: -2, marginRight: 2 }} />继续改稿
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
          {contracts.length === 0 && (
            <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>还没有审查记录，去审一份合同吧</td></tr>
          )}
        </tbody>
      </table>
      <div className={styles.panelBody} style={{ borderTop: '1px solid var(--color-border-light)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className={`${styles.small} ${styles.muted}`}>
          免费版记录仅保留 7 天，到期自动清除；个人版不限份数、永久存档。
        </span>
        {!deep && <a className={styles.small} style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => navigate('/me/billing')}>升级个人版 →</a>}
      </div>
    </div>
  )

  const clauseIcons = {
    LEASE: <BankOutlined />, NDA: <FileProtectOutlined />,
    CUSTOM: <DisconnectOutlined />, LABOR: <CreditCardOutlined />, SERVICE: <ToolOutlined />,
  }

  const renderClauses = () => (
    <div className={styles.panelBody}>
      <div className={styles.clGrid}>
        {clauseLibrary.map((c) => (
          <div key={c.id} className={styles.clCard}>
            <div className={styles.clTop}>
              <span className={styles.clIc}>{clauseIcons[c.scene] || <FileProtectOutlined />}</span>
              <b style={{ fontSize: 14 }}>{c.title}</b>
            </div>
            <p>{c.content}</p>
            <div className={styles.clFoot}>
              <span className={`${styles.tag} ${styles.tagBlue}`}>{SCENE_LABELS[c.scene] || '非标合同'}</span>
              <a className={styles.btnText} style={{ marginLeft: 'auto' }} onClick={() => removeClause(c.id)}>
                <DeleteOutlined /> 删除
              </a>
            </div>
          </div>
        ))}
        {clauseLibrary.length === 0 && (
          <div className={`${styles.small} ${styles.muted}`} style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '20px 0' }}>
            还没有收藏条款，可在审查结果中把常用条款收藏到这里
          </div>
        )}
      </div>
      <button className={styles.clAdd} onClick={() => setAddOpen(true)}>
        <PlusOutlined /> 从审查结果中收藏条款
      </button>
      <div className={`${styles.small} ${styles.muted}`} style={{ marginTop: 10 }}>
        个人版可无限收藏条款，并在 AI 改稿时一键插入；免费版最多收藏 3 条。
      </div>
    </div>
  )

  const renderFollow = () => (
    <div className={styles.panelBody} style={{ padding: '20px 22px' }}>
      <div className={styles.prefTitle} style={{ marginTop: 0 }}>关注的风险项（命中后在报告中置顶提醒）</div>
      <div className={styles.switches}>
        {FOLLOW_RISK_OPTIONS.map((name) => {
          const on = followRisks.includes(name)
          return (
            <label key={name} className={`${styles.switch} ${on ? styles.switchOn : ''}`} onClick={() => toggleFollow(name)}>
              <span className={styles.track} />
              {name}
            </label>
          )
        })}
      </div>

      <div className={styles.prefTitle}>审查偏好</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--color-text-sub)', marginBottom: 8 }}>语气风格</label>
          <div className={styles.radios}>
            <span className={`${styles.radio} ${tone === 'RIGOROUS' ? styles.radioOn : ''}`} onClick={() => setTone('RIGOROUS')}>
              <span className={styles.dot} />严谨（法条原文）
            </span>
            <span className={`${styles.radio} ${tone === 'PLAIN' ? styles.radioOn : ''}`} onClick={() => setTone('PLAIN')}>
              <span className={styles.dot} />通俗（大白话）
            </span>
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--color-text-sub)', marginBottom: 8 }}>优先立场</label>
          <div className={styles.radios}>
            <span className={`${styles.radio} ${stance === 'LESSEE' ? styles.radioOn : ''}`} onClick={() => setStance('LESSEE')}>
              <span className={styles.dot} />承租方
            </span>
            <span className={`${styles.radio} ${stance === 'LESSOR' ? styles.radioOn : ''}`} onClick={() => setStance('LESSOR')}>
              <span className={styles.dot} />出租方
            </span>
          </div>
        </div>
      </div>

      <div className={styles.formActions}>
        <button className="btn btn-primary" disabled={savingPref} onClick={doSavePrefs}>保存偏好</button>
      </div>
    </div>
  )

  return (
    <div className={styles.wrap}>
      <div className={styles.panel}>
        <div className={styles.panelHead}>
          <h3>合同管理</h3>
          <span className={styles.segmented}>
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`${styles.segItem} ${tab === t.key ? styles.segItemActive : ''}`}
                onClick={() => setTab(t.key)}
              >{t.label}</button>
            ))}
          </span>
        </div>
        {!preferences && (tab === 'clauses' || tab === 'follow') ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : (
          <>
            {tab === 'history' && renderHistory()}
            {tab === 'clauses' && renderClauses()}
            {tab === 'follow' && renderFollow()}
          </>
        )}
      </div>

      {tab === 'history' && (
        <div className={`${styles.banner} ${styles.bannerInfo}`} style={{ alignItems: 'center' }}>
          <CreditCardOutlined style={{ flex: 'none' }} />
          <div>
            深度券按份解锁长文档与非标合同（¥9.9/份）；个人版 ¥19/月、¥99/年全部解锁。
            <a style={{ marginLeft: 6, cursor: 'pointer' }} onClick={() => navigate('/me/billing')}>查看我的订阅 →</a>
          </div>
        </div>
      )}

      <Modal
        open={addOpen}
        title="收藏条款到个人条款库"
        onCancel={() => setAddOpen(false)}
        onOk={doAddClause}
        okText="收藏"
        cancelText="取消"
        transitionName=""
        maskTransitionName=""
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }} initialValues={{ scene: 'CUSTOM' }}>
          <Form.Item name="title" label="条款标题" rules={[{ required: true, message: '请输入条款标题' }]}>
            <Input maxLength={100} placeholder="如：押金退还条款" />
          </Form.Item>
          <Form.Item name="content" label="条款内容" rules={[{ required: true, message: '请输入条款内容' }]}>
            <Input.TextArea rows={4} maxLength={2000} showCount placeholder="把你认可的条款文本粘贴进来" />
          </Form.Item>
          <Form.Item name="scene" label="适用场景">
            <Select
              options={Object.entries(SCENE_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Paywall
        open={paywall}
        onClose={() => setPaywall(false)}
        couponBalance={couponBalance}
        description="AI 改稿、长文档与非标合同审查属于深度权益。"
        onUseCoupon={() => {
          if (!lockedContractId) return
          // 去该份报告用券重跑深度审查，解锁后即可继续改稿
          navigate(`/review/${lockedContractId}?start=1&coupon=1`)
          setPaywall(false)
        }}
      />
    </div>
  )
}
