// ref 注册表：页面元素 ↔ 模型可引用的短 id。同一元素多次快照保持同一 ref。
import type { WidgetHint } from '../shared/types'

export interface OptionEl { label: string; el: Element; input?: HTMLInputElement }

export interface Entry {
  ref: string
  kind: 'field' | 'button' | 'node'
  anchor: Element
  inputs: Element[]
  hint: WidgetHint
  options?: OptionEl[]
  label?: string
  /** 定位签名：页面重新渲染后，用它把旧 ref 绑定到新元素上 */
  sig?: string
  /** 备用签名（分区+种类+第一次看到的占位文字+name+长度上限）：标签文字变了（例如报错/占位文字被当成过标签）时用它找回 */
  alt?: string
}

let prefix = ''
let counter = 0
const refOf = new WeakMap<Element, string>()
export const registry = new Map<string, Entry>()

export function setFramePrefix(frameId: number) {
  prefix = frameId === 0 ? '' : `f${frameId}_`
}

export function refFor(el: Element, kind: 'e' | 'n' = 'e'): string {
  let r = refOf.get(el)
  if (!r) {
    r = `${prefix}${kind}${++counter}`
    refOf.set(el, r)
  }
  try {
    el.setAttribute('data-aa-ref', r)
  } catch {}
  return r
}

/** 把 ref 绑定到（重新渲染出来的）新元素上，使 ref 跨渲染保持稳定 */
export function bindRef(el: Element, ref: string) {
  refOf.set(el, ref)
  try {
    el.setAttribute('data-aa-ref', ref)
  } catch {}
}

export function hasRef(el: Element) {
  return refOf.has(el)
}

let relocate: (() => void) | null = null
export function setRelocator(fn: () => void) {
  relocate = fn
}

export function register(entry: Entry) {
  registry.set(entry.ref, entry)
}

/** 通过 ref 找元素；registry 失效时用 data-aa-ref 属性兜底 */
export function lookup(ref: string): Entry | undefined {
  const e = registry.get(ref)
  if (e && e.anchor.isConnected) return e
  const el = findByAttr(ref)
  if (el) {
    const entry: Entry = e ? { ...e, anchor: el } : { ref, kind: 'node', anchor: el, inputs: [], hint: 'unknown' }
    registry.set(ref, entry)
    return entry
  }
  // 面板里的节点（n 开头）被重新渲染：按"标签名+文字"在当前页面里找回
  if (e?.kind === 'node' && e.sig) {
    const [tag, text] = e.sig.split('|')
    const hit = Array.from(document.querySelectorAll(tag)).find((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim() === text && (x as HTMLElement).offsetParent !== null)
    if (hit) {
      bindRef(hit, ref)
      const entry: Entry = { ...e, anchor: hit }
      registry.set(ref, entry)
      return entry
    }
  }
  // 元素被重新渲染：重新扫描页面，按签名（标签+分区+种类+序号）找回同一个字段
  if (e?.sig && relocate) {
    relocate()
    const again = registry.get(ref)
    if (again && again.anchor.isConnected) return again
  }
  return undefined
}

function findByAttr(ref: string): Element | null {
  const sel = `[data-aa-ref="${CSS.escape(ref)}"]`
  const direct = document.querySelector(sel)
  if (direct) return direct
  // shadow roots
  const stack: ParentNode[] = [document]
  while (stack.length) {
    const n = stack.pop()!
    for (const el of Array.from((n as ParentNode).querySelectorAll('*'))) {
      const sr = (el as HTMLElement).shadowRoot
      if (sr) {
        const hit = sr.querySelector(sel)
        if (hit) return hit
        stack.push(sr)
      }
    }
  }
  return null
}

export function clearRegistry() {
  registry.clear()
}
