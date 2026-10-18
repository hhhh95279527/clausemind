// frontend/src/components/assistant/RobotModel.jsx
// 程序化低多边形 3D 机器人「小律」：零外部模型资源，动画全部 useFrame 驱动
// 待机悬浮 / 随机眨眼 / 眼睛头部跟随全局鼠标 / 点击挥手 / 思考态（天线脉冲 + 低头）
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import * as THREE from 'three'

const BODY_COLOR = '#5b8cff'
const BODY_DARK = '#3f6ae0'
const INK = '#141b33'

export default function RobotModel({ running = false, gazeRef, waveRef }) {
  const root = useRef()
  const head = useRef()
  const eyeL = useRef()
  const eyeR = useRef()
  const antennaLight = useRef()
  const armR = useRef()
  const shadow = useRef()
  // 动画状态机：下一次眨眼时间 / 眨眼进度 / 挥手进度 / 已消费的挥手信号
  const st = useRef({ nextBlink: 1.6, blinkT: -1, waveT: -1, waveStamp: 0 })

  useFrame((s, delta) => {
    const t = s.clock.elapsedTime
    const cur = st.current
    // 全局鼠标视线：gazeRef.current = { x, y }，均归一化到 [-1,1]（右上 = x>0,y<0）
    const gz = gazeRef?.current || { x: 0, y: 0 }
    // 外部挥手信号（DOM 点击触发，比射线拾取稳定）：tick 变化即挥手一次
    if (waveRef?.current && waveRef.current !== cur.waveStamp) {
      cur.waveStamp = waveRef.current
      cur.waveT = 0
    }

    // 待机悬浮 + 轻微侧倾；思考时浮动加快
    if (root.current) {
      const freq = running ? 3.2 : 1.6
      root.current.position.y = Math.sin(t * freq) * (running ? 0.05 : 0.07)
      root.current.rotation.z = Math.sin(t * 1.1) * 0.02
    }
    // 柔影随高度伸缩
    if (shadow.current) {
      shadow.current.material.opacity = 0.32 - Math.sin(t * 1.6) * 0.08
      const sc = 1 - Math.sin(t * 1.6) * 0.06
      shadow.current.scale.set(sc, sc, 1)
    }
    // 眨眼：触发后 160ms 内 scaleY 压缩再弹回
    if (cur.blinkT >= 0) {
      cur.blinkT += delta
      const p = Math.min(cur.blinkT / 0.16, 1)
      const sy = 1 - Math.sin(p * Math.PI) * 0.92
      if (eyeL.current) eyeL.current.scale.y = sy
      if (eyeR.current) eyeR.current.scale.y = sy
      if (p >= 1) {
        cur.blinkT = -1
        cur.nextBlink = t + 2.4 + Math.random() * 2.8
      }
    } else if (t > cur.nextBlink) {
      cur.blinkT = 0
    }
    // 头部与眼球跟随鼠标（lerp 平滑）：鼠标右上 → 头右转、眼球移向右上
    if (head.current) {
      head.current.rotation.y = THREE.MathUtils.lerp(head.current.rotation.y, gz.x * 0.5, 0.1)
      head.current.rotation.x = THREE.MathUtils.lerp(
        head.current.rotation.x,
        gz.y * 0.32 + (running ? 0.18 : 0),
        0.1,
      )
    }
    if (eyeL.current && eyeR.current) {
      const ex = gz.x * 0.075
      const ey = gz.y * 0.05
      eyeL.current.position.x = -0.2 + ex
      eyeR.current.position.x = 0.2 + ex
      eyeL.current.position.y = ey
      eyeR.current.position.y = ey
    }
    // 天线灯：待机呼吸，思考时快速脉冲
    if (antennaLight.current) {
      antennaLight.current.material.emissiveIntensity = running
        ? 2.4 + Math.sin(t * 7) * 1.4
        : 1.1 + Math.sin(t * 2) * 0.35
    }
    // 右臂挥手：触发后 1.1s 内衰减摆动；平时小幅摇摆
    if (armR.current) {
      if (cur.waveT >= 0) {
        cur.waveT += delta
        const p = Math.min(cur.waveT / 1.1, 1)
        armR.current.rotation.z = 0.3 + Math.sin(p * Math.PI * 3) * 0.8 * (1 - p * 0.55)
        if (p >= 1) {
          cur.waveT = -1
          armR.current.rotation.z = 0.3
        }
      } else {
        armR.current.rotation.z = 0.3 + Math.sin(t * 1.4) * 0.07
      }
    }
  })

  return (
    <group ref={root}>
      {/* 柔影 */}
      <mesh ref={shadow} position={[0, -1.08, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.52, 32]} />
        <meshBasicMaterial color="#1c2440" transparent opacity={0.3} />
      </mesh>

      {/* 身体 */}
      <group position={[0, -0.38, 0]}>
        <mesh>
          <capsuleGeometry args={[0.33, 0.3, 8, 20]} />
          <meshStandardMaterial color={BODY_COLOR} roughness={0.35} metalness={0.15} />
        </mesh>
        {/* 胸口指示灯 */}
        <mesh position={[0, 0.08, 0.32]}>
          <circleGeometry args={[0.09, 24]} />
          <meshStandardMaterial color="#eaf6ff" emissive="#7fd4ff" emissiveIntensity={1.2} />
        </mesh>
        {/* 左臂 */}
        <group position={[-0.46, 0.08, 0]} rotation={[0, 0, -0.3]}>
          <mesh position={[0, -0.2, 0]}>
            <capsuleGeometry args={[0.085, 0.24, 6, 14]} />
            <meshStandardMaterial color={BODY_DARK} roughness={0.4} metalness={0.1} />
          </mesh>
        </group>
        {/* 右臂（挥手用） */}
        <group ref={armR} position={[0.46, 0.08, 0]} rotation={[0, 0, 0.3]}>
          <mesh position={[0, -0.2, 0]}>
            <capsuleGeometry args={[0.085, 0.24, 6, 14]} />
            <meshStandardMaterial color={BODY_DARK} roughness={0.4} metalness={0.1} />
          </mesh>
        </group>
      </group>

      {/* 头 */}
      <group ref={head} position={[0, 0.42, 0]}>
        <RoundedBox args={[1.15, 0.85, 0.95]} radius={0.26} smoothness={8}>
          <meshStandardMaterial color={BODY_COLOR} roughness={0.32} metalness={0.18} />
        </RoundedBox>
        {/* 面罩屏幕 */}
        <RoundedBox args={[0.88, 0.52, 0.12]} radius={0.16} position={[0, -0.02, 0.44]}>
          <meshStandardMaterial color={INK} roughness={0.18} metalness={0.35} />
        </RoundedBox>
        {/* 眼睛（眨眼用 scaleY） */}
        <mesh ref={eyeL} position={[-0.2, 0, 0.52]}>
          <sphereGeometry args={[0.088, 20, 20]} />
          <meshStandardMaterial color="#eaf6ff" emissive="#7fd4ff" emissiveIntensity={0.95} />
        </mesh>
        <mesh ref={eyeR} position={[0.2, 0, 0.52]}>
          <sphereGeometry args={[0.088, 20, 20]} />
          <meshStandardMaterial color="#eaf6ff" emissive="#7fd4ff" emissiveIntensity={0.95} />
        </mesh>
        {/* 天线 + 呼吸灯 */}
        <mesh position={[0, 0.55, 0]}>
          <cylinderGeometry args={[0.028, 0.028, 0.28, 10]} />
          <meshStandardMaterial color={INK} roughness={0.4} />
        </mesh>
        <mesh ref={antennaLight} position={[0, 0.74, 0]}>
          <sphereGeometry args={[0.075, 20, 20]} />
          <meshStandardMaterial color="#ffd166" emissive="#ffb020" emissiveIntensity={1.1} />
        </mesh>
        {/* 两侧「耳朵」 */}
        <mesh position={[-0.63, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.1, 0.1, 0.12, 18]} />
          <meshStandardMaterial color="#e8eefc" roughness={0.4} />
        </mesh>
        <mesh position={[0.63, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.1, 0.1, 0.12, 18]} />
          <meshStandardMaterial color="#e8eefc" roughness={0.4} />
        </mesh>
      </group>
    </group>
  )
}
