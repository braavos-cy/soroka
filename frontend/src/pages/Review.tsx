import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useT } from '../i18n'
import { useStore } from '../store'
import { fmtDate, TierBadge } from '../components/Pickers'

type Item = { page_id: number; document_id: number; title: string; tier: string; page_no: number; received_at: string; flagged: { stage: string; tier: string; method: string }[] }

export default function ReviewPage() {
  const { t } = useT()
  const { reload, toast } = useStore()
  const nav = useNavigate()
  const [items, setItems] = useState<Item[]>([])
  const [idx, setIdx] = useState(0)
  const [medium, setMedium] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const load = useCallback(() => api<Item[]>(`/api/review?include_medium=${medium}`).then((r) => { setItems(r); setIdx((i) => Math.min(i, Math.max(0, r.length - 1))) }), [medium])
  useEffect(() => { load() }, [load])
  const cur = items[idx]
  useEffect(() => { setDetail(null); if (cur) api(`/api/pages/${cur.page_id}`).then(setDetail) }, [cur?.page_id])

  const act = useCallback(async (kind: 'accept' | 'non_document' | 'open') => {
    if (!cur) return
    if (kind === 'open') return nav(`/doc/${cur.document_id}`)
    try {
      if (kind === 'accept') await api(`/api/pages/${cur.page_id}/review`, { body: { action: 'accept' } })
      if (kind === 'non_document') await api(`/api/pages/${cur.page_id}/edit`, { body: { stage: 'acceptance', value: { value: 'non_document' } } })
      setItems((xs) => xs.filter((x) => x.page_id !== cur.page_id))
      reload()
    } catch (e: any) { toast(e.detail) }
  }, [cur])
  const pickCrop = async (quad: any) => {
    await api(`/api/pages/${cur.page_id}/edit`, { body: { stage: 'crop', value: { quad } } })
    setItems((xs) => xs.filter((x) => x.page_id !== cur.page_id)); reload()
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName.match(/INPUT|TEXTAREA|SELECT/)) return
      if (e.key === 'j' || e.key === 'ArrowDown') setIdx((i) => Math.min(items.length - 1, i + 1))
      else if (e.key === 'k' || e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1))
      else if (e.key === 'a') act('accept')
      else if (e.key === 'n') act('non_document')
      else if (e.key === 'e' || e.key === 'Enter') act('open')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [items, act])

  const cands = detail?.stages_detail?.crop?.info?.candidates || []
  return (
    <div className="page-pad">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{t('review_queue')}</h2>
        <span className="muted">{items.length}</span>
        <span className="spacer" />
        <label className="inline"><input type="checkbox" checked={medium} onChange={(e) => setMedium(e.target.checked)} />{t('include_medium')}</label>
      </div>
      <div className="muted small" style={{ marginBottom: 12 }}>{t('review_help')}</div>
      {items.length === 0 && <div className="card muted">{t('queue_empty')}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 2fr', gap: 16 }}>
        <div className="review-list">
          {items.map((it, i) => (
            <div key={it.page_id} className={'item' + (i === idx ? ' sel' : '')} onClick={() => setIdx(i)}>
              <img src={`/api/pages/${it.page_id}/image?variant=thumb`} alt="" />
              <div className="col" style={{ gap: 4 }}>
                <b>{it.title}</b>
                <span className="small muted">{t('page')} {it.page_no} · {fmtDate(it.received_at)}</span>
                <span className="row" style={{ gap: 4 }}>{it.flagged.map((f) => <span key={f.stage} className="chip">{t('stage_' + f.stage)} <TierBadge tier={f.tier} /></span>)}</span>
              </div>
            </div>
          ))}
        </div>
        {cur && detail && (
          <div className="card col">
            <div className="row">
              <button className="primary" onClick={() => act('accept')}>✓ {t('accept')} (a)</button>
              <button onClick={() => act('open')}>{t('open_editor')} (e)</button>
              <button className="danger" onClick={() => act('non_document')}>{t('not_document')} (n)</button>
            </div>
            {cands.length > 1 && detail.original_url ? (
              <>
                <div className="small muted">{t('candidates')} — {t('stage_crop')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(3, cands.length)}, 1fr)`, gap: 8 }}>
                  {cands.slice(0, 3).map((c: any) => (
                    <div key={c.method} className="col" style={{ gap: 4, cursor: 'pointer' }} onClick={() => pickCrop(c.quad)}>
                      <div className="imgwrap"><img src={detail.original_url} alt="" style={{ maxHeight: 360 }} />
                        <svg viewBox={`0 0 ${detail.width} ${detail.height}`} preserveAspectRatio="none">
                          <polygon points={c.quad.map((p: number[]) => p.join(',')).join(' ')} fill="rgba(47,111,237,.15)" stroke="#2f6fed" strokeWidth={detail.width / 150} />
                        </svg></div>
                      <span className="small">{c.method} · {c.score.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            <div className="small muted">{t('view_result')}</div>
            <div className="imgwrap" style={{ alignSelf: 'flex-start' }}><img src={detail.render_url} alt="" style={{ maxHeight: 520 }} /></div>
          </div>
        )}
      </div>
    </div>
  )
}
