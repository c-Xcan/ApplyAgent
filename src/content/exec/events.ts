// 输入通道：DOM 合成事件（默认）与 CDP 真实输入（升级）。
import { sleep } from '../dom'
import { hotspot } from './prof'

export const execState = { trusted: 'auto' as 'auto' | 'off' | 'always' }

/** 用原型上的 setter 赋值，绕过 React/Vue 对实例 value 的拦截 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

export function fire(el: Element, type: string, init: EventInit = {}) {
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true, ...init }))
}

function center(el: Element) {
  const r = el.getBoundingClientRect()
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
}

export function scrollIntoView(el: Element) {
  try {
    ;(el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' })
  } catch {}
}

// 用定时器而不是 requestAnimationFrame：页面在后台标签页时 rAF 会被暂停
const frame = () => sleep(16)

/** 滚动到控件后，等页面安静下来：滚动停了、页面 quiet 毫秒内没有新变化（例如侧边导航跟着滚动换高亮）。
 *  没发生滚动就只等两帧。最多等 maxMs。这样打开下拉时，页面上不会还有别的东西在变，不会把它误当成弹出的面板 */
export async function settleAfterScroll(maxMs = 300, quiet = 50) {
  const t0 = performance.now()
  let last = t0
  let scrolled = false
  const bump = () => { last = performance.now() }
  const onScroll = () => { scrolled = true; bump() }
  const mo = new MutationObserver(bump)
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  document.addEventListener('scroll', onScroll, true)
  try {
    await frame()
    await frame()
    if (!scrolled) return
    while (performance.now() - t0 < maxMs && performance.now() - last < quiet) await frame()
  } finally {
    mo.disconnect()
    document.removeEventListener('scroll', onScroll, true)
  }
}

/** 完整的指针点击序列（合成） */
/** 合成点击后等页面响应：一有 DOM 变化、且安静 quiet 毫秒就返回，最多等 maxMs（代替点击后固定 sleep） */
export async function clickSettle(el: Element, maxMs = 200, quiet = 30) {
  let last = 0
  let any = false
  const mo = new MutationObserver(() => { any = true; last = performance.now() })
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  synthClick(el)
  const t0 = performance.now()
  while (performance.now() - t0 < maxMs) {
    await sleep(15)
    if (any && performance.now() - last >= quiet) break
  }
  mo.disconnect()
}

export function synthClick(el: Element) {
  const c = center(el)
  const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...c }
  el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerType: 'mouse' }))
  el.dispatchEvent(new MouseEvent('mouseover', base))
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerType: 'mouse', buttons: 1 }))
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
  if (el instanceof HTMLElement) el.focus?.({ preventScroll: true })
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerType: 'mouse' }))
  el.dispatchEvent(new MouseEvent('mouseup', base))
  el.dispatchEvent(new MouseEvent('click', base))
}

export function synthKey(el: Element, key: string, extra: KeyboardEventInit = {}) {
  const code = key.length === 1 ? 'Key' + key.toUpperCase() : key
  const keyCode = ({ Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9, Backspace: 8 } as Record<string, number>)[key] ?? 0
  const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, ...extra }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  el.dispatchEvent(new KeyboardEvent('keypress', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

/** 合成地"输入"一段文本：赋值 + input/compositionend 事件 */
export function synthType(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  el.focus({ preventScroll: true })
  setNativeValue(el, text)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
  el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }))
}

// ---------- CDP 真实输入（由 background 通过 chrome.debugger 执行） ----------

function frameOffset(): { x: number; y: number } {
  let x = 0
  let y = 0
  let w: Window = window
  try {
    while (w !== w.top && w.frameElement) {
      const r = w.frameElement.getBoundingClientRect()
      x += r.left + (w.frameElement as HTMLElement).clientLeft
      y += r.top + (w.frameElement as HTMLElement).clientTop
      w = w.parent
    }
  } catch {}
  return { x, y }
}

async function cdp(msg: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await chrome.runtime.sendMessage({ t: 'cdp', ...msg })
    return !!r?.ok
  } catch {
    return false
  }
}

export function trustedClick(el: Element): Promise<boolean> {
  return hotspot('cdp', () => trustedClick0(el))
}
/** 元素正中间实际在最上层的，是不是别的浮层（弹窗遮罩、另一个下拉）。
 *  真实点击按坐标落点：被别的浮层盖住时点下去会点到别人身上（例如把另一个地区弹窗里的城市选上），这时返回挡住它的元素 */
export function coveredBy(el: Element): Element | null {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  if (!top || top === el || el.contains(top) || top.contains(el)) return null
  let ca: Element | null = top.parentElement
  while (ca && !ca.contains(el)) ca = ca.parentElement
  // 共同祖先就是 body：挡住它的是挂在 body 下的独立浮层（门户），绝对定位也算
  const shallow = !ca || ca === document.body || ca === document.documentElement
  for (let cur: Element | null = top; cur && cur !== ca; cur = cur.parentElement) {
    const p = getComputedStyle(cur).position
    if (p === 'fixed' || (shallow && p === 'absolute')) return cur
  }
  return null
}

async function trustedClick0(el: Element): Promise<boolean> {
  if (execState.trusted === 'off') return false
  scrollIntoView(el)
  await sleep(30)
  if (coveredBy(el)) return false
  const c = center(el)
  const o = frameOffset()
  return cdp({ op: 'click', x: c.clientX + o.x, y: c.clientY + o.y })
}

export async function trustedType(text: string): Promise<boolean> {
  if (execState.trusted === 'off') return false
  return hotspot('cdp', () => cdp({ op: 'insertText', text }))
}

export async function trustedKey(key: string, modifiers = 0): Promise<boolean> {
  if (execState.trusted === 'off') return false
  return hotspot('cdp', () => cdp({ op: 'key', key, modifiers }))
}

/** 点击：always 模式直接真实点击，否则先合成，必要时由调用方升级 */
export async function click(el: Element, opts: { trusted?: boolean } = {}) {
  scrollIntoView(el)
  if (opts.trusted || execState.trusted === 'always') {
    if (await trustedClick(el)) return 'cdp'
  }
  synthClick(el)
  return 'dom'
}
