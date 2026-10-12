import { useEffect, useState } from 'react'
import type { ApplyRecord } from '../shared/types'
import { store } from '../shared/storage'
import { Icon } from '../shared/icons'
import { IconButton } from '../shared/ui'
import { ago } from './Archives'

function exportCsv(list: ApplyRecord[]) {
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const date = (t: number) => new Date(t).toLocaleString()
  const rows = [
    ['页面标题', '网址', '使用档案', '首次填写', '最近填写', '填写次数', '没填上的字段', '备注'],
    ...list.map((r) => [r.title, r.url, r.archiveName, date(r.createdAt), date(r.updatedAt), r.fills, r.failed.join('、'), r.note]),
  ]
  const blob = new Blob(['\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `投递记录-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
}

export function RecordsTab() {
  const [list, setList] = useState<ApplyRecord[]>([])
  const [q, setQ] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})

  useEffect(() => {
    store.applications().then(setList)
    const onChanged = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.applications) setList((c.applications.newValue as ApplyRecord[] | undefined) ?? [])
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const kw = q.trim().toLowerCase()
  const shown = kw ? list.filter((r) => [r.title, r.host, r.note, r.archiveName].some((s) => s?.toLowerCase().includes(kw))) : list
  const saveNote = (r: ApplyRecord) => {
    const v = notes[r.id]
    if (v !== undefined && v !== (r.note ?? '')) store.updateNote(r.id, v)
  }
  const remove = (r: ApplyRecord) => confirm(`删除「${r.title || r.host}」这条记录？`) && store.removeApplications([r.id])
  const clear = () => confirm(`删除下面列出的 ${shown.length} 条记录？不能恢复。`) && store.removeApplications(shown.map((r) => r.id))

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div className="row grow">
            <input className="rec-search" value={q} placeholder="搜索标题、网址、备注…" onChange={(e) => setQ(e.target.value)} />
            <span className="muted small">{kw ? `找到 ${shown.length} 条，共 ${list.length} 条` : `共 ${list.length} 条`}</span>
          </div>
          <div className="row">
            <button className="btn small" disabled={!shown.length} onClick={() => exportCsv(shown)}><Icon name="download" size={14} />导出表格</button>
            <button className="btn small outline-danger" disabled={!shown.length} onClick={clear}><Icon name="trash" size={14} />清空</button>
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="empty">
            <Icon name="send" size={22} />
            <span>{list.length ? '没有符合条件的记录。' : '还没有投递记录。在侧边栏填写一个网申页面后，这里会自动记下来。'}</span>
          </div>
        ) : (
          <div className="rec-list">
            {shown.map((r) => (
              <div className="rec-item" key={r.id}>
                <div className="rec-avatar">{(r.host.replace(/^www\./, '')[0] ?? '?').toUpperCase()}</div>
                <div className="rec-body">
                  <a className="rec-title" href={r.url} target="_blank" rel="noreferrer" title={r.url}>{r.title || r.host}</a>
                  <div className="rec-meta">
                    <span>{r.host}</span>
                    {r.archiveName && <span>档案：{r.archiveName}</span>}
                    <span title={new Date(r.updatedAt).toLocaleString()}>最近填写 {ago(r.updatedAt)}</span>
                    {r.fills > 1 && <span>共填写 {r.fills} 次</span>}
                  </div>
                  <div className="rec-meta">
                    {(r.counts.filled ?? 0) + (r.counts['already-correct'] ?? 0) > 0 && <span className="pill ok">已填 {(r.counts.filled ?? 0) + (r.counts['already-correct'] ?? 0)}</span>}
                    {!!r.counts.generated && <span className="pill ai">AI 撰写 {r.counts.generated}</span>}
                    {!!r.failed.length && <span className="pill bad" title={r.failed.join('、')}>没填上 {r.failed.length}：{r.failed.slice(0, 3).join('、')}{r.failed.length > 3 ? '…' : ''}</span>}
                  </div>
                  <input className="rec-note" value={notes[r.id] ?? r.note ?? ''} placeholder="添加备注，例如岗位、笔试时间…" onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} onBlur={() => saveNote(r)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                </div>
                <IconButton icon="trash" label="删除记录" variant="danger" onClick={() => remove(r)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
