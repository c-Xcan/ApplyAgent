// chrome.debugger 真实输入通道：产生 isTrusted 的鼠标/键盘事件。
const attached = new Set<number>()

async function attach(tabId: number) {
  if (attached.has(tabId)) return
  await chrome.debugger.attach({ tabId }, '1.3')
  attached.add(tabId)
}

export async function detach(tabId: number) {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  await chrome.debugger.detach({ tabId }).catch(() => {})
}

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId) attached.delete(src.tabId)
})

const cmd = (tabId: number, method: string, params: Record<string, unknown> = {}) => chrome.debugger.sendCommand({ tabId }, method, params)

const KEYS: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
}

export async function cdpInput(tabId: number, msg: { op: string; x?: number; y?: number; text?: string; key?: string; modifiers?: number }) {
  await attach(tabId)
  if (msg.op === 'click') {
    const p = { x: msg.x!, y: msg.y!, button: 'left', clickCount: 1 }
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await cmd(tabId, 'Input.dispatchMouseEvent', { ...p, type: 'mousePressed' })
    await cmd(tabId, 'Input.dispatchMouseEvent', { ...p, type: 'mouseReleased' })
  } else if (msg.op === 'insertText') {
    await cmd(tabId, 'Input.insertText', { text: msg.text ?? '' })
  } else if (msg.op === 'key') {
    const k = msg.key ?? ''
    const info = KEYS[k] ?? { code: 'Key' + k.toUpperCase(), keyCode: k.toUpperCase().charCodeAt(0) }
    const base = { key: k, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers: msg.modifiers ?? 0 }
    await cmd(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' })
    if (k === 'Enter') await cmd(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'char', text: '\r' })
    await cmd(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }
  return { ok: true }
}
