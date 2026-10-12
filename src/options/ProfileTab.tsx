import { useEffect, useState } from 'react'
import { emptyProfile, type Dict, type Profile, type StoredFile } from '../shared/types'
import { store } from '../shared/storage'
import { Icon } from '../shared/icons'
import { IconButton } from '../shared/ui'
import { FILE_KIND as KIND, LABELS as L, LONG_FIELDS as LONG, SECTIONS } from '../shared/profile-schema'
import { PdfPreview, isPdf } from '../shared/pdf'
import { docxText, pdfText, toBase64 } from './extract'

const str = (v: unknown) => (Array.isArray(v) ? v.join('、') : v == null ? '' : String(v))
const parse = (k: string, s: string): unknown => (['cities', 'positions', 'tech'].includes(k) ? s.split(/[、,，]\s*/).filter(Boolean) : s)

function KV({ value, fields, onChange }: { value: Dict; fields: string[]; onChange: (v: Dict) => void }) {
  const keys = Array.from(new Set([...fields, ...Object.keys(value)]))
  const [newKey, setNewKey] = useState('')
  const add = () => {
    const k = newKey.trim()
    if (!k) return
    if (!(k in value) && !fields.includes(k)) onChange({ ...value, [k]: '' })
    setNewKey('')
  }
  /** 自己新增的项可以删掉（内置的项不能删，清空即可） */
  const remove = (k: string) => {
    const { [k]: _, ...rest } = value
    onChange(rest)
  }
  return (
    <div className="fields">
      {keys.map((k) => (
        <label key={k} className={LONG.has(k) ? 'field long' : 'field'}>
          <span className="field-name">
            {L[k] ?? k}
            {!fields.includes(k) && <span onClick={(e) => e.preventDefault()}><IconButton icon="trash" label={`删除「${k}」这一项`} variant="danger" onClick={() => remove(k)} /></span>}
          </span>
          {LONG.has(k) ? (
            <textarea rows={3} value={str(value[k])} onChange={(e) => onChange({ ...value, [k]: parse(k, e.target.value) })} />
          ) : (
            <input value={str(value[k])} onChange={(e) => onChange({ ...value, [k]: parse(k, e.target.value) })} />
          )}
        </label>
      ))}
      <div className="row field-add">
        <input className="grow" placeholder="新增一项（如：身高、紧急联系人）" value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn small" disabled={!newKey.trim()} onClick={add}><Icon name="plus" size={14} />添加</button>
      </div>
    </div>
  )
}

export function ProfileTab({ archiveId, onDirty }: { archiveId: string; onDirty?: (d: boolean) => void }) {
  const [p, setP] = useState<Profile>(emptyProfile())
  const [files, setFiles] = useState<StoredFile[]>([])
  const [preview, setPreview] = useState<StoredFile | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [open, setOpen] = useState<string>('basics')

  useEffect(() => {
    store.profile(archiveId).then(setP)
    store.files(archiveId).then(setFiles)
  }, [archiveId])
  useEffect(() => { onDirty?.(dirty) }, [dirty])
  const update = (next: Profile) => { setP(next); setDirty(true) }
  const save = async () => { await store.saveProfile(p, archiveId); setDirty(false); setMsg('已保存') }

  const importResume = async (file: File) => {
    setBusy(true)
    setMsg('正在读取简历…')
    try {
      const buf = await file.arrayBuffer()
      const b64 = toBase64(buf) // 先存一份，避免解析过程中 buffer 被转移
      const kind = /\.pdf$/i.test(file.name) ? 'pdf' : /\.docx$/i.test(file.name) ? 'docx' : 'txt'
      const text = kind === 'pdf' ? await pdfText(buf) : kind === 'docx' ? await docxText(buf) : new TextDecoder().decode(buf)
      const meta: StoredFile = { id: 'f' + Date.now().toString(36), name: file.name, kind: 'resume', mime: file.type || 'application/octet-stream', size: file.size }
      await store.addFile(meta, b64, archiveId)
      setFiles(await store.files(archiveId))
      setMsg('AI 正在解析简历（约 10~30 秒）…')
      const r = await chrome.runtime.sendMessage({ t: 'resume.parse', text })
      if (!r?.ok) throw new Error(r?.error ?? '解析失败')
      const parsed = r.profile as Partial<Profile>
      const merged: Profile = { ...emptyProfile(), ...p }
      for (const [k, v] of Object.entries(parsed)) {
        if (v == null) continue
        const cur = (merged as any)[k]
        ;(merged as any)[k] = Array.isArray(v) ? (v.length ? v : cur) : typeof v === 'object' ? { ...cur, ...Object.fromEntries(Object.entries(v as Dict).filter(([, x]) => x !== '' && x != null)) } : v
      }
      merged.resumeText = text
      update(merged)
      setMsg('解析完成，请检查后点「保存」')
    } catch (e) {
      setMsg('出错：' + (e as Error).message)
    }
    setBusy(false)
  }

  const addAttachment = async (file: File, kind: StoredFile['kind']) => {
    const meta: StoredFile = { id: 'f' + Date.now().toString(36), name: file.name, kind, mime: file.type || 'application/octet-stream', size: file.size }
    await store.addFile(meta, toBase64(await file.arrayBuffer()), archiveId)
    setFiles(await store.files(archiveId))
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title"><span className="row"><Icon name="file-up" size={16} />从简历导入</span></div>
        <div className="muted small">上传 PDF / DOCX，AI 自动整理成资料；简历文件同时保存为附件，网申时自动上传。</div>
        <input type="file" accept=".pdf,.docx,.txt" disabled={busy} onChange={(e) => e.target.files?.[0] && importResume(e.target.files[0])} />
        {msg && <div className="status">{busy && <span className="spinner" />}{msg}</div>}
      </div>

      {SECTIONS.map((s) => (
        <div className="card" key={s.key}>
          <div className="card-title clickable" onClick={() => setOpen(open === s.key ? '' : s.key)}>
            {s.title}
            <span className="row muted small">{s.kind === 'list' ? `${(p[s.key] as Dict[]).length} 条` : ''}<Icon name="chevron-down" size={15} className={'chev' + (open === s.key ? ' open' : '')} /></span>
          </div>
          {open === s.key && s.kind === 'obj' && <KV value={p[s.key] as Dict} fields={s.fields} onChange={(v) => update({ ...p, [s.key]: v })} />}
          {open === s.key && s.kind === 'tags' && (
            <textarea rows={3} value={(p.skills ?? []).join('、')} placeholder="用顿号或逗号分隔" onChange={(e) => update({ ...p, skills: e.target.value.split(/[、,，]\s*/).filter(Boolean) })} />
          )}
          {open === s.key && s.kind === 'list' && (
            <div className="stack">
              {(p[s.key] as Dict[]).map((item, i) => (
                <div className="sub" key={i}>
                  <div className="row between">
                    <b>#{i + 1}</b>
                    <span>
                      {i > 0 && <IconButton icon="arrow-up" label="上移" onClick={() => { const a = [...(p[s.key] as Dict[])]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; update({ ...p, [s.key]: a }) }} />}
                      <IconButton icon="trash" label="删除这一条" variant="danger" onClick={() => update({ ...p, [s.key]: (p[s.key] as Dict[]).filter((_, j) => j !== i) })} />
                    </span>
                  </div>
                  <KV value={item} fields={s.fields} onChange={(v) => { const a = [...(p[s.key] as Dict[])]; a[i] = v; update({ ...p, [s.key]: a }) }} />
                </div>
              ))}
              <button className="btn dashed" onClick={() => update({ ...p, [s.key]: [...(p[s.key] as Dict[]), {}] })}><Icon name="plus" size={14} />添加一条</button>
            </div>
          )}
        </div>
      ))}

      <div className="card">
        <div className="card-head"><div><div className="card-title">附件</div><div className="card-desc">网申时自动上传到对应的上传框。</div></div></div>
        {files.map((f) => (
          <div className="file-row" key={f.id}>
            <Icon name={f.kind === 'resume' ? 'file-text' : 'paperclip'} size={16} className="muted" />
            <span className="grow">{f.name} <span className="muted small">{KIND[f.kind] ?? f.kind} · {(f.size / 1024).toFixed(0)}KB</span></span>
            {isPdf(f) && <button className="btn small" onClick={() => setPreview(f)}><Icon name="file-text" size={14} />预览</button>}
            <IconButton icon="trash" label="删除附件" variant="danger" onClick={async () => { await store.removeFile(f.id, archiveId); setFiles(await store.files(archiveId)) }} />
          </div>
        ))}
        <div className="row">
          {(['resume', 'photo', 'transcript', 'certificate', 'other'] as const).map((k) => (
            <label key={k} className="btn small">
              <Icon name="upload" size={14} />{KIND[k]}
              <input type="file" hidden onChange={(e) => e.target.files?.[0] && addAttachment(e.target.files[0], k)} />
            </label>
          ))}
        </div>
      </div>

      {preview && <PdfPreview file={preview} onClose={() => setPreview(null)} />}

      <div className="savebar">
        <button className="btn primary grow" disabled={!dirty} onClick={save}>{dirty ? '保存资料' : '已保存'}</button>
      </div>
    </div>
  )
}
