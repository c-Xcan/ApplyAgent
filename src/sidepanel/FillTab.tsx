import { useEffect, useState } from 'react'
import { Icon } from '../shared/icons'
import type { ConfirmDecision, FieldOutcome, RunEvent } from '../shared/types'
import { IconButton, copyText, toast } from '../shared/ui'

const STATUS: Record<string, [string, string]> = {
  filled: ['已填', 'ok'],
  generated: ['AI 撰写', 'ai'],
  'already-correct': ['已正确', 'ok'],
  failed: ['失败', 'bad'],
  skipped: ['跳过', 'muted'],
  asked: ['待回答', 'warn'],
  pending: ['待填写', 'warn'],
}

function show(v: unknown) {
  if (v == null || v === '') return '—'
  if (Array.isArray(v)) return v.join(' / ')
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}

/** 没填上、但有应填值的字段：可以一键复制，手动粘贴 */
const copyable = (o: FieldOutcome) => o.status === 'failed' && o.op !== 'upload' && o.planned != null && o.planned !== '' && !(Array.isArray(o.planned) && o.planned.every((x) => !x))

export function FillTab({ tabId }: { tabId: number | null }) {
  const [events, setEvents] = useState<RunEvent[]>([])
  const [running, setRunning] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, { use: boolean; value: string }>>({})

  useEffect(() => {
    if (tabId == null) return
    setEvents([])
    setRunning(false)
    chrome.runtime.sendMessage({ t: 'run.state', tabId }).then((r) => {
      setEvents(r?.events ?? [])
      setRunning(!!r?.running)
    }, () => {})
    // 后台 service worker 可能被浏览器回收，连接断了就重连，日志不会断
    let port: chrome.runtime.Port | null = null
    let closed = false
    const onMsg = (m: { t: string; tabId: number; event: RunEvent }) => {
      if (m.tabId !== tabId) return
      setEvents((ev) => {
        const next = m.event.kind === 'outcomes' ? ev.filter((e) => e.kind !== 'outcomes') : ev
        return [...next, m.event]
      })
      if (m.event.kind === 'done') setRunning(false)
    }
    const connect = () => {
      if (closed) return
      port = chrome.runtime.connect({ name: 'panel' })
      port.onMessage.addListener(onMsg)
      port.onDisconnect.addListener(() => setTimeout(connect, 500))
    }
    connect()
    return () => {
      closed = true
      port?.disconnect()
    }
  }, [tabId])

  const start = async () => {
    if (tabId == null) return
    setEvents([])
    setRunning(true)
    const r = await chrome.runtime.sendMessage({ t: 'run.start', tabId })
    setDrafts({})
    if (!r?.ok) {
      setRunning(false)
      setEvents([{ kind: 'log', level: 'error', text: r?.error ?? '启动失败' }])
    }
  }
  const stop = () => {
    setRunning(false) // 立即恢复界面，不等后台收尾
    chrome.runtime.sendMessage({ t: 'run.stop', tabId }).catch(() => {})
  }
  const answer = (id: string, a: string) => {
    chrome.runtime.sendMessage({ t: 'run.answer', tabId, id, answer: a })
    setEvents((ev) => ev.filter((e) => !(e.kind === 'question' && e.id === id)))
  }

  const confirm = (id: string, items: { key: string; value: string }[], all?: boolean) => {
    const decisions: ConfirmDecision[] = items.map((it) => {
      const d = drafts[id + it.key]
      return { key: it.key, use: all ? true : d ? d.use : true, value: d?.value ?? it.value }
    })
    chrome.runtime.sendMessage({ t: 'run.confirm', tabId, id, decisions })
    setEvents((ev) => ev.filter((e) => !(e.kind === 'confirm' && e.id === id)))
  }

  const status = [...events].reverse().find((e) => e.kind === 'status') as Extract<RunEvent, { kind: 'status' }> | undefined
  const done = events.find((e) => e.kind === 'done') as Extract<RunEvent, { kind: 'done' }> | undefined
  const outcomes = ((events.find((e) => e.kind === 'outcomes') as any)?.outcomes ?? []) as FieldOutcome[]
  const confirms = events.filter((e) => e.kind === 'confirm') as Extract<RunEvent, { kind: 'confirm' }>[]
  const questions = events.filter((e) => e.kind === 'question') as Extract<RunEvent, { kind: 'question' }>[]
  const errors = events.filter((e) => e.kind === 'log' && e.level === 'error') as Extract<RunEvent, { kind: 'log' }>[]
  const copyField = async (o: FieldOutcome) => {
    const text = Array.isArray(o.planned) ? o.planned.join(o.op === 'date' ? ' ~ ' : '、') : show(o.planned)
    if (!(await copyText(text))) return toast('复制失败，请手动选中复制', 'bad')
    chrome.runtime.sendMessage({ t: 'highlight', tabId, ref: o.ref }) // 顺便在页面上定位到这个字段
    toast(`已复制「${text.length > 20 ? text.slice(0, 20) + '…' : text}」，粘贴到页面上高亮的「${o.label || o.ref}」`)
  }
  const counts = outcomes.reduce<Record<string, number>>((m, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {})

  return (
    <div className="stack">
      <div className="card hero">
        <div className="row">
          {running ? (
            <button className="btn outline-danger grow lg" onClick={stop}><Icon name="square" size={15} />停止</button>
          ) : (
            <button className="btn primary grow lg" onClick={start} disabled={tabId == null}><Icon name="play" size={15} />开始填写当前页面</button>
          )}
        </div>
        {running && status && <div className="status"><Icon name="loader-circle" size={15} className="spin" />{status.text}</div>}
        {done && <div className="status done"><Icon name="circle-check" size={15} />{done.summary}</div>}
        {!done && errors.map((e, i) => <div key={i} className="bad small">{e.text}</div>)}
      </div>

      {confirms.map((c) => (
        <div className="card question" key={c.id}>
          <div className="q-title"><Icon name="sparkles" size={15} />AI 根据你的资料推导出了这些答案，是否采用？</div>
          <div className="muted small">勾选的会填进表单并保存到问答库，以后遇到同样的问题直接使用、不再询问。可以直接改值。</div>
          {c.items.map((it) => {
            const d = drafts[c.id + it.key] ?? { use: true, value: it.value }
            const set = (v: Partial<typeof d>) => setDrafts({ ...drafts, [c.id + it.key]: { ...d, ...v } })
            return (
              <div className="confirm-row" key={it.key}>
                <input type="checkbox" checked={d.use} onChange={(e) => set({ use: e.target.checked })} />
                <div className="grow">
                  <div className="small"><b>{it.label}</b>{it.reason && <span className="muted"> · {it.reason}</span>}</div>
                  <input value={d.value} onChange={(e) => set({ value: e.target.value })} disabled={!d.use} />
                </div>
              </div>
            )
          })}
          <div className="row">
            <button className="btn primary grow" onClick={() => confirm(c.id, c.items, true)}>全部采用</button>
            <button className="btn grow" onClick={() => confirm(c.id, c.items)}>按勾选采用</button>
          </div>
        </div>
      ))}

      {questions.map((q) => (
        <div className="card question" key={q.id}>
          <div className="q-title"><Icon name="message-square-text" size={15} />需要你回答{q.label ? `（${q.label}）` : ''}</div>
          <div className="q-text">{q.question}</div>
          {q.options?.length ? (
            <div className="chips">
              {q.options.map((o) => (
                <button key={o} className="chip" onClick={() => answer(q.id, o)}>{o}</button>
              ))}
            </div>
          ) : null}
          <div className="row">
            <input className="grow" placeholder="输入回答…" value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && answers[q.id] && answer(q.id, answers[q.id])} />
            <button className="btn primary" disabled={!answers[q.id]} onClick={() => answer(q.id, answers[q.id])}>确定</button>
            <button className="btn" onClick={() => answer(q.id, '')}>跳过</button>
          </div>
          <div className="muted small">回答会保存到问答库，以后其他站点遇到同样的问题会直接使用。</div>
        </div>
      ))}

      {outcomes.length > 0 && (
        <div className="card">
          <div className="card-title">
            字段（{outcomes.length}）
            <span className="counts">
              {Object.entries(counts).map(([k, n]) => (
                <span key={k} className={'pill ' + (STATUS[k]?.[1] ?? '')}>{STATUS[k]?.[0] ?? k} {n}</span>
              ))}
            </span>
          </div>
          <div className="table">
            {outcomes.map((o) => (
              <div key={o.ref} className="tr" onClick={() => chrome.runtime.sendMessage({ t: 'highlight', tabId, ref: o.ref })} title={o.note ?? ''}>
                <div className="td label">
                  {o.label || o.ref}
                  {o.section && <div className="muted small">{o.section}</div>}
                </div>
                <div className="td value">{show(o.actual ?? o.planned)}{o.status === 'failed' && o.planned !== undefined && o.actual !== undefined && <div className="muted small">应填：{show(o.planned)}</div>}{o.status === 'failed' && o.note && <div className="bad small">{o.note}</div>}</div>
                <div className="td status-cell">
                  <span className={'pill ' + (STATUS[o.status]?.[1] ?? '')}>{STATUS[o.status]?.[0] ?? o.status}</span>
                  {copyable(o) && <span onClick={(e) => e.stopPropagation()}><IconButton icon="copy" label="复制应填的值，手动粘贴" onClick={() => copyField(o)} /></span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
