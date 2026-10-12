// 与页面各 frame 的 content script 通信；多 frame 快照合并。
import type { Action, ActionResult, FormSnapshot, FrameSnapshot } from '../shared/types'

export function frameOfRef(ref: string): number {
  const m = ref.match(/^f(\d+)_/)
  return m ? +m[1] : 0
}

function send<T>(tabId: number, frameId: number, msg: unknown, timeout = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('页面没有响应（超时）')), timeout)
    chrome.tabs.sendMessage(tabId, msg, { frameId }, (r) => {
      clearTimeout(t)
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve(r as T)
    })
  })
}

export async function ensureInjected(tabId: number) {
  try {
    await send(tabId, 0, { t: 'aa:ping' }, 1500)
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {})
  }
}

export async function liveFrames(tabId: number): Promise<number[]> {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [{ frameId: 0 } as any]
  const ok = await Promise.all(
    frames.map(async (f) => {
      try {
        const r = await send<{ size: number }>(tabId, f.frameId, { t: 'aa:ping' }, 1500)
        return r && (f.frameId === 0 || r.size > 400) ? f.frameId : -1
      } catch {
        return -1
      }
    }),
  )
  return ok.filter((x) => x >= 0)
}

export async function snapshotTab(tabId: number, trusted: string): Promise<FormSnapshot> {
  const ids = await liveFrames(tabId)
  const snaps = await Promise.all(ids.map((id) => send<FrameSnapshot>(tabId, id, { t: 'aa:snapshot', frameId: id, trusted }).catch(() => null)))
  const top = snaps.find((s) => s?.frameId === 0)
  const fields: FormSnapshot['fields'] = []
  const buttons: FormSnapshot['buttons'] = []
  snaps.forEach((s, i) => {
    if (!s) return
    const off = i * 100_000
    fields.push(...s.fields.map((f) => ({ ...f, order: f.order + off, section: s.frameId ? `[iframe] ${f.section ?? ''}`.trim() : f.section })))
    buttons.push(...s.buttons.map((b) => ({ ...b, order: b.order + off })))
  })
  return { url: top?.url ?? '', title: top?.title ?? '', heading: top?.heading, fields, buttons, takenAt: Date.now() }
}

export async function act(tabId: number, action: Action, trusted: string): Promise<ActionResult> {
  try {
    return await send<ActionResult>(tabId, frameOfRef(action.ref), { t: 'aa:act', action, trusted }, 60_000)
  } catch (e) {
    return { ok: false, ref: action.ref, error: '执行失败：' + (e as Error).message }
  }
}

export async function abortTab(tabId: number) {
  const ids = await liveFrames(tabId).catch(() => [0])
  await Promise.all(ids.map((id) => send(tabId, id, { t: 'aa:abort' }, 1500).catch(() => null)))
}

export async function waitStable(tabId: number, quiet = 400, max = 8000) {
  const ids = await liveFrames(tabId)
  await Promise.all(ids.map((id) => send(tabId, id, { t: 'aa:stable', quiet, max }, max + 2000).catch(() => null)))
}

export async function highlight(tabId: number, ref: string) {
  return send(tabId, frameOfRef(ref), { t: 'aa:highlight', ref }, 3000).catch(() => null)
}

export async function watchEdits(tabId: number, items: { ref: string; label: string; value: unknown }[]) {
  const byFrame = new Map<number, typeof items>()
  for (const it of items) byFrame.set(frameOfRef(it.ref), [...(byFrame.get(frameOfRef(it.ref)) ?? []), it])
  for (const [fid, list] of byFrame) send(tabId, fid, { t: 'aa:watch', items: list }, 3000).catch(() => {})
}

export async function collectDumps(tabId: number) {
  const ids = await liveFrames(tabId)
  const all = await Promise.all(ids.map((id) => send<{ url: string; dumps: unknown[] }>(tabId, id, { t: 'aa:dumps' }, 3000).catch(() => null)))
  return all.filter((x) => x && x.dumps.length)
}

export async function resetDumps(tabId: number) {
  const ids = await liveFrames(tabId)
  await Promise.all(ids.map((id) => send(tabId, id, { t: 'aa:resetDumps' }, 2000).catch(() => null)))
}
