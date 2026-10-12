// 简历文本提取：PDF（pdf.js）与 DOCX（最小 zip 解析）。
import * as pdfjs from 'pdfjs-dist'

export async function pdfText(buf: ArrayBuffer): Promise<string> {
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs')
  // 复制一份：pdf.js 会把传入的 buffer 转移给 worker，原 buffer 会被 detach
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    let lastY: number | null = null
    let line = ''
    const lines: string[] = []
    for (const it of tc.items as any[]) {
      const y = it.transform?.[5]
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        lines.push(line)
        line = ''
      }
      line += it.str
      lastY = y
    }
    lines.push(line)
    pages.push(lines.map((l) => l.trim()).filter(Boolean).join('\n'))
  }
  return pages.join('\n\n')
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds))
  return new Uint8Array(await out.arrayBuffer())
}

export async function docxText(buf: ArrayBuffer): Promise<string> {
  const b = new Uint8Array(buf)
  const dv = new DataView(buf)
  let eocd = -1
  for (let i = b.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('不是有效的 docx 文件')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen))
    if (name === 'word/document.xml') {
      const lnameLen = dv.getUint16(local + 26, true)
      const lextraLen = dv.getUint16(local + 28, true)
      const start = local + 30 + lnameLen + lextraLen
      const raw = b.subarray(start, start + csize)
      const xml = new TextDecoder().decode(method === 8 ? await inflate(raw) : raw)
      return xml
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('docx 中没有找到正文')
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
