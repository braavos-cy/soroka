import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, DocSummary, downloadPost } from '../api'
import { plural, useT } from '../i18n'
import { folderPath, useStore } from '../store'
import { DND, DND_DOCS } from '../components/Sidebar'
import { setMultiDragImage } from '../components/dragGhost'
import UploadModal, { checkItems, dragVerdict, itemsFromDrop, skippedMessage, toUploads } from '../components/Upload'
import { fmtMB, UpTask, useUploads } from '../components/uploads'
import { DateRangeFilter, FileName, FolderMenu, fmtDate, PageThumb, Snippet, TagAdder, TagChips, TierBadge } from '../components/Pickers'
import { Combo, Select, useDialog } from '../components/ui'
import { ArchiveRestore, ArrowDownWideNarrow, ArrowUpNarrowWide, Ban, Files, Download, LayoutGrid, List, Pause, Play, SlidersHorizontal, TagIcon, Tags, Trash2, Upload as UploadIcon, X } from 'lucide-react'

const PAGE = 60
const AUTO_MAX = 200 // documents loaded by scrolling alone; beyond that the Load more button

// per history entry (location.key): how many documents the list had loaded and how far it was scrolled when it
// was left, so going back to it returns to the same place
const listPlaces = new Map<string, { n: number; top: number }>()

// sort: a field from the dropdown plus a direction (the arrow button); choosing a field starts in its natural direction
const SORT_FIELDS = ['received', 'date', 'title', 'size', 'pages'] as const
type SortField = typeof SORT_FIELDS[number]
const SORT_DEFAULT_DIR: Record<SortField, 'asc' | 'desc'> = { received: 'desc', date: 'desc', title: 'asc', size: 'desc', pages: 'desc' }
/** What a document card / row can do; one unchanging object for all of them (see `acts` in the page). */
type CardActs = {
  click: (d: DocSummary) => void; toggle: (id: number) => void; dragStart: (e: React.DragEvent, d: DocSummary) => void
  rescue: (id: number) => void; restore: (id: number) => void
}

/** A document in the grid (and in search results). Memoized: redrawn only when its document or selection changes. */
const DocCard = memo(function DocCard({ d, selected, view, acts }: { d: DocSummary; selected: boolean; view: string; acts: CardActs }) {
  const { t, lang } = useT()
  return (
    <div data-doc-id={d.id} className={'doc-card' + (selected ? ' sel' : '')} onClick={() => acts.click(d)} draggable onDragStart={(e) => acts.dragStart(e, d)}>
      <input type="checkbox" className="chk" checked={selected} onClick={(e) => e.stopPropagation()} onChange={() => acts.toggle(d.id)} />
      <span className="tierdot"><TierBadge tier={d.needs_review ? 'low' : d.tier} status={d.status} /></span>
      <div className="thumb"><PageThumb pageId={d.first_page_id} v={d.thumb_v} status={d.status} /></div>
      <div className="body">
        <div className="card-title">
          <FileName name={d.title} className="t" />
          {d.page_count > 0 && <span className="pages-count" title={plural(t, lang, d.page_count, 'pl_pages')}><Files size={13} />{d.page_count}</span>}
        </div>
        {view === 'rejected' && <button onClick={(e) => { e.stopPropagation(); acts.rescue(d.id) }}>{t('rescue')}</button>}
        {view === 'trash' && <button onClick={(e) => { e.stopPropagation(); acts.restore(d.id) }}>{t('restore')}</button>}
        {d.tags.length > 0 && <div className="card-tags"><TagChips ids={d.tags} singleLine /></div>}
      </div>
    </div>
  )
})

/** A document in the list layout. Memoized like DocCard. */
const DocRow = memo(function DocRow({ d, selected, view, folder, acts }: { d: DocSummary; selected: boolean; view: string; folder: string; acts: CardActs }) {
  const { t } = useT()
  return (
    <tr data-doc-id={d.id} className={selected ? 'sel' : ''} onClick={() => acts.click(d)} style={{ cursor: 'pointer' }} draggable onDragStart={(e) => acts.dragStart(e, d)}>
      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected} onChange={() => acts.toggle(d.id)} /></td>
      <td className="title-cell"><FileName name={d.title} /><Snippet text={d.snippet} /></td>
      <td className="small muted">{folder}</td>
      <td><TagChips ids={d.tags} /></td>
      <td className="small">{t('source_' + d.source)}{d.chat ? ` · ${d.chat}` : ''}</td>
      <td className="small">{fmtDate(d.received_at, true)}</td>
      <td><TierBadge tier={d.needs_review ? 'low' : d.tier} status={d.status} />{view === 'rejected' && <button className="link" onClick={(e) => { e.stopPropagation(); acts.rescue(d.id) }}>{t('rescue')}</button>}</td>
    </tr>
  )
})

/** The new list, with each document that did not change kept as the very same object (so its card is not redrawn). */
function keepUnchanged(cur: DocSummary[], next: DocSummary[]): DocSummary[] {
  const old = new Map(cur.map((d) => [d.id, d]))
  return next.map((d) => { const o = old.get(d.id); return o && JSON.stringify(o) === JSON.stringify(d) ? o : d })
}

function parseSort(s: string | null): [SortField, 'asc' | 'desc'] {
  if (s === 'title') return ['title', 'asc'] // older links
  const m = /^(\w+)_(asc|desc)$/.exec(s || '')
  return m && (SORT_FIELDS as readonly string[]).includes(m[1]) ? [m[1] as SortField, m[2] as 'asc' | 'desc'] : ['received', 'desc']
}

// filters in the Filters panel; dates count once per range
const FILTER_GROUPS = [['source'], ['file_type'], ['review', 'upload'], ['language'], ['received_from', 'received_to'], ['date_from', 'date_to'], ['sender'], ['chat']]

type UpProps = { task: UpTask; selected: boolean; onToggle: () => void; onPause: () => void; onResume: () => void; onCancel: () => void }

const upPct = (u: UpTask) => (u.size ? Math.floor((u.sent / u.size) * 100) : 100)
const canPause = (u: UpTask) => u.state === 'queued' || u.state === 'uploading'
const canResume = (u: UpTask) => u.state === 'paused' || u.state === 'error'

function UpButtons({ task, onPause, onResume, onCancel }: Omit<UpProps, 'selected' | 'onToggle'>) {
  const { t } = useT()
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f() }
  return <>
    {canPause(task) && <button title={t('up_pause')} onClick={stop(onPause)}><Pause size={14} /></button>}
    {canResume(task) && <button title={t('up_resume')} onClick={stop(onResume)}><Play size={14} /></button>}
    {task.state !== 'saving' && <button className="danger" title={t('up_cancel')} onClick={stop(onCancel)}><X size={14} /></button>}
  </>
}

function upStatus(u: UpTask, t: (k: string) => string): string {
  if (u.state === 'error') return `${t('up_error')}: ${u.error || ''}`
  return t('up_' + u.state)
}

/** An upload in progress, shown as a card until the server has created the document. */
function UploadCard(p: UpProps) {
  const { t } = useT()
  const u = p.task, pct = upPct(u)
  return (
    <div data-upload-id={u.id} className={'doc-card upload-card' + (p.selected ? ' sel' : '') + ' up-' + u.state} onClick={p.onToggle}>
      <input type="checkbox" className="chk" checked={p.selected} onClick={(e) => e.stopPropagation()} onChange={p.onToggle} />
      {/* everything about the upload sits in the picture area, the body holds only the name: the card is exactly
          as tall as the document card that replaces it, so nothing around it moves at the hand-over */}
      <div className="thumb up-thumb">
        {u.state === 'paused' ? <Pause size={24} /> : <UploadIcon size={24} />}
        <div className="up-pct">{u.state === 'saving' ? t('up_saving') : `${pct}%`}</div>
        <div className="progress"><div style={{ width: `${pct}%` }} /></div>
        <div className="small muted">{fmtMB(u.sent)} / {fmtMB(u.size)} MB</div>
        <div className="row up-actions">
          <span className={'small ' + (u.state === 'error' ? 'danger-text' : 'muted')} title={upStatus(u, t)}>{upStatus(u, t)}</span>
          <UpButtons {...p} />
        </div>
      </div>
      <div className="body">
        <div className="card-title"><FileName name={u.name} className="t" /></div>
      </div>
    </div>
  )
}

function UploadRow(p: UpProps) {
  const { t } = useT()
  const u = p.task, pct = upPct(u)
  return (
    <tr data-upload-id={u.id} className={'upload-row up-' + u.state + (p.selected ? ' sel' : '')} onClick={p.onToggle}>
      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={p.selected} onChange={p.onToggle} /></td>
      <td className="title-cell"><FileName name={u.name} /><div className="progress"><div style={{ width: `${pct}%` }} /></div></td>
      <td colSpan={3} className="small muted">{fmtMB(u.sent)} / {fmtMB(u.size)} MB · {pct}%</td>
      <td className="small">{upStatus(u, t)}</td>
      <td className="up-actions"><UpButtons {...p} /></td>
    </tr>
  )
}

export default function DocumentsPage({ view }: { view: 'active' | 'rejected' | 'trash' }) {
  const { t, lang } = useT()
  const { folders, user, reload, toast } = useStore()
  const dlg = useDialog()
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const loc = useLocation()
  const [items, setItems] = useState<DocSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [upSel, setUpSel] = useState<Set<string>>(new Set())
  const uploads = useUploads()
  const [upload, setUpload] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  // the File type filter offers every file type there is among the documents. Fetched once when the page loads, so
  // the panel opens with its final width (the select is as wide as its longest option: filled in only after opening,
  // it widened and the bar jumped)
  const [fileTypes, setFileTypes] = useState<{ value: string; label: string; count: number }[]>([])
  const getFileTypes = useCallback(() =>
    api<typeof fileTypes>('/api/documents/suggest?field=file_type&limit=100').then(setFileTypes).catch(() => {}), [])
  useEffect(() => { getFileTypes() }, [getFileTypes])
  // and again when the filters open and whenever documents change (trashed, deleted, arrived), so the counts stay
  // true while the panel is open
  useEffect(() => {
    if (!showFilters) return
    getFileTypes()
    window.addEventListener('soroka:reload', getFileTypes)
    return () => window.removeEventListener('soroka:reload', getFileTypes)
  }, [showFilters, total, getFileTypes])
  const [layout, setLayout] = useState<'grid' | 'list'>(() => { try { return (localStorage.getItem('layout') as any) || 'grid' } catch { return 'grid' } })

  // the list's query, without paging
  const query = useCallback(() => {
    const p = new URLSearchParams({ view })
    const g = (k: string) => params.get(k) || ''
    if (g('q')) p.set('q', g('q'))
    if (g('folder') === 'none') p.set('unfiled', 'true')
    else if (g('folder')) { p.set('folder_id', g('folder')); if (user.include_subfolders) p.set('subfolders', 'true') }
    if (g('tags')) p.set(g('tag_mode') === 'or' ? 'tags_any' : 'tags_all', g('tags'))
    if (g('tags_not')) p.set('tags_not', g('tags_not'))
    for (const k of ['source', 'file_type', 'review', 'status', 'sender', 'chat', 'received_from', 'received_to', 'date_from', 'date_to', 'sort', 'language'])
      if (g(k)) p.set(k, g(k))
    return p.toString()
  }, [params, view, user.include_subfolders])

  const itemsRef = useRef(items)
  itemsRef.current = items
  const loadSeq = useRef(0) // numbers the requests
  const appliedSeq = useRef(0) // the newest answer on screen: an older one arriving later must not replace it
  const curQuery = useRef('') // search-as-you-type: an answer to a query no longer asked is dropped
  const shown = useRef<string | null>(null) // the text of the answer on screen (offset 0)
  const shownQuery = useRef<string | null>(null) // the query the documents on screen were listed for
  // documents whose permanent deletion is under way: gone from the list at once (emptying a large trash takes a while)
  const gone = useRef<Set<number>>(new Set())
  /** offset 0: (re)load the first n documents in place of the list; offset > 0: add the next n ("Load more") */
  const fetchList = useCallback((offset: number, n: number) => {
    const seq = ++loadSeq.current
    const q = query()
    curQuery.current = q
    setLoading(true)
    // a new search (other text, or into / out of a search): what is on screen answers another question, so it goes
    // and "Loading…" shows until the answer comes. Kept, it flashed: the plain list shown as search results, or the
    // results for "te" (one match) still there while "test" (none) was asked. A refresh of the same query and
    // changes to the plain list keep the documents on screen until the new answer replaces them.
    if (offset === 0 && q !== shownQuery.current && (isSearch(q) || isSearch(shownQuery.current))) {
      shownQuery.current = q
      shown.current = null
      setItems([])
      setTotal(0)
    }
    api(`/api/documents?${q}&offset=${offset}&limit=${n}`, { raw: true }).then((res: Response) => res.text()).then((text) => {
      // an answer to the same query is shown even when newer reloads are on their way: many uploads finishing one
      // after another each ask for a reload, and dropping all but the last kept every saved upload waiting for the
      // last one (each list request outlasted the gap to the next save)
      if (q !== curQuery.current || seq < appliedSeq.current) return
      appliedSeq.current = seq
      shownQuery.current = q
      // same answer as what is on screen (next letter of the same word, background refresh): leave the list alone
      if (offset === 0) { if (text === shown.current) return; shown.current = text } else shown.current = null
      const r = JSON.parse(text)
      // documents being deleted stay hidden until the deletion is done (the server lists them until it commits)
      const items = r.items.filter((d: DocSummary) => !gone.current.has(d.id))
      setTotal(Math.max(0, r.total - (r.items.length - items.length)))
      setItems((cur) => {
        const next = keepUnchanged(cur, items)
        if (offset === 0) return next
        const have = new Set(cur.map((d) => d.id)) // the list may have shifted since: no document twice
        return [...cur, ...next.filter((d) => !have.has(d.id))]
      })
    })
      .catch((e) => { if (seq === loadSeq.current) toast(e.detail) }).finally(() => { if (seq === loadSeq.current) setLoading(false) })
  }, [query])
  // back from a document (or any page opened from here): the list as it was left, with as many documents loaded
  // ("Load more") and scrolled to the same place; `place` is what was saved for this history entry
  const place = useRef(listPlaces.get(loc.key))
  const restoreTop = useRef(place.current?.top)
  const firstFetch = useRef(fetchList)
  useEffect(() => {
    // only for the list as it was opened: a new search or filter starts from the top as before
    const n = fetchList === firstFetch.current ? place.current?.n : undefined
    fetchList(0, Math.max(PAGE, n || 0))
  }, [fetchList])
  useLayoutEffect(() => {
    const scroller = area.current?.closest('.content')
    if (restoreTop.current == null || !items.length || !scroller) return
    scroller.scrollTop = restoreTop.current
    restoreTop.current = undefined
  }, [items])
  const locKey = useRef(loc.key)
  locKey.current = loc.key
  useLayoutEffect(() => {  // layout: saved before the document view replaces the list and resets the scroll
    const scroller = area.current?.closest('.content')
    if (!scroller) return
    let top = scroller.scrollTop
    const onScroll = () => { top = scroller.scrollTop }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      // saved when the list is left (the document view replaces it): its history entry remembers the place
      if (itemsRef.current.length) {
        listPlaces.delete(locKey.current)
        listPlaces.set(locKey.current, { n: itemsRef.current.length, top })
        if (listPlaces.size > 50) listPlaces.delete(listPlaces.keys().next().value!)
      }
    }
  }, [])
  /** reload everything loaded so far, in one request */
  const load = useCallback(() => fetchList(0, Math.max(PAGE, itemsRef.current.length)), [fetchList])
  const loadMore = () => fetchList(itemsRef.current.length, PAGE)
  // scrolling near the end loads the next documents by itself, up to AUTO_MAX on the page; from there on (or when an
  // automatic load brought nothing new) the Load more button does it, so the page does not grow without end
  const moreRef = useRef<HTMLDivElement>(null)
  const autoAt = useRef(-1) // list length the last automatic load started from: never twice from the same one
  useEffect(() => { autoAt.current = -1 }, [fetchList]) // a new search or filter: a new list
  const moreNow = useRef({ loading, more: loadMore })
  moreNow.current = { loading, more: loadMore }
  const autoOn = items.length < AUTO_MAX && autoAt.current !== items.length
  const showMoreBtn = !autoOn && !(loading && autoAt.current === items.length)
  useEffect(() => {
    const el = moreRef.current, root = el?.closest('.content')
    if (!el || !root || !autoOn) return
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting) || moreNow.current.loading || autoAt.current === itemsRef.current.length) return
      autoAt.current = itemsRef.current.length
      moreNow.current.more()
    }, { root, rootMargin: '0px 0px 800px 0px' }) // starts about a screen before the end is reached
    io.observe(el)
    return () => io.disconnect()
  }, [autoOn, loading, items.length < total])
  // arriving from a document ("Show in folders"): scroll to it and flash it once; load further pages until it is found
  const hl: number | undefined = (loc.state as any)?.highlight
  const hlDone = useRef('')
  useEffect(() => {
    if (!hl || hlDone.current === loc.key || loading) return
    if (!items.some((d) => d.id === hl)) {
      if (items.length && items.length < total && items.length < 2000) loadMore()
      else if (items.length >= total && total > 0) hlDone.current = loc.key
      return
    }
    hlDone.current = loc.key
    const el = area.current?.querySelector<HTMLElement>(`[data-doc-id="${hl}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1600)
  }, [hl, loc.key, items, total, loading, layout])
  useEffect(() => { setSel(new Set()); setUpSel(new Set()) }, [params, view])
  // a selected document that left the list (dropped on Trash or into another folder, deleted in another tab) is no
  // longer selected: the selection bar and its actions must not act on documents that are not shown
  useEffect(() => {
    const have = new Set(items.map((d) => d.id))
    setSel((cur) => { const next = new Set([...cur].filter((id) => have.has(id))); return next.size === cur.size ? cur : next })
  }, [items])
  // something changed (an upload, a processing step, another user's edit): the store's status check notices within 5 s
  // and tells every open page; that also covers documents being processed, so the list has no poll of its own
  useEffect(() => {
    const h = () => load()
    window.addEventListener('soroka:reload', h)
    return () => window.removeEventListener('soroka:reload', h)
  }, [load])

  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p) }
  // rubber-band selection: press on empty space and drag; Ctrl/Shift adds to the selection, a plain click clears it
  const area = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const startBand = (e: React.MouseEvent) => {
    if (e.button !== 0 || !area.current) return
    if ((e.target as HTMLElement).closest('[data-doc-id], [data-upload-id], button, input, a, thead, .dd-pop')) return
    const wrap = area.current
    const r0 = wrap.getBoundingClientRect()
    const sx = e.clientX - r0.left, sy = e.clientY - r0.top
    const additive = e.ctrlKey || e.metaKey || e.shiftKey
    const base = additive ? new Set(sel) : new Set<number>()
    const upBase = additive ? new Set(upSel) : new Set<string>()
    const scroller = wrap.closest('.content') as HTMLElement | null
    // every card's box relative to the list, measured once: scrolling moves the list and its cards together
    const boxes = <K,>(q: string, key: (el: HTMLElement) => K) => Array.from(wrap.querySelectorAll<HTMLElement>(q)).map((el) => {
      const b = el.getBoundingClientRect()
      return { key: key(el), x: b.left - r0.left, y: b.top - r0.top, w: b.width, h: b.height }
    })
    const docBoxes = boxes('[data-doc-id]', (el) => Number(el.dataset.docId))
    const upBoxes = boxes('[data-upload-id]', (el) => el.dataset.uploadId!)
    const hit = <K,>(list: { key: K; x: number; y: number; w: number; h: number }[], from: Set<K>, x: number, y: number, w: number, h: number) => {
      const next = new Set(from)
      for (const b of list) if (b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y) next.add(b.key)
      return next
    }
    const same = <K,>(a: Set<K>, b: Set<K>) => a.size === b.size && [...a].every((k) => b.has(k))
    let moved = false, frame = 0, last: MouseEvent | null = null
    e.preventDefault()
    // mouse moves are handled once per frame, with the latest position
    const step = () => {
      frame = 0
      const ev = last!
      const r = wrap.getBoundingClientRect()
      const cx = ev.clientX - r.left, cy = ev.clientY - r.top
      if (!moved && Math.abs(cx - sx) + Math.abs(cy - sy) < 5) return
      moved = true
      const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), h = Math.abs(cy - sy)
      setBand({ x, y, w, h })
      const next = hit(docBoxes, base, x, y, w, h), upNext = hit(upBoxes, upBase, x, y, w, h)
      setSel((cur) => (same(cur, next) ? cur : next)) // unchanged selection: the list is not redrawn
      setUpSel((cur) => (same(cur, upNext) ? cur : upNext))
      if (scroller) {  // auto-scroll near the edges
        const sr = scroller.getBoundingClientRect()
        if (ev.clientY > sr.bottom - 40) scroller.scrollTop += 20
        else if (ev.clientY < sr.top + 100) scroller.scrollTop -= 20
      }
    }
    const move = (ev: MouseEvent) => { last = ev; if (!frame) frame = requestAnimationFrame(step) }
    const up = () => {
      if (frame) { cancelAnimationFrame(frame); step() } // the last move still counts
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setBand(null)
      if (!moved && !additive) { setSel(new Set()); setUpSel(new Set()) }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const toggle = (id: number) => setSel((cur) => { const s = new Set(cur); s.has(id) ? s.delete(id) : s.add(id); return s })
  const upToggle = (id: string) => { const s = new Set(upSel); s.has(id) ? s.delete(id) : s.add(id); setUpSel(s) }
  // uploads in progress: only in the main list, only those going to the folder shown; optional state filter
  const upFilter = params.get('upload') || ''
  // a saved upload's card gives way to its document card the moment the list shows that document (no gap)
  const listed = new Set(items.map((d) => d.id))
  const shownUp = (u: UpTask) => !!u.docIds && u.docIds.some((id) => listed.has(id))
  // and from then on that upload is finished with (it must not come back if the document leaves the list)
  const handedIds = uploads.tasks.filter(shownUp).map((u) => u.id).join(',')
  useEffect(() => { if (handedIds) uploads.handedOver(handedIds.split(',')) }, [handedIds])
  const upVisible = view !== 'active' ? [] : uploads.tasks.filter((u) => !shownUp(u) &&
    (params.get('folder') === 'none' ? u.folder == null : params.get('folder') ? u.folder === Number(params.get('folder')) : true) &&
    (upFilter === 'uploading' ? ['queued', 'uploading', 'saving'].includes(u.state)
      : upFilter === 'paused' ? u.state === 'paused' : upFilter === 'failed' ? u.state === 'error' : true))
  // the documents on screen answer another search than the one in the address (the first render after a new search,
  // before fetchList has cleared them): not shown, or the old list flashed up as results of the new search
  const stale = (() => { const q = query(); return q !== shownQuery.current && (isSearch(q) || isSearch(shownQuery.current)) })()
  const docsShown = upFilter || stale ? [] : items  // the upload filters show uploads only
  // everything the list shows (documents loaded so far and the uploads in it): the "Select all" link and Ctrl+A
  const selectAll = () => { setSel(new Set(docsShown.map((d) => d.id))); setUpSel(new Set(upVisible.map((u) => u.id))) }
  const selectAllNow = useRef(selectAll)
  selectAllNow.current = selectAll
  const selCount = useRef(0)
  selCount.current = sel.size + upSel.size
  // Ctrl+A selects everything shown; Esc clears the selection. Registered when the list opens, so before the
  // filter panel's Esc: with something selected, Esc only clears the selection (marked handled, so neither the
  // panel nor the page-wide search Esc acts on the same press); the next Esc closes the filters / ends the search
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.modal-bg')) return
      const el = document.activeElement as HTMLElement | null
      if (el?.matches('input, textarea, select, [contenteditable="true"]')) return // a field keeps its own keys
      if (e.key === 'Escape' && selCount.current > 0) {
        e.preventDefault()
        setSel(new Set()); setUpSel(new Set())
        return
      }
      // e.code: the A key in any keyboard layout (Ф on the Russian one)
      if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyA' || e.altKey || e.shiftKey) return
      e.preventDefault() // not the browser's select-all of the page text
      selectAllNow.current()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])
  const cancelUploads = async (ids: string[]) => {
    const n = ids.length
    if (!n || !(await dlg.confirm({ title: n === 1 ? t('up_cancel_q') : `${t('up_cancel_many_q')} (${n})`,
      message: t('up_cancel_msg'), ok: t('up_cancel'), danger: true }))) return
    await uploads.cancel(ids)
    setUpSel((s) => { const x = new Set(s); ids.forEach((i) => x.delete(i)); return x })
  }
  const upProps = (u: UpTask) => ({ task: u, selected: upSel.has(u.id), onToggle: () => upToggle(u.id),
    onPause: () => uploads.pause([u.id]), onResume: () => uploads.resume([u.id]), onCancel: () => cancelUploads([u.id]) })
  const bulk = async (action: string, extra: any = {}) => {
    try { await api('/api/documents/bulk', { body: { ids: [...sel], action, ...extra } }); setSel(new Set()); load(); reload() } catch (e: any) { toast(e.detail) }
  }
  const rescue = async (id: number) => { await api(`/api/documents/${id}/rescue`, { method: 'POST' }); load(); reload() }
  /** Permanent deletion: the documents leave the list at once and the request runs behind it (it takes a while for
   *  many documents); on failure the list is reloaded with what is really still there. `all`: every document in the
   *  list goes (Empty trash), also those not loaded yet. */
  const deleteNow = async (ids: number[], request: () => Promise<unknown>, all = false) => {
    ids.forEach((id) => gone.current.add(id))
    shown.current = null
    setSel(new Set())
    const cur = itemsRef.current
    const left = all ? [] : cur.filter((d) => !gone.current.has(d.id))
    setItems(left)
    setTotal((n) => all ? 0 : Math.max(0, n - (cur.length - left.length)))
    try { await request() } catch (e: any) { toast(e.detail) }
    ids.forEach((id) => gone.current.delete(id))
    load(); reload()
  }
  const purge = async (ids: number[]) => {
    if (!(await dlg.confirm({ title: t('purge') + '?', message: t('confirm_purge'), ok: t('purge'), danger: true }))) return
    await deleteNow(ids, () => api('/api/documents/purge', { body: { ids } }))
  }
  const emptyTrash = async () => {
    if (!(await dlg.confirm({ title: t('empty_trash') + '?', message: t('confirm_purge'), ok: t('empty_trash'), danger: true }))) return
    await deleteNow(itemsRef.current.map((d) => d.id), () => api('/api/trash/empty', { method: 'POST' }), true)
  }
  const setLayoutP = (l: 'grid' | 'list') => { setLayout(l); try { localStorage.setItem('layout', l) } catch { /* */ } }
  const open = (d: DocSummary) => nav(`/doc/${d.id}${params.get('q') ? '?q=' + encodeURIComponent(params.get('q')!) : ''}`)
  const dragStart = (e: React.DragEvent, d: DocSummary) => {
    const ids = sel.has(d.id) ? [...sel] : [d.id]
    e.dataTransfer.setData(DND, JSON.stringify({ type: 'docs', ids }))
    e.dataTransfer.setData(DND_DOCS, '') // readable during the drag (data is not): lets Trash light up for documents only
    // documents are only ever moved (to a folder, out of folders, to the trash): with every effect allowed the browser
    // showed the "copy" cursor for a moment between two folders
    e.dataTransfer.effectAllowed = 'move'
    // while documents are dragged the Trash tab has a larger drop area (styles: body.dragging-docs)
    document.body.classList.add('dragging-docs')
    const end = () => { document.body.classList.remove('dragging-docs'); window.removeEventListener('dragend', end, true); window.removeEventListener('drop', end, true) }
    window.addEventListener('dragend', end, true)
    window.addEventListener('drop', end, true)
    if (ids.length > 1) setMultiDragImage(e, ids.length, (e.currentTarget as HTMLElement).querySelector('.thumb img'))
  }
  // while something is selected a click on a document adds it to / removes it from the selection instead of opening it
  const selecting = sel.size + upSel.size > 0
  const activeFilters = FILTER_GROUPS.filter((g) => g.some((k) => params.get(k))).length
  const resetFilters = () => { const p = new URLSearchParams(params); FILTER_GROUPS.flat().forEach((k) => p.delete(k)); setParams(p) }
  // closing the filter panel (its button again, or Esc) also clears the filters it set
  const closeFilters = () => { setShowFilters(false); if (activeFilters) resetFilters() }
  const closeNow = useRef(closeFilters)
  closeNow.current = closeFilters
  useEffect(() => {
    if (!showFilters) return
    // on document: a dropdown open in the panel takes Esc first (it stops it there) and only closes itself; marked
    // handled so the page-wide Esc (App: ends a search) does not act on the same press
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-bg')) return
      e.preventDefault()
      closeNow.current()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [showFilters])
  const unfiled = params.get('folder') === 'none' // "Not in folders"; uploads from here go to no folder (folderId null)
  const folderId = params.get('folder') && !unfiled ? Number(params.get('folder')) : null
  const heading = view === 'trash' ? t('trash') : view === 'rejected' ? t('rejected') : folderId ? folderPath(folders, folderId) : unfiled ? t('not_in_folders') : t('all_documents')

  // files dragged in from the computer and dropped anywhere on the list: uploaded into the folder shown (as the
  // dialog would with its defaults). Only files from outside: documents dragged within the page carry no 'Files'.
  // fileOver: what is being dragged, as far as the types tell (none supported -> "not supported", no drop)
  const [fileOver, setFileOver] = useState<false | 'ok' | 'some' | 'none'>(false)
  const dragDepth = useRef(0) // enter/leave fire for every child crossed: count them to know when the pointer left
  // the overlay's message sits at the centre of the part of the overlay that is on screen (the list can be much
  // taller than the window and scrolled anywhere)
  const [dropCenter, setDropCenter] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    if (!fileOver || !area.current) return setDropCenter(null)
    const r = area.current.getBoundingClientRect()
    const s = (area.current.closest('.content') as HTMLElement | null)?.getBoundingClientRect()
    const top = Math.max(r.top, s?.top ?? 0, 0), bottom = Math.min(r.bottom, s?.bottom ?? innerHeight, innerHeight)
    const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth)
    setDropCenter({ x: (left + right) / 2, y: (top + bottom) / 2 })
  }, [!!fileOver])
  // a refused drop (unsupported files) or a drag that ended outside leaves no drop event to clear the overlay;
  // mouse moves never happen during a drag, so the first one after it ends does
  useEffect(() => {
    if (!fileOver) return
    const reset = () => { dragDepth.current = 0; setFileOver(false) }
    document.addEventListener('mousemove', reset)
    return () => document.removeEventListener('mousemove', reset)
  }, [fileOver])
  const acceptsFiles = view === 'active' && !upload
  const isFileDrag = (e: React.DragEvent) => acceptsFiles && Array.from(e.dataTransfer.types).includes('Files')
  const fileDrop = {
    onDragEnter: (e: React.DragEvent) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth.current++; setFileOver(dragVerdict(e.dataTransfer)) },
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = dragVerdict(e.dataTransfer) === 'none' ? 'none' : 'copy'
    },
    onDragLeave: (e: React.DragEvent) => { if (!isFileDrag(e)) return; if (--dragDepth.current <= 0) { dragDepth.current = 0; setFileOver(false) } },
    onDrop: async (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault(); dragDepth.current = 0; setFileOver(false)
      // only what can be uploaded (type, size); the rest is named in a message
      const { ok, skipped } = checkItems(await itemsFromDrop(e.dataTransfer))
      if (ok.length) uploads.add(toUploads(ok, { folder: folderId, tagIds: [], combine: false, low: false }))
      if (skipped.length) toast(skippedMessage(t, skipped))
    },
  }

  const searchMode = !!params.get('q')
  // an occurrence opens the place it is in: page text -> that page with the Text tab, context -> the Info tab with
  // the field / message marked, title or file name -> just the document
  const openHit = (d: DocSummary, h: NonNullable<DocSummary['hits']>[number]) => {
    const p = new URLSearchParams({ q: params.get('q') || '' })
    if (h.where === 'text') {
      p.set('tab', 'text')
      if (h.page != null) p.set('page', String(h.page + 1))
      // which occurrence on that page: its text without the hit marks, and where the first matched word starts
      p.set('at', h.text.replace(/[\x01\x02]/g, ''))
      p.set('ao', String(Math.max(0, h.text.indexOf('\x01'))))
    }
    else if (h.where === 'context') { p.set('tab', 'info'); if (h.field) p.set('focus', h.field) }
    else return nav(`/doc/${d.id}`)
    nav(`/doc/${d.id}?${p}`)
  }
  const restore = (id: number) => api('/api/documents/bulk', { body: { ids: [id], action: 'restore' } })
    .then(() => { setSel((o) => { const n = new Set(o); n.delete(id); return n }); load(); reload() }).catch((err) => toast(err.detail))
  // the cards get one unchanging set of actions that always calls the current handlers, so a card is redrawn only
  // when its document or its selection changes
  const actsNow = useRef<CardActs>(null as any)
  actsNow.current = { click: (d) => (selecting ? toggle(d.id) : open(d)), toggle, dragStart, rescue, restore }
  const acts = useMemo<CardActs>(() => ({
    click: (d) => actsNow.current.click(d), toggle: (id) => actsNow.current.toggle(id),
    dragStart: (e, d) => actsNow.current.dragStart(e, d), rescue: (id) => actsNow.current.rescue(id), restore: (id) => actsNow.current.restore(id),
  }), [])
  const card = (d: DocSummary) => <DocCard key={d.id} d={d} selected={sel.has(d.id)} view={view} acts={acts} />
  return (
    <div className={sel.size + upSel.size > 0 ? 'has-selection' : undefined} {...fileDrop}>
      {/* the toolbar and the filter panel stay at the top while the list scrolls under them */}
      <div className="list-head">
      {/* while documents are selected the selection actions replace the regular toolbar (same place, same height) */}
      <div className={'toolbar' + (sel.size + upSel.size > 0 ? ' selecting' : '')}>
        {sel.size + upSel.size > 0 ? <>
        <b>{sel.size + upSel.size} {t('selected')}</b>
        <span className="spacer" />
        <button className="link" onClick={selectAll} title="Ctrl+A">{t('select_all')}</button>
        <button className="link" onClick={() => { setSel(new Set()); setUpSel(new Set()) }}><X size={14} /> {t('clear_selection')}</button>
        {/* desktop: on the right of the bar; phone: a bottom action bar in place of the tab bar */}
        <div className="sel-actions">
          {upSel.size > 0 && <>
            <button onClick={() => uploads.pause([...upSel])}><Pause size={16} /> <span>{t('up_pause')}</span></button>
            <button onClick={() => uploads.resume([...upSel])}><Play size={16} /> <span>{t('up_resume')}</span></button>
            <button className="danger" onClick={() => cancelUploads([...upSel])}><X size={16} /> <span>{t('up_cancel')}</span></button>
          </>}
          {view === 'active' && sel.size > 0 && <>
            <FolderMenu label={t('sel_move')} onPick={(f) => bulk('move', { folder_id: f })} />
            <TagAdder exclude={[]} icon={<TagIcon size={16} />} label={t('sel_tag_add')} onAdd={(id) => bulk('tag_add', { tag_ids: [id] })} />
            <TagAdder exclude={[]} icon={<Tags size={16} />} label={t('sel_tag_remove')} noCreate onAdd={(id) => bulk('tag_remove', { tag_ids: [id] })} />
            <button onClick={() => downloadPost('/api/documents/download-zip', { ids: [...sel], kind: 'pdf' }, 'documents.zip')}><Download size={16} /> <span>{t('sel_zip')}</span></button>
            <button className="danger" onClick={() => bulk('trash')}><Trash2 size={16} /> <span>{t('to_trash')}</span></button>
          </>}
          {view === 'trash' && sel.size > 0 && <button onClick={() => bulk('restore')}><ArchiveRestore size={16} /> <span>{t('restore')}</span></button>}
          {(view === 'trash' || view === 'rejected') && sel.size > 0 && user.role === 'admin' && <button className="danger" onClick={() => purge([...sel])}><Trash2 size={16} /> <span>{t('purge')}</span></button>}
        </div>
        </> : <>
        <div className="tb-title">
          <h2>{heading}</h2>
          <span className="muted">{params.get('q') ? `${total} ${t('results')}` : plural(t, lang, total, 'pl_docs')}</span>
          {upVisible.length > 0 && <button className="link small" onClick={() => setParam('upload', upFilter ? '' : 'uploading')}>· {upVisible.length} {t('up_count')}</button>}
        </div>
        <span className="spacer" />
        {view === 'active' && <button onClick={() => (showFilters ? closeFilters() : setShowFilters(true))} className={showFilters || activeFilters ? 'active' : ''}>
          <SlidersHorizontal size={15} /> {t('filters')}{activeFilters > 0 && <span className="count">{activeFilters}</span>}</button>}
        {total > 0 && (() => {
          // sort = "<field>_<asc|desc>"; none = newest received first
          const [field, dir] = parseSort(params.get('sort'))
          const set = (f: SortField, d: 'asc' | 'desc') => setParam('sort', f === 'received' && d === 'desc' ? '' : `${f}_${d}`)
          return <div className="seg sort-btn">
            <button onClick={() => set(field, dir === 'asc' ? 'desc' : 'asc')} title={t(dir === 'asc' ? 'sort_asc' : 'sort_desc')}>
              {dir === 'asc' ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />}</button>
            <Select value={field} onChange={(f) => set(f, SORT_DEFAULT_DIR[f])} title={t('sort')}
              options={SORT_FIELDS.map((f) => ({ value: f, label: t(`sort_${f}`) }))} />
          </div>
        })()}
        {!searchMode && <div className="seg"><button className={layout === 'grid' ? 'active' : ''} onClick={() => setLayoutP('grid')} title={t('layout_grid')}><LayoutGrid size={15} /></button><button className={layout === 'list' ? 'active' : ''} onClick={() => setLayoutP('list')} title={t('layout_list')}><List size={15} /></button></div>}
        {view === 'active' && <button className="primary upload-btn" onClick={() => setUpload(true)} title={t('upload')}><UploadIcon size={16} /> <span>{t('upload')}</span></button>}
        {view === 'trash' && user.role === 'admin' && total > 0 && <button className="danger" onClick={emptyTrash} title={t('empty_trash')}><Trash2 size={15} /> <span className="lbl-phone-hide">{t('empty_trash')}</span></button>}
        </>}
      </div>
      {view === 'rejected' && <div className="filters muted small">{t('rejected_help')}</div>}
      {view === 'trash' && <div className="filters muted small">{t('trash_help')}</div>}
      {showFilters && view === 'active' && (
        <div className="filters filter-panel">
          <Field label={t('source')}><Select value={params.get('source') || ''} onChange={(v) => setParam('source', v)}
            options={[{ value: '', label: t('any') }, ...['upload', 'whatsapp', 'telegram', 'email', 'import'].map((x) => ({ value: x, label: t('source_' + x) }))]} /></Field>
          <Field label={t('file_type')}><Select value={params.get('file_type') || ''} onChange={(v) => setParam('file_type', v)}
            options={[{ value: '', label: t('any') }, ...fileTypes.map((x) => ({ value: x.value, label: `${x.label} (${x.count})` })),
              // a type picked earlier (link) that no document has any more stays shown
              ...(params.get('file_type') && !fileTypes.some((x) => x.value === params.get('file_type')) ? [{ value: params.get('file_type')!, label: params.get('file_type')!.toUpperCase() }] : [])]} /></Field>
          {/* one Status filter: document states (review param) and, while files are uploaded from this browser, upload
              states (upload param, shows those uploads only) */}
          <Field label={t('status')}><Select value={upFilter ? 'up:' + upFilter : params.get('review') || ''}
            onChange={(v) => {
              const p = new URLSearchParams(params)
              p.delete('review'); p.delete('upload')
              if (v.startsWith('up:')) p.set('upload', v.slice(3)); else if (v) p.set('review', v)
              setParams(p)
            }}
            options={[{ value: '', label: t('any') }, { value: 'queued', label: t('queued') }, { value: 'processing', label: t('processing') },
              { value: 'needs_review', label: t('needs_review') }, { value: 'check', label: t('st_check') }, { value: 'ok', label: t('st_ok') },
              { value: 'error', label: t('error') },
              ...(uploads.tasks.length > 0 || upFilter ? [{ value: 'up:uploading', label: t('up_f_uploading') },
                { value: 'up:paused', label: t('st_up_paused') }, { value: 'up:failed', label: t('st_up_failed') }] : [])]} /></Field>
          <Field label={t('language')}><Select value={params.get('language') || ''} onChange={(v) => setParam('language', v)}
            options={[{ value: '', label: t('any') }, { value: 'ru', label: 'RU' }, { value: 'en', label: 'EN' }, { value: 'mixed', label: 'RU + EN' }]} /></Field>
          {([['received', 'received'], ['date', 'doc_date']] as const).map(([k, label]) => (
            <Field key={k} label={t(label)}><DateRangeFilter label={t(label)} from={params.get(`${k}_from`) || ''} to={params.get(`${k}_to`) || ''}
              onChange={(f, to) => setParams((p) => { const n = new URLSearchParams(p); f ? n.set(`${k}_from`, f) : n.delete(`${k}_from`); to ? n.set(`${k}_to`, to) : n.delete(`${k}_to`); return n })} /></Field>
          ))}
          {/* pick a sender / chat from the list, or type part of a name: "ant" finds every sender containing it */}
          {(['sender', 'chat'] as const).map((k) => (
            <Field key={k} label={t(k)}><Combo className="text-filter" placeholder={t('any')} value={params.get(k) || ''} onCommit={(v) => setParam(k, v)}
              load={(q) => api(`/api/documents/suggest?field=${k}&q=${encodeURIComponent(q)}`)} /></Field>
          ))}
          {activeFilters > 0 && <button className="link reset-filters" onClick={resetFilters}><X size={14} /> {t('reset_filters')}</button>}
        </div>
      )}
      </div>
      <div ref={area} className="results" onMouseDown={startBand}>
      {band && <div className="band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />}
      {fileOver && (
        <div className={'file-drop' + (fileOver === 'none' ? ' bad' : '')}><div className="file-drop-msg"
          style={dropCenter ? { left: dropCenter.x, top: dropCenter.y } : { visibility: 'hidden' }}>
          {fileOver === 'none'
            ? <span className="icon-text"><Ban size={24} /> {t('drag_not_supported')}</span>
            : <span className="icon-text"><UploadIcon size={28} /> {t('drop_to_upload')} <b>{heading}</b></span>}
          {fileOver === 'some' && <span className="small file-drop-warn">{t('drag_some_not_supported')}</span>}
          <span className="small muted">{t('upload_limits')}</span>
        </div></div>
      )}
      {upFilter && <div className="filters small">{t('up_filter_on')} <button className="link" onClick={() => setParam('upload', '')}><X size={13} /> {t('clear_selection')}</button></div>}
      {!loading && !stale && docsShown.length === 0 && upVisible.length === 0 && <div className="page-pad muted">{t('nothing_found')}</div>}
      {(loading || stale) && searchMode && docsShown.length === 0 && <div className="page-pad muted">{t('loading')}</div>}
      {searchMode ? (
        /* search: one row per document — its card on the left, every place the words occur on the right */
        <div className="hit-rows">
          {docsShown.map((d) => (
            <div key={d.id} className="hit-row">
              {card(d)}
              <div className="hits"><div className="hits-in">
                {(d.hits || []).map((h, i) => <div key={i} className="hit-line" role="link" tabIndex={0} onClick={() => (selecting ? toggle(d.id) : openHit(d, h))}
                  onKeyDown={(e) => { if (e.key === 'Enter') openHit(d, h) }}><span className={'hit-where ' + h.where}>{t('hit_' + h.where)}</span><Snippet text={h.text} /></div>)}
              </div></div>
            </div>
          ))}
        </div>
      ) : layout === 'grid' ? (
        <div className="grid">
          {upVisible.map((u) => <UploadCard key={u.id} {...upProps(u)} />)}
          {docsShown.map(card)}
        </div>
      ) : (
        <table className="list docs-list">
          <thead><tr><th style={{ width: 30 }}><input type="checkbox" checked={sel.size === items.length && items.length > 0} onChange={(e) => setSel(e.target.checked ? new Set(items.map((d) => d.id)) : new Set())} /></th>
            <th>{t('title')}</th><th>{t('folder')}</th><th>{t('tags')}</th><th>{t('source')}</th><th>{t('received')}</th><th>{t('status')}</th></tr></thead>
          <tbody>
            {upVisible.map((u) => <UploadRow key={u.id} {...upProps(u)} />)}
            {docsShown.map((d) => (
              <DocRow key={d.id} d={d} selected={sel.has(d.id)} view={view} folder={folderPath(folders, d.folder_id)} acts={acts} />
            ))}
          </tbody>
        </table>
      )}
      {!upFilter && !stale && items.length < total && <div ref={moreRef} style={{ textAlign: 'center', padding: 16 }}>
        {showMoreBtn ? <button disabled={loading} onClick={loadMore}>{t('load_more')}</button> : loading && <span className="muted small">{t('loading')}</span>}</div>}
      </div>
      {upload && <UploadModal folderId={folderId} onClose={() => setUpload(false)} />}
    </div>
  )
}

/** A filter with its name in small type on the box's top border, at the left (instead of "Name: value" inside). */
/** Whether a list query (see DocumentsPage's query()) is a search. */
const isSearch = (s: string | null) => !!s && new URLSearchParams(s).has('q')

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <span className={'flt' + (wide ? ' flt-wide' : '')}><span className="flt-label">{label}</span>{children}</span>
}
