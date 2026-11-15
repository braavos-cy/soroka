import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useT } from '../i18n'
import { useStore } from '../store'
import { DateInput, FolderSelect, fmtBytes, fmtDate, PageThumb, TagAdder, TagChips, TierBadge } from '../components/Pickers'
import { Menu, Select, useDialog } from '../components/ui'
import { CropEditor, MeshEditor } from '../components/PageEditors'
import { ArchiveRestore, ArrowLeft, Check, CheckCheck, Crop, Download, Eye, Grid3x3, History, Loader2, MoreHorizontal, Redo2, RefreshCw, RotateCcw, RotateCw, Trash2, Undo2 } from 'lucide-react'

const STAGES = ['quality', 'acceptance', 'crop', 'dewarp', 'orientation', 'deskew', 'cleanup', 'ocr', 'layout', 'consistency', 'outputs']
type Pt = [number, number]

export default function DocumentView() {
  const { id } = useParams()
  const { t } = useT()
  const { user, reload: reloadStore, toast } = useStore()
  const dlg = useDialog()
  const nav = useNavigate()
  // back to where the document was opened from (list, folder, search, review); opened by direct link -> the list
  const goBack = () => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav('/'))
  const [params] = useSearchParams()
  const q = params.get('q') || ''
  const [doc, setDoc] = useState<any>(null)
  const [pageIdx, setPageIdx] = useState(0)
  const [page, setPage] = useState<any>(null)
  const [tab, setTab] = useState<'pipeline' | 'info' | 'text'>('pipeline')
  const [mode, setMode] = useState<'result' | 'crop'>('result')
  const [preview, setPreview] = useState<{ rotate?: number; deskew?: number } | null>(null)

  const loadDoc = useCallback(() => api(`/api/documents/${id}`).then(setDoc).catch((e) => toast(e.detail)), [id])
  useEffect(() => { loadDoc() }, [loadDoc])
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

  const patch = async (body: any) => { try { await api(`/api/documents/${id}`, { method: 'PATCH', body }); loadDoc(); reloadStore() } catch (e: any) { toast(e.detail) } }
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
  return (
    <div className="doc-view">
      {/* row 1: back, title, actions; row 2: what the document is (status, folder, date, tags) */}
      <div className="doc-head">
        <div className="dh-row">
          <button className="icon" onClick={goBack} title={t('back')}><ArrowLeft size={18} /></button>
          <input className="title-input" defaultValue={doc.title} key={doc.title} title={doc.title} onBlur={(e) => e.target.value !== doc.title && patch({ title: e.target.value })} />
          {doc.status === 'rejected' && <button className="primary" onClick={() => post(`/api/documents/${doc.id}/rescue`)}>{t('rescue')}</button>}
          {trashed && <button onClick={restore}><ArchiveRestore size={15} /> <span className="lbl-phone-hide">{t('restore')}</span></button>}
          <Menu icon={<Download size={15} />} label={t('download')} align="right" className="dl-btn" title={t('download')}
            items={[...(doc.has_pdf ? [{ key: 'pdf', label: t('processed_pdf') }] : []), { key: 'original', label: t('original') }, { key: 'text', label: t('plain_text') }]}
            onSelect={(k) => window.open(`/api/documents/${doc.id}/download?kind=${k}`, '_blank')} />
          {more.length > 0 && <Menu icon={<MoreHorizontal size={16} />} caret={false} align="right" title={t('more_actions')} items={more} onSelect={onMore} />}
        </div>
        <div className="dh-meta">
          <TierBadge tier={doc.needs_review ? 'low' : doc.tier} status={doc.status} />
          <FolderSelect value={doc.folder_id} allowEmpty onChange={(f) => patch(f ? { folder_id: f } : { clear_folder: true })} />
          <DateInput value={doc.document_date ? doc.document_date.slice(0, 10) : ''} placeholder={t('doc_date')} title={t('doc_date')}
            onChange={(v) => patch(v ? { document_date: v } : { clear_date: true })} />
          <TagChips ids={doc.tags} onRemove={(tid) => patch({ tag_ids: doc.tags.filter((x: number) => x !== tid) })} />
          <TagAdder exclude={doc.tags} onAdd={(tid) => patch({ tag_ids: [...doc.tags, tid] })} />
        </div>
      </div>
      <div className={'viewer' + (multi ? '' : ' single')}>
        {/* page strip only for documents with several pages */}
        {multi && <div className="thumbs">
          {doc.pages.map((p: any, i: number) => (
            <div key={p.id} className={'th' + (i === pageIdx ? ' sel' : '')} onClick={() => setPageIdx(i)} title={`${t('page')} ${i + 1}`}>
              <div className="th-img"><PageThumb pageId={p.id} v={p.thumb_v} status={p.status} /></div>
              <div className="th-foot"><span>{i + 1}</span><TierBadge tier={p.reviewed ? 'high' : p.tier} status={p.status} /></div>
            </div>
          ))}
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
          {tab === 'info' && <InfoPanel doc={doc} />}
          {tab === 'text' && page && <div className="page-pad"><div className="pre">{page.text || t('no_text')}</div></div>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- canvas: result with search hits / crop editor
function norm(s: string) { return s.toLowerCase().replace(/ё/g, 'е') }

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
    const terms = q.split(/\s+/).map((w) => norm(w.replace(/[^\p{L}\p{N}]/gu, ''))).filter((w) => w.length >= 2 && !w.startsWith('-'))
    // prefix match on a stem-ish prefix: handles Russian endings (договор / договора / договору)
    const stems = terms.map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w))
    return structure.words.filter((w: any) => { const x = norm(w.text.replace(/[^\p{L}\p{N}]/gu, '')); return stems.some((s) => x.startsWith(s)) })
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
    <div className="col" style={{ alignItems: 'center', gap: 6 }}>
      {page.original_url && (
        <button className={'compare-btn' + (comparing ? ' active' : '')} title={t('compare_hint')}
          onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); hold(true)(e) }} onPointerUp={hold(false)}
          onPointerCancel={hold(false)} onLostPointerCapture={() => setComparing(false)} onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(true) } }}
          onKeyUp={() => setComparing(false)} onBlur={() => setComparing(false)}>
          <Eye size={15} /> {t('compare')}
        </button>
      )}
    <div className="imgwrap" style={{ transform: tf, transition: 'transform .15s' }}>
      <img src={comparing ? page.original_url : page.render_url} alt="" />
      {!comparing && structure && hits.length > 0 && (
        <svg viewBox={`0 0 ${structure.width} ${structure.height}`} preserveAspectRatio="none">
          {hits.map((w: any, i: number) => <rect key={i} className="hl" x={w.box[0] - 2} y={w.box[1] - 2} width={w.box[2] + 4} height={w.box[3] + 4} rx={3} />)}
        </svg>
      )}
      {['queued', 'processing'].includes(page.status) && <div className="canvas-busy"><Loader2 size={14} className="spin" /> {t(page.status)}</div>}
      {['stopped', 'excluded'].includes(page.status) && <div className="canvas-busy">{t(page.status)}</div>}
    </div>
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
function InfoPanel({ doc }: { doc: any }) {
  const { t } = useT()
  const ev = doc.event
  return (
    <div className="page-pad col">
      <div className="kv">
        <span>{t('source')}</span><span>{t('source_' + doc.source)}</span>
        <span>{t('received')}</span><span>{fmtDate(doc.received_at, true)}</span>
        <span>{t('status')}</span><span>{doc.status} {doc.status_detail}</span>
        {doc.language && <><span>{t('languages')}</span><span>{doc.language}</span></>}
        {doc.rejected && <><span>{t('expires')}</span><span>{fmtDate(doc.rejected.expires_at, true)} ({doc.rejected.reason})</span></>}
        {ev?.chat_name && <><span>{t('chat')}</span><span>{ev.chat_name}</span></>}
        {(ev?.sender_name || ev?.sender_phone || ev?.sender_email) && <><span>{t('sender')}</span><span>{[ev.sender_name, ev.sender_phone, ev.sender_username, ev.sender_email].filter(Boolean).join(' · ')}</span></>}
        {ev?.sent_at && <><span>{t('sent_at')}</span><span>{fmtDate(ev.sent_at, true)}</span></>}
        {ev?.forwarded && <><span>{t('forwarded')}</span><span><Check size={13} /></span></>}
        {ev?.forced && <><span>{t('forced')}</span><span>{ev.force_reason}</span></>}
        {ev?.extra?.subject && <><span>Subject</span><span>{ev.extra.subject}</span></>}
        {ev?.extra?.from && <><span>From</span><span>{ev.extra.from}</span></>}
        {ev?.extra?.import_path && <><span>Path</span><span>{ev.extra.import_path}</span></>}
      </div>
      {ev?.caption && <div><label>{t('caption')}</label><div className="ctx-msg">{ev.caption}</div></div>}
      {ev?.reply_to?.text && <div><label>{t('reply_to')}</label><div className="ctx-msg">{ev.reply_to.text}</div></div>}
      {ev?.context?.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <label>{t('context')}</label>
          {[...ev.context].sort((a: any, b: any) => (a.time || '').localeCompare(b.time || '')).map((c: any, i: number) => (
            <div key={i} className="ctx-msg" style={c.position === 'after' ? { borderLeft: '3px solid var(--accent)' } : undefined}>
              <div className="who">{c.sender_name || c.sender} · {fmtDate(c.time, true)}</div>{c.text}
            </div>
          ))}
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
