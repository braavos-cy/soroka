import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useT } from '../i18n'
import { useStore } from '../store'
import { FolderSelect, fmtBytes, fmtDate, TagAdder, TagChips, TierBadge } from '../components/Pickers'
import { Menu, Select, useDialog } from '../components/ui'
import { ArchiveRestore, ArrowLeft, Check, CheckCheck, Crop, Download, History, Maximize, Redo2, RefreshCw, RotateCcw, RotateCw, Trash2, Undo2 } from 'lucide-react'

const STAGES = ['quality', 'acceptance', 'crop', 'orientation', 'dewarp', 'deskew', 'cleanup', 'ocr', 'layout', 'consistency', 'outputs']
type Pt = [number, number]

export default function DocumentView() {
  const { id } = useParams()
  const { t } = useT()
  const { user, reload: reloadStore, toast } = useStore()
  const dlg = useDialog()
  const nav = useNavigate()
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
  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100%' }}>
      <div className="doc-head">
        <button className="icon" onClick={() => nav(-1)} title={t('back')}><ArrowLeft size={18} /></button>
        <input className="title-input" defaultValue={doc.title} key={doc.title} onBlur={(e) => e.target.value !== doc.title && patch({ title: e.target.value })} />
        <TierBadge tier={doc.needs_review ? 'low' : doc.tier} status={doc.status} />
        <FolderSelect value={doc.folder_id} allowEmpty onChange={(f) => patch(f ? { folder_id: f } : { clear_folder: true })} />
        <input type="date" title={t('doc_date')} value={doc.document_date ? doc.document_date.slice(0, 10) : ''}
          onChange={(e) => patch(e.target.value ? { document_date: e.target.value } : { clear_date: true })} />
        <TagChips ids={doc.tags} onRemove={(tid) => patch({ tag_ids: doc.tags.filter((x: number) => x !== tid) })} />
        <TagAdder exclude={doc.tags} onAdd={(tid) => patch({ tag_ids: [...doc.tags, tid] })} />
        <span className="spacer" />
        <Menu icon={<Download size={15} />} label={t('download')} align="right"
          items={[...(doc.has_pdf ? [{ key: 'pdf', label: t('processed_pdf') }] : []), { key: 'original', label: t('original') }, { key: 'text', label: t('plain_text') }]}
          onSelect={(k) => window.open(`/api/documents/${doc.id}/download?kind=${k}`, '_blank')} />
        {doc.status === 'rejected' && <button className="primary" onClick={() => post(`/api/documents/${doc.id}/rescue`)}>{t('rescue')}</button>}
        {!trashed && <button title={t('reprocess')} onClick={() => post(`/api/documents/${doc.id}/reprocess`)}><RefreshCw size={15} /></button>}
        {!trashed && <button className="danger" title={t('to_trash')} onClick={async () => { await api('/api/documents/bulk', { body: { ids: [doc.id], action: 'trash' } }); reloadStore(); nav(-1) }}><Trash2 size={15} /></button>}
        {trashed && <button onClick={async () => { await api('/api/documents/bulk', { body: { ids: [doc.id], action: 'restore' } }); loadDoc(); reloadStore() }}><ArchiveRestore size={15} /> {t('restore')}</button>}
        {user.role === 'admin' && (trashed || doc.status === 'rejected') && <button className="danger" onClick={async () => { if (await dlg.confirm({ title: t('purge') + '?', message: t('confirm_purge'), ok: t('purge'), danger: true })) { await api(`/api/documents/${doc.id}`, { method: 'DELETE' }); reloadStore(); nav('/') } }}>{t('purge')}</button>}
      </div>
      <div className="viewer">
        <div className="thumbs">
          {doc.pages.map((p: any, i: number) => (
            <div key={p.id} className={'th' + (i === pageIdx ? ' sel' : '')} onClick={() => setPageIdx(i)}>
              {p.status === 'ready' ? <img src={`/api/pages/${p.id}/image?variant=thumb&v=${p.updated_at}`} alt="" /> : <div className="muted small" style={{ padding: 20 }}>{t(p.status)}</div>}
              <div className="small row" style={{ justifyContent: 'center', gap: 4 }}>{i + 1} <TierBadge tier={p.reviewed ? 'high' : p.tier} status={p.status} /></div>
            </div>
          ))}
          {doc.pages.length === 0 && <div className="muted small">{doc.status_detail || t('not_ready')}</div>}
        </div>
        <div className="stage-area">
          {page ? <PageCanvas page={page} q={q} mode={mode} preview={preview} onQuad={(quad) => edit('crop', { quad })} onCancelCrop={() => setMode('result')} />
            : <div className="muted">{doc.pages.length ? t('loading') : (doc.status_detail || t('not_ready'))}</div>}
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

function PageCanvas({ page, q, mode, preview, onQuad, onCancelCrop }: { page: any; q: string; mode: string; preview: any; onQuad: (q: Pt[]) => void; onCancelCrop: () => void }) {
  const { t } = useT()
  const [structure, setStructure] = useState<any>(null)
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
  if (mode === 'crop' && page.original_url) return <CropEditor page={page} onApply={onQuad} onCancel={onCancelCrop} />
  if (!page.render_key && !page.rendered && page.status !== 'ready') return <div className="muted">{t('not_ready')}</div>
  const tf = preview ? `rotate(${(preview.rotate || 0) - (preview.deskew || 0)}deg)` : undefined
  return (
    <div className="imgwrap" style={{ transform: tf, transition: 'transform .15s' }}>
      <img src={page.render_url} alt="" />
      {structure && hits.length > 0 && (
        <svg viewBox={`0 0 ${structure.width} ${structure.height}`} preserveAspectRatio="none">
          {hits.map((w: any, i: number) => <rect key={i} className="hl" x={w.box[0] - 2} y={w.box[1] - 2} width={w.box[2] + 4} height={w.box[3] + 4} rx={3} />)}
        </svg>
      )}
      {['queued', 'processing'].includes(page.status) && <div style={{ position: 'absolute', top: 8, right: 8 }}><span className="tier proc">{t(page.status)}</span></div>}
    </div>
  )
}

function CropEditor({ page, onApply, onCancel }: { page: any; onApply: (q: Pt[]) => void; onCancel: () => void }) {
  const { t } = useT()
  const W = page.width, H = page.height
  const initial: Pt[] = page.recipe.crop.quad || [[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]]
  const [quad, setQuad] = useState<Pt[]>(initial)
  const [drag, setDrag] = useState<number | null>(null)
  const [mag, setMag] = useState<{ x: number; y: number; px: number; py: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const cands = page.stages_detail?.crop?.info?.candidates || []
  const toImg = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(W - 1, ((e.clientX - r.left) / r.width) * W)), y: Math.max(0, Math.min(H - 1, ((e.clientY - r.top) / r.height) * H)), px: e.clientX - r.left, py: e.clientY - r.top, rw: r.width }
  }
  const move = (e: React.PointerEvent) => {
    if (drag == null) return
    const p = toImg(e)
    const nq = quad.map((pt, i) => (i === drag ? [p.x, p.y] : pt)) as Pt[]
    setQuad(nq); setMag({ x: p.x, y: p.y, px: p.px, py: p.py })
  }
  const zoom = 3
  const scale = svgRef.current ? svgRef.current.getBoundingClientRect().width / W : 1
  const colors = ['#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4']
  return (
    <div className="col" style={{ alignItems: 'center' }}>
      <div className="imgwrap" style={{ touchAction: 'none' }}>
        <img src={page.original_url} alt="" draggable={false} />
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={move} onPointerUp={() => { setDrag(null); setMag(null) }} onPointerLeave={() => { setDrag(null); setMag(null) }}>
          {cands.map((c: any, i: number) => (
            <polygon key={c.method} points={c.quad.map((p: Pt) => p.join(',')).join(' ')} fill="none" stroke={colors[i % colors.length]} strokeWidth={2 / scale} strokeDasharray={`${8 / scale} ${6 / scale}`} opacity={0.8} />
          ))}
          <polygon points={quad.map((p) => p.join(',')).join(' ')} fill="rgba(47,111,237,.12)" stroke="#2f6fed" strokeWidth={2.5 / scale} />
          {quad.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={12 / scale} fill="#fff" stroke="#2f6fed" strokeWidth={3 / scale} style={{ cursor: 'grab' }}
              onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); setDrag(i) }} />
          ))}
        </svg>
        {mag && (
          <div className="magnifier" style={{
            left: mag.px + 20, top: mag.py - 160,
            backgroundImage: `url(${page.original_url})`,
            backgroundSize: `${W * scale * zoom}px ${H * scale * zoom}px`,
            backgroundPosition: `${-(mag.x * scale * zoom - 70)}px ${-(mag.y * scale * zoom - 70)}px`,
          }}><svg viewBox="0 0 140 140" style={{ width: 140, height: 140 }}><path d="M70 55V85M55 70H85" stroke="#dc2626" strokeWidth="1.5" /></svg></div>
        )}
      </div>
      <div className="row">
        {cands.map((c: any, i: number) => (
          <button key={c.method} onClick={() => setQuad(c.quad)} style={{ borderColor: colors[i % colors.length] }}>{c.method} · {c.score.toFixed(2)}</button>
        ))}
        <button title={t('full_page')} onClick={() => setQuad([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]])}><Maximize size={15} /></button>
        <span className="spacer" />
        <button onClick={onCancel}>{t('cancel')}</button>
        <button className="primary" onClick={() => onApply(quad)}>{t('apply')}</button>
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
  return (
    <div>
      <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <TierBadge tier={page.reviewed ? 'high' : page.tier} status={page.status} />
        {page.reviewed && <span className="small muted icon-text"><Check size={13} /> {t('reviewed')}</span>}
        <span className="spacer" />
        <button title={t('undo')} disabled={curIdx <= 0} onClick={() => post(`/api/pages/${page.id}/recipe/goto`, { version: hist[curIdx - 1].version })}><Undo2 size={15} /></button>
        <button title={t('redo')} disabled={curIdx < 0 || curIdx >= hist.length - 1} onClick={() => post(`/api/pages/${page.id}/recipe/goto`, { version: hist[curIdx + 1].version })}><Redo2 size={15} /></button>
        {isImage && <button title={t('reset_auto')} onClick={() => post(`/api/pages/${page.id}/reset`)}><RotateCcw size={15} /> {t('auto')}</button>}
        {!page.reviewed && <button title={t('mark_reviewed')} onClick={() => post(`/api/pages/${page.id}/review`, { action: 'accept' })}><CheckCheck size={15} /></button>}
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
    case 'crop':
      return <div className="row"><button className={mode === 'crop' ? 'active' : ''} onClick={() => setMode(mode === 'crop' ? 'result' : 'crop')}><Crop size={15} /> {t('edit_corners')}</button></div>
    case 'orientation':
      return (
        <div className="row">
          <button onClick={() => edit('orientation', { angle: (angle + 270) % 360 })}><RotateCcw size={15} /> 90°</button>
          <button onClick={() => edit('orientation', { angle: (angle + 90) % 360 })}><RotateCw size={15} /> 90°</button>
          <button onClick={() => edit('orientation', { angle: (angle + 180) % 360 })}>180°</button>
          <span className="small muted">{angle}°</span>
        </div>
      )
    case 'dewarp':
      return <div className="small muted">{t('dewarp_phase2')}</div>
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
