import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, DocSummary, downloadPost } from '../api'
import { useT } from '../i18n'
import { folderPath, useStore } from '../store'
import { DND } from '../components/Sidebar'
import { setMultiDragImage } from '../components/dragGhost'
import UploadModal from '../components/Upload'
import { FileName, FolderMenu, fmtDate, Snippet, TagAdder, TagChips, TierBadge } from '../components/Pickers'
import { Select, useDialog } from '../components/ui'
import { ArchiveRestore, Files, Download, LayoutGrid, List, SlidersHorizontal, TagIcon, Tags, Trash2, Upload as UploadIcon, X } from 'lucide-react'

const PAGE = 60

/** "1 page" / "3 pages"; Russian: 1 страница, 2–4 страницы, 5+ страниц (11–14 → страниц). */
function pagesLabel(n: number, lang: string): string {
  if (lang !== 'ru') return `${n} ${n === 1 ? 'page' : 'pages'}`
  const m10 = n % 10, m100 = n % 100
  const w = m10 === 1 && m100 !== 11 ? 'страница' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'страницы' : 'страниц'
  return `${n} ${w}`
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

  const load = useCallback(() => {
    setLoading(true)
    api(`/api/documents?${query()}`).then((r) => { setItems(r.items); setTotal(r.total) }).catch((e) => toast(e.detail)).finally(() => setLoading(false))
  }, [query])
  useEffect(() => { load() }, [load])
  useEffect(() => { setSel(new Set()); setLimit(PAGE) }, [params, view])
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
    if ((e.target as HTMLElement).closest('[data-doc-id], button, input, a, thead, .dd-pop')) return
    const wrap = area.current
    const r0 = wrap.getBoundingClientRect()
    const sx = e.clientX - r0.left, sy = e.clientY - r0.top
    const additive = e.ctrlKey || e.metaKey || e.shiftKey
    const base = additive ? new Set(sel) : new Set<number>()
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
      if (!moved && !additive) setSel(new Set())
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const toggle = (id: number) => { const s = new Set(sel); s.has(id) ? s.delete(id) : s.add(id); setSel(s) }
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
  const folderId = params.get('folder') ? Number(params.get('folder')) : null
  const heading = view === 'trash' ? t('trash') : view === 'rejected' ? t('rejected') : folderId ? folderPath(folders, folderId) : t('all_documents')

  return (
    <div>
      {/* while documents are selected the selection actions replace the regular toolbar (same place, same height) */}
      <div className={'toolbar' + (sel.size > 0 ? ' selecting' : '')}>
        {sel.size > 0 ? <>
        <b>{sel.size} {t('selected')}</b>
        {view === 'active' && <>
          <FolderMenu onPick={(f) => bulk('move', { folder_id: f })} />
          <TagAdder exclude={[]} icon={<TagIcon size={15} />} label={t('add_tag')} onAdd={(id) => bulk('tag_add', { tag_ids: [id] })} />
          <TagAdder exclude={[]} icon={<Tags size={15} />} label={t('remove_tag')} noCreate onAdd={(id) => bulk('tag_remove', { tag_ids: [id] })} />
          <button onClick={() => downloadPost('/api/documents/download-zip', { ids: [...sel], kind: 'pdf' }, 'documents.zip')}><Download size={15} /> {t('download_zip')}</button>
          <button className="danger" onClick={() => bulk('trash')}><Trash2 size={15} /> {t('to_trash')}</button>
        </>}
        {view === 'trash' && <button onClick={() => bulk('restore')}><ArchiveRestore size={15} /> {t('restore')}</button>}
        {(view === 'trash' || view === 'rejected') && user.role === 'admin' && <button className="danger" onClick={() => purge([...sel])}>{t('purge')}</button>}
        <span className="spacer" />
        <button className="link" onClick={() => setSel(new Set(items.map((d) => d.id)))}>{t('select_all')}</button>
        <button className="link" onClick={() => setSel(new Set())}><X size={14} /> {t('clear_selection')}</button>
        </> : <>
        <h2 style={{ margin: 0 }}>{heading}</h2>
        <span className="muted">{total} {params.get('q') ? t('results') : t('doc_count')}</span>
        <span className="spacer" />
        {view === 'active' && <button onClick={() => setShowFilters(!showFilters)} className={showFilters ? 'active' : ''}><SlidersHorizontal size={15} /> {t('filters')}</button>}
        <Select value={params.get('sort') || ''} onChange={(v) => setParam('sort', v)} prefix={t('sort')}
          options={[{ value: '', label: t('sort_received_desc') }, { value: 'received_asc', label: t('sort_received_asc') },
            { value: 'date_desc', label: t('sort_date_desc') }, { value: 'title', label: t('sort_title') }]} />
        <div className="seg"><button className={layout === 'grid' ? 'active' : ''} onClick={() => setLayoutP('grid')} title={t('layout_grid')}><LayoutGrid size={15} /></button><button className={layout === 'list' ? 'active' : ''} onClick={() => setLayoutP('list')} title={t('layout_list')}><List size={15} /></button></div>
        {view === 'active' && <button className="primary" onClick={() => setUpload(true)}><UploadIcon size={15} /> {t('upload')}</button>}
        {view === 'trash' && user.role === 'admin' && <button className="danger" onClick={emptyTrash}><Trash2 size={15} /> {t('empty_trash')}</button>}
        </>}
      </div>
      {view === 'rejected' && <div className="filters muted small">{t('rejected_help')}</div>}
      {view === 'trash' && <div className="filters muted small">{t('trash_help')}</div>}
      {showFilters && view === 'active' && (
        <div className="filters">
          <Select prefix={t('source')} value={params.get('source') || ''} onChange={(v) => setParam('source', v)}
            options={[{ value: '', label: t('any') }, ...['upload', 'whatsapp', 'telegram', 'email', 'import'].map((x) => ({ value: x, label: t('source_' + x) }))]} />
          <Select prefix={t('file_type')} value={params.get('file_type') || ''} onChange={(v) => setParam('file_type', v)}
            options={[{ value: '', label: t('any') }, ...['image', 'pdf', 'office', 'mixed'].map((x) => ({ value: x, label: t('ft_' + x) }))]} />
          <Select prefix={t('review_status')} value={params.get('review') || ''} onChange={(v) => setParam('review', v)}
            options={[{ value: '', label: t('any') }, { value: 'needs_review', label: t('needs_review') }, { value: 'check', label: t('check') }, { value: 'ok', label: t('ok') }]} />
          <Select prefix={t('languages')} value={params.get('language') || ''} onChange={(v) => setParam('language', v)}
            options={[{ value: '', label: t('any') }, { value: 'ru', label: 'RU' }, { value: 'en', label: 'EN' }, { value: 'mixed', label: 'RU + EN' }]} />
          <span className="small muted">{t('received')}</span>
          <input type="date" value={params.get('received_from') || ''} onChange={(e) => setParam('received_from', e.target.value)} />
          <input type="date" value={params.get('received_to') || ''} onChange={(e) => setParam('received_to', e.target.value)} />
          <span className="small muted">{t('doc_date')}</span>
          <input type="date" value={params.get('date_from') || ''} onChange={(e) => setParam('date_from', e.target.value)} />
          <input type="date" value={params.get('date_to') || ''} onChange={(e) => setParam('date_to', e.target.value)} />
          <input placeholder={t('sender')} defaultValue={params.get('sender') || ''} onBlur={(e) => setParam('sender', e.target.value)} style={{ width: 120 }} />
          <input placeholder={t('chat')} defaultValue={params.get('chat') || ''} onBlur={(e) => setParam('chat', e.target.value)} style={{ width: 120 }} />
        </div>
      )}
      <div ref={area} className="results" onMouseDown={startBand}>
      {band && <div className="band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />}
      {!loading && items.length === 0 && <div className="page-pad muted">{t('nothing_found')}</div>}
      {layout === 'grid' ? (
        <div className="grid">
          {items.map((d) => (
            <div key={d.id} data-doc-id={d.id} className={'doc-card' + (sel.has(d.id) ? ' sel' : '')} onClick={() => open(d)} draggable onDragStart={(e) => dragStart(e, d)}>
              <input type="checkbox" className="chk" checked={sel.has(d.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(d.id)} />
              <span className="tierdot"><TierBadge tier={d.needs_review ? 'low' : d.tier} status={d.status} /></span>
              <div className="thumb">{d.first_page_id ? <img loading="lazy" src={`/api/pages/${d.first_page_id}/image?variant=thumb&v=${d.status}`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : <span className="muted">{t('not_ready')}</span>}</div>
              <div className="body">
                <div className="card-title">
                  <FileName name={d.title} className="t" />
                  {d.page_count > 0 && <span className="pages-count" title={pagesLabel(d.page_count, lang)}><Files size={13} />{d.page_count}</span>}
                </div>
                {view === 'rejected' && <button onClick={(e) => { e.stopPropagation(); rescue(d.id) }}>{t('rescue')}</button>}
                {view === 'trash' && <button onClick={(e) => { e.stopPropagation(); setSel(new Set([d.id])); api('/api/documents/bulk', { body: { ids: [d.id], action: 'restore' } }).then(() => { load(); reload() }) }}>{t('restore')}</button>}
                {d.tags.length > 0 && <div className="card-tags"><TagChips ids={d.tags} singleLine /></div>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table className="list">
          <thead><tr><th style={{ width: 30 }}><input type="checkbox" checked={sel.size === items.length && items.length > 0} onChange={(e) => setSel(e.target.checked ? new Set(items.map((d) => d.id)) : new Set())} /></th>
            <th>{t('title')}</th><th>{t('folder')}</th><th>{t('tags')}</th><th>{t('source')}</th><th>{t('received')}</th><th>{t('status')}</th></tr></thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id} data-doc-id={d.id} className={sel.has(d.id) ? 'sel' : ''} onClick={() => open(d)} style={{ cursor: 'pointer' }} draggable onDragStart={(e) => dragStart(e, d)}>
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
      {items.length < total && <div style={{ textAlign: 'center', padding: 16 }}><button onClick={() => setLimit(limit + PAGE)}>{t('load_more')}</button></div>}
      </div>
      {upload && <UploadModal folderId={folderId} onClose={() => setUpload(false)} />}
    </div>
  )
}
