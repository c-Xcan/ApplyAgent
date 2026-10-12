// 弹出面板发现：比较操作前后的 DOM 变化，找到新出现/新变可见的浮层；以及在面板中收集选项。
// 不依赖任何组件库类名，靠"新出现 + 定位浮层 + 含多个短文本可点项"来判断。
//
// 判断规则都集中在这个文件里：
//  · 什么是浮层：floatingNow（role=listbox/menu/dialog…、body 下的定位元素、带面板类名的定位元素）
//  · 常驻浮层：第一次用到时就在页面上、有实际内容、不像下拉/弹窗的定位元素（固定按钮栏、侧边导航）——永远不当成面板
//  · 这次打开的面板：withPopup 里"新加进页面的"，或"原来就在、刚变显示/内容刚变，并且贴着控件（弹窗可以不贴着）"；
//    只是内容变了的固定定位元素（跟着滚动换高亮的导航）不算
//  · 选项：optionsIn（多种线索合并，去掉装着多个选项的容器；只有同一行首尾相接的行内文字片段才合并成一个选项）
//  · 谁打开谁关：我们打开过的弹层记在 opened 里；closeAllPanels 先 Esc / 点空白，关不掉的模态弹窗点它自己的关闭按钮；
//    装着页面字段的弹窗（编辑框）不是我们打开的，不对它按 Esc
import { classOf, clean, containsDeep, isVisible, parentOf, sleep, textOf, until } from '../dom'
import { hotspot } from './prof'
import { synthClick } from './events'
import { EMPTY_OPTION_RE } from './match'

const PANEL_CLASS_RE = /(dropdown|popper|popover|popup|picker|panel|cascader-menu|menus|listbox|options|overlay|calendar|select-menu)/i
const OPTION_ROLES = '[role=option],[role=menuitem],[role=treeitem],[role=menuitemradio],[role=menuitemcheckbox],[role=gridcell]'

export interface Opt { text: string; el: Element; disabled: boolean; selected: boolean; column: number; box: Element }

function positioned(el: Element) {
  const p = getComputedStyle(el).position
  return p === 'absolute' || p === 'fixed'
}

/** 面板打开前页面上已有的表单字段：往上找面板根时，碰到装着它们的容器就停。
 *  （面板自己内部的年/月下拉、搜索框等不算，它们是面板打开后才出现的） */
let baseline = new Set<Element>()

/** 调试：最近一次看到的面板 HTML（失败时导出，方便分析真实结构） */
export const lastPanel = { html: '', at: 0, layers: '' }
/** 页面常驻的浮层（固定按钮栏等）：第一次用到时页面上已有的、不含输入框的浮层。
 *  它们里面也有可点项，但不是我们打开的面板，关面板时不能把它们当成"还开着"（否则每次都要白等约 240ms）。 */
let staticLayers: WeakSet<Element> | null = null
function initStatic() {
  // 只收有实际内容的（隐藏下拉留下的 0 高度包装层不算），也不收看起来就是下拉/弹窗的（用户启动前自己点开着的下拉）
  staticLayers ??= new WeakSet(floatingNow().filter((x) => !x.querySelector('input,textarea,select,[contenteditable=true]') && !!boxOf(x) && !panelLike(x)))
}
function panelLike(x: Element): boolean {
  return /listbox|menu|tree|dialog/.test(x.getAttribute('role') ?? '') || !!x.querySelector('[role=listbox],[role=menu],[role=tree],[role=dialog]') ||
    /(dropdown|popper|popover|select-menu|picker|cascader)/i.test(classOf(x))
}
/** 固定定位、不像下拉/弹窗的元素（嵌在页面布局里的侧边导航）：自己没出现也没切换显示、只是里面的高亮项变了，是页面常驻的 */
function residentFixed(x: Element): boolean {
  return getComputedStyle(x).position === 'fixed' && !panelLike(x) && !isModal(x)
}
/** el 是否位于某个常驻浮层里 */
function inStatic(el: Element): boolean {
  if (!staticLayers) return false
  for (let cur: Element | null = el, i = 0; cur && cur !== document.body && i < 30; cur = parentOf(cur), i++) if (staticLayers.has(cur)) return true
  return false
}

/** 控件旁边一个只显示"无数据 / 无匹配数据"的空面板（选项要等别的字段填了才有，或搜索没有结果） */
export function emptyPanelNear(trigger: Element, maxDist = 300): Element | null {
  const t = trigger.getBoundingClientRect()
  for (const p of floatingNow()) {
    if (closing(p) || inStatic(p) || containsDeep(p, trigger) || optionsIn(p).length) continue
    const leaves = Array.from(p.querySelectorAll('*')).filter((x) => !x.childElementCount && isVisible(x))
    if (!leaves.some((x) => EMPTY_OPTION_RE.test(clean(x.textContent)))) continue
    const r = boxOf(p)
    if (!r) continue
    const dy = r.top > t.bottom ? r.top - t.bottom : t.top > r.bottom ? t.top - r.bottom : 0
    const dx = r.left > t.right ? r.left - t.right : t.left > r.right ? t.left - r.right : 0
    if (dx + dy <= maxDist) return p
  }
  return null
}
function remember(p: Element | null) {
  if (p) {
    lastPanel.html = p.outerHTML.slice(0, 120000)
    lastPanel.at = Date.now()
  }
  return p
}
function pageFields(): Element[] {
  return Array.from(document.querySelectorAll('[data-aa-ref]')).filter((x) => /(^|_)e\d+$/.test(x.getAttribute('data-aa-ref')!) && isVisible(x))
}
/** 字段是否位于某个"不包含 trigger 的浮层"里（那是别的弹窗里的输入框，不是页面字段） */
function inForeignLayer(f: Element, trigger: Element): boolean {
  let cur: Element | null = parentOf(f)
  for (let i = 0; i < 25 && cur && cur !== document.body; i++) {
    const p = getComputedStyle(cur).position
    if ((p === 'absolute' || p === 'fixed') && !containsDeep(cur, trigger)) return true
    cur = parentOf(cur)
  }
  return false
}
function holdsPageField(c: Element, trigger: Element): number {
  let n = 0
  for (const f of baseline) if (f.isConnected && c.contains(f) && !containsDeep(trigger, f) && !f.contains(trigger) && !inForeignLayer(f, trigger)) n++
  return n
}

function panelRootOf(el: Element, trigger: Element): Element {
  let best: Element | null = null
  let cur: Element | null = el
  for (let i = 0; i < 12 && cur && cur !== document.body && cur !== document.documentElement; i++) {
    if (containsDeep(cur, trigger) && cur !== el) break
    // 往上爬到装着表单字段的容器就停（那是页面布局，不是弹出面板）
    if (cur !== el && holdsPageField(cur, trigger) > 0) break
    if (positioned(cur) || PANEL_CLASS_RE.test(classOf(cur)) || /listbox|menu|tree|dialog|grid/.test(cur.getAttribute('role') ?? '')) best = cur
    cur = parentOf(cur)
  }
  return best ?? el
}

const OPTION_SEL = OPTION_ROLES + ',li,label,[class*=option],[class*=item],[class*=cell],[class*=node],[class*=choice]'
/** 面板底部的操作按钮（"取消 / 确定"），不是选项 */
const ACTION_RE = /^(取消|确定|确认|完成|清空|重置|cancel|ok|confirm|done|apply|clear|reset)$/i
const BUTTON_SEL = 'button,[role=button],[class*=button],[class*=btn]'

/** 面板里的可选项。合并多种线索（role / li / label / 类名 / 可点击叶子），再去掉"装着多个选项的容器"。 */
export function optionsIn(panel: Element): Opt[] {
  const cands = new Set<Element>()
  for (const e of Array.from(panel.querySelectorAll(OPTION_SEL))) cands.add(e)
  for (const e of Array.from(panel.querySelectorAll('div,span,a,p'))) {
    if (e.childElementCount <= 4 && getComputedStyle(e).cursor === 'pointer') cands.add(e)
  }
  let nodes = Array.from(cands).filter((e) => {
    const role = e.getAttribute('role')
    if (role === 'tab' || role === 'tablist' || role === 'columnheader') return false
    if (e.querySelector('input[type=text],input[type=search],input:not([type])')) return false
    // 读屏用的隐藏 listbox（0×0、overflow:hidden，里面放的是选项 value）不是真正的选项
    const lb = e.closest('[role=listbox]')
    if (lb && lb !== e) { const r = lb.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false }
    // 空状态区块（图标 + "这里什么都没有..."）里的东西不是选项
    const em = e.closest('[class*=empty],[class*=Empty]')
    if (em && em !== panel && panel.contains(em)) return false
    // 长度按完整文字算（textOf 的上限把缩进空白也算进去，截断后一整格按钮看起来也像"短文字"）
    const t = textOf(e, [], 400)
    // 底部操作按钮，以及只装着这几个按钮的按钮栏
    if (t.split(/\s+/).every((w) => ACTION_RE.test(w)) && (e.closest(BUTTON_SEL) || e.querySelector(BUTTON_SEL))) return false
    // "无匹配数据 / 暂无数据"这类空状态文字不是选项
    return !!t && t.length <= 40 && !EMPTY_OPTION_RE.test(t) && isVisible(e)
  })
  // 装着 ≥2 个候选的元素是容器，不是选项；但如果里面的候选都是行内文字片段（搜索高亮把"嵌入式"拆成两段），它本身才是选项。
  // 片段 = display:inline 的纯文字（inline-block 的是按钮，一格一格的城市/区县按钮不能合并成一个选项）
  const isInline = (o: Element) => getComputedStyle(o).display === 'inline' && !o.querySelector('div,li,p,label')
  nodes = nodes.filter((e) => {
    const inner = nodes.filter((o) => o !== e && e.contains(o))
    return inner.length < 2 || (inner.every(isInline) && textOf(e, [], 400).length <= 40)
  })
  // 剩下的嵌套对：保留外层（点击外层同样生效，且语义更完整）
  nodes = nodes.filter((e) => !nodes.some((o) => o !== e && o.contains(e)))
  const colOf = columnsOf(nodes, panel)
  const cols: Element[] = []
  return nodes
    .map((el) => {
      const box = colOf(el)
      let column = cols.indexOf(box)
      if (column < 0) column = cols.push(box) - 1
      const c = classOf(el)
      const inp = el.querySelector('input[type=radio],input[type=checkbox]') as HTMLInputElement | null
      return {
        text: textOf(el, [], 80),
        el,
        disabled: el.getAttribute('aria-disabled') === 'true' || /(^|[\s_-])disabled/i.test(c),
        // 写了 aria-selected 就以它为准：antd 的 -active 只是悬停高亮
        selected: (el.hasAttribute('aria-selected') ? el.getAttribute('aria-selected') === 'true' : /(selected|active|checked)/i.test(c)) || !!inp?.checked,
        column,
        box,
      }
    })
    .filter((o) => o.text)
}

/** 选项所在的列（同一列的选项共享这个容器）：列表元素；否则往上第一个装着 ≥2 个上下排列的选项的容器。
 *  选项横着排的容器只是一行（一行两格的分类列表），要再往上；只装一个选项、但比选项高得多的容器是只有一项的列 */
function columnsOf(nodes: Element[], panel: Element): (el: Element) => Element {
  const info = new Map<Element, { n: number; min: number; max: number }>()
  for (const o of nodes) {
    const top = o.getBoundingClientRect().top
    for (let a = parentOf(o); a && a !== panel; a = parentOf(a)) {
      const s = info.get(a) ?? { n: 0, min: Infinity, max: -Infinity }
      info.set(a, { n: s.n + 1, min: Math.min(s.min, top), max: Math.max(s.max, top) })
    }
  }
  return (el) => {
    const list = el.closest('ul,[role=listbox],[role=menu],[role=tree]')
    if (list && panel.contains(list)) return list
    const p = parentOf(el)
    if (!p || p === panel) return panel
    if (info.get(p)!.n === 1 && p.getBoundingClientRect().height > el.getBoundingClientRect().height * 1.8) return p
    for (let a: Element | null = p; a && a !== panel; a = parentOf(a)) {
      const s = info.get(a)!
      if (s.n >= 2 && s.max - s.min > 2) return a
    }
    return p
  }
}

/** 正在播放"消失"动画的浮层（选完后组件自己在关，动画还没放完）：当作已经关了。
 *  判断方式与组件库无关：有正在运行的动画/过渡，且终点透明度为 0 或 visibility:hidden */
export function closing(p: Element): boolean {
  const anims = (p as HTMLElement).getAnimations?.({ subtree: true }) ?? []
  return anims.some((a) => {
    if (a.playState !== 'running') return false
    const kf = (a.effect as KeyframeEffect | null)?.getKeyframes?.() ?? []
    const end = kf[kf.length - 1] as Record<string, unknown> | undefined
    return !!end && (String(end.opacity) === '0' || end.visibility === 'hidden')
  })
}

function floatingNow(): Element[] {
  const out: Element[] = []
  for (const el of Array.from(document.body.querySelectorAll('[role=listbox],[role=menu],[role=tree],[role=dialog],[role=grid]'))) if (isVisible(el)) out.push(el)
  for (const el of Array.from(document.body.children)) if (isVisible(el) && positioned(el)) out.push(el)
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (PANEL_CLASS_RE.test(classOf(el)) && positioned(el) && isVisible(el)) out.push(el)
  }
  return out
}

/** 元素实际占据的区域。浮层常挂在"高度为 0、贴在页面顶部"的包装层里，
 *  包装层自身的位置没有意义，要看里面真正有内容的子元素。 */
function boxOf(el: Element, depth = 0): DOMRect | null {
  const r = el.getBoundingClientRect()
  if ((r.width >= 2 && r.height >= 2) || depth > 8) return r.width || r.height ? r : null
  let u: DOMRect | null = null
  for (const c of Array.from(el.children)) {
    const b = boxOf(c, depth + 1)
    if (!b) continue
    u = u ? new DOMRect(Math.min(u.left, b.left), Math.min(u.top, b.top), Math.max(u.right, b.right) - Math.min(u.left, b.left), Math.max(u.bottom, b.bottom) - Math.min(u.top, b.top)) : b
  }
  return u
}

function best(cands: Element[], trigger: Element, maxDist = Infinity, minOpts = 1): Element | null {
  const tr = trigger.getBoundingClientRect()
  let top: { el: Element; score: number } | null = null
  for (const c of new Set(cands)) {
    if (!isVisible(c)) continue
    if (c === trigger || containsDeep(c, trigger)) continue
    if (closing(c) || inStatic(c)) continue
    // 装着其他表单字段的不是弹出面板（而是页面/表单容器）
    if (holdsPageField(c, trigger) >= 1) continue
    const n = Math.min(optionsIn(c).length, 30)
    if (n < minOpts) continue
    const r = boxOf(c)
    if (!r) continue
    // 面板到触发器的距离（重叠为 0）
    const dy = r.top > tr.bottom ? r.top - tr.bottom : tr.top > r.bottom ? tr.top - r.bottom : 0
    const dx = r.left > tr.right ? r.left - tr.right : tr.left > r.right ? tr.left - r.right : 0
    const dist = dx + dy
    if (dist > maxDist) continue
    const score = n * 2 - dist / 10
    if (!top || score > top.score) top = { el: c, score }
  }
  return top?.el ?? null
}

/** 执行 action，返回其后新出现的面板（没有则 null） */
export function withPopup(trigger: Element, action: () => unknown, waitMs = 800, minOpts = 1, idleMs = 0): Promise<Element | null> {
  return hotspot('withPopup', () => withPopup0(trigger, action, waitMs, minOpts, idleMs))
}
/** idleMs：动作之后这么久页面一点变化都没有，就认为这种打开方式无效，提前放弃（不再干等满 waitMs） */
async function withPopup0(trigger: Element, action: () => unknown, waitMs: number, minOpts: number, idleMs: number): Promise<Element | null> {
  initStatic()
  const before = new Set(floatingNow())
  baseline = new Set(pageFields())
  const changed = new Set<Element>()
  // 区分"新出现的浮层"和"原来就在页面上、只是内容变了的东西"（例如右侧进度导航跟着表单更新）
  const added = new Set<Element>()
  const toggled = new Set<Element>()
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => n.nodeType === 1 && (changed.add(n as Element), added.add(n as Element)))
      else if (r.target.nodeType === 1 && r.attributeName !== 'data-aa-ref') { changed.add(r.target as Element); toggled.add(r.target as Element) }
    }
  })
  const upTo = (c: Element, set: Set<Element>) => {
    for (let cur: Element | null = c, i = 0; cur && cur !== document.body && cur !== document.documentElement && i < 30; cur = parentOf(cur), i++) if (set.has(cur)) return true
    return false
  }
  const nearTrigger = (c: Element, max: number) => {
    const r = boxOf(c)
    if (!r) return false
    const t = trigger.getBoundingClientRect()
    const dy = r.top > t.bottom ? r.top - t.bottom : t.top > r.bottom ? t.top - r.bottom : 0
    const dx = r.left > t.right ? r.left - t.right : t.left > r.right ? t.left - r.right : 0
    return dx + dy <= max
  }
  /** 能当成"这次弹出的面板"的：新加进页面的；或者自己（或外层）刚从隐藏变成显示、或里面的内容刚变（包装层一直留着、
   *  只把里面的下拉重新显示出来的组件），并且贴着控件（弹窗可以不贴着） */
  const isNew = (c: Element) =>
    !inStatic(c) && (upTo(c, added) || (upTo(c, toggled) ? nearTrigger(c, 200) || isModal(c) : changedContent(c, changed) && nearTrigger(c, 200) && !residentFixed(c)))
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'aria-expanded'] })
  await action()
  const aria = () => {
    for (const el of [trigger, ...Array.from(trigger.querySelectorAll('[aria-controls],[aria-owns]'))]) {
      const id = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns')
      const p = id ? document.getElementById(id) : null
      if (p && isVisible(p) && optionsIn(p).length) return panelRootOf(p, trigger)
    }
    return null
  }
  const collectCands = () => {
    const cands: Element[] = []
    for (const el of changed) {
      if (!el.isConnected) continue
      const root = panelRootOf(el, trigger)
      if ((!before.has(root) || changedContent(root, changed)) && isNew(root)) cands.push(root)
    }
    for (const el of floatingNow()) if (!before.has(el) && !inStatic(el)) cands.push(el, panelRootOf(el, trigger))
    return cands
  }
  // 一出现带 ≥2 个选项的新面板就返回；否则沿用原来的"变化停下来"判断
  const start = Date.now()
  let last = -1
  let early: Element | null = null
  while (Date.now() - start < waitMs) {
    await sleep(40)
    if (idleMs && changed.size === 0 && Date.now() - start >= idleMs) { mo.disconnect(); return null }
    if (changed.size > 0 && changed.size === last) {
      early = aria() ?? best(collectCands(), trigger, Infinity, 2)
      if (early || Date.now() - start > 180) break
    }
    last = changed.size
  }
  mo.disconnect()
  if (early) return track(early, trigger)
  const a0 = aria()
  if (a0) return track(a0, trigger)
  const cands = collectCands()
  let found = best(cands, trigger, Infinity, 2)
  // 真正的面板可能异步加载（先弹出的是悬浮提示之类）：再等一会儿
  for (let i = 0; i < 8 && !found; i++) {
    await sleep(150)
    const more = floatingNow().filter((el) => !before.has(el) && !inStatic(el)).flatMap((el) => [el, panelRootOf(el, trigger)])
    found = best([...cands, ...more], trigger, Infinity, 2)
  }
  return track(found ?? (minOpts <= 1 ? best(cands, trigger) : null), trigger)
}

/** 我们打开过的弹层（整层）：收尾时要确认它们真的关了 */
const opened = new Set<Element>()
function track(p: Element | null, trigger: Element) {
  if (p) opened.add(layerOf(p, trigger))
  return remember(p)
}
function coversViewport(c: Element) {
  const r = c.getBoundingClientRect()
  return r.width * r.height >= innerWidth * innerHeight * 0.6
}
function isModal(c: Element) {
  return /dialog/.test(c.getAttribute('role') ?? '') || c.getAttribute('aria-modal') === 'true' || !!c.querySelector('[role=dialog],[aria-modal=true]')
}
/** 装着页面字段的浮层（例如"编辑教育经历"弹窗）：是页面的一部分，不是我们打开的面板 */
function holdsFields(p: Element) {
  return pageFields().some((f) => p.contains(f))
}

function changedContent(root: Element, changed: Set<Element>) {
  for (const c of changed) if (containsDeep(root, c)) return true
  return false
}

/** 当前已经打开的、离 trigger 最近的面板 */
export function openPanel(trigger: Element, maxDist = 400): Element | null {
  if (!baseline.size) baseline = new Set(pageFields())
  const fl = floatingNow()
  // 优先真正的选项面板；只有一个可点项的（悬浮提示"删除"之类）最后才考虑
  return remember(best(fl, trigger, maxDist, 2) ?? best(fl, trigger, maxDist))
}

/** 等待一个含 ≥2 个选项的面板出现（有的面板要先请求数据，比悬浮提示晚出现） */
export function waitPanel(trigger: Element, maxMs = 2500, maxDist = 600): Promise<Element | null> {
  return hotspot('waitPanel', () => waitPanel0(trigger, maxMs, maxDist))
}
async function waitPanel0(trigger: Element, maxMs: number, maxDist: number): Promise<Element | null> {
  const t0 = Date.now()
  for (;;) {
    const p = best(floatingNow(), trigger, maxDist, 2)
    if (p || Date.now() - t0 > maxMs) return remember(p)
    await sleep(150)
  }
}

/** 调试：当前页面上所有可见浮层的 HTML（失败时一起导出，避免只看到错的那个） */
export function visibleLayers(max = 200000): string {
  // 去掉整页布局容器（装着很多表单字段的定位元素）
  const fl = floatingNow().filter((x) => pageFields().filter((f) => x.contains(f)).length <= 3)
  const tops = fl.filter((x) => !fl.some((o) => o !== x && o.contains(x)))
  let out = ''
  for (const t of tops) {
    if (out.length > max) break
    out += `<!-- layer options=${optionsIn(t).length} -->\n` + t.outerHTML.slice(0, 120000) + '\n'
  }
  return out.slice(0, max)
}

/** 按 Esc。焦点在"装着页面字段的弹窗"（编辑框）里时不按：那个弹窗会被 Esc 一起关掉 */
export function pressEscape() {
  const ae = document.activeElement as HTMLElement | null
  const host = ae && ae !== document.body ? floatingNow().find((p) => p.contains(ae) && holdsFields(p) && !opened.has(p)) : undefined
  if (host) return false
  ;(ae ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
  return true
}

/** 关闭页面上所有打开的浮层（Esc + 点空白处；关不掉的模态弹窗点它自己的关闭按钮），避免上一个控件残留的面板干扰下一个。
 *  返回：我们打开过的弹层是否都关掉了 */
export function closeAllPanels(): Promise<boolean> {
  return hotspot('closeAllPanels', closeAllPanels0)
}
async function closeAllPanels0(): Promise<boolean> {
  initStatic()
  // 包装层留着、里面的下拉已经隐藏（0 高度）的不算开着
  // 再加上页面上开着的"选择器弹窗"（模态、有一堆选项、不装页面字段）：不是这次打开的（例如上次运行残留的）也要关掉，不然它挡着整页
  const pickers = () => floatingNow().filter((p) => isModal(p) && !holdsFields(p) && !staticLayers!.has(p) && !closing(p) && optionsIn(p).length >= 3)
  const mine = () => [...new Set([...opened, ...pickers()])].filter((l) => l.isConnected && isVisible(l) && !!boxOf(l) && !closing(l))
  const anyOpen = () => mine().length > 0 || floatingNow().some((p) => !staticLayers!.has(p) && !closing(p) && !holdsFields(p) && optionsIn(p).length > 0)
  for (const l of [...opened]) if (!l.isConnected || !isVisible(l)) opened.delete(l)
  if (!anyOpen()) return true
  const ae = document.activeElement as HTMLElement | null
  pressEscape()
  // 关掉了就立刻返回（关闭动画不用等完）
  if (!(await until(() => !anyOpen(), 80))) {
    for (const t of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: 2, clientY: 2 }))
    ae?.blur?.()
    await until(() => !anyOpen(), 150)
  } else ae?.blur?.()
  // 还开着的、我们打开的弹层（不响应 Esc 的模态弹窗）：点它自己的关闭按钮
  // 只对模态弹窗/全屏遮罩这样做；普通下拉里右上角的小图标可能是某个选项的勾选框
  // 固定定位的自制弹窗（没有 role=dialog）只认明确的"关闭/×/取消"；普通下拉浮层只认"取消"（里面的 × 可能是删掉某个已选项）
  for (const l of mine()) await closeLayer(l, isModal(l) || coversViewport(l) ? 'full' : getComputedStyle(l).position === 'fixed' ? 'named' : 'cancel')
  for (const l of [...opened]) if (!l.isConnected || !isVisible(l) || !boxOf(l) || closing(l)) opened.delete(l)
  baseline = new Set(pageFields())
  return mine().length === 0
}

/** 关掉一个弹层：先找它自己的关闭按钮（"关闭/×"、close 类名、右上角无文字的小图标、"取消"），再点它的遮罩 */
export async function closeLayer(layer: Element, mode: 'full' | 'named' | 'cancel' = 'full'): Promise<boolean> {
  const gone = () => !layer.isConnected || !isVisible(layer) || closing(layer)
  if (gone()) return true
  const dlg = layer.matches('[role=dialog],[aria-modal=true]') ? layer : layer.querySelector('[role=dialog],[aria-modal=true]') ?? layer
  const x = closeControl(dlg, mode)
  if (mode !== 'full' && !x) return gone()
  if (x) {
    synthClick(x)
    if ((await until(gone, 400)) || mode !== 'full') return gone()
  }
  // 点遮罩（对话框框外、但仍属于这个弹层的地方）
  const b = dlg.getBoundingClientRect()
  for (const [px, py] of [[4, 4], [innerWidth - 4, innerHeight - 4], [4, innerHeight - 4]]) {
    if (px >= b.left && px <= b.right && py >= b.top && py <= b.bottom) continue
    const t = document.elementFromPoint(px, py)
    if (t && layer.contains(t) && !dlg.contains(t)) {
      synthClick(t)
      if (await until(gone, 300)) return true
    }
  }
  return gone()
}

function closeControl(dlg: Element, mode: 'full' | 'named' | 'cancel'): Element | null {
  const els = Array.from(dlg.querySelectorAll('button,[role=button],a,i,span,svg,div,em')).filter((e) => isVisible(e))
  const cancel = () => els.filter((e) => /^(取\s*消|cancel)$/i.test(clean(e.textContent))).pop() ?? null
  if (mode === 'cancel') return cancel()
  const said = (e: Element) => (e.getAttribute('aria-label') ?? e.getAttribute('title') ?? '').trim()
  const named = els.find((e) => /^(关闭|close|×|✕|✖)$/i.test(said(e)) || /^(×|✕|✖|关闭)$/.test(clean(e.textContent)))
  if (named) return named
  const byClass = els.find((e) => /(^|[\s_-])close([\s_-]|$)|closebtn|close-?icon|icon-?close/i.test(classOf(e)) && !clean(e.textContent))
  if (byClass) return byClass
  if (mode === 'named') return cancel()
  // 右上角、没有文字的小图标（对话框关闭按钮的通用位置）
  const b = dlg.getBoundingClientRect()
  const corner = els
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ e, r }) => !clean(e.textContent) && !e.querySelector('input') && r.width >= 6 && r.width <= 48 && r.height >= 6 && r.height <= 48 && b.right - r.right <= 64 && r.top - b.top <= 64)
    .sort((p, q) => (b.right - p.r.right + p.r.top - b.top) - (b.right - q.r.right + q.r.top - b.top))
  if (corner.length) return corner[0].e
  return cancel()
}

export function describePanel(panel: Element, max = 1500): string {
  const opts = optionsIn(panel)
  if (opts.length) {
    const cols = new Map<number, string[]>()
    for (const o of opts) cols.set(o.column, [...(cols.get(o.column) ?? []), (o.selected ? '✓' : '') + (o.disabled ? '(禁用)' : '') + o.text])
    const parts = Array.from(cols.values()).map((c, i) => (cols.size > 1 ? `第${i + 1}列: ` : '') + c.join(' | '))
    return clean(parts.join('\n')).slice(0, max)
  }
  return textOf(panel, [], max)
}

/** 面板所在的整个弹层（往上到不包含触发控件的最外层）。日历头部、"确定"页脚常在面板外层 */
export function layerOf(panel: Element, trigger: Element): Element {
  let top = panel
  for (let cur = parentOf(panel); cur && cur !== document.body && !containsDeep(cur, trigger); cur = parentOf(cur)) top = cur
  return top
}
