// LLM 网关：OpenAI 兼容协议 + Anthropic 原生协议，支持工具调用、JSON 输出。
import type { ModelConfig } from '../shared/types'
import { isLocalModel } from '../shared/storage'
import { timing } from './timing'

export interface ToolCall { id: string; name: string; args: any }
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}
export interface ChatResult { text: string; toolCalls: ToolCall[]; usage: { in: number; out: number } }
export interface ChatOpts { tools?: ToolDef[]; json?: boolean; maxTokens?: number; temperature?: number; signal?: AbortSignal; /** 计时用的调用名（plan / pick / repair#1 …） */ tag?: string }

/** 最近一次请求实际发了几次（含重试），给计时用 */
let lastAttempts = 0

export const usage = { calls: 0, inTok: 0, outTok: 0, reset() { this.calls = 0; this.inTok = 0; this.outTok = 0 } }

function openaiUrl(base: string) {
  const b = base.replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(b)) return b
  if (/\/v\d+[a-z]*$/.test(b) || /compatible-mode\/v1$/.test(b)) return b + '/chat/completions'
  return b + '/v1/chat/completions'
}
function anthropicUrl(base: string) {
  const b = base.replace(/\/+$/, '')
  if (/\/messages$/.test(b)) return b
  if (/\/v1$/.test(b)) return b + '/messages'
  return b + '/v1/messages'
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    lastAttempts = attempt + 1
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 90_000)
      signal?.addEventListener('abort', () => ctl.abort())
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal })
      clearTimeout(t)
      const txt = await res.text()
      if (res.ok) return JSON.parse(txt)
      // 多数模型接口出错时返回 {error:{message}}：直接给用户看原因
      const msg = (() => { try { return JSON.parse(txt)?.error?.message } catch { return undefined } })()
      const err = new Error(msg ?? `模型接口返回 ${res.status}：${txt.slice(0, 300)}`) as Error & { status?: number }
      err.status = res.status
      if (res.status === 429 || res.status >= 500) { lastErr = err; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue }
      throw err
    } catch (e) {
      if (signal?.aborted) throw new Error('已停止')
      if ((e as any)?.status && (e as any).status < 500 && (e as any).status !== 429) throw e
      lastErr = e
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  throw lastErr
}

async function chatOpenAI(cfg: ModelConfig, msgs: Msg[], o: ChatOpts): Promise<ChatResult> {
  const messages = msgs.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    if (m.role === 'assistant')
      return {
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) } : {}),
      }
    return { role: m.role, content: m.content }
  })
  const body: any = { model: cfg.model, messages, temperature: o.temperature ?? 0.2, max_tokens: o.maxTokens ?? 4096 }
  if (o.tools?.length) body.tools = o.tools.map((t) => ({ type: 'function', function: t }))
  if (o.json) body.response_format = { type: 'json_object' }
  const headers = { authorization: `Bearer ${cfg.apiKey}`, ...cfg.headers }
  let data: any
  try {
    data = await post(openaiUrl(cfg.baseURL), headers, body, o.signal)
  } catch (e) {
    if (o.json && (e as any)?.status === 400) {
      delete body.response_format
      data = await post(openaiUrl(cfg.baseURL), headers, body, o.signal)
    } else throw e
  }
  const msg = data.choices?.[0]?.message ?? {}
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function?.name, args: safeJson(t.function?.arguments) ?? {} }))
  return { text: msg.content ?? '', toolCalls, usage: { in: data.usage?.prompt_tokens ?? 0, out: data.usage?.completion_tokens ?? 0 } }
}

async function chatAnthropic(cfg: ModelConfig, msgs: Msg[], o: ChatOpts): Promise<ChatResult> {
  const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const out: any[] = []
  for (const m of msgs) {
    if (m.role === 'system') continue
    let role = m.role === 'assistant' ? 'assistant' : 'user'
    let blocks: any[]
    if (m.role === 'tool') blocks = [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
    else blocks = m.content ? [{ type: 'text', text: m.content }] : []
    if (m.role === 'assistant' && m.toolCalls?.length) blocks.push(...m.toolCalls.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.args ?? {} })))
    const prev = out[out.length - 1]
    if (prev && prev.role === role) prev.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  const body: any = { model: cfg.model, system: system || undefined, messages: out, max_tokens: o.maxTokens ?? 4096, temperature: o.temperature ?? 0.2 }
  if (o.tools?.length) body.tools = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  const data = await post(
    anthropicUrl(cfg.baseURL),
    { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body,
    o.signal,
  )
  const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  const toolCalls = (data.content ?? []).filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, args: b.input }))
  return { text, toolCalls, usage: { in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0 } }
}

export async function chat(cfg: ModelConfig, msgs: Msg[], o: ChatOpts = {}): Promise<ChatResult> {
  if (!cfg.apiKey && !isLocalModel(cfg.baseURL)) throw new Error('还没有配置模型 API Key，请在「设置 → 模型」里填写')
  const t = Date.now()
  let r: ChatResult
  try {
    r = cfg.provider === 'anthropic' ? await chatAnthropic(cfg, msgs, o) : await chatOpenAI(cfg, msgs, o)
  } catch (e) {
    timing.addLlm({ tag: o.tag ?? 'chat', model: cfg.model, ms: Date.now() - t, in: 0, out: 0, attempts: lastAttempts, ok: false })
    throw e
  }
  timing.addLlm({ tag: o.tag ?? 'chat', model: cfg.model, ms: Date.now() - t, in: r.usage.in, out: r.usage.out, attempts: lastAttempts, ok: true })
  usage.calls++
  usage.inTok += r.usage.in
  usage.outTok += r.usage.out
  return r
}

export function safeJson(s: unknown): any {
  if (typeof s !== 'string') return s
  try {
    return JSON.parse(s)
  } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) try { return JSON.parse(fenced[1]) } catch {}
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) try { return JSON.parse(s.slice(a, b + 1)) } catch {}
  return null
}

/** 要求 JSON 输出；解析失败时把错误反馈给模型重试一次 */
export async function chatJson<T>(cfg: ModelConfig, msgs: Msg[], o: ChatOpts = {}): Promise<T> {
  const r = await chat(cfg, msgs, { ...o, json: true })
  const j = safeJson(r.text)
  if (j) return j as T
  const r2 = await chat(cfg, [...msgs, { role: 'assistant', content: r.text }, { role: 'user', content: '上面的输出不是合法 JSON。请只输出一个合法的 JSON 对象。' }], { ...o, json: true, tag: (o.tag ?? 'json') + ':retry' })
  const j2 = safeJson(r2.text)
  if (!j2) throw new Error('模型没有返回合法 JSON')
  return j2 as T
}
