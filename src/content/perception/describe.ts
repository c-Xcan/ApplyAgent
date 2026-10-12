// 给每个字段提取：标签与上下文证据、控件种类提示、当前值、选项、约束、报错。
// 证据原样交给模型，不在本地判定语义。
import { ancestors, classOf, clean, containsDeep, cut, docOrder, isVisible, parentOf, textOf } from '../dom'
import type { RawField } from './collect'
import { WIDGET_RE } from './collect'
import type { WidgetHint } from '../../shared/types'

const ERROR_RE = /(error|explain|invalid|warning|feedback|err-msg|errmsg)/i
const PLACEHOLDER_RE = /placeholder/i
/** 占位文字是提示语（不是选中的值） */
const PROMPT_RE = /^(请|选择|输入|搜索|填写|点击|可选|如[:：]|例[:：如]|please|select|search|enter|choose|type|pick)/i
const ICON_RE = /(^|[\s_-])(arrow|icon|suffix|caret|clear)([\s_-]|$)/i
const TAG_RE = /(^|[\s_-])(tag|chip|selection-item|select-tag|multiple-item)([\s_-]|$)/i

function stripLabel(s: string) {
  return clean(s.replace(/^[*＊\s]+|[*＊]+|[:：\s]+$/g, ' '))
}

function idsText(ids: string | null): string {
  if (!ids) return ''
  return ids
    .split(/\s+/)
    .map((id) => {
      const el = (document.getElementById(id) ?? null) as Element | null
      return el ? textOf(el, [], 80) : ''
    })
    .filter(Boolean)
    .join(' ')
}

/** root 里的校验报错文字元素（"请填写您有效的证件号码"）：类名像报错、是不含输入框和标签的小块文字。
 *  Element / antd 把它放在输入框所在的容器里，找标签时要跳过它，否则报错会被当成字段名、报错本身也报不出来 */
function errorEls(root: Element, anchor: Element): Element[] {
  return Array.from(root.querySelectorAll('*')).filter(
    (x) => ERROR_RE.test(classOf(x)) && !x.contains(anchor) && !containsDeep(anchor, x) && !x.querySelector('input,select,textarea,label,button') && clean(x.textContent).length < 80,
  )
}

/** 报错文字属于哪个字段：从报错往上，第一个装着字段的容器里、排在报错前面最近的那个字段（没有就取容器里第一个）。
 *  没有文字标签的字段（页面顶部的搜索框）找"同一行"时会爬到整张表单，表单里别的字段的报错不能算到它头上 */
function ownerOf(err: Element, anchors: Element[]): Element | undefined {
  for (let a = parentOf(err); a; a = parentOf(a)) {
    const inside = anchors.filter((x) => containsDeep(a!, x))
    if (inside.length) return inside.filter((x) => docOrder(x, err) < 0).pop() ?? inside[0]
  }
  return undefined
}

/** 正在淡出的旧提示（值已经改对，提示在播"消失"动画）：不算报错 */
function fading(e: Element) {
  if (/leave/i.test(classOf(e)) || getComputedStyle(e).opacity === '0') return true
  return ((e as HTMLElement).getAnimations?.() ?? []).some((a) => {
    const kf = (a.effect as KeyframeEffect | null)?.getKeyframes?.() ?? []
    return a.playState === 'running' && String((kf[kf.length - 1] as Record<string, unknown> | undefined)?.opacity) === '0'
  })
}

/** 与 anchor 同行的说明文本：向上找第一个"除自身外有文字、且不含其他字段"的祖先（跳过校验报错文字） */
function rowText(anchor: Element, others: Element[], exclude: Element[]): { text: string; row: Element | null } {
  let cur = anchor
  for (let i = 0; i < 8; i++) {
    const p = parentOf(cur)
    if (!p || p === document.body) break
    const hasOther = others.some((o) => o !== anchor && containsDeep(p, o) && !containsDeep(anchor, o))
    if (hasOther) {
      // 表格/行内布局：取 cur 之前的兄弟文本
      let sib = cur.previousElementSibling
      const parts: string[] = []
      while (sib && parts.join('').length < 40) {
        if (others.some((o) => containsDeep(sib!, o))) break
        const t = textOf(sib, [...exclude, ...errorEls(sib, anchor)], 60)
        if (t) parts.unshift(t)
        sib = sib.previousElementSibling
      }
      return { text: parts.join(' '), row: p }
    }
    const t = textOf(p, [anchor, ...exclude, ...errorEls(p, anchor)], 160)
    if (t) return { text: t, row: p }
    cur = p
  }
  return { text: '', row: null }
}

export function hintOf(f: RawField): WidgetHint {
  if (f.hint !== 'unknown') return f.hint
  const inputs = f.inputs as HTMLInputElement[]
  const first = inputs[0]
  const isRoot = !inputs.includes(f.anchor as HTMLInputElement)
  // 类名 + 图标的 id/引用（如 <use href="#..date_time_picker">）都算线索
  const icons = isRoot ? Array.from(f.anchor.querySelectorAll('svg [id], use')).map((u) => (u.getAttribute('id') ?? '') + ' ' + (u.getAttribute('href') ?? u.getAttribute('xlink:href') ?? '')) : []
  const cls = [f.anchor, ...(isRoot ? Array.from(f.anchor.querySelectorAll('*')).slice(0, 12) : []), ...inputs].map(classOf).join(' ') + ' ' + icons.join(' ').replace(/[#_]/g, ' ')
  const r = (first ?? f.anchor).getAttribute('role') ?? ''
  if (first?.tagName === 'SELECT') return 'native-select'
  if (first?.tagName === 'TEXTAREA') return 'textarea'
  if (first && (first as HTMLElement).isContentEditable && first.tagName !== 'INPUT') return 'richtext'
  const t = first?.tagName === 'INPUT' ? first.type : ''
  if (t === 'date' || t === 'month' || t === 'datetime-local' || t === 'week') return 'date'
  if (/cascader|region|area|city|address/i.test(cls)) return 'cascader'
  if (/(date|calendar)/i.test(icons.join(' '))) return inputs.length >= 2 ? 'date-range' : 'date'
  if (/(date|picker|calendar|time)/i.test(cls) && !/select/i.test(cls)) return inputs.length >= 2 ? 'date-range' : 'date'
  if (/upload/i.test(cls)) return 'file'
  if (WIDGET_RE.test(cls) || r === 'combobox' || f.anchor.getAttribute('aria-haspopup') || !inputs.length) return 'custom-select'
  if (/请选择|选择|select|choose/i.test(first?.placeholder ?? '')) return 'custom-select'
  if (first && /^(yyyy|年|\d{4}[-/.])/i.test(first.placeholder ?? '')) return 'date'
  if (t === 'number') return 'number'
  if (t === 'email') return 'email'
  if (t === 'tel') return 'tel'
  if (t === 'password') return 'password'
  return 'text'
}

/** 同一段文字被读了两遍（选中项 + title/镜像节点）："快手招聘官网 快手招聘官网" → "快手招聘官网" */
const once = (s: string) => s.match(/^(.+?)\s*\1$/)?.[1] ?? s

export function valueOf(f: RawField, hint: WidgetHint): string | string[] | boolean | null {
  const inputs = f.inputs as HTMLInputElement[]
  if (hint === 'radio-group') {
    const o = f.options?.find((o) => (o.input ? o.input.checked : o.el.getAttribute('aria-checked') === 'true'))
    return o ? o.label : null
  }
  if (hint === 'checkbox' || hint === 'switch') {
    const i = inputs[0]
    return i instanceof HTMLInputElement ? i.checked : (i as Element).getAttribute('aria-checked') === 'true'
  }
  if (hint === 'checkbox-group') {
    return (f.options ?? []).filter((o) => (o.input ? o.input.checked : o.el.getAttribute('aria-checked') === 'true')).map((o) => o.label)
  }
  if (hint === 'native-select') {
    const s = inputs[0] as unknown as HTMLSelectElement
    const sel = Array.from(s.selectedOptions ?? []).map((o) => clean(o.text))
    return s.multiple ? sel : sel[0] ?? ''
  }
  if (hint === 'file') {
    const fi = inputs[0] as HTMLInputElement
    const names = Array.from(fi?.files ?? []).map((x) => x.name)
    if (names.length) return names
    const list = (parentOf(f.anchor) ?? f.anchor).querySelector('[class*=upload-list],[class*=file-name],[class*=filename],[class*=file-list]')
    const t = list ? textOf(list, [], 120) : ''
    return t ? [t] : null
  }
  if (hint === 'richtext') return textOf(inputs[0] ?? f.anchor, [], 2000)
  if (hint === 'custom-select' || hint === 'cascader' || hint === 'date' || hint === 'date-range') {
    const tags = Array.from(f.anchor.querySelectorAll('*')).filter((e) => TAG_RE.test(classOf(e)) && isVisible(e))
    const tagTexts = tags.map((t) => textOf(t, [], 60)).filter(Boolean)
    if (tagTexts.length > 1 || (tagTexts.length && /multiple/i.test(classOf(f.anchor)))) return Array.from(new Set(tagTexts))
    // 占位符还显示着 = 没有值（输入框里的字只是搜索词，不是选中的值）
    const phShown = Array.from(f.anchor.querySelectorAll('*')).some((e) => PLACEHOLDER_RE.test(classOf(e)) && isVisible(e) && textOf(e, [], 20))
    if (phShown && !tagTexts.length) return hint === 'date-range' ? ['', ''] : ''
    const vals = inputs.filter((i) => i.tagName === 'INPUT').map((i) => (i as HTMLInputElement).value)
    if (hint === 'date-range' && vals.length >= 2) return vals.slice(0, 2)
    // 可搜索的下拉（Element 的 filterable select 等）：选中后输入框是空的，选中值显示在占位文字上
    const inp = inputs.find((i) => i.tagName === 'INPUT') as HTMLInputElement | undefined
    if (inp && !inp.value && !inp.readOnly && inp.placeholder && hint === 'custom-select') {
      // 占位文字不是提示语（"请选择…"），或者和第一次看到的不一样了 = 它显示的是选中的值
      const orig = inp.dataset.aaPh
      if (!PROMPT_RE.test(inp.placeholder) && (!orig || orig !== inp.placeholder || !PROMPT_RE.test(orig))) return clean(inp.placeholder)
    }
    const decor = Array.from(f.anchor.querySelectorAll('*')).filter((e) => PLACEHOLDER_RE.test(classOf(e)) || ICON_RE.test(classOf(e)) || e.tagName === 'svg' || (e.tagName === 'I' && textOf(e, [], 4).length <= 1))
    const shown = textOf(f.anchor, [...inputs, ...decor], 200)
    if (vals.some(Boolean)) return once(vals.filter(Boolean).join(' '))
    if (!shown && inputs.includes(f.anchor as HTMLInputElement)) {
      // 锚点就是输入框（没找到组件根）：已选值常显示在输入框旁边的兄弟节点里
      const p = parentOf(f.anchor)
      if (p) {
        const t = textOf(p, [f.anchor, ...Array.from(p.querySelectorAll('*')).filter((e) => PLACEHOLDER_RE.test(classOf(e)) || ICON_RE.test(classOf(e)))], 80)
        if (t && t.length <= 40) return once(t)
      }
    }
    return once(shown)
  }
  const i = inputs[0]
  if (!i) return textOf(f.anchor, [], 200)
  return (i as HTMLInputElement).value ?? ''
}

export function describe(f: RawField, all: RawField[]) {
  const hint = hintOf(f)
  const inputs = f.inputs as HTMLInputElement[]
  const first = inputs[0]
  const others = all.map((x) => x.anchor)
  const optionEls = (f.options ?? []).map((o) => o.el)
  const cands: string[] = []
  const push = (s: string | null | undefined) => {
    const t = stripLabel(s ?? '')
    if (t && !cands.includes(t)) cands.push(cut(t, 80))
  }
  for (const el of [first, f.anchor]) {
    if (!el) continue
    push(idsText(el.getAttribute('aria-labelledby')))
    push(el.getAttribute('aria-label'))
  }
  const labels = first?.labels ? Array.from(first.labels) : []
  const wrap = (first ?? f.anchor).closest('label')
  for (const l of [...labels, wrap]) if (l && !optionEls.includes(l)) push(textOf(l, [f.anchor, ...inputs], 120))
  if ((hint === 'checkbox' || hint === 'switch') && f.options?.[0]?.label) push(f.options[0].label)
  const exclude = [...optionEls, ...inputs]
  const row = rowText(f.anchor, others, exclude)
  push(row.text)
  // 记下第一次看到的占位文字：可搜索下拉选中后会把选中值写到占位文字上，读值时据此判断
  if (first instanceof HTMLInputElement && first.placeholder && !first.dataset.aaPh) first.dataset.aaPh = first.placeholder
  const ph = first?.placeholder || Array.from(f.anchor.querySelectorAll('*')).find((e) => PLACEHOLDER_RE.test(classOf(e)))?.textContent || ''
  if (first?.title) push(first.title)
  const nm = first?.getAttribute('name') || first?.id || ''
  if (nm && /[a-z]{3,}/i.test(nm) && !/^[a-z0-9]{12,}$/i.test(nm) && !/^(rc_|el-id|input-|v-|:r)/i.test(nm)) cands.push('name=' + nm)

  const requiredText = /[*＊]/.test(row.text) || cands.some((c) => /\*/.test(c))
  // 必填的星号常常是 CSS 伪元素（Element 的 is-required），DOM 里没有 * 文字：看行容器自身的类名和标签的 ::before
  const rowEls = row.row ? [row.row, ...Array.from(row.row.querySelectorAll('*'))] : []
  const starBefore = (el: Element) => /[*＊]/.test(getComputedStyle(el, '::before').content || '') || /[*＊]/.test(getComputedStyle(el, '::after').content || '')
  const required = !!(first?.required || first?.getAttribute('aria-required') === 'true' || requiredText ||
    rowEls.some((e) => /required/i.test(classOf(e))) ||
    rowEls.some((e) => (e.tagName === 'LABEL' || /label/i.test(classOf(e))) && !containsDeep(e, f.anchor) && starBefore(e)))

  let error: string | undefined
  if (row.row) {
    for (const e of errorEls(row.row, f.anchor)) {
      if (isVisible(e) && !fading(e) && ownerOf(e, others) === f.anchor) {
        const t = textOf(e, [], 80)
        if (t && t.length < 60 && !cands.includes(t)) { error = t; break }
      }
    }
  }
  if (!error && first?.getAttribute('aria-invalid') === 'true') error = idsText(first.getAttribute('aria-describedby')) || '校验未通过'

  let options: string[] | undefined
  if (f.options && (hint === 'radio-group' || hint === 'checkbox-group')) options = f.options.map((o) => o.label)
  if (hint === 'native-select') options = Array.from((first as unknown as HTMLSelectElement).options).map((o) => clean(o.text)).filter(Boolean)

  const label = cands.find((c) => !c.startsWith('name=')) ?? ph ?? ''
  return {
    hint,
    label: cut(label, 60),
    context: cands.filter((c) => c !== label).slice(0, 3),
    required,
    value: valueOf(f, hint),
    options,
    optionsCollapsed: ['custom-select', 'cascader'].includes(hint) ? true : undefined,
    placeholder: clean(ph) || undefined,
    constraints: {
      maxLength: first && first.maxLength > 0 ? first.maxLength : undefined,
      accept: hint === 'file' ? first?.accept || undefined : undefined,
      multiple: (first as any)?.multiple || /multiple/i.test(classOf(f.anchor)) || undefined,
      readonly: first?.readOnly || undefined,
    },
    error,
    disabled: !!(first?.disabled || f.anchor.getAttribute('aria-disabled') === 'true' || /disabled/i.test(classOf(f.anchor))),
  }
}
