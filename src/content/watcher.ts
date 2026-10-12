// 页面稳定检测：一段时间内没有 DOM 变化即视为稳定。
export function waitStable(quietMs = 400, maxMs = 8000): Promise<{ mutations: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    let count = 0
    let timer: ReturnType<typeof setTimeout>
    const start = Date.now()
    const done = (timedOut: boolean) => {
      mo.disconnect()
      clearTimeout(timer)
      clearTimeout(hard)
      resolve({ mutations: count, timedOut })
    }
    const mo = new MutationObserver((recs) => {
      // 忽略我们自己写的 data-aa-ref 属性
      const real = recs.filter((r) => !(r.type === 'attributes' && r.attributeName === 'data-aa-ref'))
      if (!real.length) return
      count += real.length
      clearTimeout(timer)
      timer = setTimeout(() => done(false), quietMs)
    })
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    timer = setTimeout(() => done(false), quietMs)
    const hard = setTimeout(() => done(true), Math.max(quietMs, maxMs - (Date.now() - start)))
  })
}
