// 动作原语共用的小工具：读值、打开下拉、找"确定"按钮、子树描述等（actions.ts / cascade.ts 共用）
import type { ActionResult } from '../../shared/types'
import { classOf, clean, cut, isVisible, parentOf, sleep } from '../dom'
import { refFor, register, type Entry } from '../registry'
import { valueOf } from '../perception/describe'
import { execState, synthClick, synthKey, synthType, trustedClick, trustedKey, trustedType } from './events'
import { matchOption, type MatchResult } from './match'
import { closeAllPanels, emptyPanelNear, layerOf, openPanel, optionsIn, pressEscape, waitPanel, withPopup, type Opt } from './popup'
import { hotspot, mark } from './prof'

export type R = Omit<ActionResult, 'ref'>

export const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)])

export function freshInputs(e: Entry): HTMLInputElement[] {
  const live = e.inputs.filter((i) => i.isConnected) as HTMLInputElement[]
  if (live.length) return live
  const q = Array.from(e.anchor.querySelectorAll('input:not([type=hidden]),textarea,select')) as HTMLInputElement[]
  return q.length ? q : e.anchor.matches('input,textarea,select') ? [e.anchor as HTMLInputElement] : []
}

export function readback(e: Entry) {
  return valueOf({ anchor: e.anchor, inputs: freshInputs(e), hint: e.hint, options: e.options }, e.hint)
}


// ---------------- select ----------------
export function searchInput(e: Entry): HTMLInputElement | undefined {
  return freshInputs(e).find((i) => i.tagName === 'INPUT' && !i.readOnly && !i.disabled) as HTMLInputElement | undefined
}

/** allowType=false：控件自己能输入（联想框/可搜索下拉）时由调用方负责输入搜索，这里只试点击类的打开方式，失败就快速返回 */
export async function openDropdown(e: Entry, query?: string, reuse = false, allowType = true): Promise<{ panel: Element | null; path: string }> {
  const root = e.anchor
  if (reuse) {
    const existing = openPanel(root, 300)
    if (existing) return { panel: existing, path: 'already-open' }
  }
  // 先关掉别的控件残留的面板，否则会把它误当成本控件的面板
  await closeAllPanels()
  mark('选:关旧面板')
  const input = freshInputs(e)[0] as HTMLInputElement | undefined
  // 合成点击只会派发到被点的那个元素上：点外层容器，绑在里面子元素上的处理函数收不到。
  // 所以优先点控件正中间实际显示的那个元素（和真人点击一样）
  const box = root.getBoundingClientRect()
  const atCenter = box.width && box.height ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null
  const clickable = (atCenter && root.contains(atCenter) ? atCenter : null) ?? (root.querySelector('[class*=selector],[class*=select-view],[class*=trigger],[class*=wrapper]') as Element) ?? root
  const tries: [string, () => unknown][] = [
    ['click-root', () => synthClick(clickable)],
    ['click-input', () => input && synthClick(input)],
    ['arrow-down', () => input && (input.focus(), synthKey(input, 'ArrowDown'))],
  ]
  const s = searchInput(e)
  if (s && query && allowType) tries.push(['type', () => synthType(s, query)])
  if (execState.trusted !== 'off') {
    tries.push(['cdp-click', () => trustedClick(clickable)])
    if (s && query && allowType) tries.push(['cdp-type', async () => { await trustedClick(s); await trustedKey('a', /Mac/i.test(navigator.platform) ? 4 : 2); await trustedType(query) }])
  }
  // 只弹出了一个东西（悬浮提示"删除"之类）不算打开成功，继续换下一种打开方式
  for (const [name, fn] of tries) {
    // 点击类的打开方式：点了之后页面毫无变化，很快就换下一种，不干等
    const p = await withPopup(root, fn, 800, 2, /type/.test(name) ? 0 : 400)
    mark(`选:打开(${name})`)
    if (p) return { panel: p, path: name }
    // 弹出来的是一个只写着"无数据"的空面板：不用再换别的打开方式了。
    // 能输入的控件（远程搜索下拉）点开先显示"暂无数据"是正常的，输入后才有结果：交给调用方去搜
    if (query !== undefined && allowType && emptyPanelNear(root)) return { panel: null, path: 'empty' }
  }
  if (!allowType) {
    const single = openPanel(root, 300)
    return { panel: single, path: single ? 'single-option' : 'none' }
  }
  // 面板可能还在加载数据：再等一会儿真正的选项面板，最后才接受只有一个项的浮层
  const late = await waitPanel(root, 2500)
  mark('选:等面板')
  if (late) return { panel: late, path: 'late' }
  const single = openPanel(root, 300)
  return { panel: single, path: single ? 'single-option' : 'none' }
}

/** 选项可能是异步加载的（打开后才请求接口）：等到出现匹配项或选项数稳定 */
export function settleOptions(panel: Element, want: string, maxMs = 1500): Promise<MatchResult<Opt>> {
  return hotspot('settleOptions', () => settleOptions0(panel, want, maxMs))
}
async function settleOptions0(panel: Element, want: string, maxMs: number): Promise<MatchResult<Opt>> {
  let last = -1
  const t0 = Date.now()
  for (;;) {
    const opts = optionsIn(panel)
    const m = matchOption(opts, want)
    if (m.hit || Date.now() - t0 > maxMs || (opts.length === last && opts.length > 0 && Date.now() - t0 > 300)) return m
    last = opts.length
    await sleep(150)
  }
}


/** 关掉只写着"无数据"的空面板（它没有选项，closeAllPanels 不会把它当成开着的面板） */
export async function dismissEmpty() {
  const ae = document.activeElement as HTMLElement | null
  pressEscape()
  for (const t of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: 1, clientY: 1 }))
  ae?.blur?.()
  await sleep(80)
}

/** 下拉是空的：多半要先填它依赖的字段（例如先选学历才有学位），由上层等其他字段填完再试 */
export function emptyResult(path?: string): R {
  return { ok: false, path: 'empty', error: `下拉面板是空的（没有可选项，可能要先填写它依赖的字段，例如先选学历再选学位）${path ? '' : ''}`, observed: '面板选项：（空）' }
}


export function confirmIn(panel: Element, trigger?: Element): Element | undefined {
  if (trigger) panel = layerOf(panel, trigger)
  const isOk = (b: Element) => /^(确定|确认|ok|完成|done|apply)$/i.test(clean(b.textContent).replace(/\s+/g, '')) && isVisible(b)
  const hits = Array.from(panel.querySelectorAll('*')).filter(isOk)
  // 取最内层（真正绑定点击的按钮在里面，外层包装 div 收不到点击）
  const inner = hits.filter((h) => !hits.some((o) => o !== h && h.contains(o)))
  return inner.find((h) => h.closest('button,[role=button],[class*=button],[class*=btn]')) ?? inner[0]
}

/** 选项里真正负责"选中"的控件（单选/复选圆圈）。有它时点它，点文字可能只是展开下一级 */
const CHOICE_SEL = 'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],[class*=radio],[class*=Radio],[class*=checkbox],[class*=Checkbox]'
export function choiceControl(o: Opt): Element | null {
  // 从选项往上找：第一个"恰好只含一个选择控件"的祖先就是这个选项所在的条目
  let sc: Element | null = o.el
  for (let i = 0; i < 4 && sc; i++) {
    const cs = Array.from(sc.querySelectorAll(CHOICE_SEL)).filter((c) => !Array.from(sc!.querySelectorAll(CHOICE_SEL)).some((d) => d !== c && d.contains(c)))
    if (cs.length === 1 && (isVisible(cs[0]) || isVisible(cs[0].parentElement))) return cs[0]
    if (cs.length > 1) return null
    sc = parentOf(sc)
  }
  return null
}

export function deepestWithText(el: Element, text: string): Element {
  let cur = el
  for (;;) {
    const kid = Array.from(cur.children).find((k) => clean(k.textContent) === clean(text) && isVisible(k))
    if (!kid) return cur
    cur = kid
  }
}

// ---------------- observe ----------------
/** 子树的紧凑描述，给可点击/有文本的节点分配临时 ref，模型可以直接 click 它们 */
export function subtree(root: Element, max = 1800): string {
  const lines: string[] = []
  let len = 0
  const visit = (el: Element, depth: number) => {
    if (len > max || depth > 10 || !isVisible(el)) return
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')
    const t = clean(own)
    const tag = el.tagName.toLowerCase()
    const cls = cut(classOf(el).split(/\s+/).filter(Boolean).slice(0, 2).join('.'), 40)
    const interesting = t || ['input', 'button', 'select', 'textarea', 'li', 'a'].includes(tag) || el.getAttribute('role') || getComputedStyle(el).cursor === 'pointer'
    if (interesting) {
      const ref = refFor(el, 'n')
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      register({ ref, kind: 'node', anchor: el, inputs: el.matches('input,textarea,select') ? [el] : [], hint: 'unknown', sig: txt && txt.length <= 60 ? `${el.tagName.toLowerCase()}|${txt}` : undefined })
      const attrs = [el.getAttribute('role') && `role=${el.getAttribute('role')}`, (el as HTMLInputElement).placeholder && `ph="${(el as HTMLInputElement).placeholder}"`, (el as HTMLInputElement).value && tag === 'input' && `value="${cut((el as HTMLInputElement).value, 30)}"`]
        .filter(Boolean)
        .join(' ')
      const line = `${'  '.repeat(Math.min(depth, 6))}[${ref}] ${tag}${cls ? '.' + cls : ''}${attrs ? ' ' + attrs : ''}${t ? ' "' + cut(t, 40) + '"' : ''}`
      lines.push(line)
      len += line.length
    }
    for (const c of Array.from(el.children)) visit(c, depth + (interesting ? 1 : 0))
    if ((el as HTMLElement).shadowRoot) for (const c of Array.from((el as HTMLElement).shadowRoot!.children)) visit(c, depth + 1)
  }
  visit(root, 0)
  return lines.join('\n') + (len > max ? '\n…(截断)' : '')
}
