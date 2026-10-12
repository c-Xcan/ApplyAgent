// PDF 预览：逐页渲染（pdf.js），带文字层，可以直接选中复制，方便手动填写自动填不进去的地方。
// PdfPages 直接嵌在页面里（侧边栏用），PdfPreview 是弹窗（资料页用）。
import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { StoredFile } from './types'
import { store } from './storage'
import { Icon } from './icons'

// pdf.js 5 用到了较新的 Map.getOrInsertComputed，旧一点的 Chrome 没有：补上
for (const C of [Map, WeakMap]) {
  const P = C.prototype as any
  P.getOrInsertComputed ??= function (this: Map<unknown, unknown>, k: unknown, f: (k: unknown) => unknown) { if (!this.has(k)) this.set(k, f(k)); return this.get(k) }
  P.getOrInsert ??= function (this: Map<unknown, unknown>, k: unknown, v: unknown) { if (!this.has(k)) this.set(k, v); return this.get(k) }
}

export const isPdf = (f: StoredFile) => /pdf/i.test(f.mime) || /\.pdf$/i.test(f.name)

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

export interface PdfInfo { msg: string; url?: string }

/** 按容器宽度渲染所有页；容器宽度变了（侧边栏被拖宽拖窄）就重新渲染 */
export function PdfPages({ fileId, maxWidth = 900, onInfo }: { fileId: string; maxWidth?: number; onInfo?: (info: PdfInfo) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [width, setWidth] = useState(0)
  const info = useRef(onInfo)
  info.current = onInfo

  useEffect(() => {
    let cancelled = false
    let task: pdfjs.PDFDocumentLoadingTask | null = null
    let blobUrl = ''
    setDoc(null)
    info.current?.({ msg: '正在加载…' })
    ;(async () => {
      const b64 = await store.fileData(fileId)
      if (!b64) return info.current?.({ msg: '找不到这个文件的内容，可能已被删除，请重新上传。' })
      const bytes = b64ToBytes(b64)
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs')
      task = pdfjs.getDocument({ data: bytes.slice() })
      const d = await task.promise
      if (cancelled) return
      setDoc(d)
      info.current?.({ msg: `共 ${d.numPages} 页 · 可以直接选中文字复制`, url: blobUrl })
    })().catch((e) => !cancelled && info.current?.({ msg: '预览失败：' + (e as Error).message }))
    return () => {
      cancelled = true
      task?.destroy()
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [fileId])

  useEffect(() => {
    const el = box.current
    if (!el) return
    let timer = 0
    const measure = () => setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => { clearTimeout(timer); timer = window.setTimeout(measure, 150) })
    ro.observe(el)
    measure()
    return () => { ro.disconnect(); clearTimeout(timer) }
  }, [])

  useEffect(() => {
    const el = box.current
    if (!doc || !el || !width) return
    let cancelled = false
    el.innerHTML = ''
    const pad = parseFloat(getComputedStyle(el).paddingLeft) * 2 || 0
    const target = Math.min(width - pad, maxWidth)
    ;(async () => {
      for (let i = 1; i <= doc.numPages && !cancelled; i++) {
        const page = await doc.getPage(i)
        if (cancelled) return
        const scale = target / page.getViewport({ scale: 1 }).width
        const viewport = page.getViewport({ scale })
        const wrap = document.createElement('div')
        wrap.className = 'pdf-page'
        wrap.style.width = viewport.width + 'px'
        wrap.style.height = viewport.height + 'px'
        wrap.style.setProperty('--total-scale-factor', String(scale))
        const canvas = document.createElement('canvas')
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = viewport.width + 'px'
        canvas.style.height = viewport.height + 'px'
        const text = document.createElement('div')
        text.className = 'textLayer'
        wrap.append(canvas, text)
        el.append(wrap)
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise
        if (cancelled) return
        await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render()
      }
    })().catch((e) => !cancelled && info.current?.({ msg: '预览失败：' + (e as Error).message }))
    return () => { cancelled = true }
  }, [doc, width, maxWidth])

  return <div className="pdf-pages" ref={box} />
}

export function PdfPreview({ file, onClose }: { file: StoredFile; onClose: () => void }) {
  const [info, setInfo] = useState<PdfInfo>({ msg: '正在加载…' })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal pdf-modal" role="dialog" aria-label={'预览 ' + file.name} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="grow">
            <div className="card-title"><span className="row"><Icon name="file-text" size={16} />{file.name}</span></div>
            <div className="card-desc">{info.msg}</div>
          </div>
          {info.url && <a className="btn small" href={info.url} target="_blank" rel="noreferrer">在新标签页打开</a>}
          <button className="btn small" title="关闭（Esc）" onClick={onClose}>关闭</button>
        </div>
        <PdfPages fileId={file.id} onInfo={setInfo} />
      </div>
    </div>
  )
}
