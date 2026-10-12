// 组装本 frame 的快照，并刷新 ref 注册表。
import { allElements, classOf, clean, cut, docOrder, isVisible, textOf } from '../dom'
import { collect } from './collect'
import { describe } from './describe'
import { bindRef, hasRef, refFor, register, registry, setRelocator } from '../registry'
import type { ButtonNode, FieldNode, FrameSnapshot } from '../../shared/types'

const HEAD_CLASS_RE = /(^|[\s_-])(title|header|heading|caption|subtitle|legend|step-title|module-name|block-name)([\s_-]|$)/i

function headings(fieldAnchors: Element[]): { el: Element; text: string }[] {
  const out: { el: Element; text: string }[] = []
  for (const el of allElements()) {
    const tag = el.tagName
    const tagged = /^H[1-6]$/.test(tag) || tag === 'LEGEND' || el.getAttribute('role') === 'heading'
    const classed = HEAD_CLASS_RE.test(classOf(el))
    let styled = false
    if (!tagged && !classed) {
      if (el.childElementCount > 3) continue
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim())
      if (!own) continue
      const st = getComputedStyle(el)
      styled = parseFloat(st.fontSize) >= 15.5 && (parseInt(st.fontWeight) >= 500 || st.fontWeight === 'bold')
      if (!styled) continue
    }
    if (el.querySelector('input,select,textarea,button')) continue
    if (el.closest('label')) continue
    if (fieldAnchors.some((a) => a.contains(el))) continue
    const text = textOf(el, [], 40)
    if (!text || text.length > 24 || /[*＊]/.test(text)) continue
    if (!isVisible(el)) continue
    if (out.some((h) => h.el.contains(el))) {
      // 外层已经是标题时保留内层更精确的文本
      const i = out.findIndex((h) => h.el.contains(el))
      out[i] = { el, text }
      continue
    }
    out.push({ el, text })
  }
  return out
}

/** 不随标签文字变化的特征：分区 + 种类 + 第一次看到的占位文字 + name/id + 长度上限。没有占位文字也没有 name 的不生成 */
function altSig(f: { inputs: Element[] }, d: { hint: string; placeholder?: string; constraints?: { maxLength?: number } }, section?: string) {
  const i = f.inputs[0] as HTMLInputElement | undefined
  const ph = i?.dataset?.aaPh || d.placeholder || ''
  const nm = i?.getAttribute?.('name') || i?.id || ''
  if (!ph && !nm) return undefined
  return `${section ?? ''}|${d.hint}|${ph}|${nm}|${d.constraints?.maxLength ?? ''}`
}

let lastFrameId = 0
setRelocator(() => takeSnapshot(lastFrameId))

export function takeSnapshot(frameId: number): FrameSnapshot {
  lastFrameId = frameId
  const { fields, buttons } = collect()
  const anchors = fields.map((f) => f.anchor)
  const heads = headings(anchors).sort((a, b) => docOrder(a.el, b.el))
  const sectionOf = (el: Element) => {
    let best: string | undefined
    for (const h of heads) {
      if (docOrder(h.el, el) < 0) best = h.text
      else break
    }
    return best
  }
  // 字段与按钮统一按文档顺序编号，便于序列化时把"添加"按钮放在正确位置
  const all = [...fields.map((f) => f.anchor), ...buttons.map((b) => b.el)].sort(docOrder)
  const orderOf = new Map(all.map((el, i) => [el, i]))
  const ordered = [...fields].sort((a, b) => docOrder(a.anchor, b.anchor))
  // 失效（元素已脱离文档）的旧 ref，按签名索引，供重新渲染出来的同一字段复用
  const stale = new Map<string, string>()
  // 备用签名 → 失效的旧 ref（同一个备用签名对应多个旧 ref 时不用，避免认错）
  const staleAlt = new Map<string, string | null>()
  for (const [ref, e] of registry) {
    if (!(e.kind === 'field' || e.kind === 'button') || e.anchor.isConnected) continue
    if (e.sig && !stale.has(e.sig)) stale.set(e.sig, ref)
    if (e.alt) staleAlt.set(e.alt, staleAlt.has(e.alt) ? null : ref)
  }
  const claimed = new Set<string>()
  const described = ordered.map((f) => {
    const d = describe(f, ordered)
    const section = sectionOf(f.anchor)
    // 文本域右下角的字数计数（"136 / 2000"）不是标签：用分区标题代替
    if (section && /^\s*\d+\s*\/\s*\d+\s*$/.test(d.label)) d.label = section
    return { f, d, section, alt: altSig(f, d, section) }
  })
  const altCount = new Map<string, number>()
  for (const x of described) if (x.alt) altCount.set(x.alt, (altCount.get(x.alt) ?? 0) + 1)
  const nth = new Map<string, number>()
  const nodes: FieldNode[] = described.map(({ f, d, section, alt }) => {
    const i = orderOf.get(f.anchor)!
    const base = `${section ?? ''}|${d.label}|${d.hint}`
    const k = nth.get(base) ?? 0
    nth.set(base, k + 1)
    const sig = `${base}|${k}`
    if (!hasRef(f.anchor)) {
      const old = stale.get(sig)
      const byAlt = alt && altCount.get(alt) === 1 ? staleAlt.get(alt) : null
      const pick = old && !claimed.has(old) ? old : byAlt && !claimed.has(byAlt) ? byAlt : undefined
      if (pick) { bindRef(f.anchor, pick); claimed.add(pick) }
    }
    const ref = refFor(f.anchor)
    register({ ref, kind: 'field', anchor: f.anchor, inputs: f.inputs, hint: d.hint, options: f.options, label: d.label, sig, alt })
    return { ref, order: i, section, ...d }
  })

  // 按钮同样按"分区+文字+序号"签名复用旧 ref：上传简历/加块后页面重新渲染，计划里的按钮 ref 仍然有效
  const bnth = new Map<string, number>()
  const btns: ButtonNode[] = [...buttons]
    .sort((a, b) => docOrder(a.el, b.el))
    .map((b) => {
      const i = orderOf.get(b.el)!
      const section = sectionOf(b.el)
      const text = cut(clean(b.text), 24)
      const base = `btn|${section ?? ''}|${text}`
      const k = bnth.get(base) ?? 0
      bnth.set(base, k + 1)
      const sig = `${base}|${k}`
      if (!hasRef(b.el) && stale.has(sig)) bindRef(b.el, stale.get(sig)!)
      const ref = refFor(b.el)
      register({ ref, kind: 'button', anchor: b.el, inputs: [], hint: 'unknown', label: b.text, sig })
      return { ref, text, section, order: i }
    })

  // 页面主标题：第一个 h1 或 document.title
  const h1 = document.querySelector('h1')
  return {
    frameId,
    url: location.href,
    title: document.title,
    heading: h1 ? textOf(h1, [], 60) : undefined,
    fields: nodes,
    buttons: btns,
  }
}
