import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, Folder as FolderIcon, FolderOpen, Home as HomeIcon, Inbox, Library, Merge, Minus, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { api, Folder, Tag } from '../api'
import { useT } from '../i18n'
import { useStore } from '../store'
import { Modal } from './Reauth'
import { Menu, useDialog } from './ui'
import { randomTagColor } from './Pickers'

export const DND = 'application/x-soroka'

/** Inline text input used for creating / renaming in place. Enter or blur commits, Escape cancels. */
function InlineEdit({ value, onCommit, onCancel, maxLength = 300 }: { value: string; onCommit: (v: string) => void; onCancel: () => void; maxLength?: number }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const commit = () => {
    if (done.current) return
    done.current = true
    if (v.trim() && v.trim() !== value) onCommit(v.trim()); else onCancel()
  }
  return (
    <input ref={ref} className="inline-edit" value={v} onChange={(e) => setV(e.target.value)} maxLength={maxLength}
      onClick={(e) => e.stopPropagation()} onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        if (e.key === 'Escape') { e.preventDefault(); done.current = true; onCancel() }
      }} />
  )
}

export default function Sidebar() {
  const { t } = useT()
  const { folders, tags, reload, toast, tagMaxLen, docTotal, unfiledTotal } = useStore()
  const dlg = useDialog()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const loc = useLocation()
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [homeOpen, setHomeOpen] = useState(true) // "Home": the root every top-level folder hangs from
  const [editing, setEditing] = useState<number | null>(null)
  const [newTag, setNewTag] = useState(false)
  const [manage, setManage] = useState(false)
  // ?folder=none is "Not in folders"; otherwise a folder id, or nothing for All documents
  const unfiled = params.get('folder') === 'none'
  const sel = params.get('folder') && !unfiled ? Number(params.get('folder')) : null
  const children = useMemo(() => {
    const m = new Map<number | null, Folder[]>()
    folders.forEach((f) => { const k = f.parent_id; m.set(k, [...(m.get(k) || []), f]) })
    m.forEach((arr) => arr.sort((a, b) => a.name.localeCompare(b.name)))
    return m
  }, [folders])

  // a folder selected from outside the tree ("Show in folders", a link, back/forward): unfold its parents once
  // and bring it into view; collapsing by hand afterwards is respected
  const revealed = useRef<number | null>(null)
  useEffect(() => {
    if (loc.pathname !== '/' || sel == null) { revealed.current = null; return }
    if (revealed.current === sel || !folders.length) return
    revealed.current = sel
    const byId = new Map(folders.map((f) => [f.id, f]))
    const up: Record<number, boolean> = {}
    for (let p = byId.get(sel)?.parent_id, n = 0; p != null && n < 100; p = byId.get(p)?.parent_id, n++) up[p] = true
    setHomeOpen(true)
    if (Object.keys(up).length) setOpen((o) => ({ ...o, ...up }))
    requestAnimationFrame(() => document.querySelectorAll('.sidebar .tree-item.sel').forEach((el) => el.scrollIntoView({ block: 'nearest' })))
  }, [sel, folders, loc.pathname])

  const listView = ['/', '/rejected', '/trash'].includes(loc.pathname)
  // tag filters apply to the current list (documents, rejected or trash); 'stay' = false always goes to documents
  const go = (mut: (p: URLSearchParams) => void, stay = true) => {
    const p = new URLSearchParams(listView ? params : undefined)
    mut(p)
    const base = stay && ['/rejected', '/trash'].includes(loc.pathname) ? loc.pathname : '/'
    const qs = p.toString()
    nav(base + (qs ? '?' + qs : ''))
  }
  // folders (and All documents) always open the documents view
  const selectFolder = (id: number | 'none' | null) => go((p) => { id == null ? p.delete('folder') : p.set('folder', String(id)) }, false)
  const onDocs = loc.pathname === '/'

  // create immediately with a unique default name, then edit the name in place
  const createFolder = async (parent: number | null) => {
    const base = t('new_folder_name')
    const taken = new Set((children.get(parent) || []).map((f) => f.name))
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`
    try {
      const r = await api('/api/folders', { body: { name, parent_id: parent } })
      if (parent) setOpen((o) => ({ ...o, [parent]: true })); else setHomeOpen(true)
      setEditing(r.id)
      reload()
    } catch (e: any) { toast(e.detail) }
  }
  const rename = async (f: Folder, name: string) => {
    setEditing(null)
    try { await api(`/api/folders/${f.id}`, { method: 'PATCH', body: { name } }); reload() } catch (e: any) { toast(e.detail) }
  }
  const del = async (f: Folder) => {
    try { await api(`/api/folders/${f.id}`, { method: 'DELETE' }) } catch (e: any) {
      if (e.status !== 409) return toast(e.detail)
      const ok = await dlg.confirm({ title: t('delete_folder_title').replace('{name}', f.name), message: t('confirm_delete_folder'), ok: t('delete'), danger: true })
      if (!ok) return
      try { await api(`/api/folders/${f.id}?confirm=true`, { method: 'DELETE' }) } catch (e2: any) { return toast(e2.detail) }
    }
    if (sel === f.id) selectFolder(null)
    reload(); window.dispatchEvent(new Event('soroka:reload'))
  }
  // target: a folder, null = All documents (folders dropped there go to the top level), 'none' = Not in folders
  // (documents dropped there leave their folder)
  const onDrop = async (e: React.DragEvent, target: number | 'none' | null) => {
    e.preventDefault(); (e.currentTarget as HTMLElement).classList.remove('drop')
    const raw = e.dataTransfer.getData(DND)
    if (!raw) return
    const d = JSON.parse(raw)
    try {
      if (target === 'none') {
        if (d.type !== 'docs') return
        await api('/api/documents/bulk', { body: { ids: d.ids, action: 'move', unfile: true } })
      }
      else if (d.type === 'docs' && target != null) await api('/api/documents/bulk', { body: { ids: d.ids, action: 'move', folder_id: target } })
      if (d.type === 'folder' && d.id !== target) await api(`/api/folders/${d.id}`, { method: 'PATCH', body: { move: true, parent_id: target } })
      reload(); window.dispatchEvent(new Event('soroka:reload'))
    } catch (err: any) { toast(err.detail) }
  }
  const dropProps = (target: number | 'none' | null) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('drop') },
    onDragLeave: (e: React.DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop'),
    onDrop: (e: React.DragEvent) => onDrop(e, target),
  })

  const renderTree = (parent: number | null, depth: number): React.ReactNode =>
    (children.get(parent) || []).map((f) => {
      const kids = children.get(f.id) || []
      const isOpen = open[f.id] ?? false
      const isEditing = editing === f.id
      return (
        <div key={f.id}>
          <div className={'tree-item' + (onDocs && sel === f.id ? ' sel' : '') + (isEditing ? ' editing' : '')} style={{ paddingLeft: 4 + depth * 16 }}
            onClick={() => !isEditing && selectFolder(f.id)} onDoubleClick={() => !isEditing && kids.length > 0 && setOpen({ ...open, [f.id]: !isOpen })} draggable={!isEditing}
            onDragStart={(e) => e.dataTransfer.setData(DND, JSON.stringify({ type: 'folder', id: f.id }))} {...dropProps(f.id)}>
            <span className="caret" onClick={(e) => { e.stopPropagation(); setOpen({ ...open, [f.id]: !isOpen }) }}>
              {kids.length > 0 && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
            </span>
            <span className="ti-icon">{isOpen && kids.length ? <FolderOpen size={16} /> : <FolderIcon size={16} />}</span>
            {isEditing
              ? <InlineEdit value={f.name} onCommit={(n) => rename(f, n)} onCancel={() => setEditing(null)} />
              : <span className="name" title={f.name}>{f.name}</span>}
            {!isEditing && <span className="cnt">{f.count || ''}</span>}
            {!isEditing && (
              <span className="acts" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                <button className="icon" title={t('new_subfolder')} onClick={() => createFolder(f.id)}><Plus size={15} /></button>
                <button className="icon" title={t('rename')} onClick={() => setEditing(f.id)}><Pencil size={14} /></button>
                <button className="icon danger" title={t('delete')} onClick={() => del(f)}><Trash2 size={14} /></button>
              </span>
            )}
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
  const createTag = async (name: string) => {
    setNewTag(false)
    try { await api('/api/tags', { body: { name, color: randomTagColor() } }); reload() } catch (e: any) { toast(e.detail) }
  }
  const sortedTags = [...tags].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <aside className="sidebar">
      <div className="side-h"><span>{t('folders')}</span></div>
      <div className={'tree-item' + (onDocs && sel == null && !unfiled ? ' sel' : '')} style={{ paddingLeft: 4 }} onClick={() => selectFolder(null)} {...dropProps(null)}>
        <span className="caret" /><span className="ti-icon"><Library size={16} /></span><span className="name">{t('all_documents')}</span><span className="cnt">{docTotal || ''}</span>
      </div>
      <div className={'tree-item' + (onDocs && unfiled ? ' sel' : '')} style={{ paddingLeft: 4 }} onClick={() => selectFolder('none')} {...dropProps('none')}>
        <span className="caret" /><span className="ti-icon"><Inbox size={16} /></span><span className="name">{t('not_in_folders')}</span><span className="cnt">{unfiledTotal || ''}</span>
      </div>
      <div className="side-sep" />
      {/* Home: the root of the folder tree. A click folds / unfolds it; hover shows "+" for a new top-level folder;
          a folder dropped here moves to the top level */}
      <div className="tree-item" style={{ paddingLeft: 4 }} onClick={() => setHomeOpen(!homeOpen)} {...dropProps(null)}>
        <span className="caret">{(children.get(null) || []).length > 0 && (homeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}</span>
        <span className="ti-icon"><HomeIcon size={16} /></span><span className="name">{t('home')}</span>
        <span className="acts" onClick={(e) => e.stopPropagation()}>
          <button className="icon" title={t('new_folder')} onClick={() => createFolder(null)}><Plus size={15} /></button>
        </span>
      </div>
      {homeOpen && renderTree(null, 1)}
      <div className="side-h">
        <span>{t('tags')}</span>
        <span className="row" style={{ gap: 0 }}>
          <button className="icon" title={t('manage_tags')} onClick={() => setManage(true)}><Settings2 size={15} /></button>
          <button className="icon" title={t('new_tag')} onClick={() => setNewTag(true)}><Plus size={15} /></button>
        </span>
      </div>
      {newTag && (
        <div className="tree-item editing" style={{ paddingLeft: 8 }}>
          <span className="dot" style={{ background: 'var(--muted)' }} />
          <InlineEdit value="" maxLength={tagMaxLen} onCommit={createTag} onCancel={() => setNewTag(false)} />
        </div>
      )}
      {inc.size > 1 && (
        <div className="seg small" style={{ margin: '0 6px 6px' }}>
          <button className={tagMode === 'and' ? 'active' : ''} onClick={() => go((p) => p.delete('tag_mode'))}>{t('tag_mode_and')}</button>
          <button className={tagMode === 'or' ? 'active' : ''} onClick={() => go((p) => p.set('tag_mode', 'or'))}>{t('tag_mode_or')}</button>
        </div>
      )}
      {sortedTags.map((tg) => (
        <div key={tg.id} className={'tag-item' + (inc.has(tg.id) ? ' inc' : exc.has(tg.id) ? ' exc' : '')} title={t('tag_hint')}
          onClick={() => cycleTag(tg.id)} style={{ paddingLeft: 8 + (tg.name.split('/').length - 1) * 14 }}>
          <span className="dot" style={{ background: tg.color }} />
          <span className="name">{tg.name.split('/').pop()}</span>
          {inc.has(tg.id) && <Plus size={13} className="tag-state" />}
          {exc.has(tg.id) && <Minus size={13} className="tag-state" />}
          <span className="cnt">{tg.count || ''}</span>
        </div>
      ))}
      {manage && <TagManager onClose={() => { setManage(false); reload() }} />}
    </aside>
  )
}

function TagManager({ onClose }: { onClose: () => void }) {
  const { t } = useT()
  const { tags, reload, toast, tagMaxLen } = useStore()
  const dlg = useDialog()
  const upd = async (tg: Tag, body: any) => { try { await api(`/api/tags/${tg.id}`, { method: 'PATCH', body }); reload() } catch (e: any) { toast(e.detail) } }
  const merge = async (tg: Tag, target: number) => { try { await api('/api/tags/merge', { body: { source_ids: [tg.id], target_id: target } }); reload() } catch (e: any) { toast(e.detail) } }
  const del = async (tg: Tag) => {
    if (await dlg.confirm({ title: t('delete_tag_title').replace('{name}', tg.name), ok: t('delete'), danger: true })) {
      try { await api(`/api/tags/${tg.id}`, { method: 'DELETE' }); reload() } catch (e: any) { toast(e.detail) }
    }
  }
  return (
    <Modal onClose={onClose}>
      <h2>{t('manage_tags')}</h2>
      <table className="list"><tbody>
        {[...tags].sort((a, b) => a.name.localeCompare(b.name)).map((tg) => (
          <tr key={tg.id}>
            <td><input type="color" value={tg.color} onChange={(e) => upd(tg, { color: e.target.value })} className="color-input" /></td>
            <td><input defaultValue={tg.name} maxLength={Math.max(tagMaxLen, tg.name.length)} onBlur={(e) => e.target.value !== tg.name && upd(tg, { name: e.target.value })} /></td>
            <td className="muted small">{tg.count}</td>
            <td>
              <Menu icon={<Merge size={14} />} label={t('merge_into')} align="right"
                items={tags.filter((x) => x.id !== tg.id).map((x) => ({ key: String(x.id), label: x.name, icon: <span className="dot" style={{ background: x.color }} /> }))}
                onSelect={(k) => merge(tg, Number(k))} />
            </td>
            <td><button className="icon danger" title={t('delete')} onClick={() => del(tg)}><Trash2 size={15} /></button></td>
          </tr>
        ))}
      </tbody></table>
      <div className="row dlg-actions"><span className="spacer" /><button onClick={onClose}>{t('close')}</button></div>
    </Modal>
  )
}
