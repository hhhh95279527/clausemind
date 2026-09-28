// frontend/src/views/personal/NewReviewView.jsx
// 审合同：5 类型卡 → 粘贴/上传 → 免费约束前置（eligibility 预检）→ 跳结果页自动开审
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  CheckOutlined, InboxOutlined, SafetyCertificateOutlined, HomeOutlined,
  ClockCircleOutlined, FileTextOutlined, FileProtectOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { Spin } from 'antd'
import { useContractStore } from '@/stores/contract.js'
import { useMeStore } from '@/stores/me.js'
import { useAppStore } from '@/stores/app.js'
import { FREE_LIMITS } from '@/config/plans.js'
import Paywall from '@/components/billing/Paywall.jsx'
import { ANCHOR_TO_SCENE } from './scene.js'
import styles from './personal.module.css'

const TYPES = [
  { code: 'LABOR', icon: <SafetyCertificateOutlined />, title: '劳动合同', desc: '入职、转正、试用期、社保与竞业', deep: false },
  { code: 'LEASE', icon: <HomeOutlined />, title: '房屋租赁', desc: '租房、合租、押金与退租约定', deep: false },
  { code: 'SERVICE', icon: <ClockCircleOutlined />, title: '兼职劳务', desc: '兼职、实习、按次结算的劳务协议', deep: false },
  { code: 'NDA', icon: <FileTextOutlined />, title: '保密与 NDA', desc: '入职背调、合作前的保密协议', deep: false },
  { code: 'CUSTOM', icon: <FileProtectOutlined />, title: '非标合同', desc: '借款、合作、买卖等其他类型，需深度审查', deep: true },
]
const ACCEPT_EXT = ['.txt', '.md', '.docx', '.pdf', '.jpg', '.jpeg', '.png']
const MAX_FILE = 2 * 1024 * 1024
const MAX_TEXT = 200_000

export default function NewReviewView() {
  const navigate = useNavigate()
  const location = useLocation()
  const { entitlement, loadEntitlement } = useMeStore()
  const { uploadText, uploadFile, checkEligibility } = useContractStore()

  const [scene, setScene] = useState('LABOR')
  const [tab, setTab] = useState('paste')
  const [content, setContent] = useState('')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [paywall, setPaywall] = useState(false)

  const fileInputRef = useRef(null)

  // 锚点 → 场景（/new#scene-rent）
  useEffect(() => {
    const applyHash = () => {
      const h = location.hash.replace('#', '')
      if (ANCHOR_TO_SCENE[h]) setScene(ANCHOR_TO_SCENE[h])
    }
    applyHash()
  }, [location.hash])

  useEffect(() => { loadEntitlement() }, [])

  const deepPlan = !!entitlement?.features?.deep
  const charCount = content.length
  const overLimit = !deepPlan && charCount > FREE_LIMITS.maxChars
  const couponBalance = entitlement?.couponBalance ?? 0

  const pickScene = (code) => {
    setScene(code)
    if (code === 'CUSTOM' && !deepPlan) setPaywall(true)
  }

  const validate = () => {
    if (tab === 'paste') {
      if (!content.trim()) return '请先粘贴合同正文'
      if (charCount > MAX_TEXT) return `合同文本不能超过 ${MAX_TEXT.toLocaleString()} 字`
    } else if (!file) {
      return '请选择要上传的合同文件'
    }
    return null
  }

  /**
   * 发起流程：预检（拦截弹付费墙）→ 建档 → 跳结果页自动开审。
   * payWithCoupon=true 时走深度券通道。
   */
  const start = async (payWithCoupon = false) => {
    const errMsg = validate()
    if (errMsg) {
      useAppStore.getState().toast.warning(errMsg)
      return
    }
    setBusy(true)
    try {
      const estimateChars = tab === 'paste' ? charCount : Math.max(FREE_LIMITS.maxChars, 1)
      await checkEligibility({ charCount: estimateChars, scene, payWithCoupon })

      let contract
      const title = tab === 'paste'
        ? content.trim().split('\n')[0].slice(0, 24) || '文本合同'
        : file.name.replace(/\.[^.]+$/, '')
      if (tab === 'paste') {
        contract = await uploadText({ title, content, scene })
      } else {
        contract = await uploadFile(file, title, scene)
      }
      navigate(`/review/${contract.id}?start=1${payWithCoupon ? '&coupon=1' : ''}`)
    } catch (e) {
      if (e.response?.status === 403 && e.response?.data?.error?.code === 'PLAN_LIMIT') {
        setPaywall(true)
      }
      // 其余错误已由 axios 拦截器 toast
    } finally {
      setBusy(false)
    }
  }

  const onFile = (f) => {
    if (!f) return
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
    if (!ACCEPT_EXT.includes(ext)) {
      useAppStore.getState().toast.warning('仅支持 txt / md / docx / pdf / jpg / png 文件')
      return
    }
    if (f.size > MAX_FILE) {
      useAppStore.getState().toast.warning('单文件不能超过 2MB')
      return
    }
    setFile(f)
  }

  const primaryText = useMemo(() => {
    if (busy) return '正在创建…'
    return deepPlan ? '开始深度审查' : '开始免费审查'
  }, [busy, deepPlan])

  return (
    <div className={styles.wrap}>
      {/* ① 选择合同类型 */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h3>① 选择合同类型</h3>
          {!deepPlan && <span className={`${styles.small} ${styles.muted}`}>免费支持前四类</span>}
        </div>
        <div className={styles.panelBody}>
          <div className={styles.types}>
            {TYPES.map((t) => (
              <button
                key={t.code}
                type="button"
                className={`${styles.typeCard} ${scene === t.code ? styles.typeCardActive : ''}`}
                onClick={() => pickScene(t.code)}
              >
                {scene === t.code && <CheckOutlined className={styles.typeCheck} />}
                <span className={`${styles.typeIc} ${t.deep ? styles.typeIcGray : ''}`}>{t.icon}</span>
                <b>
                  {t.title}
                  {t.deep && <span className={`${styles.tag} ${styles.tagGray}`}>深度权益</span>}
                </b>
                <span className={styles.typeDesc}>{t.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ② 合同内容 */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h3>② 合同内容</h3>
          <span className={styles.segmented}>
            <button className={`${styles.segItem} ${tab === 'paste' ? styles.segItemActive : ''}`} onClick={() => setTab('paste')}>粘贴文本</button>
            <button className={`${styles.segItem} ${tab === 'upload' ? styles.segItemActive : ''}`} onClick={() => setTab('upload')}>上传文档</button>
          </span>
        </div>
        <div className={styles.panelBody}>
          {tab === 'paste' ? (
            <div>
              <textarea
                className={styles.textarea}
                rows={12}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={'把合同正文粘贴到这里…\n免费版每份不超过 3000 字，长文档可使用深度审查券（¥9.9/份）或开通个人版。'}
              />
              {!overLimit ? (
                <span className={styles.charCount}>
                  {charCount.toLocaleString()} / {FREE_LIMITS.maxChars.toLocaleString()} 字（{deepPlan ? '不限字数' : '免费额度'}）
                </span>
              ) : (
                <span className={`${styles.charCount} ${styles.charOver}`}>
                  {charCount.toLocaleString()} / {FREE_LIMITS.maxChars.toLocaleString()} 字，超出 {(charCount - FREE_LIMITS.maxChars).toLocaleString()} 字
                </span>
              )}
            </div>
          ) : (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT_EXT.join(',')}
                style={{ display: 'none' }}
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <div className={styles.dropzone} onClick={() => fileInputRef.current?.click()}>
                <div className={styles.dropzoneIc}><InboxOutlined style={{ fontSize: 26 }} /></div>
                <b style={{ color: 'var(--color-text)', fontSize: 14.5 }}>
                  {file ? file.name : '点击或拖拽文件到这里'}
                </b>
                <div className={styles.small} style={{ marginTop: 6 }}>支持 txt / md / docx / pdf / jpg / png，单文件 ≤ 2MB</div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 额度提示 */}
      {!overLimit ? (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          <ExclamationCircleOutlined style={{ flex: 'none', marginTop: 3 }} />
          <div>
            免费版：每月 2 份、每份 3000 字以内，仅支持劳动 / 租赁 / 劳务 / NDA 四类；
            <b>长文档与非标合同请使用深度审查券（¥9.9/份）或开通个人版</b>。
          </div>
        </div>
      ) : (
        <div className={`${styles.banner} ${styles.bannerDanger}`}>
          <ExclamationCircleOutlined style={{ flex: 'none', marginTop: 3 }} />
          <div>
            <b>文档 {charCount.toLocaleString()} 字，超出免费 3000 字额度。</b>
            使用 1 张深度审查券（¥9.9）即可解锁完整深度审查，或开通个人版不限字数。
          </div>
        </div>
      )}

      {/* 操作行 */}
      <div className={styles.newActions}>
        <button className={`btn btn-primary ${styles.btnLg}`} disabled={busy} onClick={() => start(false)}>
          {busy && <Spin size="small" style={{ marginRight: 8 }} />}
          {primaryText}
        </button>
        {!deepPlan && (
          <a className={styles.btnText} style={{ fontSize: 13.5 }} onClick={() => start(true)}>
            我有深度审查券，审查长文档
          </a>
        )}
        <span className={`${styles.small} ${styles.muted}`} style={{ marginLeft: 'auto' }}>
          免费版可查看：风险点 · 大白话摘要 · 风险评分
        </span>
      </div>

      <Paywall
        open={paywall}
        onClose={() => setPaywall(false)}
        couponBalance={couponBalance}
        onUseCoupon={() => start(true)}
      />
    </div>
  )
}
