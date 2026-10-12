// 选项文本匹配：只做字面层面的归一化，不做任何语义等价（语义交给模型）。

export function norm(s: string): string {
  // 只保留文字和数字：去掉空格、标点、箭头（"江西省 ›"）、圆圈（"◯ 男"）等装饰
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 下拉面板里的"空状态"文字：不是选项 */
export const EMPTY_OPTION_RE = /^(无匹配数据|暂无数据|无数据|没有数据|暂无|无结果|暂无结果|没有匹配(的)?(数据|结果|项|选项)|未找到.{0,8}|查无数据|(这里)?什么(都|也)没有[.。…]*|no (matching )?(data|options|results?)( found)?|no results? found|nothing found|empty)$/i

export interface MatchResult<T> { hit?: T; ambiguous?: T[] }

export function matchOption<T extends { text: string; disabled?: boolean }>(opts: T[], want: string): MatchResult<T> {
  const usable = opts.filter((o) => !o.disabled)
  const exact = usable.filter((o) => o.text.trim() === want.trim())
  if (exact.length) return { hit: exact[0] }
  const w = norm(want)
  if (!w) return {}
  const eq = usable.filter((o) => norm(o.text) === w)
  if (eq.length) return { hit: eq[0] }
  // 选项文本里带了附加信息（"浙江大学(ZJU)"、"男 Male"）
  const starts = usable.filter((o) => norm(o.text).startsWith(w))
  if (starts.length === 1) return { hit: starts[0] }
  const contains = usable.filter((o) => norm(o.text).includes(w))
  if (contains.length === 1) return { hit: contains[0] }
  // 目标比选项长（"浙江省杭州市" vs 选项"杭州市"）——只在唯一时接受
  const inside = usable.filter((o) => norm(o.text).length >= 2 && w.includes(norm(o.text)))
  if (inside.length === 1 && !contains.length) return { hit: inside[0] }
  const amb = [...starts, ...contains, ...inside]
  return amb.length ? { ambiguous: Array.from(new Set(amb)) } : {}
}

/** 回读校验：计划值与页面实际值是否一致 */
export function sameValue(planned: unknown, actual: unknown): boolean {
  if (planned == null) return true
  if (typeof planned === 'boolean') return actual === planned
  const p = Array.isArray(planned) ? planned.map(String) : [String(planned)]
  const a = actual == null ? [] : Array.isArray(actual) ? actual.map(String) : [String(actual)]
  const aj = norm(a.join(' '))
  if (!p.length) return true
  // 日期：只比较数字
  const digits = (s: string) => s.replace(/\D/g, '')
  const isDate = p.every((x) => /^\d{4}([-/.年]\d{1,2}([-/.月]\d{1,2})?)?日?$/.test(x.trim()))
  if (isDate) {
    const ad = a.map((x) => x.replace(/(\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/g, (_m, y, m, d) => y + m.padStart(2, '0') + (d ? d.padStart(2, '0') : '')))
    const pd = p.map((x) => x.replace(/(\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/g, (_m, y, m, d) => y + m.padStart(2, '0') + (d ? d.padStart(2, '0') : '')))
    const ajd = digits(ad.join(' '))
    return pd.every((x) => ajd.includes(digits(x)))
  }
  // 级联值按"段"比较（"浙江省/宁波市" vs 页面上的"浙江-宁波"）：从最后一级往前逐段对齐，
  // 每段只容忍末尾多出一两个字（"宁波市" vs "宁波"）。不做全局的去后缀，避免"吉林市"误配"吉林-长春"
  return p.every((x) => {
    const n = norm(x)
    if (!n) return true
    if (aj.includes(n)) return true
    const xs = segs(x)
    if (a.some((ai) => alignedTail(xs, segs(ai)))) return true
    // 级联路径：最后一级出现即可（"10001-15000/月"的"月"这种一个字的尾巴不算一级）
    const parts = x.split(/[/>／,，]/).map(norm).filter(Boolean)
    return parts.length > 1 && parts[parts.length - 1].length >= 2 && aj.includes(parts[parts.length - 1])
  })
}

const segs = (s: string) => s.split(/\s*[-/>／|]\s*/).map(norm).filter(Boolean)

/** 两段文字相同，或只差末尾几个字（"宁波" vs "宁波市"）。max：允许多出的字数 */
function eqLoose(a: string, b: string, max: number) {
  if (a === b) return true
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  return s.length >= 2 && l.startsWith(s) && l.length - s.length <= max
}

/** 计划的路径段 xs 与页面值的段 as 从末尾对齐后逐段相同 */
function alignedTail(xs: string[], as: string[]) {
  if (!xs.length || !as.length || xs.length > as.length) return false
  // 页面值本身是路径（"浙江-宁波"）时，行政区后缀（省/市/自治区…）可能被省掉；单段值只容忍 1 个字
  const max = as.length >= 2 ? 5 : 1
  return xs.every((x, i) => eqLoose(x, as[as.length - xs.length + i], max))
}

/** 文字里含有 part（或去掉 part 最后一个字后含有）——用于在搜索结果里认路径的每一级 */
export function looseIn(text: string, part: string) {
  const t = norm(text)
  const p = norm(part)
  return !!p && (t.includes(p) || (p.length >= 3 && t.includes(p.slice(0, -1))))
}
