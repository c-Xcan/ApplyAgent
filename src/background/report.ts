// 脱敏：保存站点经验前，把资料里的值、问答库的回答、附件文件名、本次填写和页面上读到的值，
// 一律换成 ‹v编号›（同一个值编号相同）；手机号、邮箱、证件号、长数字再按格式兜底替换。
// 站点自带的选项、字段标签、按钮文字、分区名保留，它们是站点经验本身。
import type { FieldOutcome, FormSnapshot, Profile, QA, StoredFile } from '../shared/types'

const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '‹邮箱›'],
  [/(?<![\dXx])\d{17}[\dXx](?![\dXx])/g, '‹证件号›'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '‹手机号›'],
  [/\d{6,}/g, '‹数字›'],
]
const MAX_STR = 60_000

function leaves(v: unknown, out: string[] = []): string[] {
  if (v == null || typeof v === 'boolean') return out
  if (typeof v === 'string') out.push(v)
  else if (typeof v === 'number') out.push(String(v))
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out))
  else if (typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out))
  return out
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 站点自己的文字：选项、标签、按钮、分区名、面板里看到的选项 */
function siteWords(snap: FormSnapshot | undefined, observed: string[]): Set<string> {
  const keep = new Set<string>()
  for (const f of snap?.fields ?? []) {
    for (const s of [f.label, f.section, f.placeholder, ...(f.options ?? [])]) if (s) keep.add(s.trim())
  }
  for (const b of snap?.buttons ?? []) keep.add(b.text.trim())
  for (const ob of observed) {
    for (const s of ob.replace(/^[^：]*：/, '').split(/\||第\d+列:/)) keep.add(s.replace(/^✓|\(禁用\)/g, '').trim())
  }
  return keep
}

export function makeRedactor(src: { profile: Profile; qa: QA[]; files: StoredFile[]; outcomes: FieldOutcome[]; snap?: FormSnapshot; observed: string[] }) {
  const keep = siteWords(src.snap, src.observed)
  const secrets = new Set<string>()
  const add = (v: unknown) => {
    for (const raw of leaves(v)) {
      const s = raw.trim()
      if (s.length < 2 || keep.has(s) || /^(请选择|select)/i.test(s)) continue
      secrets.add(s)
      // 长文本：模型可能只引用其中几句
      if (s.length > 24) for (const part of s.split(/[\n。！？；!?;]+/)) if (part.trim().length >= 8) secrets.add(part.trim())
    }
  }
  const { resumeText: _, ...profile } = src.profile
  add(profile)
  add(src.qa.map((x) => x.a))
  add(src.files.map((f) => f.name))
  add(src.outcomes.map((o) => [o.planned, o.actual]))
  add(src.snap?.fields.map((f) => f.value))

  const list = [...secrets].sort((a, b) => b.length - a.length)
  const ids = new Map(list.map((s, i) => [s, i + 1]))
  const re = list.length ? new RegExp(list.map(esc).join('|'), 'g') : null
  const text = (s: string) => {
    let out = re ? s.replace(re, (m) => `‹v${ids.get(m)}›`) : s
    for (const [p, r] of PATTERNS) out = out.replace(p, r)
    return out.length > MAX_STR ? out.slice(0, MAX_STR) + '…(截断)' : out
  }
  const deep = (v: unknown): unknown =>
    typeof v === 'string' ? text(v)
    : typeof v === 'number' && ids.has(String(v)) ? `‹v${ids.get(String(v))}›`
    : Array.isArray(v) ? v.map(deep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
    : v
  return deep
}
