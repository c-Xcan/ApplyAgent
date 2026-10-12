// 后台管理页：资料档案 / 问答库 / 设置（侧边栏只保留填写）
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import type { Archive } from '../shared/types'
import { store } from '../shared/storage'
import { SAMPLE_ID } from '../shared/sample-profile'
import { Archives } from './Archives'
import { Icon } from '../shared/icons'
import { ProfileTab } from './ProfileTab'
import { QATab, SettingsTab } from './SettingsTab'
import { RecordsTab } from './RecordsTab'
import { useModelReady } from '../shared/model'
import { Select, Toaster } from '../shared/ui'

const NAV = [
  ['profile', '资料档案', '个人资料、简历与附件。每个档案相互独立，填写时使用当前选中的档案。', 'file-text'],
  ['qa', '问答库', '填写时遇到资料里没有的问题会问你，回答自动存到这里；你在网页上手动改过的值也会被学习。任何站点都会优先使用这里的答案。', 'message-square-text'],
  ['records', '投递记录', '每次在网申页面填写后自动记一条，同一网址只记一条。记录只保存在本机浏览器里。', 'send'],
  ['settings', '设置', '模型 API Key、填写行为与备份。', 'settings'],
] as const
type Page = (typeof NAV)[number][0]

function App() {
  const initial = (location.hash.slice(1) as Page) || 'profile'
  const [page, setPage] = useState<Page>(NAV.some((n) => n[0] === initial) ? initial : 'profile')
  const [archives, setArchives] = useState<{ list: Archive[]; active: string }>({ list: [], active: '' })
  const model = useModelReady()
  const dirty = useRef(false)

  const reload = () => store.archives().then(setArchives)
  useEffect(() => {
    reload()
    // 侧边栏里切换了档案：这里同步过来
    const onChanged = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.archives || c.activeArchive) reload()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])
  const guard = () => !dirty.current || confirm('当前档案有未保存的修改，切换后会丢失。继续？')
  const go = (p: Page) => {
    if (p === page || !guard()) return
    dirty.current = false
    setPage(p)
    history.replaceState(null, '', '#' + p)
  }
  const current = archives.list.find((a) => a.id === archives.active)

  return (
    <div className="admin">
      <header className="admin-header">
        <div className="admin-header-inner">
          <div className="side-brand">
            <img src="icons/icon48.png" alt="" />
            <b>新新闪投</b>
          </div>
          <nav className="tabs admin-tabs" role="tablist">
            {NAV.map(([k, name, , icon]) => (
              <button key={k} role="tab" aria-selected={page === k} className={'tab' + (page === k ? ' active' : '')} onClick={() => go(k)}>
                <Icon name={icon} size={15} />
                {name}
              </button>
            ))}
          </nav>
          {current && (
            <span className="current-archive muted small"><Icon name="user-round" size={14} />{current.name}</span>
          )}
        </div>
      </header>
      <main className="admin-main">
        {model.loaded && !model.ready && page !== 'settings' && (
          <div className="banner">
            <Icon name="circle-alert" size={15} />
            <span className="grow">还没有配置模型。填写和解析简历都要用你自己的模型 API Key。</span>
            <button className="btn small primary" onClick={() => go('settings')}>去设置</button>
          </div>
        )}
        {archives.active === SAMPLE_ID && (page === 'profile' || page === 'qa') && (
          <div className="banner">
            <Icon name="circle-alert" size={15} />
            <span>这是示例档案，人物是虚构的，可以照着它填自己的资料。点「新建档案」创建你自己的；不需要时可以删掉它。</span>
          </div>
        )}
        <div className="page-head">
          <div className="page-head-text">
            <h1 className="page-title">{NAV.find((n) => n[0] === page)![1]}</h1>
            <p className="muted">{NAV.find((n) => n[0] === page)![2]}</p>
          </div>
          {page === 'qa' && archives.active && (
            <Select
              className="page-head-side"
              icon="user-round"
              title="切换档案（每个档案的问答库相互独立）"
              value={archives.active}
              options={archives.list.map((a) => ({ value: a.id, label: a.name }))}
              onChange={async (v) => { if (v === archives.active || !guard()) return; dirty.current = false; await store.setActive(v); reload() }}
            />
          )}
        </div>
        {page === 'profile' && archives.active && (
          <Archives list={archives.list} active={archives.active} onChange={() => { dirty.current = false; reload() }} guard={guard} />
        )}
        {page === 'profile' && archives.active && <ProfileTab key={archives.active} archiveId={archives.active} onDirty={(d) => { dirty.current = d }} />}
        {page === 'qa' && archives.active && <QATab key={archives.active} archiveId={archives.active} onDirty={(d) => { dirty.current = d }} />}
        {page === 'records' && <RecordsTab />}
        {page === 'settings' && <SettingsTab />}
      </main>
    </div>
  )
}

createRoot(document.getElementById('app')!).render(<><App /><Toaster /></>)
