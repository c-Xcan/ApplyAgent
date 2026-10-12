// Content script 入口：每个 frame 一份。只负责感知与执行，状态全部在 background。
import { takeSnapshot } from './perception/snapshot'
import { setFramePrefix, lookup } from './registry'
import { runAction, readback, dumps } from './exec/actions'
import { execState } from './exec/events'
import { waitStable } from './watcher'
import { isVisible, runFlag } from './dom'

declare global {
  interface Window { __applyAgent?: string }
}
declare const __BUILD_ID__: string

// 扩展更新后，旧版本留在页面里的脚本会失效；按构建号判断，新版本总能接管
if (window.__applyAgent !== __BUILD_ID__) {
  window.__applyAgent = __BUILD_ID__
  let frameId = 0

  // 用户纠正监听：Agent 填完后，用户手动改了哪个字段
  const watched = new Map<string, { label: string; value: unknown }>()
  const onUserEdit = (ev: Event) => {
    if (!ev.isTrusted) return
    for (const [ref, info] of watched) {
      const e = lookup(ref)
      if (!e || !(e.anchor === ev.target || e.anchor.contains(ev.target as Node))) continue
      setTimeout(() => {
        const now = readback(e)
        if (JSON.stringify(now) !== JSON.stringify(info.value)) {
          chrome.runtime.sendMessage({ t: 'userEdit', ref, label: info.label, from: info.value, to: now }).catch(() => {})
          info.value = now
        }
      }, 300)
    }
  }
  document.addEventListener('change', onUserEdit, true)
  document.addEventListener('focusout', onUserEdit, true)

  chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, reply: (r: unknown) => void) => {
    if (!msg || typeof msg.t !== 'string' || !msg.t.startsWith('aa:')) return
    // 停止标记只拦住停止前正在做的动作；之后的任何新请求都清掉它
    if (msg.t !== 'aa:abort') runFlag.aborted = false
    ;(async () => {
      switch (msg.t) {
        case 'aa:ping':
          return { ok: true, url: location.href, visible: document.visibilityState, size: innerWidth * innerHeight }
        case 'aa:snapshot':
          frameId = msg.frameId ?? frameId
          setFramePrefix(frameId)
          if (msg.trusted) execState.trusted = msg.trusted
          return takeSnapshot(frameId)
        case 'aa:abort':
          runFlag.aborted = true
          return { ok: true }
        case 'aa:act':
          if (msg.trusted) execState.trusted = msg.trusted
          return runAction(msg.action)
        case 'aa:stable':
          return waitStable(msg.quiet ?? 400, msg.max ?? 8000)
        case 'aa:highlight': {
          const e = lookup(msg.ref)
          if (!e) return { ok: false }
          const el = e.anchor as HTMLElement
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
          const old = el.style.outline
          el.style.outline = '3px solid #f59e0b'
          setTimeout(() => (el.style.outline = old), 1800)
          return { ok: true }
        }
        case 'aa:watch':
          watched.clear()
          for (const w of msg.items as { ref: string; label: string; value: unknown }[]) watched.set(w.ref, { label: w.label, value: w.value })
          return { ok: true }
        case 'aa:resetDumps':
          dumps.length = 0
          return { ok: true }
        case 'aa:dumps':
          return { url: location.href, dumps }
        case 'aa:visible':
          return { ok: true, visible: isVisible(document.body) }
      }
    })().then(reply, (err) => reply({ ok: false, error: String(err?.message ?? err) }))
    return true
  })
}
