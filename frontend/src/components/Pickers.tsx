import { Folder as FolderIcon, FolderInput, FolderX, Plus, X } from 'lucide-react'
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

export function TagChips({ ids, onRemove }: { ids: number[]; onRemove?: (id: number) => void }) {
  const { tags } = useStore()
  const byId = new Map(tags.map((t) => [t.id, t]))
  return (
    <span className="row" style={{ gap: 4 }}>
      {ids.map((id) => byId.get(id)).filter(Boolean).map((tg) => (
        <span key={tg!.id} className="chip"><span className="dot" style={{ background: tg!.color }} />{tg!.name}
          {onRemove && <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(tg!.id) }}><X size={12} /></button>}</span>
      ))}
    </span>
  )
}

export const TAG_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b']
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
