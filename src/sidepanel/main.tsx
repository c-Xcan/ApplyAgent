import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { FillTab } from './FillTab'
import { ResumeView } from './ResumeView'
import { useModelReady } from '../shared/model'
import { Icon } from '../shared/icons'
import { store } from '../shared/storage'
import { SAMPLE_ID } from '../shared/sample-profile'
import type { Archive } from '../shared/types'
import { Select, Toaster } from '../shared/ui'

function useActiveTab() {
  const forced = Number(new URLSearchParams(location.search).get('tab')) || null // 调试：sidepanel.html?tab=ID
  const [tabId, setTabId] = useState<number | null>(forced)
  useEffect(() => {
    if (forced) return
    const refresh = () => chrome.tabs.query({ active: true, currentWindow: true }).then((t) => setTabId(t[0]?.id ?? null))
    refresh()
    chrome.tabs.onActivated.addListener(refresh)
    return () => chrome.tabs.onActivated.removeListener(refresh)
  }, [])
  return tabId
}

const openAdmin = (page = 'profile') => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#' + page) })

function App() {
  const tabId = useActiveTab()
  const model = useModelReady()
  const [archives, setArchives] = useState<{ list: Archive[]; active: string }>({ list: [], active: '' })
  const [viewResume, setViewResume] = useState(false)
  useEffect(() => {
    const load = () => store.archives().then(setArchives)
    load()
    const onChanged = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.archives || c.activeArchive) load()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  if (!model.loaded) return null
  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <Select className="grow" icon="user-round" title="填写使用的资料档案" value={archives.active} options={archives.list.map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => store.setActive(v)} />
          <button className={'btn' + (viewResume ? ' pressed' : '')} aria-pressed={viewResume} title={viewResume ? '返回填写' : '查看当前档案的简历、问答库和 PDF 原件'} onClick={() => setViewResume(!viewResume)}><Icon name="file-text" size={14} />简历详情</button>
          <button className="btn" title="资料档案、问答库与设置" onClick={() => openAdmin('profile')}><Icon name="settings" size={14} />设置</button>
        </div>
      </header>
      {!model.ready && (
        <div className="banner">
          <Icon name="circle-alert" size={15} />
          <span className="grow">还没有配置模型。填写和解析简历都要用你自己的模型 API Key，请先到设置里填写。</span>
          <button className="btn small primary" onClick={() => openAdmin('settings')}>去设置</button>
        </div>
      )}
      {archives.active === SAMPLE_ID && (
        <div className="banner">
          <Icon name="circle-alert" size={15} />
          <span>当前选的是示例档案，人物和联系方式都是虚构的，只用来试用，不要拿去正式投递。</span>
        </div>
      )}
      <main className="stack">
        {/* 填写面板一直挂着，切去看简历时正在进行的填写和提问不会丢 */}
        <div hidden={viewResume}><FillTab tabId={tabId} /></div>
        {viewResume && archives.active && <ResumeView archiveId={archives.active} />}
      </main>
      <Toaster />
    </div>
  )
}

createRoot(document.getElementById('app')!).render(<App />)
