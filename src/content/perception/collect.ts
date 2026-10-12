// 收集页面上的"字段"：原生控件、ARIA 控件、自定义组件根、单选/多选组、文件上传，以及按钮。
// 这里只做结构归并（哪些元素属于同一个字段），不做任何语义判断。
import { allElements, ancestors, classOf, clean, containsDeep, isFormControl, isVisible, parentOf, textOf } from '../dom'
import type { OptionEl } from '../registry'
import type { WidgetHint } from '../../shared/types'

export interface RawField {
  anchor: Element
  inputs: Element[]
  hint: WidgetHint
  options?: OptionEl[]
}
export interface RawButton { el: Element; text: string }

export const WIDGET_RE =
  /(^|[\s_-])(select|selector|picker|cascader|dropdown|combobox|combo|autocomplete|datepicker|date|calendar|time|region|area|city|upload|uploader|treeselect|tree-select|editor)(?=$|[\s_-])/i
const POPUP_ROLES = new Set(['listbox', 'menu', 'tree', 'grid', 'tooltip'])
const VALUE_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider', 'switch', 'listbox'])
const POPUP_CLASS_RE = /(dropdown|popper|popover|popup|picker-panel|picker-dropdown|cascader-menus|select-dropdown|overlay|tooltip)/i

function role(el: Element) {
  return (el.getAttribute('role') ?? '').toLowerCase()
}

/** 处于打开的下拉面板等浮层内部（这些不是表单字段） */
function inPopup(el: Element): boolean {
  for (const a of [el, ...ancestors(el, 12)]) {
    if (POPUP_ROLES.has(role(a))) return true
    const c = classOf(a)
    if (POPUP_CLASS_RE.test(c) && !WIDGET_ROOT_OK(a)) {
      const st = getComputedStyle(a)
      if (st.position === 'absolute' || st.position === 'fixed') return true
    }
  }
  return false
}
const WIDGET_ROOT_OK = (a: Element) => isFormControl(a)

/** 不依赖类名的"像输入框的可点击框"：有边框、可点、尺寸像输入框、带下拉图标或"请选择"类占位文字 */
function looksLikeBox(el: Element): boolean {
  if (el.childElementCount > 8 || ['BUTTON', 'A', 'LABEL', 'LI', 'TD', 'TR', 'TABLE', 'UL', 'BODY', 'HTML'].includes(el.tagName)) return false
  if (el.getAttribute('role') === 'button') return false
  const st = getComputedStyle(el)
  if (st.cursor !== 'pointer' && !(el as HTMLElement).hasAttribute('tabindex')) return false
  const bordered = ['Top', 'Bottom', 'Left', 'Right'].filter((k) => parseFloat((st as any)['border' + k + 'Width']) > 0).length >= 3
  if (!bordered) return false
  const r = el.getBoundingClientRect()
  if (r.width < 60 || r.height < 18 || r.height > 64) return false
  const t = textOf(el, [], 80)
  if (t.length > 40) return false
  const icon = !!el.querySelector('svg,i,[class*=arrow],[class*=icon],[class*=suffix],[class*=placeholder]')
  return icon || !t || /选择|select|choose|pick/i.test(t)
}

function countControls(el: Element): number {
  let n = 0
  for (const c of Array.from(el.querySelectorAll('input,select,textarea'))) {
    if (isFormControl(c) && (c as HTMLInputElement).type !== 'radio' && (c as HTMLInputElement).type !== 'checkbox') n++
  }
  return n
}

/** 向上找组件根：类名像控件、只包含 1~2 个控件、自身文本很短 */
export function widgetRoot(ctrl: Element): Element | null {
  let best: Element | null = null
  let cur = ctrl
  for (let i = 0; i < 6; i++) {
    const p = parentOf(cur)
    if (!p || p === document.body || p.tagName === 'FORM') break
    if (countControls(p) > 2) break
    const t = textOf(p, [ctrl], 120)
    if (t.length > 60) break
    // 组件自己用 <label> 当外框（Moka：label 里放 显示值 + 输入框 + 下拉箭头）：label 就是组件根，再往外是页面布局
    if (p.tagName === 'LABEL') {
      if (countControls(p) === 1 && [p, ...Array.from(p.querySelectorAll('*'))].some((x) => x !== ctrl && WIDGET_RE.test(classOf(x)))) best = p
      break
    }
    if (WIDGET_RE.test(classOf(p)) || role(p) === 'combobox' || p.getAttribute('aria-haspopup')) best = p
    cur = p
  }
  return best
}

function optionLabel(input: Element): { label: string; el: Element } {
  const lab = (input as HTMLInputElement).labels?.[0] ?? input.closest('label')
  if (lab) return { label: textOf(lab, [], 80), el: lab }
  const aria = input.getAttribute('aria-label')
  if (aria) return { label: clean(aria), el: input }
  // 自定义：取包裹元素文本
  let cur: Element = input
  for (let i = 0; i < 3; i++) {
    const p = parentOf(cur)
    if (!p) break
    const t = textOf(p, [], 60)
    if (t) return { label: t, el: p }
    cur = p
  }
  const next = input.nextSibling?.textContent ?? ''
  return { label: clean(next), el: input }
}

function lowestCommon(els: Element[]): Element | null {
  if (!els.length) return null
  let cand: Element | null = parentOf(els[0])
  while (cand && !els.every((e) => containsDeep(cand!, e))) cand = parentOf(cand)
  return cand
}

/** 把单选/复选输入归组 */
function groupChoices(inputs: Element[], type: 'radio' | 'checkbox'): RawField[] {
  const groups = new Map<string, Element[]>()
  const loose: Element[] = []
  for (const el of inputs) {
    const name = (el as HTMLInputElement).name
    if (name) {
      const k = name + '|' + ((el as HTMLInputElement).form?.id ?? '')
      groups.set(k, [...(groups.get(k) ?? []), el])
    } else loose.push(el)
  }
  // 无 name 的按容器归组
  const used = new Set<Element>()
  for (const el of loose) {
    if (used.has(el)) continue
    let box: Element | null = el
    let members: Element[] = [el]
    for (let i = 0; i < 5 && box; i++) {
      box = parentOf(box)
      if (!box) break
      const rg = role(box) === 'radiogroup' || role(box) === 'group'
      const inside = loose.filter((x) => !used.has(x) && containsDeep(box!, x))
      if (inside.length >= 2 || rg) {
        members = inside
        break
      }
    }
    members.forEach((m) => used.add(m))
    groups.set('loose' + groups.size, members)
  }
  const out: RawField[] = []
  for (const members of groups.values()) {
    const opts = members.map((m) => {
      const o = optionLabel(m)
      return { label: o.label, el: o.el, input: m instanceof HTMLInputElement ? m : undefined }
    })
    const visible = opts.filter((o) => isVisible(o.el) || isVisible(o.input))
    if (!visible.length) continue
    // 每一项文字都一样（分区导航上重复的"91%"进度）：不是在几个选项里选一个
    if (opts.length >= 2 && opts[0].label && opts.every((o) => o.label === opts[0].label)) continue
    if (members.length === 1) {
      out.push({ anchor: members[0], inputs: members, hint: role(members[0]) === 'switch' ? 'switch' : type === 'radio' ? 'radio-group' : 'checkbox', options: opts })
    } else {
      const anchor = lowestCommon(members.map((m, i) => opts[i].el)) ?? members[0]
      out.push({ anchor, inputs: members, hint: type === 'radio' ? 'radio-group' : 'checkbox-group', options: opts })
    }
  }
  return out
}

export function collect(): { fields: RawField[]; buttons: RawButton[] } {
  const els = allElements()
  const radios: Element[] = []
  const checks: Element[] = []
  const byRoot = new Map<Element, Element[]>()
  const files: Element[] = []
  const pseudo: Element[] = []

  for (const el of els) {
    const tag = el.tagName
    const r = role(el)
    if (tag === 'INPUT') {
      const t = (el as HTMLInputElement).type
      if (t === 'radio') { if (!inPopup(el)) radios.push(el); continue }
      if (t === 'checkbox') { if (!inPopup(el)) checks.push(el); continue }
      if (t === 'file') { files.push(el); continue }
    }
    if (r === 'radio') { if (!el.querySelector('input')) radios.push(el); continue }
    if (r === 'checkbox' || r === 'switch') { if (!el.querySelector('input')) checks.push(el); continue }
    const editable = (el as HTMLElement).isContentEditable && !parentOf(el)?.closest('[contenteditable=true]')
    const isCtl = isFormControl(el) || (VALUE_ROLES.has(r) && !el.querySelector('input,textarea,select')) || (editable && el.getAttribute('contenteditable') !== null)
    if (isCtl) {
      if (!isVisible(el) && !isVisible(widgetRoot(el))) continue
      if (inPopup(el)) continue
      const root = widgetRoot(el) ?? el
      byRoot.set(root, [...(byRoot.get(root) ?? []), el])
      continue
    }
    // 无原生控件的自定义选择器（div 做的"请选择"）
    if ((WIDGET_RE.test(classOf(el)) || el.getAttribute('aria-haspopup') || looksLikeBox(el)) && !el.querySelector('input,select,textarea')) pseudo.push(el)
  }

  // 合并嵌套的根：外层根包含内层根 → 归到外层
  const roots = Array.from(byRoot.keys())
  for (const a of roots) for (const b of roots) {
    if (a !== b && byRoot.has(a) && byRoot.has(b) && containsDeep(a, b) && a !== document.body) {
      byRoot.set(a, [...byRoot.get(a)!, ...byRoot.get(b)!])
      byRoot.delete(b)
    }
  }

  const fields: RawField[] = []
  for (const [anchor, inputs] of byRoot) fields.push({ anchor, inputs, hint: 'unknown' })

  // 自定义伪控件：取最外层、短文本、可见、不在已有字段内
  const takenRoots = () => fields.map((f) => f.anchor)
  for (const el of pseudo) {
    if (!isVisible(el) || inPopup(el)) continue
    if (takenRoots().some((r) => containsDeep(r, el) || containsDeep(el, r))) continue
    if (textOf(el, [], 80).length > 40) continue
    // 取同样像控件的最外层祖先
    let top = el
    for (const a of ancestors(el, 4)) {
      if ((WIDGET_RE.test(classOf(a)) || a.getAttribute('aria-haspopup') || looksLikeBox(a)) && textOf(a, [], 80).length <= 40 && !a.querySelector('input,select,textarea')) top = a
      else break
    }
    if (takenRoots().some((r) => containsDeep(top, r) || containsDeep(r, top))) continue
    if (/upload/i.test(classOf(top))) continue
    fields.push({ anchor: top, inputs: [], hint: 'unknown' })
  }

  fields.push(...groupChoices(radios, 'radio'), ...groupChoices(checks, 'checkbox'))

  // 文件上传：锚点取可见的上传区域
  for (const f of files) {
    let anchor: Element = f
    if (!isVisible(f)) {
      const vis = [f.closest('label'), ...ancestors(f, 5)].find((a) => a && isVisible(a) && (WIDGET_RE.test(classOf(a)) || a.tagName === 'LABEL' || textOf(a, [], 80).length > 0))
      if (vis) anchor = vis
    } else anchor = widgetRoot(f) ?? f
    if (!isVisible(anchor)) continue
    if (fields.some((x) => x.anchor === anchor)) continue
    fields.push({ anchor, inputs: [f], hint: 'file' })
  }

  // 去掉被其他字段完全包含的字段（例如上传区域里的隐藏输入被重复识别）
  const final = fields.filter((f) => !fields.some((g) => g !== f && g.hint === 'file' && f.hint !== 'file' && containsDeep(g.anchor, f.anchor) && f.inputs.every((i) => (i as HTMLInputElement).type === 'file')))

  // 按钮
  const buttons: RawButton[] = []
  const fieldAnchors = final.map((f) => f.anchor)
  for (const el of els) {
    const tag = el.tagName
    const r = role(el)
    const isBtn =
      tag === 'BUTTON' || r === 'button' || r === 'tab' || (tag === 'INPUT' && ['button', 'submit'].includes((el as HTMLInputElement).type)) ||
      (tag === 'A' && (el as HTMLAnchorElement).getAttribute('href') !== null) ||
      /(^|[\s_-])(btn|button|add|plus|next|submit)([\s_-]|$)/i.test(classOf(el)) ||
      (el.childElementCount <= 2 && !['LABEL', 'LI', 'OPTION', 'TD', 'BODY', 'HTML'].includes(tag) && getComputedStyle(el).cursor === 'pointer' && getComputedStyle(parentOf(el) ?? el).cursor !== 'pointer')
    if (!isBtn) continue
    if (el.closest('label')) continue
    const text = clean(tag === 'INPUT' ? (el as HTMLInputElement).value : textOf(el, [], 40) || el.getAttribute('aria-label') || el.getAttribute('title') || '')
    if (!text || text.length > 24) continue
    if (!isVisible(el) || inPopup(el)) continue
    if (fieldAnchors.some((a) => containsDeep(a, el))) continue
    const outer = buttons.findIndex((b) => containsDeep(b.el, el))
    if (outer >= 0) {
      buttons[outer] = { el, text } // 内层（真正的按钮）优先
      continue
    }
    buttons.push({ el, text })
    if (buttons.length >= 80) break
  }
  return { fields: final, buttons }
}
