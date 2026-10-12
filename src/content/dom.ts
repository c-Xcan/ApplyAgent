import { addSleep } from './exec/prof'
// DOM 基础工具：可见性、遍历（含 open shadow root）、文本。

/** 停止标记：用户点"停止"后，页面里正在进行的动作在下一次等待时立即结束 */
export const runFlag = { aborted: false }
export const sleep = (ms: number) =>
  (addSleep(ms), new Promise<void>((r, j) => setTimeout(() => (runFlag.aborted ? j(new Error('已停止')) : r()), ms)))

/** 轮询直到 cond() 为真或超时；返回是否满足。用来代替"固定等一会儿再看" */
export async function until(cond: () => boolean, maxMs: number, step = 20): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    if (cond()) return true
    if (Date.now() - t0 >= maxMs) return false
    await sleep(Math.min(step, maxMs - (Date.now() - t0)))
  }
}

export function isVisible(el: Element | null | undefined): boolean {
  if (!el || !(el as HTMLElement).isConnected) return false
  const h = el as HTMLElement
  if (typeof h.checkVisibility === 'function') {
    if (!h.checkVisibility({ visibilityProperty: true } as any)) return false
  }
  const r = h.getBoundingClientRect()
  if (r.width < 1 && r.height < 1) {
    // display:contents 等情况：看子节点
    return Array.from(h.children).some((c) => isVisible(c))
  }
  return true
}

/** 深度遍历所有元素（含 open shadow root） */
export function* walk(root: ParentNode = document): Generator<Element> {
  const stack: ParentNode[] = [root]
  while (stack.length) {
    const node = stack.pop()!
    const kids = (node as Element).children ?? (node as Document).children
    if (!kids) continue
    for (let i = kids.length - 1; i >= 0; i--) {
      const el = kids[i]
      stack.push(el)
      if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!)
    }
    if (node instanceof Element) yield node
  }
}

export function allElements(): Element[] {
  // 先序，保持文档顺序
  const out: Element[] = []
  const visit = (node: ParentNode) => {
    for (const el of Array.from((node as Element).children ?? [])) {
      out.push(el)
      if ((el as HTMLElement).shadowRoot) visit((el as HTMLElement).shadowRoot!)
      visit(el)
    }
  }
  visit(document)
  return out
}

/** 跨 shadow root 的父节点 */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement
  const root = el.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

export function ancestors(el: Element, max = 50): Element[] {
  const out: Element[] = []
  let cur = parentOf(el)
  while (cur && out.length < max && cur !== document.documentElement) {
    out.push(cur)
    cur = parentOf(cur)
  }
  return out
}

export function containsDeep(a: Element, b: Element): boolean {
  let cur: Element | null = b
  while (cur) {
    if (cur === a) return true
    cur = parentOf(cur)
  }
  return false
}

export const clean = (s: string | null | undefined) => (s ?? '').replace(/[\s ​]+/g, ' ').trim()

export function cut(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 元素可见文本（排除指定子树、隐藏节点、表单控件的值） */
export function textOf(el: Element, exclude: Element[] = [], max = 400): string {
  const parts: string[] = []
  let len = 0
  const visit = (node: Node) => {
    if (len > max) return
    if (node.nodeType === 3) {
      const t = node.textContent ?? ''
      if (t.trim()) {
        parts.push(t)
        len += t.length
      }
      return
    }
    if (node.nodeType !== 1) return
    const e = node as Element
    if (exclude.includes(e)) return
    const tag = e.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') return
    if (tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'OPTION') return
    if (e instanceof HTMLElement && e.hidden) return
    const st = e instanceof HTMLElement ? getComputedStyle(e) : null
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return
    for (const c of Array.from(e.childNodes)) visit(c)
    if ((e as HTMLElement).shadowRoot) for (const c of Array.from((e as HTMLElement).shadowRoot!.childNodes)) visit(c)
  }
  visit(el)
  return clean(parts.join(' '))
}

export function classOf(el: Element): string {
  const c = (el as HTMLElement).className
  return typeof c === 'string' ? c : (c as any)?.baseVal ?? ''
}

/** 把 shadow 内元素提升到与另一方同一棵树（用宿主代替） */
function lift(el: Element): Element[] {
  const chain: Element[] = [el]
  let cur: Element = el
  while (cur.getRootNode() instanceof ShadowRoot) {
    cur = (cur.getRootNode() as ShadowRoot).host
    chain.push(cur)
  }
  return chain
}

export function docOrder(a: Element, b: Element): number {
  if (a === b) return 0
  if (a.getRootNode() !== b.getRootNode()) {
    const ca = lift(a)
    const cb = lift(b)
    for (const x of ca) for (const y of cb) if (x.getRootNode() === y.getRootNode()) return x === y ? 0 : docOrder(x, y)
    return 0
  }
  const pos = a.compareDocumentPosition(b)
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
  return 0
}

export function isFormControl(el: Element): boolean {
  const t = el.tagName
  if (t === 'TEXTAREA' || t === 'SELECT') return true
  if (t === 'INPUT') return !['hidden', 'submit', 'button', 'reset', 'image'].includes((el as HTMLInputElement).type)
  return false
}
