// 日期控件：先尝试直接输入，再尝试面板导航（年/月/日网格 + 前后翻页按钮）。
import { classOf, clean, isVisible, sleep, textOf } from '../dom'
import { click, clickSettle, fire, setNativeValue, synthClick, synthKey } from './events'
import { closeAllPanels, layerOf, openPanel, withPopup } from './popup'
import { hotspot, mark } from './prof'

export interface Ymd { y: number; m?: number; d?: number }

export function parseDate(s: string): Ymd | null {
  const m = s.match(/(\d{4})\D*(\d{1,2})?\D*(\d{1,2})?/)
  if (!m) return null
  return { y: +m[1], m: m[2] ? +m[2] : undefined, d: m[3] ? +m[3] : undefined }
}

const OUT_RE = /(prev|next|other|outside|last-month|next-month|old|new|disabled|not-current|adjacent)/i
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/** 叶子文本节点；年/月头部如果是输入框或下拉，用它的值当文本 */
function leafText(e: Element): string {
  if (e instanceof HTMLInputElement) return clean(e.value || e.placeholder)
  if (e instanceof HTMLSelectElement) return clean(e.selectedOptions[0]?.text ?? '')
  return clean(e.textContent)
}

function leaves(panel: Element): Element[] {
  const inputs = Array.from(panel.querySelectorAll('input,select')).filter((e) => isVisible(e) && leafText(e))
  return [...inputs, ...Array.from(panel.querySelectorAll('*')).filter((e) => {
    if (e.tagName === 'INPUT' || e.tagName === 'SELECT' || e.tagName === 'OPTION') return false
    if (!isVisible(e)) return false
    const t = clean(e.textContent)
    if (!t || t.length > 12) return false
    // 取"文本恰好是自身"的最外层：父元素文本不同
    const p = e.parentElement
    return !(p && panel.contains(p) && clean(p.textContent) === t && p !== panel)
  })].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

function monthOf(t: string): number | null {
  let m = t.match(/^(\d{1,2})\s*月$/)
  if (m) return +m[1]
  const cn = t.match(/^(.{1,2})月$/)
  if (cn && CN_NUM.includes(cn[1])) return CN_NUM.indexOf(cn[1]) + 1
  const en = MONTHS_EN.indexOf(t.slice(0, 3).toLowerCase())
  if (en >= 0 && /^[a-z]+\.?$/i.test(t)) return en + 1
  return null
}

interface Header { y: number; m?: number; el?: Element }
interface View { kind: 'day' | 'month' | 'year' | 'unknown'; headers: Header[]; cells: Element[] }

function readView(panel: Element): View {
  const ls = leaves(panel)
  const headers: Header[] = []
  // 同一个标题可能被读到两次（外层"2024年 6月"和内层"2024年""6月"）：只留第一个
  const push = (h: Header) => {
    const last = headers[headers.length - 1]
    if (!last || last.y !== h.y || last.m !== h.m) headers.push(h)
  }
  // 头部：形如 "2024年3月" / "2024 年" + "3 月" / "March 2024" / "2024-03"
  const text = ls.map((e) => leafText(e))
  // 头部里的"10月"也是"N月"叶子：不能当成月份格子（目标正好是头部显示的月份时会点到头部上）
  const headLeaves = new Set<Element>()
  for (let i = 0; i < text.length; i++) {
    const t = text[i]
    let m = t.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月$/) || t.match(/^(\d{4})[-/.](\d{1,2})$/)
    if (m) { push({ y: +m[1], m: +m[2], el: ls[i] }); continue }
    m = t.match(/^(\d{4})\s*年?$/)
    if (m && i + 1 < text.length && monthOf(text[i + 1])) { push({ y: +m[1], m: monthOf(text[i + 1])!, el: ls[i] }); headLeaves.add(ls[i + 1]); i++; continue }
    if (m && i > 0 && monthOf(text[i - 1]) && !/\d/.test(text[i - 1])) { push({ y: +m[1], m: monthOf(text[i - 1])!, el: ls[i - 1] }); headLeaves.add(ls[i - 1]); continue }
    const en = t.match(/^([A-Za-z]{3,})\s+(\d{4})$/)
    if (en && monthOf(en[1])) { push({ y: +en[2], m: monthOf(en[1])!, el: ls[i] }); continue }
    if (m && /^\d{4}\s*年?$/.test(t) && headers.length === 0) push({ y: +m[1], el: ls[i] })
  }
  // 网格单元：不依赖类名，靠数量判断（≥28 个日数字 / 12 个月份 / ≥9 个年份）
  const dayCells = ls.filter((e) => !(e instanceof HTMLInputElement) && /^\d{1,2}$/.test(clean(e.textContent)) && +clean(e.textContent) >= 1 && +clean(e.textContent) <= 31)
  const monthCells = ls.filter((e) => monthOf(clean(e.textContent)) && !/\d{4}/.test(clean(e.textContent)) && !headLeaves.has(e))
  const yearCells = ls.filter((e) => /^\d{4}\s*年?$/.test(clean(e.textContent)))
  // 没解析出头部时：从非网格的叶子里找年份 / 月份
  if (!headers.length || headers[0].m == null) {
    const yLeaf = ls.find((e) => /^\d{4}\s*年?$/.test(leafText(e)) && yearCells.length < 9)
    const mLeaf = ls.find((e) => monthOf(leafText(e)) && monthCells.length < 12)
    if (yLeaf) headers.unshift({ y: parseInt(leafText(yLeaf)), m: mLeaf ? monthOf(leafText(mLeaf))! : headers[0]?.m })
  }
  if (dayCells.length >= 28) return { kind: 'day', headers, cells: dayCells }
  if (monthCells.length >= 12) return { kind: 'month', headers, cells: monthCells }
  if (yearCells.length >= 9) return { kind: 'year', headers, cells: yearCells }
  return { kind: 'unknown', headers, cells: [] }
}

function navButton(panel: Element, dir: 'prev' | 'next', big: boolean): Element | null {
  const all = Array.from(panel.querySelectorAll('button,a,span,i,div,[role=button]')).filter(isVisible)
  const want = dir === 'prev' ? /(prev|previous|left|back|last)/i : /(next|right|forward)/i
  const bigRe = /(super|double|year|fast|jump)/i
  const sym = dir === 'prev' ? (big ? /^[«≪]$/ : /^[‹<〈]$/) : big ? /^[»≫]$/ : /^[›>〉]$/
  const cands = all.filter((e) => {
    const s = classOf(e) + ' ' + (e.getAttribute('aria-label') ?? '') + ' ' + (e.getAttribute('title') ?? '')
    const t = clean(e.textContent)
    return (want.test(s) && (big ? bigRe.test(s) : !bigRe.test(s))) || sym.test(t)
  })
  const hit = cands.find((e) => e.tagName === 'BUTTON') ?? cands[0]
  if (hit || big) return hit ?? null
  // 只有图标的翻页按钮：取面板顶部区域最左 / 最右的小可点元素
  const pr = panel.getBoundingClientRect()
  const top = all.filter((e) => {
    const r = e.getBoundingClientRect()
    return r.top < pr.top + Math.min(60, pr.height * 0.25) && r.width < 40 && r.height < 40 && r.width > 4 && (e.tagName === 'BUTTON' || getComputedStyle(e).cursor === 'pointer') && !/\d/.test(clean(e.textContent))
  })
  if (top.length < 2) return null
  top.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
  return dir === 'prev' ? top[0] : top[top.length - 1]
}

/** 头部年/月是原生下拉时：直接设置 */
function setHeaderSelects(panel: Element, t: Ymd): boolean {
  let changed = false
  for (const sel of Array.from(panel.querySelectorAll('select')) as HTMLSelectElement[]) {
    const opts = Array.from(sel.options)
    const y = opts.find((o) => parseInt(o.text) === t.y && /^\d{4}/.test(o.text.trim()))
    const m = t.m != null ? opts.find((o) => monthOf(clean(o.text)) === t.m || (opts.length === 12 && clean(o.text) === String(t.m))) : undefined
    const pick = y ?? m
    if (pick && !pick.selected) {
      sel.value = pick.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      changed = true
    }
  }
  return changed
}

const IN_VIEW_RE = /in-view|current-month|this-month/i

/** 单元格属于当前显示的月份。面板里有"in-view"之类的标记时，没有这个标记的格子就是上/下个月补位的 */
function cellOk(e: Element, strict = false) {
  const s = classOf(e) + ' ' + classOf(e.closest('td,[role=gridcell]') ?? e)
  if (IN_VIEW_RE.test(s)) return true
  return !strict && !OUT_RE.test(s)
}

/** 单元格自带的完整日期（title / aria-label / data-date 等，如 title="2024-06-01"） */
function cellDate(e: Element): Ymd | null {
  for (const a of [e, e.closest('td,[role=gridcell]')]) {
    if (!a) continue
    for (const k of ['title', 'aria-label', 'data-date', 'data-value', 'data-day']) {
      const v = a.getAttribute(k)?.trim()
      if (v && /^\d{4}\D\d{1,2}\D\d{1,2}/.test(v)) return parseDate(v)
    }
  }
  return null
}

/** 多月面板（区间选择器左右两个月）：单元格属于它前面最近的那个月份标题 */
function ownerHeader(headers: Header[], cell: Element): number {
  let k = -1
  headers.forEach((h, i) => {
    if (h.el && h.el.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING) k = i
  })
  return k
}

function headerYearLeaf(panel: Element): Element | null {
  return leaves(panel).find((e) => /^\d{4}\s*年?$/.test(clean(e.textContent)) || /^\d{4}\s*年\s*\d{1,2}\s*月$/.test(clean(e.textContent))) ?? null
}

function chooseInPanel(panel: Element, t: Ymd): Promise<boolean> {
  return hotspot('chooseInPanel', () => chooseInPanel0(panel, t))
}
async function chooseInPanel0(panel: Element, t: Ymd): Promise<boolean> {
  let switched = 0
  if (setHeaderSelects(panel, t)) await sleep(200)
  for (let step = 0; step < 120; step++) {
    if (!panel.isConnected) return false
    const v = readView(panel)
    const head = v.headers[0]
    if (v.kind === 'year') {
      const hit = v.cells.find((c) => parseInt(clean(c.textContent)) === t.y && cellOk(c))
      if (hit) { await clickSettle(hit, 150); if (t.m == null) return true; continue }
      const ys = v.cells.map((c) => parseInt(clean(c.textContent)))
      const dir = t.y < Math.min(...ys) ? 'prev' : 'next'
      const b = navButton(panel, dir, true) ?? navButton(panel, dir, false)
      if (!b) return false
      await clickSettle(b, 120); continue
    }
    if (v.kind === 'month') {
      if (!head) return false // 读不出年份时不要盲点
      if (head.y !== t.y) {
        const dir = t.y < head.y ? 'prev' : 'next'
        const b = navButton(panel, dir, true) ?? navButton(panel, dir, false)
        if (!b) return false
        await clickSettle(b, 120); continue
      }
      const hit = v.cells.find((c) => monthOf(clean(c.textContent)) === (t.m ?? 1))
      if (!hit) return false
      await clickSettle(hit, 150)
      if (t.d == null) return true
      continue
    }
    if (v.kind === 'day') {
      const tm = t.m ?? 1
      const td = t.d ?? 1
      const strict = v.cells.some((c) => IN_VIEW_RE.test(classOf(c) + ' ' + classOf(c.closest('td,[role=gridcell]') ?? c)))
      // 单元格带完整日期时直接按日期找，不用猜它属于哪个月
      const exact = v.cells.filter((c) => { const d = cellDate(c); return !!d && d.y === t.y && d.m === tm && d.d === td })
      const hit = exact.find((c) => cellOk(c, strict))
      if (hit) { await clickSettle(hit, 150); return true }
      const idx = v.headers.findIndex((h) => h.y === t.y && h.m === tm)
      if (idx >= 0) {
        // 区间选择器同时显示两个月：只在目标月份那一块里找，否则会点到左边月份的同一天
        const tables = Array.from(panel.querySelectorAll('table,[role=grid]')).filter(isVisible)
        const inScope = v.headers.every((h) => h.el)
          ? (c: Element) => ownerHeader(v.headers, c) === idx
          : tables.length === v.headers.length ? (c: Element) => tables[idx].contains(c) : v.headers.length === 1 ? () => true : null
        if (!inScope) return false
        const cands = v.cells.filter((c) => inScope(c) && +clean(c.textContent) === td && cellOk(c, strict))
        if (!cands.length) return false
        await clickSettle(cands[0], 150)
        return true
      }
      if (!head?.m) return false
      const diff = (t.y - head.y) * 12 + (tm - head.m)
      let b = Math.abs(diff) >= 12 ? navButton(panel, diff < 0 ? 'prev' : 'next', true) : null
      if (!b && Math.abs(diff) >= 12 && switched < 2) {
        // 没有"跳年"按钮：点头部年份切到年视图
        const hy = headerYearLeaf(panel)
        if (hy) { switched++; await clickSettle(hy, 200); continue }
      }
      b = b ?? navButton(panel, diff < 0 ? 'prev' : 'next', false)
      if (!b) return false
      await clickSettle(b, 80); continue
    }
    return false
  }
  return false
}

function confirmButton(panel: Element): Element | null {
  const hits = Array.from(panel.querySelectorAll('*')).filter((e) => isVisible(e) && /^(确定|确认|ok|完成|done|apply)$/i.test(clean(e.textContent).replace(/\s+/g, '')))
  return hits.find((h) => !hits.some((o) => o !== h && h.contains(o))) ?? null
}

export async function setDate(root: Element, inputs: HTMLInputElement[], values: string[]): Promise<string> {
  // 1) 原生 date/month 输入
  if (inputs[0] && ['date', 'month', 'datetime-local', 'week'].includes(inputs[0].type)) {
    values.forEach((v, i) => {
      const el = inputs[i]
      if (!el) return
      const p = parseDate(v)
      const iso = p ? (el.type === 'month' ? `${p.y}-${String(p.m ?? 1).padStart(2, '0')}` : `${p.y}-${String(p.m ?? 1).padStart(2, '0')}-${String(p.d ?? 1).padStart(2, '0')}`) : v
      setNativeValue(el, iso)
      fire(el, 'input')
      fire(el, 'change')
    })
    return 'native'
  }
  // 2) 直接输入
  if (inputs.length) {
    for (let i = 0; i < Math.min(inputs.length, values.length); i++) {
      const el = inputs[i]
      const ro = el.readOnly
      if (ro) el.readOnly = false
      synthClick(el)
      await sleep(80)
      setNativeValue(el, values[i])
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: values[i] }))
      synthKey(el, 'Enter')
      fire(el, 'change')
      if (ro) el.readOnly = true
      await sleep(120)
    }
    return 'typed'
  }
  return 'none'
}

export async function setDateByPanel(root: Element, inputs: HTMLInputElement[], values: string[]): Promise<{ ok: boolean; panelText?: string; why?: string }> {
  await closeAllPanels()
  let panel = await withPopup(root, () => click(inputs[0] ?? root))
  mark('日历:打开')
  if (!panel) return { ok: false, why: '点开后没有出现日历面板' }
  panel = layerOf(panel, root) // 只抓到日期表格时，扩展到整个日历（含年月头部、翻页按钮、输入框）
  // 日历面板自带输入框（rc-calendar 等）：直接输入完整日期 + 回车
  const own = Array.from(panel.querySelectorAll('input')).filter((x) => isVisible(x) && !x.readOnly && x.type !== 'hidden') as HTMLInputElement[]
  if (own.length >= values.length && values.length <= 2) {
    for (let i = 0; i < values.length; i++) {
      const t = parseDate(values[i])
      if (!t) break
      const full = `${t.y}-${String(t.m ?? 1).padStart(2, '0')}-${String(t.d ?? 1).padStart(2, '0')}`
      own[i].focus()
      setNativeValue(own[i], full)
      own[i].dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: full }))
      fire(own[i], 'change')
      await sleep(150)
      if (own[i].isConnected) synthKey(own[i], 'Enter')
      await sleep(250)
    }
    mark('日历:面板内输入')
    if (!panel.isConnected || !isVisible(panel)) return { ok: true }
    const c = confirmButton(panel)
    if (c) { synthClick(c); await sleep(200); return { ok: true } }
  }
  for (let i = 0; i < values.length; i++) {
    const t = parseDate(values[i])
    if (!t) return { ok: false, why: `「${values[i]}」不是能识别的日期` }
    if (!panel || !panel.isConnected) panel = openPanel(root) ?? (await withPopup(root, () => click(inputs[i] ?? root)))
    if (!panel) return { ok: false, why: `选第 ${i + 1} 个日期时日历面板不见了` }
    panel = layerOf(panel, root)
    const ok = await chooseInPanel(panel, t)
    mark(`日历:选第${i + 1}个日期`)
    if (!ok) return { ok: false, why: `在日历里没能翻到或点中「${values[i]}」`, panelText: textOf(panel, [], 800) }
  }
  const c = panel?.isConnected ? confirmButton(panel) : null
  if (c) { synthClick(c); await sleep(150) }
  return { ok: true }
}
