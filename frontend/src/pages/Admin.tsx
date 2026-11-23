import { useCallback, useEffect, useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { api, User } from '../api'
import { errText, useT } from '../i18n'
import { generatePassword } from '../password'
import { useStore } from '../store'
import { Modal, QR } from '../components/Reauth'
import { FolderSelect, fmtBytes, fmtDate, TagAdder, TagChips } from '../components/Pickers'
import { Select, TextInput, useDialog } from '../components/ui'
import { CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, Info, Loader2, MessageCircle, KeyRound, LockOpen, Pencil, Plug, ScrollText, Send, Server, ShieldOff, SlidersHorizontal, Trash2, UserCheck, UserX, Users as UsersIcon } from 'lucide-react'

export default function AdminPage() {
  const { t } = useT()
  const { user } = useStore()
  if (user.role !== 'admin') return <div className="page-pad">403</div>
  return (
    <div className="page-pad">
      <nav className="admin-tabs">
        {([['', 'connectors', Plug], ['users', 'users', UsersIcon], ['settings', 'settings', SlidersHorizontal], ['audit', 'audit_log', ScrollText], ['system', 'system', Server]] as const).map(([p, k, Icon]) => (
          <NavLink key={k} to={p ? '/admin/' + p : '/admin'} end className={({ isActive }) => isActive ? 'active' : ''}><Icon size={15} /> {t(k)}</NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Connectors />} />
        <Route path="users" element={<Users />} />
        <Route path="settings" element={<Settings />} />
        <Route path="audit" element={<Audit />} />
        <Route path="system" element={<System />} />
      </Routes>
    </div>
  )
}

// ---------------------------------------------------------------- connectors & chats
function Connectors() {
  const { t } = useT()
  const { toast } = useStore()
  const dlg = useDialog()
  const [conns, setConns] = useState<any[]>([])
  const [chats, setChats] = useState<any>({ registered: [], unregistered: [] })
  const [editing, setEditing] = useState<any>(null)
  const [showUnreg, setShowUnreg] = useState<Record<string, boolean>>({})  // per platform; collapsed by default
  const load = useCallback(() => {
    api('/api/admin/connectors').then(setConns)
    api('/api/admin/chats').then(setChats)
  }, [])
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i) }, [load])
  const relink = async (p: string) => { if (await dlg.confirm({ title: t('relink') + '?', message: t('relink_confirm'), ok: t('relink'), danger: true })) { await api(`/api/admin/connectors/${p}/logout`, { method: 'POST' }); load() } }
  const unregister = async (c: any) => { if (await dlg.confirm({ title: `${t('unregister')} «${c.chat_name || c.chat_id}»?`, ok: t('unregister'), danger: true })) { await api(`/api/admin/chats/${c.id}`, { method: 'DELETE' }); load() } }
  const leave = async (c: any) => {
    if (!await dlg.confirm({ title: `${t('leave_chat')} «${c.chat_name || c.chat_id}»?`, message: t('leave_chat_confirm'), ok: t('leave_chat'), danger: true })) return
    try { await api('/api/admin/chats/leave', { body: { platform: c.platform, chat_id: c.chat_id } }); load() } catch (e: any) { toast(errText(t, e.detail)) }
  }
  // only groups can be left; a person's private chat is only deactivated (Unregister)
  const leaveBtn = (c: any) => !String(c.chat_id).endsWith('@g.us') ? null : c.leaving
    ? <span className="small muted icon-text"><Loader2 size={14} className="spin" /> {t('leaving')}</span>
    : <button className="link danger" onClick={() => leave(c)}>{t('leave_chat')}</button>
  const statusColor: Record<string, string> = { connected: 'high', qr: 'medium', offline: 'low', disconnected: 'low', logged_out: 'low' }
  // expanded state per connector: the admin's choice if they made one, otherwise open unless the connector is offline
  const [open, setOpen] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('conn_open') || '{}') } catch { return {} } })
  const isOpen = (c: any) => open[c.platform] ?? c.status !== 'offline'
  const toggle = (c: any) => {
    const next = { ...open, [c.platform]: !isOpen(c) }
    setOpen(next)
    try { localStorage.setItem('conn_open', JSON.stringify(next)) } catch { /* private mode */ }
  }
  const newChat = (c: any) => ({ platform: c.platform, chat_id: c.chat_id, chat_name: c.chat_name, folder_id: null, tag_ids: [], ctx_before: 5, ctx_after: 5, ctx_minutes: 10, mode: 'auto', active: true, reactions: true })
  return (
    <div className="conn-list">
      {conns.map((c) => {
        const reg = chats.registered.filter((x: any) => x.platform === c.platform)
        const unreg = chats.unregistered.filter((x: any) => x.platform === c.platform)
        const account = [c.self_name, c.self_id && '+' + c.self_id.split('@')[0].split(':')[0]].filter(Boolean).join(' · ')
        const status = t('conn_' + c.status).startsWith('conn_') ? c.status : t('conn_' + c.status)
        const expanded = isOpen(c)
        return (
          <section key={c.platform} className="card conn">
            <button className="conn-head" aria-expanded={expanded} onClick={() => toggle(c)}>
              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <PlatformIcon platform={c.platform} size={18} />
              <span className="conn-name">{c.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}</span>
              <span className="conn-meta">
                {account && <span>{account}</span>}
                <span>{t('conn_chats')}: {reg.length}</span>
                {unreg.length > 0 && <span>{t('conn_unregistered')}: {unreg.length}</span>}
              </span>
              <span className={'tier ' + (statusColor[c.status] || 'none')}>{status}</span>
            </button>
            {expanded && (
              <div className="conn-body">
                <div className="row">
                  <span className="small muted">{t('last_seen')}: {fmtDate(c.last_seen_at, true) || '—'}</span>
                  {c.detail && <span className="small muted">{c.detail}</span>}
                  {c.platform === 'telegram' && c.status === 'offline' && <span className="small muted">Phase 2</span>}
                  <span className="spacer" />
                  {c.unlinking
                    ? <span className="small muted icon-text"><Loader2 size={14} className="spin" /> {t('unlinking')}</span>
                    : c.platform === 'whatsapp' && c.status !== 'offline' && <button onClick={() => relink(c.platform)}>{t('relink')}</button>}
                </div>
                {c.qr && <div className="col"><div className="small">{t('scan_qr')}</div><QR value={c.qr} size={280} level="L" /></div>}

                {c.platform === 'whatsapp' && <PrivateCode platform={c.platform} value={c.private_code || ''} onSaved={load} />}

                <h4>{t('registered_chats')}</h4>
                {reg.length === 0 ? <div className="small muted">{t('conn_no_chats')}</div> : (
                  <div className="table-scroll">
                    <table className="list">
                      <thead><tr><th>{t('chat')}</th><th>{t('folder')}</th><th>{t('tags')}</th><th>{t('mode')}</th><th>{t('context')}</th><th>#</th><th /></tr></thead>
                      <tbody>
                        {reg.map((r: any) => (
                          <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
                            <td>{r.chat_name || r.chat_id}</td>
                            <td><FolderLabel id={r.folder_id} /></td>
                            <td><TagChips ids={r.tag_ids} /></td>
                            <td className="small">{t('mode_' + r.mode)}</td>
                            <td className="small" title={`${t('ctx_s1')} ${r.ctx_before} ${t('ctx_s2')} ${r.ctx_after} ${t('ctx_s3')} ${r.ctx_minutes} ${t('ctx_s4')}`}>{r.ctx_before} + {r.ctx_after}, {r.ctx_minutes} {t('minutes_short')}</td>
                            <td className="small">{r.events}</td>
                            <td className="nowrap"><button className="icon" title={t('edit')} onClick={() => setEditing(r)}><Pencil size={14} /></button><button className="link danger" onClick={() => unregister(r)}>{t('unregister')}</button>{leaveBtn(r)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {unreg.length > 0 && (
                  <>
                    <button className="sub-toggle" aria-expanded={!!showUnreg[c.platform]}
                      onClick={() => setShowUnreg((s) => ({ ...s, [c.platform]: !s[c.platform] }))}>
                      {showUnreg[c.platform] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      <h4>{t('unregistered_chats')}</h4>
                      <span className="small muted">{unreg.length}</span>
                    </button>
                    {showUnreg[c.platform] && <div className="table-scroll">
                      <table className="list"><tbody>
                        {unreg.map((u: any) => (
                          <tr key={u.chat_id}>
                            <td>{u.chat_name || u.chat_id}</td>
                            <td className="small muted">{u.chat_id}</td>
                            <td className="nowrap"><button onClick={() => setEditing(newChat(u))}>{t('register')}</button>{leaveBtn(u)}</td>
                          </tr>
                        ))}
                      </tbody></table>
                    </div>}
                  </>
                )}
              </div>
            )}
          </section>
        )
      })}
      {editing && <ChatEditor chat={editing} onClose={() => { setEditing(null); load() }} />}
    </div>
  )
}

/** The secret word a person sends to the bot to activate their private chat. Empty: private chats stay ignored. */
function PrivateCode({ platform, value, onSaved }: { platform: string; value: string; onSaved: () => void }) {
  const { t } = useT()
  const { toast } = useStore()
  const [v, setV] = useState(value)
  const [show, setShow] = useState(false)
  useEffect(() => setV(value), [value])
  const dirty = v.trim() !== value
  const save = async () => {
    try { await api(`/api/admin/connectors/${platform}/private-code`, { method: 'PUT', body: { code: v } }); toast(t('saved')); onSaved() }
    catch (e: any) { toast(errText(t, e.detail)) }
  }
  return (
    <div className="col" style={{ gap: 4 }}>
      <h4 style={{ margin: 0 }} className="icon-text" title={t('private_code_help')}>
        {t('private_code')} <Info size={14} className="muted" />
      </h4>
      <div className="row">
        <TextInput type={show ? 'text' : 'password'} value={v} autoComplete="off" placeholder={t('private_code_none')} maxLength={100}
          onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && dirty) save() }} wrapStyle={{ width: 240, maxWidth: '100%' }} />
        <button className="icon" title={show ? t('hide') : t('show')} onClick={() => setShow(!show)}>{show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
        <button className="primary" disabled={!dirty} onClick={save}>{t('save')}</button>
      </div>
      {!value && <span className="small muted">{t('private_code_off')}</span>}
    </div>
  )
}

function FolderLabel({ id }: { id: number | null }) {
  const { folders } = useStore()
  const f = folders.find((x) => x.id === id)
  const { t } = useT()
  return <span className="small">{f ? f.name : <span className="muted">{t('no_folder')}</span>}</span>
}

function PlatformIcon({ platform, size = 15 }: { platform: string; size?: number }) {
  return platform === 'whatsapp' ? <MessageCircle size={size} className="ok-text" /> : <Send size={size} style={{ color: 'var(--accent)' }} />
}

function ChatEditor({ chat, onClose }: { chat: any; onClose: () => void }) {
  const { t } = useT()
  const { toast } = useStore()
  const [c, setC] = useState(chat)
  const save = async () => {
    try {
      if (c.id) await api(`/api/admin/chats/${c.id}`, { method: 'PUT', body: c })
      else await api('/api/admin/chats', { body: c })
      onClose()
    } catch (e: any) { toast(e.detail) }
  }
  const num = (k: 'ctx_before' | 'ctx_after' | 'ctx_minutes', max: number) => (
    <input type="number" min={0} max={max} value={c[k]} onChange={(e) => setC({ ...c, [k]: Math.max(0, Math.min(max, Number(e.target.value))) })} />
  )
  return (
    <Modal onClose={onClose}>
      <h2>{c.chat_name || c.chat_id}</h2>
      <label className="choice">
        <input type="checkbox" checked={c.active} onChange={(e) => setC({ ...c, active: e.target.checked })} />
        <span><b>{t('chat_active')}</b><span className="hint">{t('chat_active_hint')}</span></span>
      </label>

      <label>{t('chat_place_in')}</label>
      <FolderSelect value={c.folder_id} allowEmpty onChange={(f) => setC({ ...c, folder_id: f })} />
      <label>{t('chat_auto_tag')}</label>
      <div className="row"><TagAdder exclude={c.tag_ids} onAdd={(id) => setC({ ...c, tag_ids: [...c.tag_ids, id] })} /><TagChips ids={c.tag_ids} onRemove={(id) => setC({ ...c, tag_ids: c.tag_ids.filter((x: number) => x !== id) })} /></div>

      <label>{t('chat_what_to_save')}</label>
      {(['auto', 'override'] as const).map((mode) => (
        <label key={mode} className={'choice' + (c.mode === mode ? ' on' : '')}>
          <input type="radio" name="chat-mode" checked={c.mode === mode} onChange={() => setC({ ...c, mode })} />
          <span><b>{t('mode_' + mode)}</b><span className="hint">{t('mode_' + mode + '_hint')}</span></span>
        </label>
      ))}

      <label>{t('chat_context')}</label>
      <div className="ctx-sentence" title={t('chat_context_hint')}>
        {t('ctx_s1')} {num('ctx_before', 50)} {t('ctx_s2')} {num('ctx_after', 50)} {t('ctx_s3')} {num('ctx_minutes', 120)} {t('ctx_s4')}
      </div>

      <label className="choice" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={c.reactions ?? true} onChange={(e) => setC({ ...c, reactions: e.target.checked })} />
        <span>{t('chat_reactions_one')}</span>
      </label>
      <div className="row" style={{ marginTop: 16 }}><span className="spacer" /><button onClick={onClose}>{t('cancel')}</button><button className="primary" onClick={save}>{t('save')}</button></div>
    </Modal>
  )
}

// ---------------------------------------------------------------- users
function Users() {
  const { t } = useT()
  const { user: me, toast } = useStore()
  const dlg = useDialog()
  const [users, setUsers] = useState<User[]>([])
  const [add, setAdd] = useState(false)
  const load = () => api('/api/admin/users').then(setUsers)
  useEffect(() => { load() }, [])
  const upd = async (u: User, body: any) => { try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); load(); toast(t('saved')) } catch (e: any) { toast(e.detail) } }
  const del = async (u: User) => { if (await dlg.confirm({ title: `${t('delete')} ${u.email}?`, ok: t('delete'), danger: true })) { try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); load() } catch (e: any) { toast(e.detail) } } }
  return (
    <div className="card">
      <div className="row"><h3 style={{ margin: 0 }}>{t('users')}</h3><span className="spacer" /><button className="primary" onClick={() => setAdd(true)}>{t('add_user')}</button></div>
      <table className="list mid">
        <thead><tr><th>{t('email')}</th><th>{t('name')}</th><th>{t('role')}</th><th className="center">2FA</th><th>{t('last_seen')}</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.5 }}>
              <td>{u.email}</td><td>{u.name}</td>
              <td><Select value={u.role} disabled={u.id === me.id} onChange={(v) => upd(u, { role: v })} options={[{ value: 'user', label: t('role_user') }, { value: 'admin', label: t('role_admin') }]} /></td>
              <td className="center">{u.totp_enabled ? <CheckCircle2 size={16} className="ok-text cell-icon" /> : <span className="muted">—</span>}</td>
              <td className="small">{fmtDate(u.last_login_at, true)}</td>
              <td className="actions-cell">
                <div className="row-actions">
                  <button className="icon" title={t('reset_password')} onClick={async () => { const p = await dlg.prompt({ title: `${t('reset_password')}: ${u.email}`, label: t('temp_password'), value: generatePassword(), mono: true }); if (p) upd(u, { password: p }) }}><KeyRound size={16} /></button>
                  <button className="icon" title={t('reset_2fa')} onClick={async () => { if (await dlg.confirm({ title: `${t('reset_2fa')}: ${u.email}?`, message: t('reset_2fa_confirm'), ok: t('reset_2fa'), danger: true })) upd(u, { reset_2fa: true }) }}><ShieldOff size={16} /></button>
                  <button className="icon" title={t('unlock')} onClick={() => upd(u, { unlock: true })}><LockOpen size={16} /></button>
                  {u.id !== me.id && <button className="icon" title={u.is_active ? t('disable') : t('enable')} onClick={() => upd(u, { is_active: !u.is_active })}>{u.is_active ? <UserX size={16} /> : <UserCheck size={16} />}</button>}
                  {u.id !== me.id && <button className="icon danger" title={t('delete')} onClick={() => del(u)}><Trash2 size={16} /></button>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {add && <AddUser onClose={() => { setAdd(false); load() }} />}
    </div>
  )
}

function AddUser({ onClose }: { onClose: () => void }) {
  const { t } = useT()
  const [f, setF] = useState(() => ({ email: '', name: '', role: 'user', password: generatePassword() }))
  const [err, setErr] = useState('')
  const save = async () => { try { await api('/api/admin/users', { body: f }); onClose() } catch (e: any) { setErr(errText(t, e.detail)) } }
  return (
    <Modal onClose={onClose}>
      <h2>{t('add_user')}</h2>
      <label>{t('email')}</label><TextInput value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} wrapStyle={{ width: '100%' }} />
      <label>{t('name')}</label><TextInput value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} wrapStyle={{ width: '100%' }} />
      <label>{t('role')}</label><Select value={f.role} onChange={(v) => setF({ ...f, role: v })} options={[{ value: 'user', label: t('role_user') }, { value: 'admin', label: t('role_admin') }]} />
      <label>{t('temp_password')}</label>
      <div className="row" style={{ flexWrap: 'nowrap' }}><TextInput value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" style={{ fontFamily: 'monospace' }} wrapStyle={{ flex: 1 }} /><button type="button" onClick={() => setF({ ...f, password: generatePassword() })}>{t('generate_password')}</button></div>
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ marginTop: 16 }}><span className="spacer" /><button onClick={onClose}>{t('cancel')}</button><button className="primary" onClick={save}>{t('save')}</button></div>
    </Modal>
  )
}

// ---------------------------------------------------------------- settings
function Settings() {
  const { t } = useT()
  const { toast } = useStore()
  const [s, setS] = useState<any>(null)
  useEffect(() => { api('/api/admin/settings').then(setS) }, [])
  if (!s) return null
  const save = async () => { try { setS(await api('/api/admin/settings', { method: 'PUT', body: s })); toast(t('saved')) } catch (e: any) { toast(e.detail) } }
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h3>{t('settings')}</h3>
      {Object.entries(s).map(([k, v]) => (
        <div key={k} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <span>{t(k)}</span>
          {typeof v === 'boolean'
            ? <input type="checkbox" checked={v} onChange={(e) => setS({ ...s, [k]: e.target.checked })} />
            : <input type="number" step="any" value={v as number} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} style={{ width: 110 }} />}
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}><span className="spacer" /><button className="primary" onClick={save}>{t('save')}</button></div>
    </div>
  )
}

// ---------------------------------------------------------------- audit & system
function Audit() {
  const { t } = useT()
  const PAGE = 50
  const [rows, setRows] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => { const i = setTimeout(() => { setQ(input.trim()); setPage(0) }, 300); return () => clearTimeout(i) }, [input])
  useEffect(() => {
    let stale = false
    api(`/api/admin/audit?q=${encodeURIComponent(q)}&limit=${PAGE}&offset=${page * PAGE}`).then((r) => { if (!stale) { setRows(r.items); setTotal(r.total) } })
    return () => { stale = true }
  }, [q, page])
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const pager = (
    <div className="row small">
      <span className="muted">{total ? `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} / ${total}` : '0'}</span>
      <span className="spacer" />
      <button disabled={page === 0} onClick={() => setPage(0)}>«</button>
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>{t('prev')}</button>
      <span>{page + 1} / {pages}</span>
      <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>{t('next')}</button>
      <button disabled={page >= pages - 1} onClick={() => setPage(pages - 1)}>»</button>
    </div>
  )
  return (
    <div className="card col">
      <div className="row"><h3 style={{ margin: 0 }}>{t('audit_log')}</h3><span className="spacer" /><TextInput placeholder={t('search_log')} value={input} onChange={(e) => setInput(e.target.value)} wrapStyle={{ width: 260, maxWidth: '100%' }} /></div>
      {pager}
      <div className="table-scroll"><table className="list">
        <thead><tr><th>{t('date')}</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td className="small">{fmtDate(r.at, true)}</td><td className="small">{r.user || '—'}</td><td>{r.action}</td><td className="small">{r.target}</td>
            <td className="small muted" style={{ maxWidth: 360, wordBreak: 'break-all' }}>{Object.keys(r.details || {}).length ? JSON.stringify(r.details) : ''}</td><td className="small">{r.ip}</td></tr>
        ))}</tbody>
      </table></div>
      {rows.length > 15 && pager}
    </div>
  )
}

function System() {
  const { t } = useT()
  const [s, setS] = useState<any>(null)
  useEffect(() => { const l = () => api('/api/admin/system').then(setS); l(); const i = setInterval(l, 5000); return () => clearInterval(i) }, [])
  if (!s) return null
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card kv" style={{ minWidth: 320 }}>
        <span>{t('queues')}</span><span>high {s.queues.high} · default {s.queues.default} · low {s.queues.low}</span>
        <span>{t('disk')}</span><span>{fmtBytes(s.disk.free)} free / {fmtBytes(s.disk.total)}</span>
        <span>{t('rejected')}</span><span>{fmtBytes(s.rejected_bytes)}</span>
        <span>{t('failed_pages')}</span><span>{s.failed_pages}</span>
        <span>{t('documents')}</span><span>{s.documents}</span>
        <span>{t('pages')}</span><span>{s.pages}</span>
      </div>
      <div className="card"><a href="/api/admin/export" onClick={async (e) => { e.preventDefault(); const r: Response = await api('/api/admin/export', { raw: true }); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'soroka-export.zip'; a.click() }}><button>{t('export_data')}</button></a></div>
    </div>
  )
}
