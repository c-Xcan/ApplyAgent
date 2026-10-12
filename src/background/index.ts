// Background 入口：消息路由、运行管理、事件广播。
import type { ConfirmDecision, ModelConfig, RunEvent } from '../shared/types'
import { modelConfigs, modelReady, store } from '../shared/storage'
import { runAgent } from './agent'
import { cdpInput } from './cdp'
import { abortTab, highlight } from './frames'
import { chat, chatJson } from './llm'
import { RESUME_SYSTEM } from './prompts'

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {})

interface RunState {
  abort: AbortController
  events: RunEvent[]
  questions: Map<string, (a: string) => void>
  confirms: Map<string, (d: ConfirmDecision[]) => void>
  running: boolean
  origin?: string
}

/** 停止：立刻让界面恢复可用，后台的收尾在后面慢慢做，不再往界面发事件 */
function stopRun(tabId: number, why: string) {
  const st = runs.get(tabId)
  if (!st?.running) return
  st.abort.abort()
  st.running = false
  abortTab(tabId).catch(() => {})
  broadcast(tabId, { kind: 'log', level: 'warn', text: why })
  broadcast(tabId, { kind: 'done', summary: why })
}
const runs = new Map<number, RunState>()
const ports = new Set<chrome.runtime.Port>()

function broadcast(tabId: number, event: RunEvent) {
  const st = runs.get(tabId)
  if (st) {
    if (event.kind === 'outcomes') st.events = st.events.filter((e) => e.kind !== 'outcomes')
    st.events.push(event)
    if (st.events.length > 600) st.events.splice(0, st.events.length - 600)
  }
  for (const p of ports) p.postMessage({ t: 'event', tabId, event })
}

// 换了站点 / 关了标签页：这个标签页上的运行自动停止（同站内的多步跳转不受影响）
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const st = runs.get(tabId)
  if (!st?.running || !info.url || !st.origin) return
  try {
    if (new URL(info.url).origin !== st.origin) stopRun(tabId, '页面换到了别的站点，已自动停止')
  } catch {}
})
chrome.tabs.onRemoved.addListener((tabId) => {
  stopRun(tabId, '标签页已关闭')
  runs.delete(tabId)
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return
  ports.add(port)
  port.onDisconnect.addListener(() => ports.delete(port))
})

async function startRun(tabId: number) {
  if (runs.get(tabId)?.running) return { ok: false, error: '正在运行' }
  const st: RunState = { abort: new AbortController(), events: [], questions: new Map(), confirms: new Map(), running: true }
  runs.set(tabId, st)
  const tab = await chrome.tabs.get(tabId)
  const origin = new URL(tab.url ?? 'about:blank').origin
  st.origin = origin
  const archiveId = await store.activeId()
  const [settings, profile, qa, files, mem] = await Promise.all([store.settings(), store.profile(archiveId), store.qa(archiveId), store.files(archiveId), store.site(origin)])
  if (!modelReady(settings)) {
    const why = '还没有配置模型：请先在「设置 → 模型」里填写接口地址、API Key 和模型名'
    st.running = false
    broadcast(tabId, { kind: 'log', level: 'error', text: why })
    broadcast(tabId, { kind: 'done', summary: why })
    return { ok: true }
  }
  const models = modelConfigs(settings)
  let qid = 0
  runAgent({
    tabId,
    archiveId,
    settings,
    models,
    profile,
    qa,
    files,
    mem,
    abort: st.abort,
    // 已经停止（或被新的运行替换）的旧运行不再往界面发事件
    emit: (e) => { if (runs.get(tabId) === st && st.running) broadcast(tabId, e) },
    ask: (question, options, label) =>
      new Promise<string>((resolve) => {
        const id = String(++qid)
        st.questions.set(id, resolve)
        broadcast(tabId, { kind: 'question', id, question, options, label })
        st.abort.signal.addEventListener('abort', () => resolve(''))
      }),
    confirm: (items) =>
      new Promise<ConfirmDecision[]>((resolve) => {
        const id = 'c' + ++qid
        st.confirms.set(id, resolve)
        broadcast(tabId, { kind: 'confirm', id, items })
        st.abort.signal.addEventListener('abort', () => resolve([]))
      }),
    saveSite: (m) => { store.saveSite(m).catch(() => {}) },
  }).finally(() => {
    if (st.running) {
      st.running = false
    }
  })
  return { ok: true }
}

chrome.runtime.onMessage.addListener((msg: any, sender, reply) => {
  ;(async () => {
    switch (msg?.t) {
      case 'cdp':
        return cdpInput(sender.tab!.id!, msg).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
      case 'userEdit':
        // 用户改的是自己的值，只学进自己的问答库，不进所有人共用的站点经验
        if (typeof msg.to === 'string' && msg.to) await store.addQa(msg.label, msg.to, 'learned')
        return { ok: true }
      case 'run.start':
        return startRun(msg.tabId)
      case 'run.stop':
        stopRun(msg.tabId, '已停止')
        return { ok: true }
      case 'run.answer': {
        const st = runs.get(msg.tabId)
        const fn = st?.questions.get(msg.id)
        st?.questions.delete(msg.id)
        fn?.(msg.answer ?? '')
        return { ok: true }
      }
      case 'run.confirm': {
        const st = runs.get(msg.tabId)
        const fn = st?.confirms.get(msg.id)
        st?.confirms.delete(msg.id)
        fn?.(msg.decisions ?? [])
        return { ok: true }
      }
      case 'run.state': {
        const st = runs.get(msg.tabId)
        return { running: !!st?.running, events: st?.events ?? [] }
      }
      case 'highlight':
        return highlight(msg.tabId, msg.ref)
      case 'llm.test': {
        // 设置页「测试连接」：用表单里还没保存的配置发一个最小请求
        const r = await chat(msg.config as ModelConfig, [{ role: 'user', content: '请只回复：OK' }], { maxTokens: 16, temperature: 0, tag: 'test' })
        return { ok: true, text: r.text.trim().slice(0, 100) }
      }
      case 'resume.parse': {
        const s = await store.settings()
        if (!modelReady(s)) throw new Error('还没有配置模型：请先在「设置 → 模型」里填写接口地址、API Key 和模型名')
        const { planner } = modelConfigs(s)
        const json = await chatJson<Record<string, unknown>>(planner, [
          { role: 'system', content: RESUME_SYSTEM },
          { role: 'user', content: String(msg.text).slice(0, 20000) },
        ], { maxTokens: 6000 })
        return { ok: true, profile: json }
      }
    }
  })().then(reply, (e) => reply({ ok: false, error: String(e?.message ?? e) }))
  return true
})
