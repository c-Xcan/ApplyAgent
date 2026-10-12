// 把快照、资料、经验序列化为模型易读的紧凑文本。
import type { FieldNode, FormSnapshot, Profile, QA, SiteMemory, StoredFile } from '../shared/types'

const q = (s: string) => JSON.stringify(s)

function fmtValue(v: FieldNode['value']): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'boolean') return v ? '☑' : '☐'
  if (Array.isArray(v)) return v.length ? '[' + v.map((x) => q(x)).join(', ') + ']' : '—'
  return q(v.length > 80 ? v.slice(0, 80) + '…' : v)
}

export function fieldLine(f: FieldNode, cachedOptions?: string[]): string {
  const parts = [f.ref.padEnd(4), f.hint.padEnd(13), q(f.label + (f.required ? ' *' : ''))]
  if (f.context.length) parts.push('ctx=' + f.context.map((c) => q(c)).join(','))
  if (f.placeholder && f.placeholder !== f.label) parts.push('ph=' + q(f.placeholder))
  if (f.options?.length) parts.push('opts=[' + f.options.slice(0, 40).join('|') + (f.options.length > 40 ? `|…共${f.options.length}项` : '') + ']')
  else if (cachedOptions?.length) parts.push('opts(上次见过)=[' + cachedOptions.slice(0, 40).join('|') + ']')
  else if (f.optionsCollapsed) parts.push('opts=(未展开)')
  const c = f.constraints ?? {}
  if (c.maxLength) parts.push('max=' + c.maxLength)
  if (c.accept) parts.push('accept=' + c.accept)
  if (c.multiple) parts.push('多选')
  if (f.disabled) parts.push('禁用')
  parts.push('= ' + fmtValue(f.value))
  if (f.error) parts.push('! ' + q(f.error))
  return parts.join('  ')
}

// "添加"类按钮：文字按钮（+ 添加教育经历）或只有图标的按钮（文字取自图标的 aria-label，常见为 plus）
export const ADD_RE = /^(\+|＋)?\s*(添加|新增|增加|add)|^(\+|＋|plus|plus-circle|plus-square|plus-circle-o)$/i

type Item = { o: number; f?: FieldNode; b?: { text: string; section?: string } }

/** "添加"按钮对应的分区现有几块。块数 = 同一个标签重复出现的次数。
 *  - 按钮在分区开头（标题旁的 + 号）：数按钮下方、下一个添加按钮之前、同分区的块
 *  - 按钮在块的末尾（"+ 添加教育经历"）：数按钮上方、上一个添加按钮之后的块
 *  - 本分区一个字段都没有：0 块（不能把上一个分区的块算进来） */
function blockCount(items: Item[], at: number, b: { text: string; section?: string }): string {
  if (!ADD_RE.test(b.text.trim())) return ''
  const count = (r: Item[]) => (r.length ? r.filter((x) => x.f!.label === r[0].f!.label).length : 0)
  const mine = items.filter((x) => x.f && x.f.section === b.section)
  if (!mine.length) {
    // 每个字段自成一个分区的页面（分区名就是字段标签）：按钮的"分区"只是块末尾那道题（是/否按钮），
    // 块数 = 按钮上方、上一个添加按钮之后，块里最后一个字段的标签出现的次数
    const before = items.filter((x) => x.o < at)
    let start = 0
    for (let i = before.length - 1; i >= 0; i--) if (before[i].b && ADD_RE.test(before[i].b!.text.trim())) { start = i + 1; break }
    const fs = before.slice(start).filter((x) => x.f)
    const last = fs[fs.length - 1]?.f
    if (!last || last.section !== last.label) return '  (本分区现有 0 块)'
    return `  (本分区现有 ${fs.filter((x) => x.f!.label === last.label && x.f!.section === last.section).length} 块)`
  }
  if (!mine.some((x) => x.o < at)) {
    const next = items.find((x) => x.o > at && x.b && ADD_RE.test(x.b.text.trim()))?.o ?? Infinity
    return `  (本分区现有 ${count(mine.filter((x) => x.o > at && x.o < next))} 块)`
  }
  const before = items.filter((x) => x.o < at)
  let start = 0
  for (let i = before.length - 1; i >= 0; i--) if (before[i].b && ADD_RE.test(before[i].b!.text.trim())) { start = i + 1; break }
  return `  (本分区现有 ${count(before.slice(start).filter((x) => x.f))} 块)`
}

export function snapshotText(s: FormSnapshot, mem?: SiteMemory): string {
  const items = [...s.fields.map((f) => ({ o: f.order, f })), ...s.buttons.map((b) => ({ o: b.order, b }))].sort((a, b) => a.o - b.o)
  const lines: string[] = []
  lines.push(`PAGE title=${q(s.title)} url=${s.url}${s.heading ? ' heading=' + q(s.heading) : ''}`)
  const empty = s.fields.filter((f) => f.required && (f.value == null || f.value === '' || (Array.isArray(f.value) && f.value.every((x) => !x)))).length
  lines.push(`FORM fields=${s.fields.length} required_empty=${empty} errors=${s.fields.filter((f) => f.error).length}`)
  let section: string | undefined = '\u0000'
  for (const it of items) {
    const sec = 'f' in it ? it.f!.section : it.b!.section
    if (sec !== section) {
      section = sec
      lines.push('', `## ${sec ?? '(无分区)'}`)
    }
    if ('f' in it && it.f) lines.push(fieldLine(it.f, mem?.optionCache[it.f.label]))
    else if ('b' in it && it.b) lines.push(`${it.b.ref.padEnd(4)} button        ${q(it.b.text)}` + blockCount(items, it.o, it.b))
  }
  return lines.join('\n')
}

function yaml(v: unknown, indent = ''): string {
  if (v == null || v === '') return ''
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v)) {
    if (!v.length) return ''
    if (v.every((x) => typeof x !== 'object')) return v.join('、')
    return `（共 ${v.length} 条）` + v.map((x, i) => `\n${indent}- [${i}]` + yaml(x, indent + '  ').replace(/^\n/, '\n')).join('')
  }
  const out: string[] = []
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = yaml(val, indent + '  ')
    if (!s) continue
    out.push(`\n${indent}${k}: ${s}`)
  }
  return out.join('')
}

export function profileText(p: Profile, qa: QA[], files: StoredFile[]): string {
  const { resumeText, ...rest } = p
  let s = '# 候选人资料' + yaml(rest)
  if (qa.length) s += '\n\n# 问答库（候选人亲自回答过的问题，优先使用）\n' + qa.map((x) => `- Q: ${x.q}\n  A: ${x.a}`).join('\n')
  if (files.length) s += '\n\n# 可上传的文件（upload 动作用 fileId）\n' + files.map((f) => `- fileId=${f.id} 类型=${f.kind} 文件名=${f.name}`).join('\n')
  if (resumeText) s += '\n\n# 简历原文（结构化资料没有的信息可以从这里找）\n' + resumeText.slice(0, 6000)
  return s
}

export function memoryText(m: SiteMemory): string {
  if (!m.runs && !m.notes.length) return ''
  const lines = [`# 本站点历史经验（所有用户累计填写 ${m.runs} 次）`]
  if (m.notes.length) lines.push(...m.notes.slice(-20).map((n) => '- ' + n))
  if (m.fieldMap.length) {
    lines.push('## 以往成功填过的字段（标签 → 资料来源 / 动作；值要按当前资料重新取）')
    for (const f of m.fieldMap.slice(-80)) lines.push(`- ${f.section ? f.section + ' / ' : ''}${f.label} → ${f.source ?? ''} / ${f.op}`)
  }
  return lines.join('\n')
}
