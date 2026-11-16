import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CalendarDays, FileText, Folder as FolderIcon, FolderInput, FolderX, Loader2, Plus, X } from 'lucide-react'
import { api } from '../api'
import { useT } from '../i18n'
import { folderTree, useStore } from '../store'
import { Menu, Select } from './ui'
/** Folder picker. `null` = no folder (shown only when allowEmpty). */
export function FolderSelect({ value, onChange, allowEmpty }: { value: number | null; onChange: (v: number | null) => void; allowEmpty?: boolean }) {
  const { folders } = useStore()
  const { t } = useT()
  const opts = folderTree(folders).map((f) => ({ value: f.id as number | null, label: f.name, indent: f.depth, icon: <FolderIcon size={14} /> }))
  if (allowEmpty) opts.unshift({ value: null, label: t('no_folder'), indent: 0, icon: <FolderX size={14} /> })
  return <Select value={value} options={opts} onChange={onChange} placeholder={t('no_folder')} icon={<FolderX size={14} />} />
}

/** "Move to folder" action menu. */
export function FolderMenu({ onPick, label }: { onPick: (id: number) => void; label?: string }) {
  const { folders } = useStore()
  const { t } = useT()
  return <Menu icon={<FolderInput size={15} />} label={label ?? t('move_to')} empty={t('no_folders')}
    items={folderTree(folders).map((f) => ({ key: String(f.id), label: f.name, indent: f.depth, icon: <FolderIcon size={14} /> }))}
    onSelect={(k) => onPick(Number(k))} />
}

/** Tag chips. With singleLine the chips stay on one line that scrolls horizontally when they do not fit. */
export function TagChips({ ids, onRemove, singleLine }: { ids: number[]; onRemove?: (id: number) => void; singleLine?: boolean }) {
  const { tags } = useStore()
  const byId = new Map(tags.map((t) => [t.id, t]))
  const list = ids.map((id) => byId.get(id)).filter(Boolean) as typeof tags
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [edge, setEdge] = useState({ l: false, r: false }) // more tags hidden to the left / right
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      setOverflow(el.scrollWidth > el.clientWidth + 1)
      const l = el.scrollLeft > 1, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      setEdge((e) => (e.l === l && e.r === r ? e : { l, r }))
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    el.addEventListener('scroll', check, { passive: true })
    return () => { ro.disconnect(); el.removeEventListener('scroll', check) }
  }, [list.length, singleLine])
  // vertical wheel scrolls sideways while there is room to scroll (page scrolling is not hijacked).
  // Native non-passive listener: React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const el = ref.current
    if (!el || !overflow) return
    const h = (e: WheelEvent) => {
      if (e.deltaX !== 0 || e.deltaY === 0) return
      const atEnd = e.deltaY > 0 ? el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 : el.scrollLeft <= 0
      if (atEnd) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [overflow])
  const chips = list.map((tg) => (
    <span key={tg.id} className="chip"><span className="dot" style={{ background: tg.color }} />{tg.name}
      {onRemove && <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(tg.id) }}><X size={12} /></button>}</span>
  ))
  if (!singleLine) return chips.length ? <span className="row" style={{ gap: 4 }}>{chips}</span> : null
  return (
    <div ref={ref} className={'chips-line' + (overflow ? ' scrolling' : '') + (edge.l ? ' more-l' : '') + (edge.r ? ' more-r' : '')} onClick={(e) => overflow && e.stopPropagation()}>{chips}</div>
  )
}

export const TAG_COLORS = ['#c2726b', '#c9a05f', '#6fa588', '#6d8fc4', '#9484c0', '#c283a3', '#6aa5a3', '#7b8794'] // muted; old bright ones were remapped in migration 0006
export const randomTagColor = () => TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)]

/** Tag action menu. Typing a name that does not exist offers to create the tag (unless noCreate). */
export function TagAdder({ exclude, onAdd, label, icon, noCreate }: { exclude: number[]; onAdd: (id: number) => void; label?: string; icon?: React.ReactNode; noCreate?: boolean }) {
  const { tags, reload, toast, tagMaxLen } = useStore()
  const { t } = useT()
  const create = async (name: string) => {
    const existing = tags.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (existing) { if (!exclude.includes(existing.id)) onAdd(existing.id); return }
    try {
      const r = await api('/api/tags', { body: { name, color: randomTagColor() } })
      reload()
      onAdd(r.id)
    } catch (e: any) { toast(e.detail) }
  }
  return <Menu icon={icon ?? <Plus size={14} />} label={label ?? t('tag')} empty={noCreate ? t('no_tags') : t('type_to_create_tag')}
    onCreate={noCreate ? undefined : create} createLabel={(q) => t('create_tag').replace('{name}', q)}
    searchPlaceholder={noCreate ? undefined : t('find_or_create_tag')} searchMaxLength={noCreate ? undefined : tagMaxLen}
    items={[...tags].sort((a, b) => a.name.localeCompare(b.name)).filter((x) => !exclude.includes(x.id))
      .map((x) => ({ key: String(x.id), label: x.name, icon: <span className="dot" style={{ background: x.color }} /> }))}
    onSelect={(k) => onAdd(Number(k))} />
}

export function TierBadge({ tier, status }: { tier: string | null; status?: string }) {
  const { t } = useT()
  if (status && ['queued', 'processing', 'stopped', 'excluded'].includes(status)) return <span className="tier proc">{t(status)}</span>
  if (status === 'error') return <span className="tier low">{t('error')}</span>
  if (status === 'infected') return <span className="tier low">{t('infected')}</span>
  if (!tier) return <span className="tier-empty">—</span>
  return <span className={'tier ' + tier}>{t('tier_' + tier)}</span>
}

export function Snippet({ text }: { text: string | null }) {
  if (!text) return null
  // server marks hits with \x01 … \x02; escape everything else
  const parts: React.ReactNode[] = []
  let i = 0
  text.split('\x01').forEach((chunk, idx) => {
    if (idx === 0) { parts.push(chunk); return }
    const [hit, rest] = chunk.split('\x02')
    parts.push(<mark key={i++}>{hit}</mark>, rest)
  })
  return <div className="snippet">{parts}</div>
}

export function fmtDate(s: string | null | undefined, withTime = false) {
  if (!s) return ''
  const d = new Date(s)
  return withTime ? d.toLocaleString() : d.toLocaleDateString()
}

export function fmtBytes(n: number) {
  if (n < 1024) return n + ' B'
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return n.toFixed(1) + ' ' + u[i]
}

let measureCtx: CanvasRenderingContext2D | null = null

/** File-name style truncation: "a-very-long-scan-name.pdf" -> "a-very-lo…me.pdf".
 *  The tail (last 2 characters of the name + extension) always stays visible. The text is measured, so the
 *  result is one continuous string with no gap after the ellipsis; recomputed when the available width changes. */
export function FileName({ name, className }: { name: string; className?: string }) {
  const n = name || '—'
  const ref = useRef<HTMLSpanElement>(null)
  const [text, setText] = useState(n)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const w = el.clientWidth
      if (!w) return
      measureCtx = measureCtx || document.createElement('canvas').getContext('2d')
      if (!measureCtx) return setText(n)
      const cs = getComputedStyle(el)
      measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const width = (s: string) => measureCtx!.measureText(s).width
      if (width(n) <= w) return setText(n)
      const m = n.match(/^(.*?)(.{0,2}\.[A-Za-z0-9]{1,6})$/)
      const [head, tail] = m && m[1] ? [m[1], m[2]] : [n, '']
      let lo = 0, hi = head.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (width(head.slice(0, mid) + '…' + tail) <= w) lo = mid; else hi = mid - 1
      }
      setText(head.slice(0, lo).trimEnd() + '…' + tail)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [n])
  return <span ref={ref} className={'file-name' + (className ? ' ' + className : '')} title={n}>{text}</span>
}

/** Compact date field: shows the date (or a short placeholder) instead of the browser's wide empty mm/dd/yyyy box.
 *  The native input lies invisibly on top, so a tap / click opens the platform's date picker; × clears. */
export function DateInput({ value, onChange, placeholder, title }: { value: string; onChange: (v: string) => void; placeholder: string; title?: string }) {
  const { t } = useT()
  const shown = value ? new Date(value + 'T00:00:00').toLocaleDateString() : placeholder
  return (
    <span className={'date-in' + (value ? ' has' : '')} title={title}>
      <CalendarDays size={14} className="date-icon" />
      <span className="date-txt">{shown}</span>
      <input type="date" value={value} aria-label={title || placeholder} onChange={(e) => onChange(e.target.value)}
        onClick={(e) => { try { (e.currentTarget as any).showPicker?.() } catch { /* not allowed: the native field still works */ } }} />
      {value && <button type="button" className="date-clear" title={t('clear_date')} onClick={() => onChange('')}><X size={12} /></button>}
    </span>
  )
}

/** "Label  [from] – [to]" */
export function DateRange({ label, from, to, onFrom, onTo }: { label: string; from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  const { t } = useT()
  return (
    <span className="date-range">
      <span className="dr-label">{label}</span>
      <DateInput value={from} onChange={onFrom} placeholder={t('date_from_ph')} title={`${label}: ${t('date_from_ph')}`} />
      <span className="muted">–</span>
      <DateInput value={to} onChange={onTo} placeholder={t('date_to_ph')} title={`${label}: ${t('date_to_ph')}`} />
    </span>
  )
}

const BUSY = ['queued', 'processing']

/** A page thumbnail. `v` is the thumbnail's version (null = none rendered yet). While the page is (re)processed the
 *  last thumbnail stays visible with a spinner on top; with no thumbnail yet a placeholder says what is going on. */
export function PageThumb({ pageId, v, status }: { pageId: number | null | undefined; v: string | null | undefined; status?: string }) {
  const { t } = useT()
  const want = pageId && v ? `/api/pages/${pageId}/image?variant=thumb&v=${v}` : null
  // what is on screen: a new version is fetched in the background and swapped in once it has loaded, so the
  // card never goes blank while processing replaces the thumbnail (it used to blink at every stage)
  const [shown, setShown] = useState<string | null>(want)
  const [err, setErr] = useState(false)
  // a thumbnail there from the start loads lazily as usual; one that arrives later (processing finished) or
  // changes is loaded first, so the placeholder / old picture never gives way to an empty box
  useEffect(() => {
    if (!want || want === shown) return
    let live = true
    const img = new Image()
    img.onload = () => { if (live) { setShown(want); setErr(false) } }
    img.onerror = () => { if (live) { setShown(want); setErr(true) } }
    img.src = want
    return () => { live = false }
  }, [want])
  const busy = !!status && BUSY.includes(status)
  if (shown && !err) return (
    <>
      <img loading="lazy" src={shown} alt="" draggable={false} onError={() => setErr(true)} />
      {busy && <span className="thumb-busy"><Loader2 size={18} className="spin" /></span>}
    </>
  )
  return (
    <span className="thumb-ph">
      {busy ? <Loader2 size={22} className="spin" /> : <FileText size={22} />}
      <span className="small">{busy ? t('page_processing') : status === 'error' ? t('error') : ''}</span>
    </span>
  )
}
