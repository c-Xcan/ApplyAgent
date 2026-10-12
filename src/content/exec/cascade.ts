// 级联选择（省 → 市 → 区）：逐级在同一个弹层里点选；点不到时用弹层自带的搜索框兜底。
import { classOf, clean, isVisible, parentOf, sleep, until } from '../dom'
import type { Entry } from '../registry'
import { execState, setNativeValue, synthClick, trustedClick } from './events'
import { looseIn, matchOption, sameValue, type MatchResult } from './match'
import { closeAllPanels, describePanel, layerOf, openPanel, optionsIn, withPopup, type Opt } from './popup'
import { asList, choiceControl, confirmIn, deepestWithText, openDropdown, readback, settleOptions, subtree, type R } from './common'
import { click } from './events'

/** 选项里的"展开下一级"箭头（"江西省 ›"中的 ›） */
export function expander(o: Opt): Element | null {
  const all = [o.el, ...Array.from(o.el.querySelectorAll('*'))]
  const sib = o.el.nextElementSibling
  if (sib && clean(sib.textContent).length <= 1) all.push(sib)
  return all.reverse().find((x) => x !== o.el && (/^[›>〉»]$/.test(clean(x.textContent)) || /(arrow|expand|next|right|caret)/i.test(classOf(x)))) ?? null
}

/** 选项的"状态"：类名（去掉 hover/focus 这类悬停态）+ 勾选属性。点了之后状态变了 = 组件响应了这次点击 */
function stateOf(el: Element) {
  return [el, ...Array.from(el.querySelectorAll('*'))]
    .map((x) => classOf(x).replace(/\S*(hover|focus)\S*/gi, '') + (x.getAttribute('aria-checked') ?? '') + (x.getAttribute('aria-selected') ?? '') + ((x as HTMLInputElement).checked ? '✓' : ''))
    .join('|')
}

/** 在 root 里找这一级：优先还没选过的列里的选项（"吉林"省和"吉林"市同名时不会点回上一列），等异步加载最多 maxMs */
async function findLevel(root: Element, want: string, used: Element[], picked: Element[], maxMs = 1500): Promise<MatchResult<Opt>> {
  const t0 = Date.now()
  let last = -1
  for (;;) {
    const opts = optionsIn(root)
    const fresh = opts.filter((o) => !used.includes(o.box))
    let m = matchOption(fresh, want)
    // 有的组件下一级直接替换在同一个列表里（不新开一列）
    if (!m.hit) m = matchOption(opts.filter((o) => !picked.includes(o.el)), want)
    if (m.hit || Date.now() - t0 > maxMs || (opts.length === last && opts.length > 0 && Date.now() - t0 > 300)) return m
    last = opts.length
    await sleep(150)
  }
}

/** 弹层里可输入的搜索框（"搜索城市名/区县"） */
function searchBox(root: Element): HTMLInputElement | undefined {
  return Array.from(root.querySelectorAll('input')).find((i) => isVisible(i) && !i.readOnly && !i.disabled && !['radio', 'checkbox', 'hidden'].includes(i.type)) as HTMLInputElement | undefined
}

/** 用弹层自带的搜索框：输入最后一级，从结果里挑路径每一级都对得上的那一项 */
async function viaSearch(e: Entry, root: Element, path: string[], rb0: string): Promise<boolean> {
  const s = searchBox(root)
  if (!s) return false
  const leaf = path[path.length - 1]
  const tried = new Set<string>()
  for (const q of [leaf, leaf.length >= 3 ? leaf.slice(0, -1) : '', leaf.slice(0, 2)]) {
    if (!q || tried.has(q)) continue
    tried.add(q)
    const before = new Set(optionsIn(root).map((o) => o.el))
    await click(s)
    setNativeValue(s, q)
    s.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: q }))
    const fresh = () => {
      const near = openPanel(s, 300)
      const all = [...optionsIn(root), ...(near && !root.contains(near) ? optionsIn(near) : [])]
      return all.filter((o) => !before.has(o.el) && path.every((p) => looseIn(o.text, p)))
    }
    await until(() => fresh().length > 0, 1500)
    const hits = fresh()
    if (!hits.length) continue
    const hit = hits.sort((a, b) => a.text.length - b.text.length)[0]
    await click(deepestWithText(hit.el, hit.text))
    if (await until(() => JSON.stringify(readback(e)) !== rb0, 800)) return true
  }
  return false
}

/** 控件里并排的几个独立下拉（"省"一个、"市"一个）：各自的触发元素，按页面顺序 */
function subSelects(anchor: Element): Element[] {
  const all = Array.from(anchor.querySelectorAll('[role=combobox],[aria-haspopup=true],[aria-haspopup=listbox]')).filter(isVisible)
  return all.filter((x) => !all.some((o) => o !== x && o.contains(x)))
}

/** 每一级是一个独立的下拉：选完上一级它就关了，下一级要去点下一个下拉。
 *  资料里的路径比下拉多（省/市/区，页面只有省、市）：选到最后一个下拉为止 */
async function bySelects(e: Entry, subs: Element[], path: string[]): Promise<R> {
  const steps = path.slice(0, subs.length)
  for (let i = 0; i < steps.length; i++) {
    await closeAllPanels()
    const t = subs[i]
    let panel = await withPopup(t, () => synthClick(t), 800, 1, 400)
    if (!panel && execState.trusted !== 'off') panel = await withPopup(t, () => trustedClick(t), 800, 1, 400)
    if (!panel) return { ok: false, error: `第 ${i + 1} 级的下拉没有打开`, observed: subtree(e.anchor), readback: readback(e) }
    const m = await settleOptions(panel, steps[i])
    if (!m.hit) {
      const observed = '面板：' + describePanel(panel)
      await closeAllPanels()
      return { ok: false, error: m.ambiguous ? `第 ${i + 1} 级「${steps[i]}」匹配到多个选项：${m.ambiguous.map((o) => o.text).join(' | ')}` : `第 ${i + 1} 级没有找到「${steps[i]}」`, observed, readback: readback(e) }
    }
    const hit = m.hit
    await click(deepestWithText(hit.el, hit.text))
    await until(() => !hit.el.isConnected || !isVisible(panel!), 600)
  }
  await closeAllPanels()
  await sleep(100)
  const rb = readback(e)
  const good = sameValue(steps[steps.length - 1], rb) || sameValue(steps.join('/'), rb)
  const cut = path.length > steps.length
  return {
    ok: good,
    readback: rb,
    // 少选了几级：按选中的路径记（上层据此判定成功，并注明资料原文）
    path: cut ? `picked:${steps.join('/')}|selects` : 'selects',
    error: good ? undefined : `选择后显示「${asList(rb).join(',')}」`,
  }
}

export async function cascade(e: Entry, value: unknown): Promise<R> {
  const path = asList(value).flatMap((v) => (asList(value).length === 1 ? v.split(/\s*[/>／]\s*/) : [v])).filter(Boolean)
  const subs = subSelects(e.anchor)
  if (subs.length >= 2) return bySelects(e, subs, path)
  const opened = await openDropdown(e)
  let panel = opened.panel
  if (!panel) return { ok: false, error: '没有打开级联面板', observed: subtree(e.anchor) }
  // 整个弹层：逐级展开时里面的列表会被替换，弹层本身不变。之后每一级都只在这个弹层里找——
  // 页面上同时开着别的弹层（例如另一个地区字段的弹窗没关掉）时，不会跑到别人那里去点
  const layer = layerOf(panel, e.anchor)
  const scope = () => (layer.isConnected && isVisible(layer) ? layer : panel!.isConnected ? panel! : openPanel(e.anchor, 600))
  const rb0 = JSON.stringify(readback(e))
  const finish = async (r: R): Promise<R> => {
    const closed = await closeAllPanels()
    if (!closed) r = { ...r, ok: false, error: (r.error ? r.error + '；' : '') + '弹层没能关掉（找不到它的关闭按钮），可能挡住页面' }
    return r
  }
  const fail = async (error: string) => {
    const root = scope()
    // 逐级点不到：弹层自带搜索框的，用搜索兜底
    if (root && (await viaSearch(e, root, path, rb0))) return done('search')
    const observed = root ? '面板：' + describePanel(root) : subtree(e.anchor)
    return finish({ ok: false, error, observed, readback: readback(e) })
  }
  const done = async (how?: string) => {
    const root = scope()
    const ok = root ? confirmIn(root, e.anchor) : undefined
    if (ok) { await click(ok); await sleep(300) }
    const r = await finish({ ok: true })
    await sleep(150)
    const rb = readback(e)
    const good = sameValue(path.join('/'), rb) || sameValue(path[path.length - 1], rb)
    return { ...r, ok: r.ok && good, path: how, readback: rb, error: r.error ?? (good ? undefined : `选择后显示「${asList(rb).join(',')}」`) }
  }
  const used: Element[] = []
  const pickedEls: Element[] = []
  for (let i = 0; i < path.length; i++) {
    const root = scope()
    if (!root) return fail(`选到第 ${i} 级后弹层不见了`)
    const m = await findLevel(root, path[i], used, pickedEls)
    if (!m.hit) return fail(m.ambiguous ? `第 ${i + 1} 级「${path[i]}」匹配到多个选项：${m.ambiguous.map((o) => o.text).join(' | ')}` : `第 ${i + 1} 级没有找到「${path[i]}」`)
    const hit = m.hit
    pickedEls.push(hit.el)
    used.push(hit.box)
    const before = new Set(optionsIn(root).map((o) => o.text))
    const last = i === path.length - 1
    const target = (last && choiceControl(hit)) || deepestWithText(hit.el, hit.text)
    const look0 = stateOf(hit.el)
    await click(target)
    if (last) {
      // 最后一级：选中后控件的值会变、弹层多半会自己关掉，或者选项自己变成选中状态（多选弹窗原地打勾）。
      // 都没有才换真实点击、再点外层包装元素（有的组件把点击绑在外层）。已经有反应就不要再点：再点一次会把勾选取消
      const took = () => JSON.stringify(readback(e)) !== rb0 || !hit.el.isConnected || !scope() || !isVisible(layer) || stateOf(hit.el) !== look0
      if (!(await until(took, 600))) {
        if (execState.trusted !== 'off') await trustedClick(target) // 被别的浮层挡住时不会点
        if (!(await until(took, 500))) {
          const wrap = parentOf(hit.el)
          if (wrap && wrap !== root && clean(wrap.textContent) === clean(hit.el.textContent)) { synthClick(wrap); await until(took, 500) }
        }
      }
      break
    }
    await sleep(300)
    panel = scope() ?? panel
    if (!panel.isConnected) break
    // 下一级没有出现：尝试点击"›"展开
    if (!optionsIn(panel).some((o) => !before.has(o.text))) {
      const ex = hit.el.isConnected ? expander(hit) : null
      if (ex) { await click(ex); await sleep(300) }
    }
  }
  return done()
}
