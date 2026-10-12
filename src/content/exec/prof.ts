// 动作内部分步计时（只用于诊断，不影响执行逻辑）。
// steps：按顺序的分段（mark 记录距上一次 mark 的时间，各段相加 ≈ 动作总耗时）；
// hot：几个常用函数的累计耗时和次数（会和 steps 重叠）；slept：其中花在 sleep 上的总时长（含轮询里的 sleep）。

const now = () => performance.now()
let t = now()
let t0 = t
let steps: [string, number][] = []
let hot: Record<string, { ms: number; n: number }> = {}
let slept = 0

export function profStart() {
  t = t0 = now()
  steps = []
  hot = {}
  slept = 0
}

/** 结束一段：name 是刚刚这段在做什么 */
export function mark(name: string) {
  const n = now()
  steps.push([name, Math.round(n - t)])
  t = n
}

export function addSleep(ms: number) {
  slept += ms
}

/** 累计某个函数的耗时 */
export async function hotspot<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const s = now()
  try {
    return await fn()
  } finally {
    const h = (hot[name] ??= { ms: 0, n: 0 })
    h.ms += now() - s
    h.n++
  }
}

export interface Prof { total: number; steps: [string, number][]; hot: Record<string, { ms: number; n: number }>; slept: number }

export function profEnd(): Prof {
  if (now() - t >= 1) mark('其余')
  return {
    total: Math.round(now() - t0),
    steps,
    hot: Object.fromEntries(Object.entries(hot).map(([k, v]) => [k, { ms: Math.round(v.ms), n: v.n }])),
    slept,
  }
}
