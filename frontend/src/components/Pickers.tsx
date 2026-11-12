import { useT } from '../i18n'
import { sortedFolderOptions, useStore } from '../store'

export function FolderSelect({ value, onChange, placeholder, allowEmpty }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string; allowEmpty?: boolean }) {
  const { folders } = useStore()
  const { t } = useT()
  const inbox = t('app') === 'Сорока' ? 'Входящие' : 'Inbox'
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {(allowEmpty || value == null) && <option value="">{placeholder || '—'}</option>}
      {sortedFolderOptions(folders).map((f) => <option key={f.id} value={f.id}>{f.label === 'Inbox' ? inbox : f.label}</option>)}
    </select>
  )
}

export function TagChips({ ids, onRemove }: { ids: number[]; onRemove?: (id: number) => void }) {
  const { tags } = useStore()
  const byId = new Map(tags.map((t) => [t.id, t]))
  return (
    <span className="row" style={{ gap: 4 }}>
      {ids.map((id) => byId.get(id)).filter(Boolean).map((tg) => (
        <span key={tg!.id} className="chip"><span className="dot" style={{ background: tg!.color }} />{tg!.name}
          {onRemove && <button onClick={(e) => { e.stopPropagation(); onRemove(tg!.id) }}>×</button>}</span>
      ))}
    </span>
  )
}

export function TagAdder({ exclude, onAdd, label }: { exclude: number[]; onAdd: (id: number) => void; label?: string }) {
  const { tags } = useStore()
  const { t } = useT()
  return (
    <select value="" onChange={(e) => e.target.value && onAdd(Number(e.target.value))}>
      <option value="">{label || t('add_tag')}</option>
      {[...tags].sort((a, b) => a.name.localeCompare(b.name)).filter((x) => !exclude.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
    </select>
  )
}

export function TierBadge({ tier, status }: { tier: string | null; status?: string }) {
  const { t } = useT()
  if (status && ['queued', 'processing'].includes(status)) return <span className="tier proc">{t(status)}</span>
  if (status === 'error') return <span className="tier low">{t('error')}</span>
  if (status === 'infected') return <span className="tier low">{t('infected')}</span>
  if (!tier) return <span className="tier none">—</span>
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
