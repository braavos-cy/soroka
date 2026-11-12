import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, DocSummary, downloadPost } from '../api'
import { useT } from '../i18n'
import { folderPath, useStore } from '../store'
import { DND } from '../components/Sidebar'
import UploadModal from '../components/Upload'
import { FolderSelect, fmtDate, Snippet, TagAdder, TagChips, TierBadge } from '../components/Pickers'

const PAGE = 60

export default function DocumentsPage({ view }: { view: 'active' | 'rejected' | 'trash' }) {
  const { t } = useT()
  const { folders, user, reload, toast } = useStore()
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
    if (g('folder')) { p.set('folder_id', g('folder')); if (g('sub') === '0') p.set('subfolders', 'false') }
    if (g('tags')) p.set(g('tag_mode') === 'or' ? 'tags_any' : 'tags_all', g('tags'))
    if (g('tags_not')) p.set('tags_not', g('tags_not'))
    for (const k of ['source', 'file_type', 'review', 'status', 'sender', 'chat', 'received_from', 'received_to', 'date_from', 'date_to', 'sort', 'language'])
      if (g(k)) p.set(k, g(k))
    return p.toString()
  }, [params, view, limit])

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
  const toggle = (id: number) => { const s = new Set(sel); s.has(id) ? s.delete(id) : s.add(id); setSel(s) }
  const bulk = async (action: string, extra: any = {}) => {
    try { await api('/api/documents/bulk', { body: { ids: [...sel], action, ...extra } }); setSel(new Set()); load(); reload() } catch (e: any) { toast(e.detail) }
  }
  const rescue = async (id: number) => { await api(`/api/documents/${id}/rescue`, { method: 'POST' }); load(); reload() }
  const purge = async (ids: number[]) => {
    if (!confirm(t('confirm_purge'))) return
    for (const id of ids) await api(`/api/documents/${id}`, { method: 'DELETE' })
    setSel(new Set()); load(); reload()
  }
  const emptyTrash = async () => { if (confirm(t('confirm_purge'))) { await api('/api/trash/empty', { method: 'POST' }); load(); reload() } }
  const setLayoutP = (l: 'grid' | 'list') => { setLayout(l); try { localStorage.setItem('layout', l) } catch { /* */ } }
  const open = (d: DocSummary) => nav(`/doc/${d.id}${params.get('q') ? '?q=' + encodeURIComponent(params.get('q')!) : ''}`)
  const dragStart = (e: React.DragEvent, d: DocSummary) => {
    const ids = sel.has(d.id) ? [...sel] : [d.id]
    e.dataTransfer.setData(DND, JSON.stringify({ type: 'docs', ids }))
  }
  const folderId = params.get('folder') ? Number(params.get('folder')) : null
  const heading = view === 'trash' ? t('trash') : view === 'rejected' ? t('rejected') : folderId ? folderPath(folders, folderId) : t('all_documents')

  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>{heading.replace(/^Inbox/, t('app') === 'Сорока' ? 'Входящие' : 'Inbox')}</h2>
        <span className="muted">{total} {params.get('q') ? t('results') : t('doc_count')}</span>
        <span className="spacer" />
        {view === 'active' && <button onClick={() => setShowFilters(!showFilters)} className={showFilters ? 'active' : ''}>⚲ {t('filters')}</button>}
        <select value={params.get('sort') || ''} onChange={(e) => setParam('sort', e.target.value)}>
          <option value="">↓ {t('received')}</option><option value="received_asc">↑ {t('received')}</option>
          <option value="date_desc">↓ {t('doc_date')}</option><option value="title">{t('title')}</option>
        </select>
        <div className="seg"><button className={layout === 'grid' ? 'active' : ''} onClick={() => setLayoutP('grid')}>▦</button><button className={layout === 'list' ? 'active' : ''} onClick={() => setLayoutP('list')}>☰</button></div>
        {view === 'active' && <button className="primary" onClick={() => setUpload(true)}>⤒ {t('upload')}</button>}
        {view === 'trash' && user.role === 'admin' && <button className="danger" onClick={emptyTrash}>{t('empty_trash')}</button>}
      </div>
      {view === 'rejected' && <div className="filters muted small">{t('rejected_help')}</div>}
      {view === 'trash' && <div className="filters muted small">{t('trash_help')}</div>}
      {showFilters && view === 'active' && (
        <div className="filters">
          <select value={params.get('source') || ''} onChange={(e) => setParam('source', e.target.value)}>
            <option value="">{t('source')}: {t('any')}</option>
            {['upload', 'whatsapp', 'telegram', 'email', 'import'].map((s) => <option key={s} value={s}>{t('source_' + s)}</option>)}
          </select>
          <select value={params.get('file_type') || ''} onChange={(e) => setParam('file_type', e.target.value)}>
            <option value="">{t('file_type')}: {t('any')}</option>
            {['image', 'pdf', 'office', 'mixed'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={params.get('review') || ''} onChange={(e) => setParam('review', e.target.value)}>
            <option value="">{t('review_status')}: {t('any')}</option>
            <option value="needs_review">{t('needs_review')}</option><option value="check">{t('check')}</option><option value="ok">{t('ok')}</option>
          </select>
          <select value={params.get('language') || ''} onChange={(e) => setParam('language', e.target.value)}>
            <option value="">{t('languages')}: {t('any')}</option><option value="ru">ru</option><option value="en">en</option><option value="mixed">mixed</option>
          </select>
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
      {sel.size > 0 && (
        <div className="bulkbar">
          <b>{sel.size} {t('selected')}</b>
          {view === 'active' && <>
            <FolderSelect value={null} placeholder={t('move_to')} onChange={(f) => f && bulk('move', { folder_id: f })} />
            <TagAdder exclude={[]} onAdd={(id) => bulk('tag_add', { tag_ids: [id] })} />
            <TagAdder exclude={[]} label={t('remove_tag')} onAdd={(id) => bulk('tag_remove', { tag_ids: [id] })} />
            <button onClick={() => downloadPost('/api/documents/download-zip', { ids: [...sel], kind: 'pdf' }, 'documents.zip')}>⤓ {t('download_zip')}</button>
            <button className="danger" onClick={() => bulk('trash')}>🗑 {t('to_trash')}</button>
          </>}
          {view === 'trash' && <button onClick={() => bulk('restore')}>{t('restore')}</button>}
          {(view === 'trash' || view === 'rejected') && user.role === 'admin' && <button className="danger" onClick={() => purge([...sel])}>{t('purge')}</button>}
          <button className="link" onClick={() => setSel(new Set(items.map((d) => d.id)))}>{t('select_all')}</button>
          <button className="link" onClick={() => setSel(new Set())}>{t('clear_selection')}</button>
        </div>
      )}
      {!loading && items.length === 0 && <div className="page-pad muted">{t('nothing_found')}</div>}
      {layout === 'grid' ? (
        <div className="grid">
          {items.map((d) => (
            <div key={d.id} className={'doc-card' + (sel.has(d.id) ? ' sel' : '')} onClick={() => open(d)} draggable onDragStart={(e) => dragStart(e, d)}>
              <input type="checkbox" className="chk" checked={sel.has(d.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(d.id)} />
              <span className="tierdot"><TierBadge tier={d.needs_review ? 'low' : d.tier} status={d.status} /></span>
              <div className="thumb">{d.first_page_id ? <img loading="lazy" src={`/api/pages/${d.first_page_id}/image?variant=thumb&v=${d.status}`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : <span className="muted">{t('not_ready')}</span>}</div>
              <div className="body">
                <div className="t" title={d.title}>{d.title || '—'}</div>
                <div className="small muted row" style={{ gap: 6 }}>
                  <span>{fmtDate(d.document_date || d.received_at)}</span>
                  <span>· {t('source_' + d.source)}</span>
                  {d.page_count > 1 && <span>· {d.page_count} {t('pages').toLowerCase()}</span>}
                </div>
                {(d.chat || d.sender) && <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[d.chat, d.sender].filter(Boolean).join(' · ')}</div>}
                <TagChips ids={d.tags} />
                <Snippet text={d.snippet} />
                {view === 'rejected' && <button onClick={(e) => { e.stopPropagation(); rescue(d.id) }}>{t('rescue')}</button>}
                {view === 'trash' && <button onClick={(e) => { e.stopPropagation(); setSel(new Set([d.id])); api('/api/documents/bulk', { body: { ids: [d.id], action: 'restore' } }).then(() => { load(); reload() }) }}>{t('restore')}</button>}
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
              <tr key={d.id} onClick={() => open(d)} style={{ cursor: 'pointer' }} draggable onDragStart={(e) => dragStart(e, d)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(d.id)} onChange={() => toggle(d.id)} /></td>
                <td><div>{d.title}</div><Snippet text={d.snippet} /></td>
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
      {items.length < total && <div style={{ textAlign: 'center', padding: 16 }}><button onClick={() => setLimit(limit + PAGE)}>…</button></div>}
      {upload && <UploadModal folderId={folderId} onClose={() => setUpload(false)} />}
    </div>
  )
}
