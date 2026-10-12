import { useEffect, useState } from 'react'
import type { ApplyRecord, QA, Settings } from '../shared/types'
import { defaultSettings, store } from '../shared/storage'
import { Icon } from '../shared/icons'
import { IconButton, Select } from '../shared/ui'
import { ago } from './Archives'
import { ModelCard } from './ModelCard'

export function QATab({ archiveId, onDirty }: { archiveId: string; onDirty?: (d: boolean) => void }) {
  const [list, setList] = useState<QA[]>([])
  const [dirty, setDirty] = useState(false)
  useEffect(() => { store.qa(archiveId).then(setList); setDirty(false) }, [archiveId])
  useEffect(() => { onDirty?.(dirty) }, [dirty])
  const [added, setAdded] = useState(-1)
  const upd = (l: QA[]) => { setList(l); setDirty(true) }
  const edit = (i: number, patch: Partial<QA>) => { const l = [...list]; l[i] = { ...l[i], ...patch, updatedAt: Date.now() }; upd(l) }
  const add = () => { setAdded(list.length); upd([...list, { q: '', a: '', source: 'user', updatedAt: Date.now() }]) }
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">全部问答</div>
            <div className="card-desc">共 {list.length} 条，可以直接修改；没有填问题的条目不会保存。</div>
          </div>
          <button className="btn small" onClick={add}><Icon name="plus" size={14} />添加问答</button>
        </div>
        {list.length === 0 ? (
          <div className="empty">
            <Icon name="message-square-text" size={22} />
            <span>还没有问答。填写时被问到的问题会自动存到这里，也可以手动添加。</span>
          </div>
        ) : (
          <div className="qa-list">
            {list.map((x, i) => (
              <div className="qa-item" key={i}>
                <div className="qa-body">
                  <input className="qa-q" autoFocus={i === added} value={x.q} placeholder="问题，例如：是否接受调剂" onChange={(e) => edit(i, { q: e.target.value })} />
                  <textarea rows={2} value={x.a} placeholder="回答" onChange={(e) => edit(i, { a: e.target.value })} />
                  <div className="qa-meta">
                    <span className={'pill ' + (x.source === 'learned' ? 'ai' : 'muted')}>{x.source === 'learned' ? '从你的修改中学到' : '你的回答'}</span>
                    <span>更新于 {ago(x.updatedAt)}</span>
                  </div>
                </div>
                <IconButton icon="trash" label="删除" variant="danger" onClick={() => upd(list.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="savebar"><button className="btn primary grow" disabled={!dirty} onClick={async () => { await store.saveQa(list.filter((x) => x.q), archiveId); setDirty(false) }}>{dirty ? '保存' : '已保存'}</button></div>
    </div>
  )
}

export function SettingsTab() {
  const [s, setS] = useState<Settings>(defaultSettings())
  const [msg, setMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  useEffect(() => { store.settings().then(setS) }, [])
  const upd = (v: Settings) => { setS(v); setDirty(true); setMsg('') }
  const save = async () => { await store.saveSettings(s); setDirty(false); setMsg('已保存') }
  const exportAll = async () => {
    const all = await chrome.storage.local.get(null)
    const data = Object.fromEntries(Object.entries(all).filter(([k]) => k === 'archives' || k === 'activeArchive' || k === 'applications' || /^(profile|qa|files|file):/.test(k)))
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = '新新闪投-备份.json'
    a.click()
  }
  const importAll = async (f: File) => {
    const data = JSON.parse(await f.text())
    if (data.archives) {
      // 新版备份：档案原样合并进来（同 id 覆盖）
      const { list } = await store.archives()
      const ids = new Set(list.map((a) => a.id))
      const merged = [...list, ...(data.archives as { id: string }[]).filter((a) => !ids.has(a.id))]
      const rest = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'archives' && k !== 'activeArchive'))
      if (data.applications) {
        // 投递记录按网址合并，本机已有的保留
        const mine = await store.applications()
        const urls = new Set(mine.map((r) => r.url))
        rest.applications = [...mine, ...(data.applications as ApplyRecord[]).filter((r) => !urls.has(r.url))].sort((a, b) => b.updatedAt - a.updatedAt)
      }
      await chrome.storage.local.set({ ...rest, archives: merged })
    } else {
      // 旧版备份（单份资料）：导入成一个新档案
      const profile = data.profile ?? (data.basics ? data : null)
      if (profile) {
        const id = await store.createArchive('导入的档案')
        await store.saveProfile(profile, id)
        if (data.qa) await store.saveQa(data.qa, id)
      }
    }
    setMsg('已导入，刷新本页生效')
  }

  return (
    <div className="stack">
      <ModelCard s={s} upd={upd} />
      <div className="card">
        <div className="card-title">行为</div>
        <div className="muted small">插件只负责填写，永远不会自动点击最终「提交」，提交前请自己检查一遍。</div>
        <div className="kv-row"><span>真实输入</span>
          <Select value={s.trustedInput} options={[{ value: 'auto', label: '自动（合成事件无效时升级）' }, { value: 'always', label: '总是使用' }, { value: 'off', label: '关闭' }]} onChange={(v) => upd({ ...s, trustedInput: v as Settings['trustedInput'] })} />
        </div>
        <div className="muted small">真实输入通过浏览器调试接口发送真实鼠标键盘事件，期间 Chrome 顶部会显示"正在调试"提示条，填完自动消失。</div>
        <div className="kv-row"><span>修复轮数上限</span>
          <input type="number" min={0} max={20} value={s.maxRepairRounds} onChange={(e) => upd({ ...s, maxRepairRounds: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} />
        </div>
        <div className="muted small">批量填写后还有没填上的字段时，AI 会看现场换方法再试，最多试这么多轮。轮数越多越可能填全，也越耗 token。</div>
      </div>
      <div className="card">
        <div className="card-title">备份</div>
        <div className="row">
          <button className="btn" onClick={exportAll}><Icon name="download" size={14} />导出全部档案和投递记录</button>
          <label className="btn"><Icon name="upload" size={14} />导入<input type="file" hidden accept=".json" onChange={(e) => e.target.files?.[0] && importAll(e.target.files[0])} /></label>
        </div>
      </div>
      {msg && <div className="status">{msg}</div>}
      <div className="savebar"><button className="btn primary grow" disabled={!dirty} onClick={save}>{dirty ? '保存设置' : '已保存'}</button></div>
    </div>
  )
}
