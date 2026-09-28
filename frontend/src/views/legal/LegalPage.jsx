// frontend/src/views/legal/LegalPage.jsx
// 合规静态页通用渲染：隐私政策 / 用户协议；内容来自 legalContent.js（原型确认文案）
import { Link } from 'react-router-dom'
import { SafetyOutlined } from '@ant-design/icons'
import styles from './LegalPage.module.css'

// 极简富文本（仅 <b> 标签，原型文案范围内安全）
function Rich({ html }) {
  // 文案来自本地静态 legalContent.js，无外部输入；按 <b> 切分渲染
  const parts = html.split(/(<b>[\s\S]*?<\/b>)/g)
  return (
    <>
      {parts.map((seg, i) => {
        const m = /^<b>([\s\S]*?)<\/b>$/.exec(seg)
        return m ? <b key={i}>{m[1]}</b> : <span key={i}>{seg}</span>
      })}
    </>
  )
}

export default function LegalPage({ content }) {
  return (
    <div className={styles.wrap}>
      <nav className={styles.topnav}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandMark}><SafetyOutlined /></span>
          WorkMind
        </Link>
        <div className={styles.navLinks}>
          <Link to="/#abilities">产品能力</Link>
          <Link to="/pricing">定价</Link>
        </div>
        <div className={styles.navActions}>
          <Link className={styles.btnGhost} to="/login">登录</Link>
          <Link className={styles.btnPrimary} to="/register">免费注册</Link>
        </div>
      </nav>

      <article className={styles.doc}>
        <h1>{content.title}</h1>
        <p className={styles.meta}>{content.meta}</p>
        <p>{content.intro}</p>

        <div className={styles.callout}>
          <b>{content.callout.title}</b>
          <span>{content.callout.body}</span>
        </div>

        {content.sections.map((sec) => (
          <section key={sec.h}>
            <h2>{sec.h}</h2>
            {sec.paragraphs?.map((p, i) => <p key={i}><Rich html={p} /></p>)}
            {sec.items && (
              <ul>
                {sec.items.map((it, i) => (
                  <li key={i}><Rich html={it} /></li>
                ))}
              </ul>
            )}
            {sec.ordered && (
              <ol>
                {sec.ordered.map((it, i) => (
                  <li key={i}><Rich html={it} /></li>
                ))}
              </ol>
            )}
            {sec.after && <p><Rich html={sec.after} /></p>}
          </section>
        ))}
      </article>

      <footer className={styles.footer}>
        <p>
          <Link to="/">产品</Link> / <Link to="/pricing">定价</Link> /
          <Link to="/privacy">隐私政策</Link> / <Link to="/terms">用户协议</Link>
        </p>
        <p>AI 仅做风险提示，不构成法律意见，重大合同建议咨询执业律师</p>
      </footer>
    </div>
  )
}
