// Shared UI primitives: dropdown menus / selects (instead of native <select>) and in-app dialogs
// (instead of window.confirm / window.prompt).
import { createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react'
import { useT } from '../i18n'
import { Modal } from './Reauth'

// ---------------------------------------------------------------- dropdown
export type DropItem = {
  key: string
  label: string
  icon?: React.ReactNode
  indent?: number
  danger?: boolean
  muted?: boolean
  create?: boolean
}

type DropdownProps = {
  button: React.ReactNode
  items: DropItem[]
  onSelect: (key: string) => void
  selected?: string
  searchable?: boolean
  className?: string
  title?: string
  disabled?: boolean
  align?: 'left' | 'right'
  empty?: string
  /** offer "create <typed text>" when the search text matches no item exactly */
  onCreate?: (text: string) => void
  createLabel?: (text: string) => string
  searchPlaceholder?: string
  searchMaxLength?: number
}

const CREATE = '__create'

export function Dropdown({ button, items, onSelect, selected, searchable, className, title, disabled, align = 'left', empty, onCreate, createLabel, searchPlaceholder, searchMaxLength }: DropdownProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<React.CSSProperties>({})
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = searchable ?? (items.length > 10 || !!onCreate)
  const qt = q.trim()
  const filtered = qt ? items.filter((i) => i.label.toLowerCase().includes(qt.toLowerCase())) : items
  const canCreate = !!onCreate && !!qt && !items.some((i) => i.label.toLowerCase() === qt.toLowerCase())
  const shown: DropItem[] = canCreate ? [...filtered, { key: CREATE, label: createLabel ? createLabel(qt) : qt, icon: <Plus size={14} />, create: true }] : filtered

  const close = useCallback((refocus = true) => { setOpen(false); setQ(''); if (refocus) btn.current?.focus() }, [])
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom - 8, above = r.top - 8
    const up = below < 220 && above > below
    const maxHeight = Math.min(340, up ? above : below)
    const style: React.CSSProperties = { minWidth: Math.max(r.width, 180), maxHeight }
    if (up) style.bottom = window.innerHeight - r.top + 4; else style.top = r.bottom + 4
    if (align === 'right') style.right = window.innerWidth - r.right; else style.left = Math.min(r.left, window.innerWidth - 200)
    setPos(style)
  }, [align])

  useLayoutEffect(() => { if (open) place() }, [open, place])
  useEffect(() => {
    if (!open) return
    const sel = Math.max(0, shown.findIndex((i) => i.key === selected))
    setActive(sel)
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node
      if (!pop.current?.contains(n) && !btn.current?.contains(n)) close(false)
    }
    const onMove = (e: Event) => { if (!pop.current?.contains(e.target as Node)) close(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    if (!search) list.current?.focus()
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('resize', onMove); window.removeEventListener('scroll', onMove, true) }
  }, [open])
  useEffect(() => { setActive(0) }, [q])
  useEffect(() => { list.current?.querySelector('.dd-item.active')?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  const choose = (i: DropItem | undefined) => {
    if (!i) return
    close()
    if (i.key === CREATE) onCreate?.(qt); else onSelect(i.key)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]) }
    else if (e.key === 'Tab') close(false)
  }

  return (
    <>
      <button ref={btn} type="button" className={'dd-btn ' + (className || '') + (open ? ' open' : '')} title={title} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) } }}>
        {button}
      </button>
      {open && createPortal(
        <div ref={pop} className="dd-pop" style={pos} onKeyDown={onKey}>
          {search && (
            <div className="dd-search"><Search size={14} />
              <TextInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder || t('filter_placeholder')} maxLength={searchMaxLength} small wrapStyle={{ flex: 1 }} /></div>
          )}
          <div ref={list} className="dd-list" role="listbox" tabIndex={-1}>
            {shown.map((i, n) => (
              <div key={i.key} role="option" aria-selected={i.key === selected}
                className={'dd-item' + (n === active ? ' active' : '') + (i.danger ? ' danger' : '') + (i.muted ? ' muted' : '') + (i.create ? ' create' : '')}
                style={{ paddingLeft: 10 + (i.indent || 0) * 14 }}
                onMouseEnter={() => setActive(n)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)}>
                {i.icon && <span className="dd-icon">{i.icon}</span>}
                <span className="dd-label">{i.label}</span>
                {i.key === selected && <Check size={14} className="dd-check" />}
              </div>
            ))}
            {shown.length === 0 && <div className="dd-empty">{empty || t('nothing_found')}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/** Value picker (replaces native <select>). The button shows the current value; the list never repeats a placeholder. */
export function Select<V extends string | number | null>({ value, options, onChange, placeholder, prefix, icon, ...rest }: {
  value: V
  options: { value: V; label: string; icon?: React.ReactNode; indent?: number; muted?: boolean }[]
  onChange: (v: V) => void
  placeholder?: string
  prefix?: string
  icon?: React.ReactNode
  searchable?: boolean
  className?: string
  title?: string
  disabled?: boolean
}) {
  const key = (v: V) => (v === null ? '__null' : String(v))
  const cur = options.find((o) => o.value === value)
  return (
    <Dropdown {...rest} selected={key(value)}
      items={options.map((o) => ({ key: key(o.value), label: o.label, icon: o.icon, indent: o.indent, muted: o.muted }))}
      onSelect={(k) => { const o = options.find((x) => key(x.value) === k); if (o) onChange(o.value) }}
      button={<>{cur?.icon ?? icon}<span className="dd-val">{prefix && <span className="muted">{prefix}: </span>}{cur ? cur.label : <span className="muted">{placeholder}</span>}</span><ChevronDown size={14} className="dd-caret" /></>} />
  )
}

/** Action menu: a button that opens a list of actions. */
export function Menu({ label, icon, items, onSelect, caret = true, ...rest }: {
  label?: React.ReactNode
  icon?: React.ReactNode
  items: DropItem[]
  onSelect: (key: string) => void
  caret?: boolean
  searchable?: boolean
  className?: string
  title?: string
  disabled?: boolean
  align?: 'left' | 'right'
  empty?: string
  onCreate?: (text: string) => void
  createLabel?: (text: string) => string
  searchPlaceholder?: string
  searchMaxLength?: number
}) {
  return <Dropdown {...rest} items={items} onSelect={onSelect}
    button={<>{icon}{label && <span className="dd-val">{label}</span>}{caret && <ChevronDown size={14} className="dd-caret" />}</>} />
}

// ---------------------------------------------------------------- text input with a clear (×) button
type TextInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  /** class / style of the wrapper: sizing (width, flex) belongs here, the field fills it */
  wrapClassName?: string
  wrapStyle?: React.CSSProperties
  /** smaller ×, for compact fields */
  small?: boolean
  /** after clearing (the field also gets an ordinary change event, so controlled fields need nothing else) */
  onClear?: () => void
}

/** A text field with the app's standard clear button (the one in the main search box): shown whenever there is
 *  text, not only on hover / focus like the browser's own. Works for controlled and uncontrolled fields: clearing
 *  goes through a real input event, so onChange runs as if the text had been deleted by hand. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { wrapClassName, wrapStyle, small, onClear, onChange, ...props }, outer) {
  const { t } = useT()
  const ref = useRef<HTMLInputElement | null>(null)
  const setRef = (el: HTMLInputElement | null) => {
    ref.current = el
    if (typeof outer === 'function') outer(el); else if (outer) outer.current = el
  }
  const controlled = props.value !== undefined
  const [has, setHas] = useState(() => String(props.value ?? props.defaultValue ?? '') !== '')
  useEffect(() => { if (controlled) setHas(String(props.value ?? '') !== '') }, [props.value, controlled])
  // an uncontrolled field re-created with another default (key change) or filled by the browser
  useEffect(() => { if (!controlled && ref.current) setHas(ref.current.value !== '') })
  const clear = () => {
    const el = ref.current
    if (!el) return
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    setHas(false)
    el.focus()
    onClear?.()
  }
  const showX = has && !props.disabled && !props.readOnly
  return (
    <span className={'clearable' + (small ? ' small' : '') + (wrapClassName ? ' ' + wrapClassName : '')} style={wrapStyle}>
      <input ref={setRef} {...props} onChange={(e) => { setHas(e.target.value !== ''); onChange?.(e) }} />
      {showX && (
        <button type="button" className="icon clear-x" tabIndex={-1} title={t('clear_selection')}
          onMouseDown={(e) => e.preventDefault() /* keep focus: fields that save on blur must not save the old text */}
          onClick={clear}><X size={small ? 13 : 15} /></button>
      )}
    </span>
  )
})

// ---------------------------------------------------------------- combo box
export type ComboOption = { value: string; label: string; count?: number }

/** A text field with suggestions: typing shows matching options (fetched by `load`), but any typed text is
 *  accepted too (a partial value matches more than one option). Commits on Enter, on picking an option and when
 *  the field loses focus; Arrow keys move through the options, Esc closes them. */
export function Combo({ value, onCommit, load, placeholder, className }: {
  value: string
  onCommit: (v: string) => void
  load: (q: string) => Promise<ComboOption[]>
  placeholder?: string
  className?: string
}) {
  const { t } = useT()
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const [opts, setOpts] = useState<ComboOption[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(-1) // -1: none, Enter takes the typed text
  const [pos, setPos] = useState<React.CSSProperties>({})
  const input = useRef<HTMLInputElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  useEffect(() => setText(value), [value])

  // suggestions for what is typed, a moment after the last key; an older answer never replaces a newer one
  useEffect(() => {
    if (!open) return
    const n = ++seq.current
    setLoading(true)
    const h = window.setTimeout(() => {
      load(text.trim()).then((r) => { if (n === seq.current) { setOpts(r); setActive(-1) } })
        .catch(() => { if (n === seq.current) setOpts([]) })
        .finally(() => { if (n === seq.current) setLoading(false) })
    }, 200)
    return () => window.clearTimeout(h)
  }, [text, open])

  const place = useCallback(() => {
    const r = input.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom - 8, above = r.top - 8
    const up = below < 220 && above > below
    const style: React.CSSProperties = { minWidth: Math.max(r.width, 200), maxHeight: Math.min(340, up ? above : below), left: Math.min(r.left, window.innerWidth - 220) }
    if (up) style.bottom = window.innerHeight - r.top + 4; else style.top = r.bottom + 4
    setPos(style)
  }, [])
  useLayoutEffect(() => { if (open) place() }, [open, place])
  useEffect(() => {
    if (!open) return
    const onMove = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => { window.removeEventListener('resize', onMove); window.removeEventListener('scroll', onMove, true) }
  }, [open])
  useEffect(() => { pop.current?.querySelector('.dd-item.active')?.scrollIntoView({ block: 'nearest' }) }, [active])

  const commit = (v: string) => { setText(v); setOpen(false); if (v.trim() !== value) onCommit(v.trim()) }
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive((a) => Math.min(opts.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(active >= 0 && opts[active] ? opts[active].value : text) }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false) } // only closes the list
  }

  return (
    <>
      <TextInput ref={input} small wrapClassName={className} placeholder={placeholder} value={text} autoComplete="off"
        role="combobox" aria-expanded={open} aria-autocomplete="list"
        onChange={(e) => { setText(e.target.value); setOpen(true); if (!e.target.value && value) commit('') /* the clear (×) button */ }}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onBlur={() => { if (text.trim() !== value) commit(text); else setOpen(false) }}
        onKeyDown={onKey} />
      {open && createPortal(
        <div ref={pop} className="dd-pop" style={pos}>
          <div className="dd-list" role="listbox">
            {opts.map((o, n) => (
              <div key={o.value} role="option" aria-selected={o.value === value}
                className={'dd-item' + (n === active ? ' active' : '')}
                onMouseEnter={() => setActive(n)} onMouseDown={(e) => e.preventDefault() /* keep focus in the field */}
                onClick={() => commit(o.value)}>
                <span className="dd-label">{o.label}</span>
                {o.count != null && <span className="dd-count">{o.count}</span>}
                {o.value === value && <Check size={14} className="dd-check" />}
              </div>
            ))}
            {!opts.length && <div className="dd-empty">{loading ? t('loading') : t('nothing_found')}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

// ---------------------------------------------------------------- dialogs
type ConfirmOpts = { title: string; message?: React.ReactNode; ok?: string; danger?: boolean }
type PromptOpts = { title: string; label?: string; value?: string; ok?: string; placeholder?: string; mono?: boolean }
type Dlg = { confirm: (o: ConfirmOpts) => Promise<boolean>; prompt: (o: PromptOpts) => Promise<string | null> }
type Pending = { kind: 'confirm'; o: ConfirmOpts; res: (v: any) => void } | { kind: 'prompt'; o: PromptOpts; res: (v: any) => void }

const DialogCtx = createContext<Dlg>(null as any)
export const useDialog = () => useContext(DialogCtx)

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [cur, setCur] = useState<Pending | null>(null)
  const api = useRef<Dlg>({
    confirm: (o) => new Promise((res) => setCur({ kind: 'confirm', o, res })),
    prompt: (o) => new Promise((res) => setCur({ kind: 'prompt', o, res })),
  })
  const done = (v: any) => { cur?.res(v); setCur(null) }
  return (
    <DialogCtx.Provider value={api.current}>
      {children}
      {cur?.kind === 'confirm' && <ConfirmDialog o={cur.o} onDone={done} />}
      {cur?.kind === 'prompt' && <PromptDialog o={cur.o} onDone={done} />}
    </DialogCtx.Provider>
  )
}

function ConfirmDialog({ o, onDone }: { o: ConfirmOpts; onDone: (v: boolean) => void }) {
  const { t } = useT()
  const cancel = useCallback(() => onDone(false), [onDone])
  return (
    <Modal onClose={cancel} small>
      <h2>{o.title}</h2>
      {o.message && <div className="muted">{o.message}</div>}
      <div className="row dlg-actions">
        <span className="spacer" />
        <button type="button" onClick={cancel}>{t('cancel')}</button>
        <button type="button" autoFocus className={o.danger ? 'primary danger-fill' : 'primary'} onClick={() => onDone(true)}>{o.ok || t('confirm')}</button>
      </div>
    </Modal>
  )
}

function PromptDialog({ o, onDone }: { o: PromptOpts; onDone: (v: string | null) => void }) {
  const { t } = useT()
  const [v, setV] = useState(o.value || '')
  const cancel = useCallback(() => onDone(null), [onDone])
  return (
    <Modal onClose={cancel} small>
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onDone(v.trim()) }} className="col">
        <h2>{o.title}</h2>
        {o.label && <label>{o.label}</label>}
        <TextInput autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={o.placeholder} onFocus={(e) => e.target.select()}
          style={o.mono ? { fontFamily: 'ui-monospace, monospace' } : undefined} wrapStyle={{ width: '100%' }} />
        <div className="row dlg-actions">
          <span className="spacer" />
          <button type="button" onClick={cancel}>{t('cancel')}</button>
          <button className="primary" disabled={!v.trim()}>{o.ok || t('save')}</button>
        </div>
      </form>
    </Modal>
  )
}
