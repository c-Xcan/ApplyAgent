import { useState } from 'react'
import type { Archive } from '../shared/types'
import { store } from '../shared/storage'
import { Icon } from '../shared/icons'
import { IconButton } from '../shared/ui'

export const ago = (t: number) => {
  const d = Date.now() - t
  if (d < 60_000) return '刚刚'
  if (d < 3600_000) return Math.floor(d / 60_000) + '分钟前'
  if (d < 86400_000) return Math.floor(d / 3600_000) + '小时前'
  return new Date(t).toLocaleDateString()
}

/** 档案切换：新建 / 复制 / 重命名 / 删除。资料和问答库都跟着当前档案走 */
export function Archives({ list, active, onChange, guard }: { list: Archive[]; active: string; onChange: () => void; guard: () => boolean }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')

  const use = async (id: string) => {
    if (id === active || !guard()) return
    await store.setActive(id)
    onChange()
  }
  const create = async () => {
    if (!guard()) return
    await store.createArchive(`新档案 ${list.length + 1}`)
    onChange()
  }
  const copy = async (a: Archive) => {
    if (!guard()) return
    await store.createArchive(a.name + ' 副本', a.id)
    onChange()
  }
  const remove = async (a: Archive) => {
    if (!confirm(`删除档案「${a.name}」？里面的资料、问答库和附件都会删除，不能恢复。`)) return
    await store.deleteArchive(a.id)
    onChange()
  }
  const rename = async (id: string) => {
    if (name.trim()) await store.renameArchive(id, name.trim())
    setEditing(null)
    onChange()
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">资料档案</div>
          <div className="card-desc">点击卡片切换档案，资料和问答库都会跟着切换。</div>
        </div>
        <button className="btn small" onClick={create}><Icon name="plus" size={14} />新建档案</button>
      </div>
      <div className="archives">
        {list.map((a) => (
          <div key={a.id} className={'archive' + (a.id === active ? ' active' : '')} onClick={() => use(a.id)}>
            <div className="archive-avatar">{(a.name.trim()[0] ?? '档').toUpperCase()}</div>
            <div className="archive-title">
              {editing === a.id ? (
                <input
                  autoFocus
                  className="archive-input"
                  value={name}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => rename(a.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(a.id); if (e.key === 'Escape') setEditing(null) }}
                />
              ) : (
                <b className="archive-name" title={a.name}>{a.name}</b>
              )}
            </div>
            <div className="archive-meta">
              {a.id === active && <span className="pill ok"><Icon name="check" size={12} />使用中</span>}
              <span>更新于 {ago(a.updatedAt)}</span>
            </div>
            <span className="archive-actions" onClick={(e) => e.stopPropagation()}>
              <IconButton icon="pencil" label="重命名" onClick={() => { setEditing(a.id); setName(a.name) }} />
              <IconButton icon="copy" label="复制档案" onClick={() => copy(a)} />
              <IconButton icon="trash" label={list.length <= 1 ? '至少保留一个档案' : '删除档案'} variant="danger" disabled={list.length <= 1} onClick={() => remove(a)} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
