import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, Folder, Tag } from '../api'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Modal } from './Reauth'

export const DND = 'application/x-soroka'

export default function Sidebar() {
  const { t } = useT()
  const { folders, tags, reload, toast } = useStore()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const loc = useLocation()
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [manage, setManage] = useState(false)
  const sel = params.get('folder') ? Number(params.get('folder')) : null
  const children = useMemo(() => {
    const m = new Map<number | null, Folder[]>()
    folders.forEach((f) => { const k = f.parent_id; m.set(k, [...(m.get(k) || []), f]) })
    m.forEach((arr) => arr.sort((a, b) => (b.is_system ? 1 : 0) - (a.is_system ? 1 : 0) || a.name.localeCompare(b.name)))
    return m
  }, [folders])

  const go = (mut: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(loc.pathname === '/' || loc.pathname === '/rejected' || loc.pathname === '/trash' ? params : undefined)
    mut(p)
    const base = ['/rejected', '/trash'].includes(loc.pathname) ? loc.pathname : '/'
    nav(base + '?' + p.toString())
  }
  const selectFolder = (id: number | null) => go((p) => { id == null ? p.delete('folder') : p.set('folder', String(id)) })

  const createFolder = async (parent: number | null) => {
    const name = prompt(t(parent ? 'new_subfolder' : 'new_folder'))
    if (!name) return
    try { await api('/api/folders', { body: { name, parent_id: parent } }); if (parent) setOpen({ ...open, [parent]: true }); reload() } catch (e: any) { toast(e.detail) }
  }
  const rename = async (f: Folder) => {
    const name = prompt(t('rename'), f.name)
    if (!name || name === f.name) return
    try { await api(`/api/folders/${f.id}`, { method: 'PATCH', body: { name } }); reload() } catch (e: any) { toast(e.detail) }
  }
  const del = async (f: Folder) => {
    try { await api(`/api/folders/${f.id}`, { method: 'DELETE' }) } catch (e: any) {
      if (e.status !== 409 || !confirm(t('confirm_delete_folder'))) return toast(e.detail)
      await api(`/api/folders/${f.id}?confirm=true`, { method: 'DELETE' })
    }
    if (sel === f.id) selectFolder(null)
    reload()
  }
  const onDrop = async (e: React.DragEvent, target: number | null) => {
    e.preventDefault(); (e.currentTarget as HTMLElement).classList.remove('drop')
    const raw = e.dataTransfer.getData(DND)
    if (!raw) return
    const d = JSON.parse(raw)
    try {
      if (d.type === 'docs' && target != null) await api('/api/documents/bulk', { body: { ids: d.ids, action: 'move', folder_id: target } })
      if (d.type === 'folder' && d.id !== target) await api(`/api/folders/${d.id}`, { method: 'PATCH', body: { move: true, parent_id: target } })
      reload(); window.dispatchEvent(new Event('soroka:reload'))
    } catch (err: any) { toast(err.detail) }
  }
  const dropProps = (target: number | null) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('drop') },
    onDragLeave: (e: React.DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop'),
    onDrop: (e: React.DragEvent) => onDrop(e, target),
  })

  const renderTree = (parent: number | null, depth: number): React.ReactNode =>
    (children.get(parent) || []).map((f) => {
      const kids = children.get(f.id) || []
      const isOpen = open[f.id] ?? false
      return (
        <div key={f.id}>
          <div className={'tree-item' + (sel === f.id ? ' sel' : '')} style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => selectFolder(f.id)} draggable={!f.is_system}
            onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'folder', id: f.id }))} {...dropProps(f.id)}>
            <span className="caret" onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [f.id]: !isOpen }) }}>{kids.length ? (isOpen ? '▾' : '▸') : ''}</span>
            <span>{f.is_system ? '📥' : '📁'}</span>
            <span className="name" title={f.name}>{f.is_system ? (t('app') === 'Сорока' ? 'Входящие' : 'Inbox') : f.name}</span>
            <span className="acts" onClick={(e) => e.stopPropagation()}>
              <button className="icon" title={t('new_subfolder')} onClick={() => createFolder(f.id)}>＋</button>
              {!f.is_system && <button className="icon" title={t('rename')} onClick={() => rename(f)}>✎</button>}
              {!f.is_system && <button className="icon" title={t('delete')} onClick={() => del(f)}>🗑</button>}
            </span>
            <span className="cnt">{f.count || ''}</span>
          </div>
          {isOpen && renderTree(f.id, depth + 1)}
        </div>
      )
    })

  // tags: include/exclude cycling, AND/OR for includes
  const inc = new Set((params.get('tags') || '').split(',').filter(Boolean).map(Number))
  const exc = new Set((params.get('tags_not') || '').split(',').filter(Boolean).map(Number))
  const tagMode = params.get('tag_mode') === 'or' ? 'or' : 'and'
  const cycleTag = (id: number) => go((p) => {
    const i = new Set(inc), x = new Set(exc)
    if (i.has(id)) { i.delete(id); x.add(id) } else if (x.has(id)) x.delete(id); else i.add(id)
    i.size ? p.set('tags', [...i].join(',')) : p.delete('tags')
    x.size ? p.set('tags_not', [...x].join(',')) : p.delete('tags_not')
  })
  const createTag = async () => {
    const name = prompt(t('new_tag') + ' (finance/tax)')
    if (!name) return
    const palette = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b']
    try { await api('/api/tags', { body: { name, color: palette[Math.floor(Math.random() * palette.length)] } }); reload() } catch (e: any) { toast(e.detail) }
  }
  const sortedTags = [...tags].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <aside className="sidebar">
      <div className="side-h"><span>{t('folders')}</span><button className="icon" title={t('new_folder')} onClick={() => createFolder(null)}>＋</button></div>
      <div className={'tree-item' + (sel == null ? ' sel' : '')} onClick={() => selectFolder(null)} {...dropProps(null)}>
        <span className="caret" /><span>🗂</span><span className="name">{t('all_documents')}</span>
      </div>
      {renderTree(null, 0)}
      {sel != null && (
        <label className="inline small" style={{ margin: '4px 8px' }}>
          <input type="checkbox" checked={params.get('sub') !== '0'} onChange={(e) => go((p) => e.target.checked ? p.delete('sub') : p.set('sub', '0'))} />
          {t('include_subfolders')}
        </label>
      )}
      <div className="side-h">
        <span>{t('tags')}</span>
        <span>
          <button className="icon" title={t('manage_tags')} onClick={() => setManage(true)}>⚙</button>
          <button className="icon" title={t('new_tag')} onClick={createTag}>＋</button>
        </span>
      </div>
      {inc.size > 1 && (
        <div className="seg small" style={{ margin: '0 6px 6px' }}>
          <button className={tagMode === 'and' ? 'active' : ''} onClick={() => go((p) => p.delete('tag_mode'))}>{t('tag_mode_and')}</button>
          <button className={tagMode === 'or' ? 'active' : ''} onClick={() => go((p) => p.set('tag_mode', 'or'))}>{t('tag_mode_or')}</button>
        </div>
      )}
      {sortedTags.map((tg) => (
        <div key={tg.id} className={'tag-item' + (inc.has(tg.id) ? ' inc' : exc.has(tg.id) ? ' exc' : '')} title={t('tag_hint')}
          onClick={() => cycleTag(tg.id)} style={{ paddingLeft: 6 + (tg.name.split('/').length - 1) * 12 }}>
          <span className="dot" style={{ background: tg.color }} />
          <span className="name" style={{ flex: 1 }}>{inc.has(tg.id) ? '＋ ' : exc.has(tg.id) ? '－ ' : ''}{tg.name.split('/').pop()}</span>
          <span className="cnt muted small">{tg.count || ''}</span>
        </div>
      ))}
      {manage && <TagManager onClose={() => { setManage(false); reload() }} />}
    </aside>
  )
}

function TagManager({ onClose }: { onClose: () => void }) {
  const { t } = useT()
  const { tags, reload, toast } = useStore()
  const upd = async (tg: Tag, body: any) => { try { await api(`/api/tags/${tg.id}`, { method: 'PATCH', body }); reload() } catch (e: any) { toast(e.detail) } }
  const merge = async (tg: Tag, target: number) => { await api('/api/tags/merge', { body: { source_ids: [tg.id], target_id: target } }); reload() }
  const del = async (tg: Tag) => { if (confirm(`${t('delete')} "${tg.name}"?`)) { await api(`/api/tags/${tg.id}`, { method: 'DELETE' }); reload() } }
  return (
    <Modal onClose={onClose}>
      <h2>{t('manage_tags')}</h2>
      <table className="list"><tbody>
        {[...tags].sort((a, b) => a.name.localeCompare(b.name)).map((tg) => (
          <tr key={tg.id}>
            <td><input type="color" value={tg.color} onChange={(e) => upd(tg, { color: e.target.value })} style={{ width: 34, padding: 0 }} /></td>
            <td><input defaultValue={tg.name} onBlur={(e) => e.target.value !== tg.name && upd(tg, { name: e.target.value })} /></td>
            <td className="muted small">{tg.count}</td>
            <td>
              <select value="" onChange={(e) => e.target.value && merge(tg, Number(e.target.value))}>
                <option value="">{t('merge_into')}</option>
                {tags.filter((x) => x.id !== tg.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </td>
            <td><button className="icon" onClick={() => del(tg)}>🗑</button></td>
          </tr>
        ))}
      </tbody></table>
      <div className="row" style={{ marginTop: 12 }}><span className="spacer" /><button onClick={onClose}>{t('close')}</button></div>
    </Modal>
  )
}
