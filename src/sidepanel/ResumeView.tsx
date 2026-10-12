// 侧边栏里查看当前档案的简历：资料逐项展示、每项可复制（自动填不进去时手动粘贴）；PDF 原件可切换查看、可选中文字。
import { useEffect, useState } from 'react'
import { Icon } from '../shared/icons'
import { PdfPages, isPdf, type PdfInfo } from '../shared/pdf'
import { LABELS, LONG_FIELDS, SECTIONS, valueText } from '../shared/profile-schema'
import { store } from '../shared/storage'
import type { Dict, Profile, QA, StoredFile } from '../shared/types'
import { IconButton, Select, copyText, toast } from '../shared/ui'

async function copy(text: string, what: string) {
  if (!(await copyText(text))) return toast('复制失败，请手动选中复制', 'bad')
  toast(`已复制${what}`)
}

/** 有值的键：内置字段按固定顺序在前，自己加的项在后 */
const filledKeys = (obj: Dict, fields: string[]) =>
  Array.from(new Set([...fields, ...Object.keys(obj)])).filter((k) => valueText(obj[k]).trim())

const itemText = (obj: Dict, fields: string[]) => filledKeys(obj, fields).map((k) => `${LABELS[k] ?? k}：${valueText(obj[k])}`).join('\n')

function Row({ k, value }: { k: string; value: unknown }) {
  const label = LABELS[k] ?? k
  const text = valueText(value)
  return (
    <div className={'rv-row' + (LONG_FIELDS.has(k) || text.length > 40 ? ' long' : '')}>
      <span className="rv-label">{label}</span>
      <span className="rv-value">{text}</span>
      <IconButton icon="copy" label={`复制${label}`} onClick={() => copy(text, `「${label}」`)} />
    </div>
  )
}

function Fields({ obj, fields }: { obj: Dict; fields: string[] }) {
  return <div className="rv-rows">{filledKeys(obj, fields).map((k) => <Row key={k} k={k} value={obj[k]} />)}</div>
}

function ProfileContent({ p }: { p: Profile }) {
  const sections = SECTIONS.filter((s) => {
    const v = p[s.key]
    if (s.kind === 'list') return (v as Dict[]).some((it) => filledKeys(it, s.fields).length)
    if (s.kind === 'tags') return (v as string[]).length > 0
    return filledKeys(v as Dict, s.fields).length > 0
  })
  if (!sections.length && !p.resumeText) {
    return <div className="card empty">这个档案还没有资料。点右上角的设置按钮，到「资料档案」里上传简历或手动填写。</div>
  }
  return (
    <>
      {sections.map((s) => (
        <div className="card rv-section" key={s.key}>
          <div className="card-title">
            {s.title}
            {s.kind === 'list' && <span className="muted small">{(p[s.key] as Dict[]).length} 条</span>}
          </div>
          {s.kind === 'obj' && <Fields obj={p[s.key] as Dict} fields={s.fields} />}
          {s.kind === 'tags' && (
            <>
              <div className="chips">
                {p.skills.map((t) => <button key={t} className="chip" title="点击复制" onClick={() => copy(t, `「${t}」`)}>{t}</button>)}
              </div>
              <div><button className="btn small" onClick={() => copy(p.skills.join('、'), '全部技能')}><Icon name="copy" size={14} />复制全部</button></div>
            </>
          )}
          {s.kind === 'list' && (p[s.key] as Dict[]).map((it, i) => filledKeys(it, s.fields).length > 0 && (
            <div className="sub" key={i}>
              <div className="row between">
                <b>#{i + 1}</b>
                <IconButton icon="copy" label="复制这一条的全部内容" onClick={() => copy(itemText(it, s.fields), `${s.title} #${i + 1}`)} />
              </div>
              <Fields obj={it} fields={s.fields} />
            </div>
          ))}
        </div>
      ))}
      {p.resumeText && (
        <div className="card rv-section">
          <div className="card-title">
            简历原文
            <IconButton icon="copy" label="复制简历原文" onClick={() => copy(p.resumeText!, '简历原文')} />
          </div>
          <details>
            <summary>展开（上传简历时提取出的全部文字，{p.resumeText.length} 字）</summary>
            <div className="rv-raw">{p.resumeText}</div>
          </details>
        </div>
      )}
    </>
  )
}

function PdfTab({ files }: { files: StoredFile[] }) {
  const [id, setId] = useState(files[0]?.id ?? '')
  const [info, setInfo] = useState<PdfInfo>({ msg: '' })
  useEffect(() => {
    if (!files.some((f) => f.id === id)) setId(files[0]?.id ?? '')
  }, [files])
  const file = files.find((f) => f.id === id)
  if (!file) return <div className="card empty">这个档案没有 PDF 格式的简历附件。到「资料档案」的附件里上传简历 PDF 后可以在这里查看。</div>
  return (
    <div className="stack">
      {files.length > 1 && <Select icon="file-text" value={id} options={files.map((f) => ({ value: f.id, label: f.name }))} onChange={setId} />}
      <div className="row between">
        <span className="muted small grow">{info.msg}</span>
        {info.url && <a className="btn small" href={info.url} target="_blank" rel="noreferrer">在新标签页打开</a>}
      </div>
      <div className="rv-pdf"><PdfPages key={file.id} fileId={file.id} onInfo={setInfo} /></div>
    </div>
  )
}

function QaTab({ qa }: { qa: QA[] }) {
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const shown = (kw ? qa.filter((x) => (x.q + '\n' + x.a).toLowerCase().includes(kw)) : qa).slice().sort((a, b) => b.updatedAt - a.updatedAt)
  if (!qa.length) return <div className="card empty">问答库还是空的。填写时遇到资料里没有的问题会问你，回答会自动存到这里。</div>
  return (
    <div className="stack">
      {qa.length > 6 && <input placeholder={`搜索问题或回答（共 ${qa.length} 条）`} value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="card rv-section">
        {shown.length ? shown.map((x) => (
          <div className="rv-qa" key={x.q}>
            <div className="rv-qa-q">{x.q}{x.source === 'learned' && <span className="pill muted">学习所得</span>}</div>
            <div className="rv-qa-a">
              <span className="rv-value">{x.a}</span>
              <IconButton icon="copy" label="复制回答" onClick={() => copy(x.a, '回答')} />
            </div>
          </div>
        )) : <div className="muted small">没有匹配的问答</div>}
      </div>
    </div>
  )
}

const TABS = [
  ['content', '资料内容', 'user-round'],
  ['qa', '问答库', 'message-square-text'],
  ['pdf', 'PDF 原件', 'file-text'],
] as const

export function ResumeView({ archiveId }: { archiveId: string }) {
  const [p, setP] = useState<Profile | null>(null)
  const [files, setFiles] = useState<StoredFile[]>([])
  const [qa, setQa] = useState<QA[]>([])
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('content')

  useEffect(() => {
    const load = () => {
      store.profile(archiveId).then(setP)
      store.files(archiveId).then(setFiles)
      store.qa(archiveId).then(setQa)
    }
    load()
    const onChanged = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c['profile:' + archiveId] || c['files:' + archiveId] || c['qa:' + archiveId]) load()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [archiveId])

  // 简历附件排在前面，其他 PDF 附件（成绩单、证书）也可以看
  const pdfs = files.filter(isPdf).sort((a, b) => Number(b.kind === 'resume') - Number(a.kind === 'resume'))

  return (
    <div className="stack">
      <div className="tabs rv-tabs" role="tablist">
        {TABS.map(([k, name, icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>
            <Icon name={icon} size={14} />{name}
            {k === 'qa' && qa.length > 0 && <span className="rv-count">{qa.length}</span>}
            {k === 'pdf' && pdfs.length > 1 && <span className="rv-count">{pdfs.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'content' && (p ? <ProfileContent p={p} /> : (
        <div className="card rv-section" aria-busy="true">
          <div className="skeleton" style={{ width: 96, height: 16 }} />
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 14, width: i % 2 ? '60%' : '85%' }} />)}
        </div>
      ))}
      {tab === 'qa' && <QaTab qa={qa} />}
      {tab === 'pdf' && <PdfTab files={pdfs} />}
    </div>
  )
}
