// 动作原语。每个动作内部有多条尝试路径；失败时返回现场（面板选项、回读值），由模型决定下一步。
import type { Action, ActionResult } from '../../shared/types'
import { ancestors, classOf, clean, isVisible, parentOf, sleep, textOf, until } from '../dom'
import { lookup } from '../registry'
import { click, execState, fire, scrollIntoView, settleAfterScroll, setNativeValue, synthClick, synthType, trustedClick, trustedKey, trustedType, synthKey } from './events'
import { matchOption, norm, sameValue, type MatchResult } from './match'
import { closing, layerOf, lastPanel, closeAllPanels, describePanel, emptyPanelNear, openPanel, optionsIn, visibleLayers, withPopup, type Opt } from './popup'
import { setDate, setDateByPanel } from './date'
import { waitStable } from '../watcher'
import { mark, profEnd, profStart } from './prof'
import { asList, choiceControl, confirmIn, deepestWithText, dismissEmpty, emptyResult, freshInputs, openDropdown, readback, searchInput, settleOptions, subtree, type R } from './common'
import { cascade, expander } from './cascade'
import type { Entry } from '../registry'

export { readback, subtree }

// ---------------- fill ----------------
async function fill(e: Entry, text: string): Promise<R> {
  const el = (freshInputs(e).find((i) => i.tagName === 'TEXTAREA' || i.tagName === 'INPUT') ??
    (e.anchor as HTMLElement).querySelector('[contenteditable=true]') ??
    ((e.anchor as HTMLElement).isContentEditable ? e.anchor : null)) as HTMLInputElement | HTMLElement | null
  if (!el) return { ok: false, error: '没有找到可输入的元素', observed: subtree(e.anchor) }
  scrollIntoView(el)
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    el.focus()
    document.getSelection()?.selectAllChildren(el)
    if (!document.execCommand('insertText', false, text)) el.textContent = text
    fire(el, 'input')
    fire(el, 'blur')
    return { ok: true, path: 'contenteditable' }
  }
  el.focus({ preventScroll: true })
  fire(el, 'focus', { bubbles: false })
  setNativeValue(el, '')
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
  setNativeValue(el, text)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  mark('填:写入')
  // 输入后弹出了联想/搜索结果：选中匹配项（很多"输入框"其实是搜索选择器）
  // 只有看起来带联想的输入框才等联想结果（普通文本框不等）
  const suggests = el.matches('[role=combobox],[aria-autocomplete],[aria-haspopup],[aria-controls],[aria-expanded],[list]') || !!el.closest('[role=combobox]') || !['text', 'textarea', 'number', 'email', 'tel', 'password'].includes(e.hint)
  if (text && suggests) {
    await sleep(120)
    const panel = openPanel(e.anchor)
    const m = panel ? matchOption(optionsIn(panel), text) : {}
    mark('填:等联想')
    if (m.hit) {
      await click(deepestWithText(m.hit.el, m.hit.text))
      await sleep(150)
      return { ok: true, path: 'autocomplete', readback: readback(e) }
    }
  }
  fire(el, 'change')
  el.dispatchEvent(new FocusEvent('blur'))
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  // 值对上就不等；对不上再等一下（有的组件失焦后异步格式化）
  if (!sameValue(text, el.value)) await until(() => sameValue(text, el.value), 60)
  mark('填:提交')
  if (sameValue(text, el.value) || execState.trusted === 'off') return { ok: sameValue(text, el.value), path: 'dom', error: sameValue(text, el.value) ? undefined : `输入后值为「${el.value}」` }
  // 升级：真实键盘输入
  await trustedClick(el)
  await trustedKey('a', /Mac/i.test(navigator.platform) ? 4 : 2)
  await trustedType(text)
  el.blur()
  await sleep(60)
  mark('填:真实键盘')
  return { ok: sameValue(text, el.value), path: 'cdp', error: sameValue(text, el.value) ? undefined : `输入后值为「${el.value}」` }
}


/** 虚拟列表只渲染可见的十来项：滚动整个列表找目标，同时记下滚过的全部选项（失败时作为现场返回）。
 *  滚动容器可能是 overflow:hidden（rc-virtual-list 用自绘滚动条），所以只要求"内容比容器高且会裁剪"。 */
async function scanVirtual(panel: Element, want: string): Promise<{ hit?: Opt; seen: string[] }> {
  const seen: string[] = []
  const note = () => { for (const o of optionsIn(panel)) if (!seen.includes(o.text)) seen.push(o.text) }
  const scroller = [panel, ...Array.from(panel.querySelectorAll('*'))].find((x) => x.clientHeight > 0 && x.scrollHeight > x.clientHeight + 10 && getComputedStyle(x).overflowY !== 'visible')
  if (!scroller) return { seen }
  const step = async (top: number) => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
    await sleep(80)
  }
  await step(0)
  for (let i = 0; i < 60; i++) {
    note()
    const m = matchOption(optionsIn(panel), want)
    if (m.hit) return { hit: m.hit, seen }
    const before = scroller.scrollTop
    await step(before + Math.max(60, scroller.clientHeight - 30))
    if (scroller.scrollTop === before) break
  }
  return { seen }
}

/** 面板自带搜索框：像人一样先点一下再输入（直接聚焦会被组件当成"离开了控件"而关掉面板）。
 *  合成事件让面板关掉时，重新打开并改用真实鼠标键盘输入。 */
async function typeInPanel(e: Entry, q: string): Promise<Element | null> {
  const findInput = (p: Element | null) => (p ? (Array.from(layerOf(p, e.anchor).querySelectorAll('input')).find((i) => isVisible(i) && !i.readOnly && i.type !== 'radio' && i.type !== 'checkbox') as HTMLInputElement | undefined) : undefined)
  let p = openPanel(e.anchor, 600)
  let s = findInput(p)
  if (s) {
    await click(s)
    await sleep(60)
    setNativeValue(s, q)
    s.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: q }))
    await sleep(350)
    p = openPanel(e.anchor, 600)
    if (p && s.isConnected && isVisible(s)) return p
  }
  if (execState.trusted === 'off') return null
  const re = await openDropdown(e)
  s = findInput(re.panel)
  if (!re.panel || !s) return re.panel
  await trustedClick(s)
  await trustedKey('a', /Mac/i.test(navigator.platform) ? 4 : 2)
  await trustedType(q)
  await sleep(500)
  return openPanel(e.anchor, 600)
}

/** 在已打开的面板里按路径逐级展开（省 → 市），返回最后一级的选项 */
async function drill(e: Entry, panel: Element, parts: string[]): Promise<{ panel: Element; hit: Opt } | null> {
  for (let i = 0; i < parts.length; i++) {
    const m = await settleOptions(panel, parts[i], 800)
    if (!m.hit) return null
    if (i === parts.length - 1) return { panel, hit: m.hit }
    const before = new Set(optionsIn(panel).map((o) => o.text))
    await click(deepestWithText(m.hit.el, m.hit.text))
    await sleep(300)
    panel = openPanel(e.anchor, 600) ?? panel
    if (!optionsIn(panel).some((o) => !before.has(o.text))) {
      const ex = m.hit.el.isConnected ? expander(m.hit) : null
      if (ex) { await click(ex); await sleep(300); panel = openPanel(e.anchor, 600) ?? panel }
    }
  }
  return null
}

async function pickOne(e: Entry, want: string, reuse: boolean): Promise<R> {
  // 能直接输入的控件（联想框、可搜索下拉）：点开不出面板就交给后面的关键词搜索，不在这里重复输入
  let { panel, path } = await openDropdown(e, want, reuse, !searchInput(e))
  // 面板里自带搜索框时优先用它（表单上的输入框可能只是展示用）
  const panelInput = panel ? (Array.from(panel.querySelectorAll('input')).find((i) => isVisible(i) && !i.readOnly && i.type !== 'radio' && i.type !== 'checkbox') as HTMLInputElement | undefined) : undefined
  const s = panelInput ?? searchInput(e)
  if (!panel) {
    // 只写着"暂无数据"的空面板：不能输入的下拉才算空（能输入的远程搜索下拉，点开先是空的，要输入后才有结果）
    if (path === 'empty' || (!searchInput(e) && emptyPanelNear(e.anchor))) { await dismissEmpty(); return emptyResult() }
    // 联想输入框（输入关键词才出候选，全称常常搜不到）：换关键词搜；都搜不到就按原文手写
    const s0 = searchInput(e)
    if (s0) return autocomplete(e, s0, want)
    return { ok: false, error: '尝试了点击、键盘、输入等方式，都没有出现下拉面板', observed: subtree(e.anchor) }
  }
  const parts = want.split(/\s*[/>／]\s*/).filter(Boolean)
  // 每段都像一级名称（至少两个字）才当成"省/市"路径；"10001-15000/月"这种是选项文字本身带斜杠
  const isPath = parts.length > 1 && parts.every((p) => norm(p).length >= 2)
  let m: MatchResult<Opt> = await settleOptions(panel, want, isPath ? 600 : 1500)
  // 路径值只认整串完全一致的选项，否则会命中"省"本身
  if (isPath && !(m.hit && norm(m.hit.text) === norm(want))) m = {}
  mark('选:等选项')
  // "省/市"这类路径：先在当前面板逐级展开
  if (!m.hit && isPath) {
    const r = await drill(e, panel, parts)
    if (r) { panel = r.panel; m = { hit: r.hit }; path += '+drill' }
    mark('选:逐级展开')
  }
  const leaf = isPath ? parts[parts.length - 1] : want
  let searched = false
  if (!m.hit && s) {
    // 可搜索：输入关键词（全称 → 前几个字），等待结果刷新
    for (const q of Array.from(new Set([leaf, leaf.slice(0, 4), leaf.slice(0, 2)]))) {
      if (!q) continue
      let p2 = panelInput ? await typeInPanel(e, q) : (synthType(s, q), await sleep(250), openPanel(e.anchor, 600))
      searched = true
      if (!p2) break
      // 搜索词把下拉过滤空了，旁边又有个只含一项的浮层（"删除"悬浮提示）：那不是面板，还用原来的
      if (p2 !== panel && optionsIn(p2).length < 2 && panel.isConnected && isVisible(panel)) p2 = panel
      panel = p2
      m = await settleOptions(panel, leaf, 1500)
      if (m.hit) { path += '+search'; break }
    }
    mark('选:搜索')
  }
  if (!m.hit && searched) {
    // 搜过但没找到：清掉搜索词，拿完整的选项列表当现场（过滤后的列表只剩"没有数据"之类）
    const box = Array.from(layerOf(panel, e.anchor).querySelectorAll('input')).find((i) => isVisible(i) && !i.readOnly && i.type !== 'radio' && i.type !== 'checkbox') ?? s
    if (box) {
      setNativeValue(box, '')
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
      await sleep(250)
      const p3 = openPanel(e.anchor, 600)
      if (p3 && (optionsIn(p3).length >= 2 || !panel.isConnected || !isVisible(panel))) panel = p3
      if (!m.ambiguous) m = await settleOptions(panel, want, 600)
      if (isPath && !(m.hit && norm(m.hit.text) === norm(want))) m = {}
    }
  }
  let seen: string[] = []
  if (!m.hit && panel && !m.ambiguous) {
    const v = await scanVirtual(panel, want)
    seen = v.seen
    if (v.hit) { m = { hit: v.hit }; path += '+scroll' }
    mark('选:滚动列表')
  }
  if (!m.hit && !m.ambiguous && !seen.length && !optionsIn(panel).length && !s) {
    await closeAllPanels()
    return emptyResult(path)
  }
  if (!m.hit) {
    // 滚动过的虚拟列表：给出完整选项，而不是当前只渲染出来的那一屏
    const observed = seen.length > optionsIn(panel).length ? `（共 ${seen.length} 项）` + seen.join(' | ').slice(0, 3000) : panel ? describePanel(panel) : ''
    lastPanel.layers = visibleLayers()
    lastPanel.at = Date.now()
    await closeAllPanels()
    mark('选:没找到')
    return {
      ok: false,
      path,
      error: m.ambiguous ? `「${want}」匹配到多个选项：${m.ambiguous.map((o) => o.text).join(' | ')}` : `下拉面板中没有「${want}」（请从下面的真实选项里选最接近的，或包含它的大类）`,
      observed: '面板选项：' + observed,
    }
  }
  const hit = m.hit
  const target = choiceControl(hit) ?? deepestWithText(hit.el, hit.text)
  await click(target)
  const okNow = () => sameValue(want, readback(e)) || sameValue(leaf, readback(e)) || sameValue(hit.text, readback(e))
  await until(okNow, 150)
  mark('选:点选项')
  if (!okNow()) await until(okNow, 480) // 有的组件异步提交值
  mark('选:等回读')
  // 带"确定"的面板：先确定再判断
  if (!okNow() && panel.isConnected) {
    const ok = confirmIn(panel, e.anchor)
    if (ok) { await click(ok); await sleep(300); path += '+confirm' }
  }
  if (!okNow() && execState.trusted !== 'off' && hit.el.isConnected) {
    await trustedClick(target)
    path += '+cdp'
    await sleep(150)
  }
  // 有"确定"按钮的面板（多选/地区选择器）
  if (!okNow() && panel.isConnected) {
    const ok = confirmIn(panel, e.anchor)
    if (ok) { await click(ok); await sleep(150); path += '+confirm' }
  }
  // 可搜索下拉（Element filterable 等）：面板开着、输入框有焦点时输入框是空的，失焦收起后才显示选中值
  if (!okNow() && !confirmIn(panel, e.anchor)) {
    const inp = searchInput(e)
    if (inp) { inp.blur(); inp.dispatchEvent(new FocusEvent('blur')); inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) }
    await closeAllPanels()
    await until(okNow, 300)
    if (okNow()) path += '+blur'
  }
  mark('选:补救(确定/真实点击)')
  return { ok: okNow(), path: 'picked:' + hit.text + '|' + path, readback: readback(e), error: okNow() ? undefined : `点击了选项「${hit.text}」，但控件显示「${asList(readback(e)).join(',')}」` }
}

/** 联想输入框：依次用全称、去掉括号的名称、前 4 个字、前 2 个字搜索；
 *  出现候选就选最匹配的；都没有就把原文直接写进框里（这类框通常允许手写） */
async function autocomplete(e: Entry, s: HTMLInputElement, want: string): Promise<R> {
  const base = want.replace(/[（(][^）)]*[）)]/g, '').trim()
  const keys = Array.from(new Set([base, want, base.slice(0, 4), base.slice(0, 2)])).filter((k) => k.length >= 2)
  const clear = () => { setNativeValue(s, ''); s.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })) }
  const seen: string[] = []
  for (const q of keys) {
    clear()
    const p = await withPopup(e.anchor, () => synthType(s, q), 1500, 2) // 远程搜索有防抖和网络延迟
    if (!p) continue
    const opts = optionsIn(p)
    for (const o of opts) if (!seen.includes(o.text)) seen.push(o.text)
    const m = matchOption(opts, want)
    if (!m.hit) continue
    await click(choiceControl(m.hit) ?? deepestWithText(m.hit.el, m.hit.text))
    const okNow = () => sameValue(m.hit!.text, readback(e)) || sameValue(want, readback(e))
    await until(okNow, 300)
    if (okNow()) { await closeAllPanels(); return { ok: true, path: `picked:${m.hit.text}|search:${q}`, readback: readback(e) } }
  }
  // 没有合适的候选：按原文填写
  await closeAllPanels()
  clear()
  synthType(s, want)
  fire(s, 'change')
  s.dispatchEvent(new FocusEvent('blur'))
  s.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await sleep(60)
  await closeAllPanels()
  const rb = readback(e)
  if (sameValue(want, rb)) return { ok: true, path: 'free-text', readback: rb }
  return { ok: false, path: 'free-text', readback: rb, error: `联想框里没有「${want}」，直接手写也没有留住（控件显示「${asList(rb).join(',')}」）`, observed: seen.length ? '面板选项：' + seen.join(' | ') : subtree(e.anchor) }
}


async function select(e: Entry, value: unknown): Promise<R> {
  const want = asList(value)
  const inputs = freshInputs(e)
  if (e.hint === 'native-select') {
    const sel = inputs[0] as unknown as HTMLSelectElement
    const opts = Array.from(sel.options).map((o) => ({ text: clean(o.text) || o.value, el: o, disabled: o.disabled }))
    const picked: HTMLOptionElement[] = []
    for (const w of want) {
      const m = matchOption(opts, w)
      if (!m.hit) return { ok: false, error: m.ambiguous ? `多个选项匹配「${w}」` : `没有选项「${w}」`, observed: '选项：' + opts.map((o) => o.text).join(' | ') }
      picked.push(m.hit.el)
    }
    if (sel.multiple) Array.from(sel.options).forEach((o) => (o.selected = picked.includes(o)))
    else {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter ? setter.call(sel, picked[0].value) : (sel.value = picked[0].value)
    }
    fire(sel, 'input')
    fire(sel, 'change')
    return { ok: true, path: 'native' }
  }
  if (e.hint === 'radio-group' || e.hint === 'checkbox-group' || e.hint === 'checkbox' || e.hint === 'switch') {
    const opts = (e.options ?? []).map((o) => ({ ...o, text: o.label }))
    if (e.hint === 'checkbox' || e.hint === 'switch') {
      const wantOn = typeof value === 'boolean' ? value : !/^(否|不|no|false|0|off)/i.test(String(value))
      return check(e, wantOn)
    }
    const isOn = (o: (typeof opts)[number]) => (o.input ? o.input.checked : o.el.getAttribute('aria-checked') === 'true' || /checked|active|selected/.test(classOf(o.el)))
    const targets: typeof opts = []
    for (const w of want) {
      const m = matchOption(opts, w)
      if (!m.hit) return { ok: false, error: m.ambiguous ? `多个选项匹配「${w}」` : `没有选项「${w}」`, observed: '选项：' + opts.map((o) => o.text).join(' | ') }
      targets.push(m.hit)
    }
    const toggle = async (o: (typeof opts)[number]) => {
      const before = isOn(o)
      await click(o.el)
      await sleep(60)
      if (o.input?.isConnected && isOn(o) === before) synthClick(o.input)
    }
    for (const t of targets) if (!isOn(t)) await toggle(t)
    if (e.hint === 'checkbox-group') for (const o of opts) if (!targets.includes(o) && isOn(o)) await toggle(o)
    await sleep(50)
    let rb = readback(e)
    if (!sameValue(want, rb) && execState.trusted !== 'off') {
      for (const t of targets) if (!isOn(t)) await trustedClick(t.el)
      await sleep(80)
      rb = readback(e)
    }
    return { ok: sameValue(want, rb), readback: rb, error: sameValue(want, rb) ? undefined : '点击后选中状态没有变化' }
  }
  // 自定义下拉（单选/多选）
  const picked: string[] = []
  for (let i = 0; i < want.length; i++) {
    // 多选：已经选上的不要再点（再点一次会取消选中）
    if (want.length > 1 && asList(readback(e)).some((v) => sameValue(want[i], v))) { picked.push(want[i]); continue }
    const r = await pickOne(e, want[i], i > 0)
    if (!r.ok) {
      await closeAllPanels()
      return r
    }
    if (r.path?.startsWith('picked:')) picked.push(r.path.slice(7).split('|')[0])
  }
  mark('选:选完')
  const p = openPanel(e.anchor, 300)
  const c = p && confirmIn(p, e.anchor)
  if (c) { await click(c); await sleep(150) }
  await closeAllPanels()
  mark('选:收尾关面板')
  const rb = readback(e)
  const ok = sameValue(want, rb) || (picked.length > 0 && sameValue(picked, rb))
  const note = ok && !sameValue(want, rb) ? `（没有完全一致的选项，选了最接近的「${picked.join('、')}」）` : ''
  return { ok, readback: rb, path: note || undefined, error: ok ? undefined : `选择后控件显示「${asList(rb).join(',')}」` }
}

async function check(e: Entry, on: boolean): Promise<R> {
  const input = freshInputs(e)[0] ?? e.anchor
  const state = () => (input instanceof HTMLInputElement ? input.checked : (input as Element).getAttribute('aria-checked') === 'true')
  if (state() === on) return { ok: true, path: 'noop' }
  const target = (input instanceof HTMLInputElement && (input.labels?.[0] ?? input.closest('label'))) || (isVisible(input) ? input : parentOf(input)!)
  await click(target)
  await sleep(60)
  if (state() !== on) synthClick(input)
  await sleep(40)
  if (state() !== on) await trustedClick(target)
  return { ok: state() === on, readback: state() }
}


// ---------------- date ----------------
async function date(e: Entry, value: unknown): Promise<R> {
  const values = asList(value)
  const inputs = freshInputs(e).filter((i) => i.tagName === 'INPUT') as HTMLInputElement[]
  // 只读输入框：直接输入的值多半不会被组件接受（看着写进去了，其实没提交），优先走面板
  const customRoot = !inputs.includes(e.anchor as HTMLInputElement)
  // 每次走面板的经过都留下来：最后失败时连同第一次的现场一起返回（重试那次常常只是"面板没再打开"）
  const tried: string[] = []
  const note = (r: { ok: boolean; why?: string; panelText?: string }, rb: unknown) =>
    tried.push(`面板第 ${tried.length + 1} 次：` + (r.ok ? `点完后控件显示「${asList(rb).join(' ~ ')}」` : r.why ?? '失败') + (r.panelText ? `\n日历面板：${r.panelText}` : ''))
  if (inputs.length === 0 || ((customRoot || inputs.every((i) => i.readOnly)) && !['date', 'month'].includes(inputs[0]?.type))) {
    const r0 = await setDateByPanel(e.anchor, inputs, values)
    await until(() => sameValue(values, readback(e)), 100)
    await closeAllPanels()
    mark('日期:面板收尾')
    const rb0 = readback(e)
    if (r0.ok && sameValue(values, rb0)) return { ok: true, path: 'panel', readback: rb0 }
    note(r0, rb0)
  }
  const p1 = await setDate(e.anchor, inputs, values)
  mark('日期:直接输入')
  await until(() => sameValue(values, readback(e)), 100)
  await closeAllPanels()
  mark('日期:输入收尾')
  let rb = readback(e)
  if (sameValue(values, rb)) return { ok: true, path: p1, readback: rb }
  const r = await setDateByPanel(e.anchor, inputs, values)
  await until(() => sameValue(values, readback(e)), 100)
  await closeAllPanels()
  mark('日期:面板重试收尾')
  rb = readback(e)
  if (sameValue(values, rb)) return { ok: true, path: 'panel', readback: rb }
  note(r, rb)
  return { ok: false, readback: rb, error: `日期没有写进去，当前显示「${asList(rb).join(' ~ ')}」`, observed: tried.join('\n') + '\n控件：\n' + subtree(e.anchor) }
}

// ---------------- upload ----------------
async function upload(e: Entry, file?: Action['file']): Promise<R> {
  if (!file) return { ok: false, error: '没有提供文件' }
  let input = freshInputs(e).find((i) => (i as HTMLInputElement).type === 'file') as HTMLInputElement | undefined
  if (!input) {
    for (const a of [e.anchor, ...ancestors(e.anchor, 6)]) {
      input = a.querySelector('input[type=file]') as HTMLInputElement | undefined
      if (input) break
    }
  }
  const bin = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))
  const f = new File([bin], file.name, { type: file.mime })
  const dt = new DataTransfer()
  dt.items.add(f)
  if (input) {
    input.files = dt.files
    fire(input, 'input')
    fire(input, 'change')
    // 很多站点上传后会替换掉 input，文件名出现在上传列表里；上传和解析可能要好几秒
    const stem = file.name.replace(/\.[^.]+$/, '')
    let shown: string[] = []
    for (let t = 0; t < 40 && !shown.length; t++) {
      await sleep(250)
      const names = input.isConnected ? Array.from(input.files ?? []).map((x) => x.name) : []
      if (document.body.innerText.includes(stem)) shown = [file.name]
      else if (t >= 3 && names.length && !input.isConnected) shown = names
    }
    if (!shown.length && input.isConnected && input.files?.length) shown = Array.from(input.files).map((x) => x.name)
    return { ok: shown.length > 0, path: 'input', readback: shown, error: shown.length ? undefined : '文件已提交给上传控件，但页面上没有出现文件名（可能还在上传，或控件不接受）' }
  }
  for (const t of ['dragenter', 'dragover', 'drop']) e.anchor.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
  await sleep(500)
  return { ok: true, path: 'drop' }
}


async function observe(e: Entry, mode: string): Promise<R> {
  if (mode === 'popup') {
    const p = openPanel(e.anchor)
    return p ? { ok: true, observed: subtree(p) } : { ok: false, error: '当前没有打开的弹出面板' }
  }
  const root = mode === 'around' ? parentOf(parentOf(e.anchor) ?? e.anchor) ?? e.anchor : e.anchor
  return { ok: true, observed: subtree(root) }
}

async function open(e: Entry): Promise<R> {
  const { panel, path } = await openDropdown(e)
  if (!panel) return { ok: false, error: '没有出现弹出面板', observed: subtree(e.anchor) }
  return { ok: true, path, observed: subtree(panel) }
}

async function typeKeys(e: Entry, value: unknown): Promise<R> {
  const el = (freshInputs(e)[0] as HTMLElement) ?? (e.anchor as HTMLElement)
  el.focus()
  for (const k of asList(value)) {
    if (/^(Enter|Escape|Tab|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Backspace)$/.test(k)) {
      if (!(execState.trusted !== 'off' && (await trustedKey(k)))) synthKey(el, k)
    } else if (!(execState.trusted !== 'off' && (await trustedType(k)))) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) synthType(el, el.value + k)
    }
    await sleep(80)
  }
  return { ok: true, readback: readback(e) }
}

/** 控件所在行里的校验报错文本（"请输入整数"） */
function fieldError(e: Entry): string | undefined {
  let cur: Element = e.anchor
  for (let i = 0; i < 6; i++) {
    const p = parentOf(cur)
    if (!p || p === document.body) return
    const others = Array.from(p.querySelectorAll('[data-aa-ref]')).filter((x) => /(^|_)e\d+$/.test(x.getAttribute('data-aa-ref')!) && x !== e.anchor && !e.anchor.contains(x))
    if (others.length) return
    for (const x of Array.from(p.querySelectorAll('*'))) {
      if (e.anchor.contains(x) || !isVisible(x) || x.childElementCount > 2) continue
      if (closing(x) || /leave/i.test(classOf(x))) continue // 正在播"消失"动画的旧提示（值填对了，提示正在淡出）
      const byClass = /(error|explain|invalid|err|feedback|warning)/i.test(classOf(x))
      // 不靠类名：红色的短提示文字
      const c = getComputedStyle(x).color.match(/\d+/g)?.map(Number) ?? [0, 0, 0]
      const red = c[0] > 170 && c[1] < 110 && c[2] < 110
      if (!byClass && !red) continue
      const t = textOf(x, [], 80)
      if (t && t.length < 60 && !/^[*＊]$/.test(t)) return t
    }
    cur = p
  }
}

// ---------------- 调试现场 ----------------
export const dumps: { ref: string; label?: string; op: string; value: unknown; error?: string; path?: string; observed?: string; fieldHtml: string; panelHtml?: string; layersHtml?: string; at: number }[] = []

function rowHtml(e: Entry): string {
  let cur: Element = e.anchor
  for (let i = 0; i < 4; i++) {
    const p = parentOf(cur)
    if (!p || p === document.body || p.querySelectorAll('[data-aa-ref]').length > 6) break
    cur = p
  }
  return cur.outerHTML.slice(0, 12000)
}

// ---------------- 分发 ----------------
export async function runAction(a: Action): Promise<ActionResult> {
  let e = lookup(a.ref)
  if (!e) {
    // 页面可能正在重新渲染（例如上传简历后站点重新解析）：等稳定后再找一次
    await waitStable(300, 4000)
    e = lookup(a.ref)
  }
  if (!e) return { ok: false, ref: a.ref, error: `ref ${a.ref} 已失效（元素可能被重新渲染），请根据最新快照重新定位` }
  profStart()
  const started = Date.now()
  lastPanel.layers = ''
  let added = 0
  let removed = 0
  const mo = new MutationObserver((rs) => rs.forEach((r) => { added += r.addedNodes.length; removed += r.removedNodes.length }))
  mo.observe(document.body, { childList: true, subtree: true })
  let r: R
  try {
    scrollIntoView(e.anchor)
    // 要弹出面板的控件：等滚动带来的页面变化结束再打开，避免把正在变化的导航等当成面板
    if (['select', 'cascade', 'date', 'open'].includes(a.op)) await settleAfterScroll()
    mark('滚动到控件')
    switch (a.op) {
      case 'fill': r = await fill(e, String(a.value ?? '')); break
      case 'clear': r = await fill(e, ''); break
      case 'select': r = await select(e, a.value); break
      case 'cascade': r = await cascade(e, a.value); break
      case 'date': r = await date(e, a.value); break
      case 'check': r = await check(e, a.value !== false && a.value !== 'false'); break
      case 'upload': r = await upload(e, a.file); break
      case 'click': {
        const before = textOf(document.body, [], 3000)
        await click(e.anchor, { trusted: a.trusted })
        // 页面一有变化就继续（最多等 250ms）；没变化再用真实点击
        await until(() => added + removed > 0, 250)
        if (!a.trusted && execState.trusted !== 'off' && added + removed === 0 && textOf(document.body, [], 3000) === before) {
          await trustedClick(e.anchor)
          await until(() => added + removed > 0, 250)
        }
        r = { ok: true }
        break
      }
      case 'type_keys': r = await typeKeys(e, a.value); break
      case 'observe': r = await observe(e, String(a.value ?? 'subtree')); break
      case 'open': r = await open(e); break
      case 'scroll': r = { ok: true }; break
      default: r = { ok: false, error: '未知动作 ' + a.op }
    }
  } catch (err) {
    r = { ok: false, error: '执行异常：' + String((err as Error)?.message ?? err) }
  }
  mo.disconnect()
  mark(a.op + ':其余')
  if (e.kind === 'field' && ['fill', 'select', 'cascade', 'date', 'check'].includes(a.op)) {
    // 不再固定等 80ms：只让出一帧给校验渲染；漏掉的报错由整体验证兜底
    await sleep(16)
    let err = fieldError(e)
    // 发现报错再隔一会儿确认一次：刚填好时旧提示可能还没开始淡出
    if (err) { await sleep(120); err = fieldError(e) }
    mark('查页面报错')
    if (err) r = { ...r, ok: false, error: `页面校验报错「${err}」${r.error ? '；' + r.error : ''}` }
  }
  if (!r.ok && e.kind === 'field') {
    dumps.push({ ref: a.ref, label: e.label, op: a.op, value: a.op === 'upload' ? a.file?.name : a.value, error: r.error, path: r.path, observed: r.observed, fieldHtml: rowHtml(e), panelHtml: lastPanel.at >= started ? lastPanel.html : undefined, layersHtml: lastPanel.at >= started ? lastPanel.layers || visibleLayers() : visibleLayers(), at: Date.now() })
    if (dumps.length > 40) dumps.shift()
  }
  if (r.readback === undefined && e.kind === 'field' && !['observe', 'open', 'click', 'scroll'].includes(a.op)) r.readback = readback(e)
  return { ...r, ref: a.ref, pageChanged: added + removed > 0 ? { added, removed } : undefined, prof: profEnd() }
}
