import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, DocSummary, downloadPost } from '../api'
import { plural, useT } from '../i18n'
import { folderPath, useStore } from '../store'
import { DND } from '../components/Sidebar'
import { setMultiDragImage } from '../components/dragGhost'
import UploadModal, { itemsFromDrop, toUploads } from '../components/Upload'
import { fmtMB, UpTask, useUploads } from '../components/uploads'
import { DateRange, FileName, FolderMenu, fmtDate, PageThumb, Snippet, TagAdder, TagChips, TierBadge } from '../components/Pickers'
import { Select, useDialog } from '../components/ui'
import { ArchiveRestore, ArrowDownUp, Files, Download, LayoutGrid, List, Pause, Play, SlidersHorizontal, TagIcon, Tags, Trash2, Upload as UploadIcon, X } from 'lucide-react'

const PAGE = 60

// filters in the Filters panel; dates count once per range
const FILTER_GROUPS = [['source'], ['file_type'], ['review'], ['upload'], ['language'], ['received_from', 'received_to'], ['date_from', 'date_to'], ['sender'], ['chat']]

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
      <div className="thumb up-thumb">
        {u.state === 'paused' ? <Pause size={28} /> : <UploadIcon size={28} />}
        <div className="up-pct">{u.state === 'saving' ? t('up_saving') : `${pct}%`}</div>
        <div className="progress"><div style={{ width: `${pct}%` }} /></div>
        <div className="small muted">{fmtMB(u.sent)} / {fmtMB(u.size)} MB</div>
      </div>
      <div className="body">
        <div className="card-title"><FileName name={u.name} className="t" /></div>
        <div className="row up-actions">
          <span className={'small ' + (u.state === 'error' ? 'danger-text' : 'muted')} title={upStatus(u, t)}>{upStatus(u, t)}</span>
          <span className="spacer" /><UpButtons {...p} />
        </div>
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
  const [items, setItems] = useState<DocSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [upSel, setUpSel] = useState<Set<string>>(new Set())
  const uploads = useUploads()
  const [upload, setUpload] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [layout, setLayout] = useState<'grid' | 'list'>(() => { try { return (localStorage.getItem('layout') as any) || 'grid' } catch { return 'grid' } })
  const [limit, setLimit] = useState(PAGE)

  const query = useCallback(() => {
    const p = new URLSearchParams({ view, limit: String(limit) })
    const g = (k: string) => params.get(k) || ''
    if (g('q')) p.set('q', g('q'))
    if (g('folder')) { p.set('folder_id', g('folder')); if (user.include_subfolders) p.set('subfolders', 'true') }
    if (g('tags')) p.set(g('tag_mode') === 'or' ? 'tags_any' : 'tags_all', g('tags'))
    if (g('tags_not')) p.set('tags_not', g('tags_not'))
    for (const k of ['source', 'file_type', 'review', 'status', 'sender', 'chat', 'received_from', 'received_to', 'date_from', 'date_to', 'sort', 'language'])
      if (g(k)) p.set(k, g(k))
    return p.toString()
  }, [params, view, limit, user.include_subfolders])

  const shown = useRef('')
  const loadSeq = useRef(0)// search-as-you-type: an answer to an older query must not replace a newer one
  const load = useCallback(() => {
    const seq = ++loadSeq.current
    setLoading(true)
    api(`/api/documents?${query()}`).then((r) => { if (seq !== loadSeq.current) return
      // same answer as what is on screen (next letter of the same word, background refresh): leave the list alone
      const sig = JSON.stringify(r.items)
      if (sig !== shown.current) { shown.current = sig; setItems(r.items) }
      setTotal(r.total)
    })
      .catch((e) => { if (seq === loadSeq.current) toast(e.detail) }).finally(() => { if (seq === loadSeq.current) setLoading(false) })
  }, [query])
  useEffect(() => { load() }, [load])
  // arriving from a document ("Show in folders"): scroll to it and flash it once; load further pages until it is found
  const loc = useLocation()
  const hl: number | undefined = (loc.state as any)?.highlight
  const hlDone = useRef('')
  useEffect(() => {
    if (!hl || hlDone.current === loc.key || loading) return
    if (!items.some((d) => d.id === hl)) {
      if (items.length && items.length < total && limit < 2000) setLimit(limit + PAGE)
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
  useEffect(() => { setSel(new Set()); setUpSel(new Set()); setLimit(PAGE) }, [params, view])
  useEffect(() => {
    const h = () => load()
    window.addEventListener('soroka:reload', h)
    // keep polling while something is processing
    const busy = items.some((d) => ['queued', 'processing'].includes(d.status))
    const i = busy ? setInterval(load, 4000) : undefined
    return () => { window.removeEventListener('soroka:reload', h); if (i) clearInterval(i) }
  }, [load, items])

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
    let moved = false
    e.preventDefault()
    const move = (ev: MouseEvent) => {
      const r = wrap.getBoundingClientRect()
      const cx = ev.clientX - r.left, cy = ev.clientY - r.top
      if (!moved && Math.abs(cx - sx) + Math.abs(cy - sy) < 5) return
      moved = true
      const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), h = Math.abs(cy - sy)
      setBand({ x, y, w, h })
      const next = new Set(base)
      wrap.querySelectorAll<HTMLElement>('[data-doc-id]').forEach((el) => {
        const b = el.getBoundingClientRect()
        const bx = b.left - r.left, by = b.top - r.top
        if (bx < x + w && bx + b.width > x && by < y + h && by + b.height > y) next.add(Number(el.dataset.docId))
      })
      setSel(next)
      const upNext = new Set(upBase)
      wrap.querySelectorAll<HTMLElement>('[data-upload-id]').forEach((el) => {
        const b = el.getBoundingClientRect()
        const bx = b.left - r.left, by = b.top - r.top
        if (bx < x + w && bx + b.width > x && by < y + h && by + b.height > y) upNext.add(el.dataset.uploadId!)
      })
      setUpSel(upNext)
      if (scroller) {  // auto-scroll near the edges
        const sr = scroller.getBoundingClientRect()
        if (ev.clientY > sr.bottom - 40) scroller.scrollTop += 20
        else if (ev.clientY < sr.top + 100) scroller.scrollTop -= 20
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setBand(null)
      if (!moved && !additive) { setSel(new Set()); setUpSel(new Set()) }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const toggle = (id: number) => { const s = new Set(sel); s.has(id) ? s.delete(id) : s.add(id); setSel(s) }
  const upToggle = (id: string) => { const s = new Set(upSel); s.has(id) ? s.delete(id) : s.add(id); setUpSel(s) }
  // uploads in progress: only in the main list, only those going to the folder shown; optional state filter
  const upFilter = params.get('upload') || ''
  const upVisible = view !== 'active' ? [] : uploads.tasks.filter((u) =>
    (params.get('folder') ? u.folder === Number(params.get('folder')) : true) &&
    (upFilter === 'uploading' ? ['queued', 'uploading', 'saving'].includes(u.state)
      : upFilter === 'paused' ? u.state === 'paused' : upFilter === 'failed' ? u.state === 'error' : true))
  const docsShown = upFilter ? [] : items  // the upload filters show uploads only
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
  const purge = async (ids: number[]) => {
    if (!(await dlg.confirm({ title: t('purge') + '?', message: t('confirm_purge'), ok: t('purge'), danger: true }))) return
    for (const id of ids) await api(`/api/documents/${id}`, { method: 'DELETE' })
    setSel(new Set()); load(); reload()
  }
  const emptyTrash = async () => { if (await dlg.confirm({ title: t('empty_trash') + '?', message: t('confirm_purge'), ok: t('empty_trash'), danger: true })) { await api('/api/trash/empty', { method: 'POST' }); load(); reload() } }
  const setLayoutP = (l: 'grid' | 'list') => { setLayout(l); try { localStorage.setItem('layout', l) } catch { /* */ } }
  const open = (d: DocSummary) => nav(`/doc/${d.id}${params.get('q') ? '?q=' + encodeURIComponent(params.get('q')!) : ''}`)
  const dragStart = (e: React.DragEvent, d: DocSummary) => {
    const ids = sel.has(d.id) ? [...sel] : [d.id]
    e.dataTransfer.setData(DND, JSON.stringify({ type: 'docs', ids }))
    if (ids.length > 1) setMultiDragImage(e, ids.length, (e.currentTarget as HTMLElement).querySelector('.thumb img'))
  }
  // while something is selected a click on a document adds it to / removes it from the selection instead of opening it
  const selecting = sel.size + upSel.size > 0
  const activeFilters = FILTER_GROUPS.filter((g) => g.some((k) => params.get(k))).length
  const resetFilters = () => { const p = new URLSearchParams(params); FILTER_GROUPS.flat().forEach((k) => p.delete(k)); setParams(p) }
  const folderId = params.get('folder') ? Number(params.get('folder')) : null
  const heading = view === 'trash' ? t('trash') : view === 'rejected' ? t('rejected') : folderId ? folderPath(folders, folderId) : t('all_documents')

  // files dragged in from the computer and dropped anywhere on the list: uploaded into the folder shown (as the
  // dialog would with its defaults). Only files from outside: documents dragged within the page carry no 'Files'.
  const [fileOver, setFileOver] = useState(false)
  const dragDepth = useRef(0) // enter/leave fire for every child crossed: count them to know when the pointer left
  const acceptsFiles = view === 'active' && !upload
  const isFileDrag = (e: React.DragEvent) => acceptsFiles && Array.from(e.dataTransfer.types).includes('Files')
  const fileDrop = {
    onDragEnter: (e: React.DragEvent) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth.current++; setFileOver(true) },
    onDragOver: (e: React.DragEvent) => { if (!isFileDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy' },
    onDragLeave: (e: React.DragEvent) => { if (!isFileDrag(e)) return; if (--dragDepth.current <= 0) { dragDepth.current = 0; setFileOver(false) } },
    onDrop: async (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault(); dragDepth.current = 0; setFileOver(false)
      const items = await itemsFromDrop(e.dataTransfer)
      if (items.length) uploads.add(toUploads(items, { folder: folderId, tagIds: [], combine: false, low: false }))
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
  const card = (d: DocSummary) => (
    <div key={d.id} data-doc-id={d.id} className={'doc-card' + (sel.has(d.id) ? ' sel' : '')} onClick={() => (selecting ? toggle(d.id) : open(d))} draggable onDragStart={(e) => dragStart(e, d)}>
      <input type="checkbox" className="chk" checked={sel.has(d.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(d.id)} />
      <span className="tierdot"><TierBadge tier={d.needs_review ? 'low' : d.tier} status={d.status} /></span>
      <div className="thumb"><PageThumb pageId={d.first_page_id} v={d.thumb_v} status={d.status} /></div>
      <div className="body">
        <div className="card-title">
          <FileName name={d.title} className="t" />
          {d.page_count > 0 && <span className="pages-count" title={plural(t, lang, d.page_count, 'pl_pages')}><Files size={13} />{d.page_count}</span>}
        </div>
        {view === 'rejected' && <button onClick={(e) => { e.stopPropagation(); rescue(d.id) }}>{t('rescue')}</button>}
        {view === 'trash' && <button onClick={(e) => { e.stopPropagation(); api('/api/documents/bulk', { body: { ids: [d.id], action: 'restore' } }).then(() => { setSel((o) => { const n = new Set(o); n.delete(d.id); return n }); load(); reload() }).catch((err) => toast(err.detail)) }}>{t('restore')}</button>}
        {d.tags.length > 0 && <div className="card-tags"><TagChips ids={d.tags} singleLine /></div>}
      </div>
    </div>
  )
  return (
    <div className={sel.size + upSel.size > 0 ? 'has-selection' : undefined} {...fileDrop}>
      {/* while documents are selected the selection actions replace the regular toolbar (same place, same height) */}
      <div className={'toolbar' + (sel.size + upSel.size > 0 ? ' selecting' : '')}>
        {sel.size + upSel.size > 0 ? <>
        <b>{sel.size + upSel.size} {t('selected')}</b>
        <span className="spacer" />
        <button className="link" onClick={() => { setSel(new Set(docsShown.map((d) => d.id))); setUpSel(new Set(upVisible.map((u) => u.id))) }}>{t('select_all')}</button>
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
        {view === 'active' && <button onClick={() => setShowFilters(!showFilters)} className={showFilters || activeFilters ? 'active' : ''}>
          <SlidersHorizontal size={15} /> {t('filters')}{activeFilters > 0 && <span className="count">{activeFilters}</span>}</button>}
        {total > 0 && <Select value={params.get('sort') || ''} onChange={(v) => setParam('sort', v)} icon={<ArrowDownUp size={15} />} title={t('sort')} className="sort-btn"
          options={[{ value: '', label: t('sort_received_desc') }, { value: 'received_asc', label: t('sort_received_asc') },
            { value: 'date_desc', label: t('sort_date_desc') }, { value: 'title', label: t('sort_title') }]} />}
        {!searchMode && <div className="seg"><button className={layout === 'grid' ? 'active' : ''} onClick={() => setLayoutP('grid')} title={t('layout_grid')}><LayoutGrid size={15} /></button><button className={layout === 'list' ? 'active' : ''} onClick={() => setLayoutP('list')} title={t('layout_list')}><List size={15} /></button></div>}
        {view === 'active' && <button className="primary upload-btn" onClick={() => setUpload(true)} title={t('upload')}><UploadIcon size={16} /> <span>{t('upload')}</span></button>}
        {view === 'trash' && user.role === 'admin' && total > 0 && <button className="danger" onClick={emptyTrash} title={t('empty_trash')}><Trash2 size={15} /> <span className="lbl-phone-hide">{t('empty_trash')}</span></button>}
        </>}
      </div>
      {view === 'rejected' && <div className="filters muted small">{t('rejected_help')}</div>}
      {view === 'trash' && <div className="filters muted small">{t('trash_help')}</div>}
      {showFilters && view === 'active' && (
        <div className="filters filter-panel">
          <Select prefix={t('source')} value={params.get('source') || ''} onChange={(v) => setParam('source', v)}
            options={[{ value: '', label: t('any') }, ...['upload', 'whatsapp', 'telegram', 'email', 'import'].map((x) => ({ value: x, label: t('source_' + x) }))]} />
          <Select prefix={t('file_type')} value={params.get('file_type') || ''} onChange={(v) => setParam('file_type', v)}
            options={[{ value: '', label: t('any') }, ...['image', 'pdf', 'office', 'mixed'].map((x) => ({ value: x, label: t('ft_' + x) }))]} />
          <Select prefix={t('review_status')} value={params.get('review') || ''} onChange={(v) => setParam('review', v)}
            options={[{ value: '', label: t('any') }, { value: 'needs_review', label: t('needs_review') }, { value: 'check', label: t('check') }, { value: 'ok', label: t('ok') }]} />
          <Select prefix={t('languages')} value={params.get('language') || ''} onChange={(v) => setParam('language', v)}
            options={[{ value: '', label: t('any') }, { value: 'ru', label: 'RU' }, { value: 'en', label: 'EN' }, { value: 'mixed', label: 'RU + EN' }]} />
          {/* only meaningful while files are being uploaded from this browser */}
          {(uploads.tasks.length > 0 || upFilter) && <Select prefix={t('up_filter')} value={upFilter} onChange={(v) => setParam('upload', v)}
            options={[{ value: '', label: t('any') }, { value: 'uploading', label: t('up_f_uploading') }, { value: 'paused', label: t('up_f_paused') }, { value: 'failed', label: t('up_f_failed') }]} />}
          <DateRange label={t('received')} from={params.get('received_from') || ''} to={params.get('received_to') || ''}
            onFrom={(v) => setParam('received_from', v)} onTo={(v) => setParam('received_to', v)} />
          <DateRange label={t('doc_date')} from={params.get('date_from') || ''} to={params.get('date_to') || ''}
            onFrom={(v) => setParam('date_from', v)} onTo={(v) => setParam('date_to', v)} />
          {(['sender', 'chat'] as const).map((k) => (
            <input key={k + (params.get(k) || '')} type="search" className="text-filter" placeholder={t(k)} defaultValue={params.get(k) || ''}
              onBlur={(e) => e.target.value !== (params.get(k) || '') && setParam(k, e.target.value.trim())}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          ))}
          {activeFilters > 0 && <button className="link reset-filters" onClick={resetFilters}><X size={14} /> {t('reset_filters')}</button>}
        </div>
      )}
      <div ref={area} className="results" onMouseDown={startBand}>
      {band && <div className="band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />}
      {fileOver && <div className="file-drop"><div><UploadIcon size={28} /> {t('drop_to_upload')} <b>{heading}</b></div></div>}
      {upFilter && <div className="filters small">{t('up_filter_on')} <button className="link" onClick={() => setParam('upload', '')}><X size={13} /> {t('clear_selection')}</button></div>}
      {!loading && docsShown.length === 0 && upVisible.length === 0 && <div className="page-pad muted">{t('nothing_found')}</div>}
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
              <tr key={d.id} data-doc-id={d.id} className={sel.has(d.id) ? 'sel' : ''} onClick={() => (selecting ? toggle(d.id) : open(d))} style={{ cursor: 'pointer' }} draggable onDragStart={(e) => dragStart(e, d)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(d.id)} onChange={() => toggle(d.id)} /></td>
                <td className="title-cell"><FileName name={d.title} /><Snippet text={d.snippet} /></td>
                <td className="small muted">{folderPath(folders, d.folder_id)}</td>
                <td><TagChips ids={d.tags} /></td>
                <td className="small">{t('source_' + d.source)}{d.chat ? ` · ${d.chat}` : ''}</td>
                <td className="small">{fmtDate(d.received_at, true)}</td>
                <td><TierBadge tier={d.needs_review ? 'low' : d.tier} status={d.status} />{view === 'rejected' && <button className="link" onClick={(e) => { e.stopPropagation(); rescue(d.id) }}>{t('rescue')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!upFilter && items.length < total && <div style={{ textAlign: 'center', padding: 16 }}><button onClick={() => setLimit(limit + PAGE)}>{t('load_more')}</button></div>}
      </div>
      {upload && <UploadModal folderId={folderId} onClose={() => setUpload(false)} />}
    </div>
  )
}
