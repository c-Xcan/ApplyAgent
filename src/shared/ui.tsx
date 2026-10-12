// 通用 UI 组件（shadcn/ui 风格）：Select、IconButton、Toast。样式在 sidepanel.css。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconHandle, type IconName } from './icons'

export interface SelectOption { value: string; label: string; hint?: string }

/** shadcn/ui 风格的下拉选择：触发器 + 浮层列表 + 选中打勾，支持键盘上下/回车/Esc */
export function Select({ value, options, onChange, placeholder = '请选择', icon, className = '', title }: {
  value: string
  options: SelectOption[]
  onChange: (v: string) => void
  placeholder?: string
  icon?: IconName
  className?: string
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const cur = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    setHi(Math.max(0, options.findIndex((o) => o.value === value)))
    const off = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open])

  const pick = (v: string) => { onChange(v); setOpen(false) }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return setOpen(false)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return setOpen(true)
      setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (open && options[hi]) pick(options[hi].value)
      else setOpen(true)
    }
  }

  return (
    <div className={'select ' + className} ref={root}>
      <button type="button" className={'select-trigger' + (open ? ' open' : '')} title={title} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={onKey}>
        {icon && <Icon name={icon} size={15} className="select-icon" />}
        <span className={'select-value' + (cur ? '' : ' placeholder')}>{cur?.label ?? placeholder}</span>
        <Icon name="chevron-down" size={15} className="select-chevron" />
      </button>
      {open && (
        <div className="select-content" role="listbox">
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={'select-item' + (i === hi ? ' hl' : '')}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(o.value) }}
            >
              <span className="select-item-text">
                {o.label}
                {o.hint && <span className="select-item-hint">{o.hint}</span>}
              </span>
              {o.value === value && <Icon name="check" size={15} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function IconButton({ icon, label, onClick, variant = 'ghost', disabled, children }: {
  icon: IconName
  label: string
  onClick?: () => void
  variant?: 'ghost' | 'outline' | 'danger'
  disabled?: boolean
  children?: ReactNode
}) {
  const iconRef = useRef<IconHandle>(null)
  return (
    <button
      type="button"
      className={'icon-btn ' + variant}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
    >
      <Icon ref={iconRef} name={icon} size={16} />
      {children}
    </button>
  )
}

/** 居中弹窗：点遮罩或按 Esc 关闭（busy 时不关） */
export function Modal({ title, desc, onClose, busy, className = '', children }: {
  title: ReactNode
  desc?: ReactNode
  onClose: () => void
  busy?: boolean
  className?: string
  children: ReactNode
}) {
  const close = useRef(onClose)
  close.current = busy ? () => {} : onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [])
  return (
    <div className="modal-backdrop" onClick={() => close.current()}>
      <div className={'modal ' + className} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="grow">
            <div className="card-title">{title}</div>
            {desc && <div className="card-desc">{desc}</div>}
          </div>
          <IconButton icon="x" label="关闭（Esc）" disabled={busy} onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

/** 复制到剪贴板（侧边栏里 navigator.clipboard 偶尔不可用时退回 execCommand） */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

type ToastItem = { id: number; text: string; kind: 'ok' | 'bad'; leaving?: boolean }
let pushToast: ((t: ToastItem) => void) | null = null
let toastSeq = 0

const TOAST_MS = 2000
const TOAST_GAP = 14
const TOAST_VISIBLE = 3
const TOAST_EXIT_MS = 400

/** 顶部浮窗提示（和后台一样的叠放卡片，悬停展开、暂停计时）。页面里需要渲染一个 <Toaster /> */
export function toast(text: string, kind: ToastItem['kind'] = 'ok') {
  pushToast?.({ id: ++toastSeq, text, kind })
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([])
  const [heights, setHeights] = useState<Record<number, number>>({})
  const [expanded, setExpanded] = useState(false)
  const timers = useRef(new Map<number, { left: number; start: number; handle?: ReturnType<typeof setTimeout> }>())

  const dismiss = (id: number) => {
    timers.current.delete(id)
    setItems((l) => l.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    setTimeout(() => {
      setItems((l) => l.filter((x) => x.id !== id))
      setHeights(({ [id]: _, ...rest }) => rest)
    }, TOAST_EXIT_MS)
  }
  const schedule = (id: number, ms: number) => {
    const t = { left: ms, start: Date.now(), handle: setTimeout(() => dismiss(id), ms) }
    timers.current.set(id, t)
  }
  const pause = () => {
    setExpanded(true)
    for (const t of timers.current.values()) { clearTimeout(t.handle); t.left -= Date.now() - t.start }
  }
  const resume = () => {
    setExpanded(false)
    for (const [id, t] of timers.current) schedule(id, Math.max(t.left, 800))
  }

  useEffect(() => {
    pushToast = (t) => { setItems((l) => [...l, t]); schedule(t.id, TOAST_MS) }
    return () => { pushToast = null }
  }, [])

  const live = items.filter((t) => !t.leaving)
  const frontHeight = heights[live[live.length - 1]?.id] ?? 0
  const indexOf = (t: ToastItem) => (t.leaving ? 0 : live.length - 1 - live.indexOf(t))
  const offsetOf = (index: number) => live.slice(live.length - index).reduce((sum, t) => sum + (heights[t.id] ?? 0), 0) + index * TOAST_GAP

  return (
    <ol className="toaster" aria-live="polite" data-expanded={expanded} onMouseEnter={pause} onMouseLeave={resume}>
      {items.map((t) => (
        <ToastCard
          key={t.id}
          item={t}
          index={indexOf(t)}
          expanded={expanded}
          offset={offsetOf(indexOf(t))}
          frontHeight={frontHeight}
          onHeight={(h) => setHeights((m) => (m[t.id] === h ? m : { ...m, [t.id]: h }))}
        />
      ))}
    </ol>
  )
}

function ToastCard({ item, index, expanded, offset, frontHeight, onHeight }: {
  item: ToastItem
  index: number
  expanded: boolean
  offset: number
  frontHeight: number
  onHeight: (h: number) => void
}) {
  const [mounted, setMounted] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { const r = requestAnimationFrame(() => setMounted(true)); return () => cancelAnimationFrame(r) }, [])
  useEffect(() => { if (body.current) onHeight(body.current.offsetHeight + 2) })

  const front = index === 0
  const style: React.CSSProperties = { zIndex: 100 - index }
  if (!mounted || item.leaving) {
    style.transform = 'translateY(-100%)'
    style.opacity = 0
  } else if (expanded) {
    style.transform = `translateY(${offset}px)`
  } else {
    style.transform = `translateY(${index * TOAST_GAP}px) scale(${1 - index * 0.05})`
    if (!front && frontHeight) style.height = frontHeight
    if (index >= TOAST_VISIBLE) style.opacity = 0
  }
  return (
    <li className={'toast ' + item.kind} data-front={front} style={style} role={item.kind === 'bad' ? 'alert' : 'status'}>
      <div className="toast-body" ref={body}>
        <Icon name={item.kind === 'ok' ? 'circle-check' : 'octagon-x'} size={16} />
        <span>{item.text}</span>
      </div>
    </li>
  )
}
