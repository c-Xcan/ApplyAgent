import { useEffect, useState } from 'react'
import { modelReady, store } from './storage'

/** 设置页里的模型接口是否已经填好（保存设置后这里跟着变） */
export function useModelReady() {
  const [s, setS] = useState({ loaded: false, ready: false })
  useEffect(() => {
    const load = () => store.settings().then((v) => setS({ loaded: true, ready: modelReady(v) }))
    load()
    const onChanged = (c: Record<string, chrome.storage.StorageChange>) => { if (c.settings) load() }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])
  return s
}
