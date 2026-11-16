import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useT } from '../i18n'
import { folderPath, useStore } from '../store'
import { fmtBytes, fmtDate, PageThumb, TagAdder, TagChips, TierBadge } from '../components/Pickers'
import { Menu, Select, useDialog } from '../components/ui'
import { CropEditor, MeshEditor } from '../components/PageEditors'
import { ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, Check, CheckCheck, Crop, Download, FolderSearch, Grid3x3, History, Layers2, Loader2, MoreHorizontal, Redo2, RefreshCw, RotateCcw, RotateCw, Trash2, Undo2 } from 'lucide-react'

const STAGES = ['quality', 'acceptance', 'crop', 'dewarp', 'orientation', 'deskew', 'cleanup', 'ocr', 'layout', 'consistency', 'outputs']
type Pt = [number, number]

// what the badge under a page thumbnail shows: a processing state, or the quality tier (reviewed = OK)
const CAT_ORDER = ['high', 'medium', 'low', 'error', 'processing', 'queued', 'stopped', 'excluded', 'none']
function pageCat(p: any): string {
  if (['queued', 'processing', 'stopped', 'excluded', 'error'].includes(p.status)) return p.status
  return p.reviewed ? 'high' : p.tier || 'none'
}
const CAT_COLOR: Record<string, string> = { high: 'var(--ok)', medium: 'var(--warn)', low: 'var(--bad)', error: 'var(--bad)', none: 'var(--muted)' }
const catColor = (k: string) => CAT_COLOR[k] || 'var(--accent)'
const catLabel = (t: (k: string) => string, k: string) => (['high', 'medium', 'low'].includes(k) ? t('tier_' + k) : k === 'none' ? '—' : t(k))

export default function DocumentView() {
  const { id } = useParams()
  const { t } = useT()
  const { user, folders, reload: reloadStore, toast } = useStore()
  const dlg = useDialog()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const q = params.get('q') || ''
  // opened from search results; emptying the search box while here drops ?q= from the address
  const fromSearch = useRef(!!q)
  // where the document lives: its folder in the list, the trash, or the rejected list, with it highlighted
  const showPlace = (opts?: { replace?: boolean }) => doc && nav(doc.trashed_at ? '/trash' : doc.status === 'rejected' ? '/rejected' : doc.folder_id ? `/?folder=${doc.folder_id}` : '/', { state: { highlight: doc.id }, ...opts })
  // back to where the document was opened from (list, folder, search, review); opened by direct link -> the list.
  // Opened from a search that has since been cleared: not back to the results, to where the document is.
  const goBack = () => {
    if (fromSearch.current && !q) return showPlace({ replace: true })
    return (window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav('/')
  }
  const [doc, setDoc] = useState<any>(null)
  // opened from a search occurrence: ?page= (1-based), ?tab=, ?focus= (info field or context message)
  const [pageIdx, setPageIdx] = useState(() => Math.max(0, Number(params.get('page') || 1) - 1))
  const [page, setPage] = useState<any>(null)
  const [tab, setTab] = useState<'pipeline' | 'info' | 'text'>(() => (['info', 'text'].includes(params.get('tab') || '') ? params.get('tab') as 'info' | 'text' : 'pipeline'))
  const focus = params.get('focus') || ''
  // the occurrence pressed in the search results: its text and where in it the matched word starts
  const atText = params.get('at') || '', atOff = Number(params.get('ao') || 0)
  const at = useMemo(() => (atText ? { text: atText, off: atOff } : undefined), [atText, atOff])
  const [mode, setMode] = useState<'result' | 'crop'>('result')
  const [preview, setPreview] = useState<{ rotate?: number; deskew?: number } | null>(null)
  const [thFilter, setThFilter] = useState<string | null>(null)
  // filtering by status and the open page left that status (accepted, or re-processed into another one):
  // move on to the first page that still has it. Not while the page is being processed - its status is temporary.
  const curCat = doc?.pages?.[pageIdx] ? pageCat(doc.pages[pageIdx]) : null
  useEffect(() => {
    if (!thFilter || !doc || !curCat || curCat === thFilter || ['queued', 'processing'].includes(curCat)) return
    const i = doc.pages.findIndex((p: any) => pageCat(p) === thFilter)
    if (i >= 0) setPageIdx(i)
  }, [thFilter, curCat, doc])

  const loadDoc = useCallback(() => api(`/api/documents/${id}`).then(setDoc).catch((e) => toast(e.detail)), [id])
  useEffect(() => { loadDoc() }, [loadDoc])
  // a page number from the address that the document does not have (pages removed since): the last page
  useEffect(() => { if (doc?.pages?.length && pageIdx >= doc.pages.length) setPageIdx(doc.pages.length - 1) }, [doc?.pages?.length, pageIdx])
  // keep the open page's thumbnail in sight (opened at a search occurrence's page, or moved to another page);
  // scrolls only the strip, never the window, and only when the thumbnail is not already fully visible
  const thList = useRef<HTMLDivElement>(null)
  const hasDoc = !!doc
  useEffect(() => {
    const list = thList.current, el = list?.querySelector<HTMLElement>('.th.sel')
    if (!list || !el) return
    const l = list.getBoundingClientRect(), r = el.getBoundingClientRect()
    if (r.top < l.top || r.bottom > l.bottom) list.scrollTop += r.top - l.top - (l.height - r.height) / 2
    if (r.left < l.left || r.right > l.right) list.scrollLeft += r.left - l.left - (l.width - r.width) / 2
  }, [pageIdx, hasDoc, thFilter])
  const pageSummary = doc?.pages?.[pageIdx]
  const loadPage = useCallback(() => { if (pageSummary) api(`/api/pages/${pageSummary.id}`).then(setPage) }, [pageSummary?.id])
  useEffect(() => { setPage(null); setMode('result'); setPreview(null); loadPage() }, [pageSummary?.id])
  // poll while processing
  const busy = page && ['queued', 'processing'].includes(page.status) || doc && ['queued', 'processing'].includes(doc.status)
  useEffect(() => {
    if (!busy) return
    const i = setInterval(() => { loadPage(); loadDoc() }, 1500)
    return () => clearInterval(i)
  }, [busy, loadPage, loadDoc])
  useEffect(() => { if (page && !busy) setPreview(null) }, [page?.updated_at])
  // something changed elsewhere (another tab/user, background processing)
  useEffect(() => {
    const h = () => { loadDoc(); loadPage() }
    window.addEventListener('soroka:reload', h)
    return () => window.removeEventListener('soroka:reload', h)
  }, [loadDoc, loadPage])

  // show the change at once (the server re-indexes the whole text on every change, which takes a moment); on failure reload the real state
  const patch = async (body: any) => {
    setDoc((d: any) => d && { ...d, ...(body.tag_ids ? { tags: body.tag_ids } : {}), ...(body.title != null ? { title: body.title } : {}) })
    try { await api(`/api/documents/${id}`, { method: 'PATCH', body }); loadDoc(); reloadStore() } catch (e: any) { toast(e.detail); loadDoc() }
  }
  const edit = async (stage: string, value: any, reset = false) => {
    try {
      const r = await api(`/api/pages/${page.id}/edit`, { body: { stage, value, reset } })
      if (r.warnings?.length) toast(t('warnings') + ': ' + r.warnings.join(', '))
      setMode('result'); loadPage(); loadDoc()
    } catch (e: any) { toast(e.detail) }
  }
  const post = async (url: string, body?: any) => { try { await api(url, { method: 'POST', body }); loadPage(); loadDoc(); reloadStore() } catch (e: any) { toast(e.detail) } }

  if (!doc) return <div className="page-pad muted">{t('loading')}</div>
  const trashed = !!doc.trashed_at
  const isAdmin = user.role === 'admin'
  const toTrash = () => {
    // leave at once; the server stops the processing in the background of this page change
    api('/api/documents/bulk', { body: { ids: [doc.id], action: 'trash' } })
      .then(() => { reloadStore(); window.dispatchEvent(new Event('soroka:reload')) }).catch((e) => toast(e.detail))
    goBack()
  }
  const restore = async () => { await api('/api/documents/bulk', { body: { ids: [doc.id], action: 'restore' } }); loadDoc(); reloadStore() }
  const purge = async () => {
    if (!(await dlg.confirm({ title: t('purge') + '?', message: t('confirm_purge'), ok: t('purge'), danger: true }))) return
    api(`/api/documents/${doc.id}`, { method: 'DELETE' })
      .then(() => { reloadStore(); window.dispatchEvent(new Event('soroka:reload')) }).catch((e) => toast(e.detail))
    goBack()
  }
  // rarely used / destructive actions live in the "…" menu
  const more = [
    ...(!trashed ? [{ key: 'reprocess', label: t('reprocess'), icon: <RefreshCw size={14} /> }] : []),
    ...(trashed ? [] : [{ key: 'trash', label: t('to_trash'), icon: <Trash2 size={14} />, danger: true }]),
    ...(isAdmin && (trashed || doc.status === 'rejected') ? [{ key: 'purge', label: t('purge'), icon: <Trash2 size={14} />, danger: true }] : []),
  ]
  const onMore = (k: string) => {
    if (k === 'reprocess') post(`/api/documents/${doc.id}/reprocess`)
    if (k === 'trash') toTrash()
    if (k === 'purge') purge()
  }
  const multi = doc.pages.length > 1
  // page statuses present in this document, in a fixed order, with page counts
  const counts: Record<string, number> = {}
  for (const p of doc.pages) counts[pageCat(p)] = (counts[pageCat(p)] || 0) + 1
  const cats = CAT_ORDER.filter((k) => counts[k]).map((k) => [k, counts[k]] as const)
  // one status at a time; a status no page has any more falls back to "all"
  const activeCat = thFilter && counts[thFilter] ? thFilter : null
  const pickCat = (k: string | null) => {
    setThFilter(k)
    // the open page is not of this status: go to the first page that is
    if (k && pageCat(doc.pages[pageIdx]) !== k) setPageIdx(doc.pages.findIndex((p: any) => pageCat(p) === k))
  }
  return (
    <div className="doc-view">
      {/* row 1: back, title; row 2: where it is, its tags (one line, scrolls when they do not fit), actions */}
      <div className="doc-head">
        <div className="dh-row">
          <button className="icon" onClick={goBack} title={t('back')}><ArrowLeft size={18} /></button>
          <input className="title-input" defaultValue={doc.title} key={doc.title} title={doc.title} onBlur={(e) => e.target.value !== doc.title && patch({ title: e.target.value })} />
        </div>
        <div className="dh-meta">
          <button onClick={() => showPlace()} title={doc.folder_id ? folderPath(folders, doc.folder_id) : t('no_folder')}><FolderSearch size={15} /> <span className="lbl-phone-hide">{t('show_in_folders')}</span></button>
          <TagAdder exclude={doc.tags} onAdd={(tid) => patch({ tag_ids: [...doc.tags, tid] })} />
          <TagChips singleLine ids={doc.tags} onRemove={(tid) => patch({ tag_ids: doc.tags.filter((x: number) => x !== tid) })} />
          {doc.status === 'rejected' && <button className="primary" onClick={() => post(`/api/documents/${doc.id}/rescue`)}>{t('rescue')}</button>}
          {trashed && <button onClick={restore}><ArchiveRestore size={15} /> <span className="lbl-phone-hide">{t('restore')}</span></button>}
          <Menu icon={<Download size={15} />} label={t('download')} align="right" className="dl-btn" title={t('download')}
            items={[...(doc.has_pdf ? [{ key: 'pdf', label: t('processed_pdf') }] : []), { key: 'original', label: t('original') }, { key: 'text', label: t('plain_text') }]}
            onSelect={(k) => window.open(`/api/documents/${doc.id}/download?kind=${k}`, '_blank')} />
          {more.length > 0 && <Menu icon={<MoreHorizontal size={16} />} caret={false} align="right" title={t('more_actions')} items={more} onSelect={onMore} />}
        </div>
      </div>
      <div className={'viewer' + (multi ? '' : ' single')}>
        {/* page strip only for documents with several pages */}
        {multi && <div className="thumbs">
          {/* show only pages of one status: "All" or the chosen status again clears it */}
          <div className="th-filter">
            <button className={activeCat ? '' : 'on'} onClick={() => pickCat(null)}>{t('all')} <b>{doc.pages.length}</b></button>
            {cats.map(([k, n]) => (
              <button key={k} className={activeCat === k ? 'on' : ''} style={{ ['--c' as any]: catColor(k) }}
                onClick={() => pickCat(activeCat === k ? null : k)}><span className="dot" />{catLabel(t, k)} <b>{n}</b></button>
            ))}
          </div>
          <div className="th-list" ref={thList}>
            {doc.pages.map((p: any, i: number) => (activeCat && pageCat(p) !== activeCat) ? null : (
              <div key={p.id} className={'th' + (i === pageIdx ? ' sel' : '')} onClick={() => setPageIdx(i)} title={`${t('page')} ${i + 1}`}>
                <div className="th-img"><PageThumb pageId={p.id} v={p.thumb_v} status={p.status} /></div>
                <div className="th-foot"><span>{i + 1}</span><TierBadge tier={p.reviewed ? 'high' : p.tier} status={p.status} /></div>
              </div>
            ))}
          </div>
        </div>}
        <div className="stage-area">
          {page ? <PageCanvas page={page} q={q} mode={mode} preview={preview} edit={(stage: string, v: any, reset?: boolean) => { edit(stage, v, reset); setMode('result') }} onCancelEdit={() => setMode('result')} />
            : <div className="muted stage-msg">{doc.pages.length ? t('loading') : <><Loader2 size={16} className="spin" /> {doc.status_detail || t('not_ready')}</>}</div>}
        </div>
        <div className="side">
          <div className="tabs">
            {(['pipeline', 'info', 'text'] as const).map((k) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{t(k)}</button>)}
          </div>
          {tab === 'pipeline' && page && <PipelinePanel page={page} edit={edit} post={post} setMode={setMode} mode={mode} setPreview={setPreview} />}
          {tab === 'info' && <InfoPanel doc={doc} q={q} focus={focus} />}
          {tab === 'text' && page && <div className="page-pad"><div className="pre">{page.text ? <Marked text={page.text} q={q} scroll at={at} /> : t('no_text')}</div></div>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- canvas: result with search hits / crop editor
function norm(s: string) { return s.toLowerCase().replace(/ё/g, 'е') }

// search words as prefixes, a little shortened so that Russian endings match (договор / договора / договору)
function stemsOf(q: string): string[] {
  const terms = q.split(/\s+/).filter((w) => !w.startsWith('-')).flatMap((w) => w.split(/[^\p{L}\p{N}]+/u)).map(norm).filter((w) => w.length >= 2)
  return terms.map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w))
}

/** Where in `text` the search occurrence `at` is (offset of its matched word), or -1. The occurrence comes from the
 *  server with ё -> е and every run of whitespace as one space, so the text is compared in that form. */
function findOccurrence(text: string, at?: { text: string; off: number }): number {
  if (!at?.text) return -1
  let flat = ''
  const raw: number[] = [] // position in `flat` -> position in `text`
  let space = true // also drops leading whitespace
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) { if (!space) { flat += ' '; raw.push(i); space = true } continue }
    flat += ch === 'ё' ? 'е' : ch === 'Ё' ? 'Е' : ch
    raw.push(i)
    space = false
  }
  const pos = flat.indexOf(at.text)
  return pos < 0 ? -1 : raw[pos + at.off] ?? -1
}

/** Text with the search words marked. `scroll` brings one into view: the occurrence `at` (the line pressed in the
 *  search results) when it is in this text, otherwise the first match. */
function Marked({ text, q, scroll, at }: { text: string; q: string; scroll?: boolean; at?: { text: string; off: number } }) {
  const ref = useRef<HTMLSpanElement>(null)
  const stems = useMemo(() => stemsOf(q), [q])
  const target = useMemo(() => findOccurrence(text, at), [text, at?.text, at?.off])
  useEffect(() => {
    if (scroll) (ref.current?.querySelector('mark.cur') || ref.current?.querySelector('mark'))?.scrollIntoView({ block: 'center' })
  }, [text, q, scroll, target])
  if (!stems.length && target < 0) return <>{text}</>
  // split keeps the words (odd indexes) and what is between them
  const parts = text.split(/([\p{L}\p{N}]+)/u)
  let pos = 0
  return <span ref={ref}>{parts.map((p, i) => {
    const start = pos
    pos += p.length
    if (!(i % 2)) return p
    const cur = target >= start && target < pos
    return cur || stems.some((s) => norm(p).startsWith(s)) ? <mark key={i} className={cur ? 'cur' : undefined}>{p}</mark> : p
  })}</span>
}

function PageCanvas({ page, q, mode, preview, edit, onCancelEdit }: { page: any; q: string; mode: string; preview: any; edit: (stage: string, v: any, reset?: boolean) => void; onCancelEdit: () => void }) {
  const { t } = useT()
  const [structure, setStructure] = useState<any>(null)
  const [comparing, setComparing] = useState(false)
  useEffect(() => {
    setStructure(null)
    if (q && page.status === 'ready') api(`/api/pages/${page.id}/structure`).then(setStructure).catch(() => {})
  }, [page.id, page.updated_at, q])
  const hits = useMemo(() => {
    if (!structure || !q) return []
    const stems = stemsOf(q)
    // an OCR word may carry punctuation or be several search words in one ("IMG_1234.jpg"): try every piece of it
    return structure.words.filter((w: any) => norm(w.text).split(/[^\p{L}\p{N}]+/u).some((x) => x && stems.some((s) => x.startsWith(s))))
  }, [structure, q])

  if (page.status === 'error') return <div className="card err" style={{ maxWidth: 600 }}><b>{t('page_error')}</b><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{page.error}</pre></div>
  if (mode === 'crop' && page.original_url) return <CropEditor page={page} onApply={(v) => edit('crop', v)} onCancel={onCancelEdit} />
  if (mode === 'mesh' && page.flatten_source_url) return <MeshEditor page={page} onApply={(mesh) => edit('dewarp', { mesh })}
    onReset={() => edit('dewarp', { mesh: null })} onCancel={onCancelEdit} />
  if (!page.render_key && !page.rendered && page.status !== 'ready') return <div className="muted stage-msg"><Loader2 size={16} className="spin" /> {t('not_ready')}</div>
  const tf = preview && !comparing ? `rotate(${(preview.rotate || 0) - (preview.deskew || 0)}deg)` : undefined
  // hold "Original" to see the unmodified page in place of the result
  const hold = (on: boolean) => (e: React.PointerEvent) => { e.preventDefault(); setComparing(on) }
  return (
    <div className="canvas-col">
    <div className="imgwrap" style={{ transform: tf, transition: 'transform .15s' }}>
      {/* both images stay loaded, so switching is instant (the original used to be fetched on the first press) */}
      <img key={'r' + page.id} src={page.render_url} alt="" style={comparing ? { display: 'none' } : undefined} />
      {page.original_url && <img key={'o' + page.id} src={page.original_url} alt="" style={comparing ? undefined : { display: 'none' }} />}
      {!comparing && structure && hits.length > 0 && (
        <svg viewBox={`0 0 ${structure.width} ${structure.height}`} preserveAspectRatio="none">
          {hits.map((w: any, i: number) => <rect key={i} className="hl" x={w.box[0] - 2} y={w.box[1] - 2} width={w.box[2] + 4} height={w.box[3] + 4} rx={3} />)}
        </svg>
      )}
      {['queued', 'processing'].includes(page.status) && <div className="canvas-busy"><Loader2 size={14} className="spin" /> {t(page.status)}</div>}
      {['stopped', 'excluded'].includes(page.status) && <div className="canvas-busy">{t(page.status)}</div>}
    </div>
      {page.original_url && (
        <button className={'compare-btn' + (comparing ? ' active' : '')} title={t('compare_hint')}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); hold(true)(e) }} onPointerUp={hold(false)}
          onPointerCancel={hold(false)} onLostPointerCapture={() => setComparing(false)} onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(true) } }}
          onKeyUp={() => setComparing(false)} onBlur={() => setComparing(false)}>
          <Layers2 size={15} /> {t('compare')}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- pipeline panel
function PipelinePanel({ page, edit, post, setMode, mode, setPreview }: any) {
  const { t } = useT()
  const [open, setOpen] = useState<string | null>(null)
  const st = page.stages_detail || {}
  const rec = page.recipe
  const isImage = page.kind === 'image'
  const hist = page.history || []
  const curIdx = hist.findIndex((h: any) => h.current)
  const busy = ['queued', 'processing'].includes(page.status)
  return (
    <div>
      <div className="row pipe-head">
        <TierBadge tier={page.reviewed ? 'high' : page.tier} status={page.status} />
        {page.reviewed && <span className="small muted icon-text"><Check size={13} /> {t('reviewed')}</span>}
        <span className="spacer" />
        <button title={t('undo')} disabled={busy || curIdx <= 0} onClick={() => post(`/api/pages/${page.id}/recipe/goto`, { version: hist[curIdx - 1].version })}><Undo2 size={15} /></button>
        <button title={t('redo')} disabled={busy || curIdx < 0 || curIdx >= hist.length - 1} onClick={() => post(`/api/pages/${page.id}/recipe/goto`, { version: hist[curIdx + 1].version })}><Redo2 size={15} /></button>
        {isImage && <button title={t('reset_auto')} disabled={busy} onClick={() => post(`/api/pages/${page.id}/reset`)}><RotateCcw size={15} /> {t('auto')}</button>}
        {!page.reviewed && <button title={t('mark_reviewed')} disabled={busy} onClick={() => post(`/api/pages/${page.id}/review`, { action: 'accept' })}><CheckCheck size={15} /> {t('accept')}</button>}
      </div>
      {STAGES.map((s) => {
        const d = st[s] || {}
        const manual = rec?.[s]?.manual
        return (
          <div className="stage" key={s}>
            <div className="stage-h" onClick={() => setOpen(open === s ? null : s)}>
              <span className="n">{t('stage_' + s)}</span>
              {manual && <span className="chip">{t('manual')}</span>}
              {d.status === 'skipped' ? <span className="small muted">{t('skipped')}</span> : <TierBadge tier={d.tier || null} />}
            </div>
            {open === s && (
              <div className="stage-b">
                {d.method && <div className="small muted">{d.method}</div>}
                {isImage && <StageEditor stage={s} page={page} rec={rec} d={d} edit={edit} setMode={setMode} mode={mode} setPreview={setPreview} />}
                <Signals info={d.info} />
                {manual && <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => edit(s, null, true)}>{t('reset_auto')}</button>}
              </div>
            )}
          </div>
        )
      })}
      <div className="page-pad">
        <h3>{t('history')}</h3>
        {hist.slice().reverse().map((h: any) => (
          <div key={h.id} className="small row" style={{ padding: '2px 0' }}>
            <span style={{ fontWeight: h.current ? 700 : 400 }}>v{h.version}</span>
            <span className="muted">{h.note}</span><span className="spacer" />
            <span className="muted">{fmtDate(h.created_at, true)}</span>
            {!h.current && <button className="link" onClick={() => post(`/api/pages/${page.id}/recipe/goto`, { version: h.version })} title={t('restore')}><History size={14} /></button>}
          </div>
        ))}
      </div>
    </div>
  )
}

function Signals({ info }: { info: any }) {
  if (!info) return null
  const entries = Object.entries(info).filter(([k, v]) => k !== 'candidates' && k !== 'scores' && k !== 'passes' && (typeof v !== 'object' || v === null || Array.isArray(v)))
  if (!entries.length) return null
  return (
    <div className="kv">
      {entries.map(([k, v]) => [<span key={k + 'k'}>{k}</span>, <span key={k + 'v'}>{Array.isArray(v) ? v.join(', ') : String(v)}</span>])}
    </div>
  )
}

function StageEditor({ stage, page, rec, d, edit, setMode, mode, setPreview }: any) {
  const { t } = useT()
  const [deskew, setDeskew] = useState<number>(rec.deskew.angle)
  const [cl, setCl] = useState({ mode: rec.cleanup.mode || 'gray', strength: rec.cleanup.strength ?? 1 })
  useEffect(() => { setDeskew(rec.deskew.angle); setCl({ mode: rec.cleanup.mode || 'gray', strength: rec.cleanup.strength ?? 1 }) }, [page.recipe_version])
  const angle = rec.orientation.angle || 0
  const [ocrLangs, setOcrLangs] = useState<string>(rec.ocr.langs || 'rus+eng')
  switch (stage) {
    case 'acceptance':
      return (
        <div className="row">
          <button className={rec.acceptance.value === 'document' ? 'active' : ''} onClick={() => edit('acceptance', { value: 'document' })}>{t('is_document')}</button>
          <button className={rec.acceptance.value === 'non_document' ? 'active' : ''} onClick={() => edit('acceptance', { value: 'non_document' })}>{t('not_document')}</button>
        </div>
      )
    case 'crop': {
      const cm = rec.crop.mode === 'none' ? 'none' : rec.crop.mode === 'mask' ? 'mask' : 'quad'
      const hasOutline = !!rec.crop.polygon
      return (
        <div className="col" style={{ gap: 8 }}>
          <div className="seg wrap">
            <button className={cm === 'quad' ? 'active' : ''} onClick={() => cm !== 'quad' && edit('crop', { mode: 'quad' })}>{t('crop_corners')}</button>
            <button className={cm === 'mask' ? 'active' : ''} disabled={!hasOutline} title={hasOutline ? undefined : t('no_outline_hint')}
              onClick={() => cm !== 'mask' && edit('crop', { mode: 'mask' })}>{t('crop_outline')}</button>
            <button className={cm === 'none' ? 'active' : ''} onClick={() => cm !== 'none' && edit('crop', { mode: 'none' })}>{t('crop_none')}</button>
          </div>
          <div className="row"><button className={mode === 'crop' ? 'active' : ''} onClick={() => setMode(mode === 'crop' ? 'result' : 'crop')}><Crop size={15} /> {t('edit_crop')}</button></div>
        </div>
      )
    }
    case 'orientation':
      return (
        <div className="row">
          <button onClick={() => edit('orientation', { angle: (angle + 270) % 360 })}><RotateCcw size={15} /> 90°</button>
          <button onClick={() => edit('orientation', { angle: (angle + 90) % 360 })}><RotateCw size={15} /> 90°</button>
          <button onClick={() => edit('orientation', { angle: (angle + 180) % 360 })}>180°</button>
          <span className="small muted">{angle}°</span>
        </div>
      )
    case 'dewarp': {
      const dw = rec.dewarp
      const m = dw.model || 'none'
      // choosing a model drops a hand-edited mesh (the new model proposes its own)
      const setModel = (v: string) => edit('dewarp', { model: v === 'none' ? null : v, mesh: null })
      return (
        <div className="col" style={{ gap: 8 }}>
          <div className="row"><span className="small muted" style={{ minWidth: 90 }}>{t('flatten_model')}</span>
            <div className="seg wrap">
              {['none', 'low', 'high'].map((v) => <button key={v} className={m === v && !(v === 'none' && dw.mesh_edited) ? 'active' : ''} onClick={() => (m !== v || dw.mesh_edited) && setModel(v)}>{t('flatten_' + v)}</button>)}
            </div></div>
          <div className="row"><span className="small muted" style={{ minWidth: 90 }} title={t('shading_hint')}>{t('shading')}</span>
            <div className="seg">
              <button className={dw.shading ? 'active' : ''} title={t('shading_hint')} onClick={() => !dw.shading && edit('dewarp', { shading: true })}>{t('shading_on')}</button>
              <button className={!dw.shading ? 'active' : ''} onClick={() => dw.shading && edit('dewarp', { shading: false })}>{t('shading_off')}</button>
            </div></div>
          <div className="row">
            <button className={mode === 'mesh' ? 'active' : ''} onClick={() => setMode(mode === 'mesh' ? 'result' : 'mesh')}><Grid3x3 size={15} /> {t('edit_mesh')}</button>
            {dw.mesh_edited && <span className="small muted">{t('mesh_state_edited')}</span>}
          </div>
        </div>
      )
    }
    case 'deskew':
      return (
        <div className="col">
          <div className="row"><input type="range" min={-10} max={10} step={0.1} value={deskew} style={{ flex: 1 }}
            onChange={(e) => { const v = Number(e.target.value); setDeskew(v); setPreview({ deskew: v - rec.deskew.angle }) }} />
            <span className="small" style={{ width: 44 }}>{deskew.toFixed(1)}°</span></div>
          <div className="row"><button onClick={() => { setDeskew(rec.deskew.angle); setPreview(null) }}>{t('cancel')}</button><button className="primary" onClick={() => edit('deskew', { angle: deskew })}>{t('apply')}</button></div>
        </div>
      )
    case 'cleanup':
      return (
        <div className="col">
          <div className="seg">
            {(['color', 'gray', 'bw'] as const).map((m) => <button key={m} className={cl.mode === m ? 'active' : ''} onClick={() => setCl({ ...cl, mode: m })}>{t(m + '_mode')}</button>)}
          </div>
          <label>{t('strength')} {Math.round(cl.strength * 100)}%</label>
          <input type="range" min={0} max={1} step={0.05} value={cl.strength} onChange={(e) => setCl({ ...cl, strength: Number(e.target.value) })} />
          <button className="primary" style={{ alignSelf: 'flex-start' }} onClick={() => edit('cleanup', cl)}>{t('apply')}</button>
        </div>
      )
    case 'ocr':
      return (
        <div className="row">
          <Select value={ocrLangs} onChange={setOcrLangs} options={[{ value: 'rus+eng', label: 'RU + EN' }, { value: 'rus', label: 'RU' }, { value: 'eng', label: 'EN' }]} />
          <button onClick={() => edit('ocr', { langs: ocrLangs })}><RefreshCw size={15} /> {t('rerun')}</button>
        </div>
      )
    default:
      return null
  }
}

// ---------------------------------------------------------------- info panel: source metadata & context
// where the document itself sits among its context messages: earlier ones above, later ones below
function CtxHere() {
  const { t } = useT()
  return <div className="ctx-here"><span className="icon-text"><ArrowUp size={11} />{t('ctx_before')}</span><span>{t('ctx_this_doc')}</span><span className="icon-text">{t('ctx_after')}<ArrowDown size={11} /></span></div>
}

function InfoPanel({ doc, q = '', focus = '' }: { doc: any; q?: string; focus?: string }) {
  const { t } = useT()
  const ev = doc.event
  // the field or message a search occurrence pointed to: marked and scrolled into view
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.querySelector('.focus')?.scrollIntoView({ block: 'center' }) }, [focus, doc.id])
  const fc = (k: string) => (focus === k ? ' focus' : '')
  return (
    <div className="page-pad col" ref={box}>
      <div className="kv">
        <span>{t('source')}</span><span>{t('source_' + doc.source)}</span>
        <span>{t('uploaded')}</span><span>{fmtDate(doc.received_at, true)}</span>
        <span>{t('modified')}</span><span>{fmtDate(doc.updated_at, true)}</span>
        <span>{t('status')}</span><span>{doc.status} {doc.status_detail}</span>
        {doc.language && <><span>{t('languages')}</span><span>{doc.language}</span></>}
        {doc.rejected && <><span>{t('expires')}</span><span>{fmtDate(doc.rejected.expires_at, true)} ({doc.rejected.reason})</span></>}
        {ev?.chat_name && <><span>{t('chat')}</span><span className={fc('chat')}><Marked text={ev.chat_name} q={q} /></span></>}
        {(ev?.sender_name || ev?.sender_phone || ev?.sender_email) && <><span>{t('sender')}</span><span className={fc('sender')}><Marked text={[ev.sender_name, ev.sender_phone, ev.sender_username, ev.sender_email].filter(Boolean).join(' · ')} q={q} /></span></>}
        {ev?.sent_at && <><span>{t('sent_at')}</span><span>{fmtDate(ev.sent_at, true)}</span></>}
        {ev?.forwarded && <><span>{t('forwarded')}</span><span><Check size={13} /></span></>}
        {ev?.forced && <><span>{t('forced')}</span><span>{ev.force_reason}</span></>}
        {ev?.extra?.subject && <><span>Subject</span><span>{ev.extra.subject}</span></>}
        {ev?.extra?.from && <><span>From</span><span>{ev.extra.from}</span></>}
        {ev?.extra?.import_path && <><span>Path</span><span>{ev.extra.import_path}</span></>}
      </div>
      {ev?.caption && <div><label>{t('caption')}</label><div className={'ctx-msg' + fc('caption')}><Marked text={ev.caption} q={q} /></div></div>}
      {ev?.reply_to?.text && <div><label>{t('reply_to')}</label><div className={'ctx-msg' + fc('reply')}><Marked text={ev.reply_to.text} q={q} /></div></div>}
      {ev?.context?.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <label>{t('context')}</label>
          {/* focus refers to the message's place in the stored list, so keep it through the sort by time */}
          {/* a quiet divider shows where the document itself was sent: messages before it above, after it below */}
          {ev.context.map((c: any, i: number) => ({ c, i })).sort((a: any, b: any) => (a.c.time || '').localeCompare(b.c.time || '')).map(({ c, i }: any, n: number, all: any[]) => (
            <Fragment key={i}>
              {c.position === 'after' && all[n - 1]?.c.position !== 'after' && <CtxHere />}
              <div className={'ctx-msg' + fc('context:' + i)}>
                <div className="who"><Marked text={String(c.sender_name || c.sender || '')} q={q} /> · {fmtDate(c.time, true)}</div><Marked text={String(c.text || '')} q={q} />
              </div>
            </Fragment>
          ))}
          {ev.context.every((c: any) => c.position !== 'after') && <CtxHere />}
        </div>
      )}
      {ev?.extra?.body && <div><label>Email</label><div className="pre">{ev.extra.body}</div></div>}
      <div>
        <label>{t('files')}</label>
        {doc.files.map((f: any) => (
          <div key={f.id} className="small row">
            <a href={`/api/files/${f.id}`}>{f.filename}</a><span className="muted">{fmtBytes(f.size)}</span>
            {f.has_rendition && <a href={`/api/files/${f.id}?rendition=true&inline=true`} target="_blank">PDF</a>}
          </div>
        ))}
      </div>
      {doc.versions.length > 1 && <div><label>{t('versions')}</label>{doc.versions.map((v: any) => <div key={v.id} className="small">v{v.number} · {v.pages} {t('pages').toLowerCase()} · {v.note} {v.current && <Check size={12} />}</div>)}</div>}
    </div>
  )
}
