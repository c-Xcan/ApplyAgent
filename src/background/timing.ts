// 运行计时：按"阶段"（规划、补块、填写、修复…）和"耗时来源"（模型、页面操作、读页面、等页面稳定、等用户）两个维度统计，
// 写进日志和诊断报告。等用户的时间单独算，不计入"实际用时"。

export type Kind = 'llm' | 'act' | 'snapshot' | 'waitStable' | 'sleep' | 'user'
export const KIND_NAME: Record<Kind, string> = { llm: '模型', act: '页面操作', snapshot: '读页面', waitStable: '等页面稳定', sleep: '固定等待', user: '等你处理' }

export interface Span { kind: Kind; name: string; phase: string; start: number; ms: number; extra?: Record<string, unknown> }
export interface LlmCall { tag: string; phase: string; model: string; ms: number; in: number; out: number; tokPerSec: number; attempts: number; ok: boolean }

const r1 = (ms: number) => Math.round(ms / 100) / 10 // 秒，保留一位

class Timing {
  t0 = Date.now()
  spans: Span[] = []
  llm: LlmCall[] = []
  phase = '准备'
  phaseStart = Date.now()
  phaseMs = new Map<string, number>()
  phaseOrder: string[] = []

  reset() {
    this.t0 = Date.now()
    this.spans = []
    this.llm = []
    this.phase = '准备'
    this.phaseStart = this.t0
    this.phaseMs = new Map()
    this.phaseOrder = []
  }

  private lap() {
    const now = Date.now()
    const ms = now - this.phaseStart
    if (!this.phaseMs.has(this.phase)) this.phaseOrder.push(this.phase)
    this.phaseMs.set(this.phase, (this.phaseMs.get(this.phase) ?? 0) + ms)
    this.phaseStart = now
  }

  /** 进入一个阶段；返回函数用于回到进入前的阶段（阶段可以嵌套，例如"补块"里的"规划"） */
  enter(name: string): () => void {
    const prev = this.phase
    this.lap()
    this.phase = name
    return () => {
      if (this.phase !== name) return
      this.lap()
      this.phase = prev
    }
  }

  /** 记录一段耗时（成功、失败、被中止都记） */
  async span<T>(kind: Kind, name: string, fn: () => Promise<T>, extra?: (r: T | undefined) => Record<string, unknown> | undefined): Promise<T> {
    const start = Date.now()
    const phase = this.phase
    let res: T | undefined
    try {
      res = await fn()
      return res
    } finally {
      this.spans.push({ kind, name, phase, start, ms: Date.now() - start, extra: extra?.(res) })
    }
  }

  addLlm(c: Omit<LlmCall, 'phase' | 'tokPerSec'>) {
    this.llm.push({ ...c, phase: this.phase, tokPerSec: c.ms > 0 ? Math.round((c.out / c.ms) * 10000) / 10 : 0 })
  }

  /** 若干时间段的并集长度（等用户的几个问题是并行的，不能简单相加） */
  private union(list: Span[]) {
    const iv = list.map((s) => [s.start, s.start + s.ms]).sort((a, b) => a[0] - b[0])
    let total = 0
    let cur: number[] | null = null
    for (const x of iv) {
      if (!cur || x[0] > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [...x] }
      else cur[1] = Math.max(cur[1], x[1])
    }
    if (cur) total += cur[1] - cur[0]
    return total
  }

  totals() {
    const totalMs = Date.now() - this.t0
    const userMs = this.union(this.spans.filter((s) => s.kind === 'user'))
    const byKind: Record<string, { ms: number; n: number }> = {}
    for (const s of this.spans) {
      const k = (byKind[s.kind] ??= { ms: 0, n: 0 })
      k.ms += s.ms
      k.n++
    }
    return { totalMs, userMs, activeMs: totalMs - userMs, byKind }
  }

  /** 页面操作内部分步耗时，按操作类型汇总（来自内容脚本的 prof） */
  actInside() {
    type P = { steps: [string, number][]; hot: Record<string, { ms: number; n: number }>; slept: number; total: number }
    const out: Record<string, { n: number; total: number; slept: number; steps: Record<string, { ms: number; n: number }>; hot: Record<string, { ms: number; n: number }> }> = {}
    for (const s of this.spans) {
      const p = s.extra?.prof as P | undefined
      if (s.kind !== 'act' || !p) continue
      const op = s.name.split(' ')[0]
      const o = (out[op] ??= { n: 0, total: 0, slept: 0, steps: {}, hot: {} })
      o.n++
      o.total += p.total
      o.slept += p.slept
      for (const [k, ms] of p.steps) { const x = (o.steps[k] ??= { ms: 0, n: 0 }); x.ms += ms; x.n++ }
      for (const [k, v] of Object.entries(p.hot)) { const x = (o.hot[k] ??= { ms: 0, n: 0 }); x.ms += v.ms; x.n += v.n }
    }
    return out
  }

  /** 给日志看的几行摘要 */
  summaryLines(): string[] {
    this.lap()
    const t = this.totals()
    const kinds = (Object.keys(KIND_NAME) as Kind[])
      .filter((k) => k !== 'user' && t.byKind[k])
      .map((k) => `${KIND_NAME[k]} ${r1(t.byKind[k].ms)}s/${t.byKind[k].n}次`)
    const phases = this.phaseOrder.filter((p) => (this.phaseMs.get(p) ?? 0) >= 50).map((p) => `${p} ${r1(this.phaseMs.get(p)!)}s`)
    const outTok = this.llm.reduce((n, c) => n + c.out, 0)
    const llmMs = this.llm.reduce((n, c) => n + c.ms, 0)
    const slowLlm = [...this.llm].sort((a, b) => b.ms - a.ms).slice(0, 3).map((c) => `${c.tag} ${r1(c.ms)}s(出${c.out}tok)`)
    const slowAct = this.spans.filter((s) => s.kind === 'act').sort((a, b) => b.ms - a.ms).slice(0, 5).map((s) => `${s.name} ${r1(s.ms)}s`)
    return [
      `[耗时] 总 ${r1(t.totalMs)}s，其中等你 ${r1(t.userMs)}s，实际 ${r1(t.activeMs)}s`,
      `[耗时] 按来源：${kinds.join(' · ')}`,
      `[耗时] 按阶段：${phases.join(' · ')}`,
      `[耗时] 模型：${this.llm.length} 次共 ${r1(llmMs)}s，输出 ${outTok} tok${llmMs >= 1000 ? `（平均 ${Math.round((outTok / llmMs) * 1000)} tok/s）` : ''}；最慢 ${slowLlm.join('，')}`,
      `[耗时] 最慢的页面操作：${slowAct.join('，') || '无'}`,
      ...Object.entries(this.actInside())
        .filter(([, o]) => o.total >= 1000)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([op, o]) => {
          const steps = Object.entries(o.steps).filter(([, x]) => x.ms >= 50).sort((a, b) => b[1].ms - a[1].ms).slice(0, 6).map(([k, x]) => `${k} ${r1(x.ms)}s/${x.n}`)
          const hot = Object.entries(o.hot).sort((a, b) => b[1].ms - a[1].ms).slice(0, 4).map(([k, x]) => `${k} ${r1(x.ms)}s/${x.n}`)
          return `[耗时] ${op} 内部（${o.n} 次共 ${r1(o.total)}s，其中 sleep/轮询等待 ${r1(o.slept)}s）：${steps.join(' · ')}${hot.length ? `；累计 ${hot.join(' · ')}` : ''}`
        }),
    ]
  }

  /** 写进诊断报告的结构化数据 */
  report() {
    this.lap()
    const t = this.totals()
    const actByOp: Record<string, { ms: number; n: number; max: number }> = {}
    for (const s of this.spans.filter((x) => x.kind === 'act')) {
      const op = s.name.split(' ')[0]
      const a = (actByOp[op] ??= { ms: 0, n: 0, max: 0 })
      a.ms += s.ms
      a.n++
      a.max = Math.max(a.max, s.ms)
    }
    return {
      ...t,
      phases: this.phaseOrder.map((p) => {
        const inPhase = this.spans.filter((s) => s.phase === p)
        const by: Record<string, number> = {}
        for (const s of inPhase) by[s.kind] = (by[s.kind] ?? 0) + s.ms
        return { phase: p, ms: this.phaseMs.get(p) ?? 0, ...by }
      }),
      llm: this.llm,
      actByOp,
      actInside: this.actInside(),
      // 时间线：相对开始的毫秒数，便于看哪里在空等
      timeline: this.spans
        .slice()
        .sort((a, b) => a.start - b.start)
        .map((s) => ({ at: s.start - this.t0, ms: s.ms, kind: s.kind, phase: s.phase, name: s.name, ...(s.extra ?? {}) })),
    }
  }
}

export const timing = new Timing()
