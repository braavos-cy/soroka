import { useCallback, useEffect, useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { api, User } from '../api'
import { errText, useT } from '../i18n'
import { generatePassword } from '../password'
import { useStore } from '../store'
import { Modal, QR } from '../components/Reauth'
import { FolderSelect, fmtBytes, fmtDate, TagAdder, TagChips } from '../components/Pickers'
import { Select, useDialog } from '../components/ui'
import { CheckCircle2, Loader2, MessageCircle, KeyRound, LockOpen, Pencil, Plug, ScrollText, Send, Server, ShieldOff, SlidersHorizontal, Trash2, UserCheck, UserX, Users as UsersIcon } from 'lucide-react'

export default function AdminPage() {
  const { t } = useT()
  const { user } = useStore()
  if (user.role !== 'admin') return <div className="page-pad">403</div>
  return (
    <div className="page-pad">
      <nav className="admin-tabs">
        {([['', 'connectors', Plug], ['users', 'users', UsersIcon], ['settings', 'settings', SlidersHorizontal], ['audit', 'audit_log', ScrollText], ['system', 'system', Server]] as const).map(([p, k, Icon]) => (
          <NavLink key={k} to={'/admin/' + p} end className={({ isActive }) => isActive ? 'active' : ''}><Icon size={15} /> {t(k)}</NavLink>
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
  const [code, setCode] = useState<any>(null)
  const load = useCallback(() => {
    api('/api/admin/connectors').then(setConns)
    api('/api/admin/chats').then(setChats)
  }, [])
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i) }, [load])
  useEffect(() => {
    if (!code || code.used) return
    const i = setInterval(async () => {
      const s = await api(`/api/admin/registration-codes/${code.code}`)
      if (s.used_chat_id) { setCode({ ...code, used: s.used_chat_id }); load() }
    }, 3000)
    return () => clearInterval(i)
  }, [code])
  const relink = async (p: string) => { if (await dlg.confirm({ title: t('relink') + '?', message: t('relink_confirm'), ok: t('relink'), danger: true })) { await api(`/api/admin/connectors/${p}/logout`, { method: 'POST' }); toast('OK') } }
  const unregister = async (c: any) => { if (await dlg.confirm({ title: `${t('unregister')} «${c.chat_name || c.chat_id}»?`, ok: t('unregister'), danger: true })) { await api(`/api/admin/chats/${c.id}`, { method: 'DELETE' }); load() } }
  const statusColor: Record<string, string> = { connected: 'high', qr: 'medium', offline: 'low', disconnected: 'low', logged_out: 'low' }
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ alignItems: 'stretch' }}>
        {conns.map((c) => (
          <div key={c.platform} className="card col" style={{ minWidth: 300 }}>
            <div className="row"><h3 style={{ margin: 0 }}>{c.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}</h3><span className="spacer" /><span className={'tier ' + (statusColor[c.status] || 'none')}>{c.status}</span></div>
            {c.self_id && <div className="small">{c.self_name} {c.self_id}</div>}
            {c.detail && <div className="small muted">{c.detail}</div>}
            <div className="small muted">{t('last_seen')}: {fmtDate(c.last_seen_at, true) || '—'}</div>
            {c.qr && <><div className="small">{t('scan_qr')}</div><QR value={c.qr} size={260} /></>}
            {c.platform === 'whatsapp' && c.status !== 'offline' && <button onClick={() => relink(c.platform)}>{t('relink')}</button>}
            {c.platform === 'telegram' && c.status === 'offline' && <div className="small muted">Phase 2</div>}
          </div>
        ))}
        <div className="card col" style={{ minWidth: 300 }}>
          <h3 style={{ margin: 0 }}>{t('registration_code')}</h3>
          <div className="small muted">{t('registration_code_help')}</div>
          {code ? (
            <>
              <div style={{ fontSize: 26, fontFamily: 'monospace', letterSpacing: 2 }}>{code.code}</div>
              <div className="small icon-text">{code.used ? <><CheckCircle2 size={14} className="ok-text" /> {code.used}</> : <><Loader2 size={14} className="spin" /> {t('waiting')}</>}</div>
              <button onClick={() => setCode(null)}>{t('close')}</button>
            </>
          ) : <button onClick={async () => setCode(await api('/api/admin/registration-codes', { body: { platform: 'whatsapp' } }))}>{t('new_code')} (WhatsApp)</button>}
        </div>
      </div>
      <div className="card">
        <h3>{t('registered_chats')}</h3>
        <table className="list">
          <thead><tr><th>{t('chat')}</th><th>{t('folder')}</th><th>{t('tags')}</th><th>{t('mode')}</th><th>{t('context')}</th><th>#</th><th /></tr></thead>
          <tbody>
            {chats.registered.map((c: any) => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
                <td><PlatformName c={c} /></td>
                <td><FolderLabel id={c.folder_id} /></td>
                <td><TagChips ids={c.tag_ids} /></td>
                <td className="small">{t('mode_' + c.mode)}</td>
                <td className="small">-{c.ctx_before} / +{c.ctx_after} / ±{c.ctx_minutes}m</td>
                <td className="small">{c.events}</td>
                <td><button className="icon" title={t('edit')} onClick={() => setEditing(c)}><Pencil size={14} /></button><button className="link danger" onClick={() => unregister(c)}>{t('unregister')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>{t('unregistered_chats')}</h3>
        <table className="list"><tbody>
          {chats.unregistered.map((c: any) => (
            <tr key={c.platform + c.chat_id}>
              <td><PlatformName c={c} /></td>
              <td className="small muted">{c.chat_id}</td>
              <td><button onClick={() => setEditing({ platform: c.platform, chat_id: c.chat_id, chat_name: c.chat_name, folder_id: null, tag_ids: [], ctx_before: 5, ctx_after: 5, ctx_minutes: 10, mode: 'auto', active: true })}>{t('register')}</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      {editing && <ChatEditor chat={editing} onClose={() => { setEditing(null); load() }} />}
    </div>
  )
}

function FolderLabel({ id }: { id: number | null }) {
  const { folders } = useStore()
  const f = folders.find((x) => x.id === id)
  const { t } = useT()
  return <span className="small">{f ? f.name : <span className="muted">{t('no_folder')}</span>}</span>
}

function PlatformName({ c }: { c: any }) {
  return <span className="icon-text">{c.platform === 'whatsapp' ? <MessageCircle size={15} className="ok-text" /> : <Send size={15} style={{ color: 'var(--accent)' }} />} {c.chat_name || c.chat_id}</span>
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
  return (
    <Modal onClose={onClose}>
      <h2>{c.chat_name || c.chat_id}</h2>
      <label>{t('folder')}</label>
      <FolderSelect value={c.folder_id} allowEmpty onChange={(f) => setC({ ...c, folder_id: f })} />
      <label>{t('tags')}</label>
      <div className="row"><TagChips ids={c.tag_ids} onRemove={(id) => setC({ ...c, tag_ids: c.tag_ids.filter((x: number) => x !== id) })} /><TagAdder exclude={c.tag_ids} onAdd={(id) => setC({ ...c, tag_ids: [...c.tag_ids, id] })} /></div>
      <label>{t('mode')}</label>
      <div className="seg">
        <button className={c.mode === 'auto' ? 'active' : ''} onClick={() => setC({ ...c, mode: 'auto' })}>{t('mode_auto')}</button>
        <button className={c.mode === 'override' ? 'active' : ''} onClick={() => setC({ ...c, mode: 'override' })}>{t('mode_override')}</button>
      </div>
      <label>{t('context')}</label>
      <div className="row">
        <input type="number" min={0} max={50} value={c.ctx_before} onChange={(e) => setC({ ...c, ctx_before: Number(e.target.value) })} style={{ width: 70 }} /> {t('ctx_before')}
        <input type="number" min={0} max={50} value={c.ctx_after} onChange={(e) => setC({ ...c, ctx_after: Number(e.target.value) })} style={{ width: 70 }} /> {t('ctx_after')}
        <input type="number" min={0} max={120} value={c.ctx_minutes} onChange={(e) => setC({ ...c, ctx_minutes: Number(e.target.value) })} style={{ width: 70 }} /> {t('ctx_minutes')}
      </div>
      <label className="inline" style={{ marginTop: 10 }}><input type="checkbox" checked={c.active} onChange={(e) => setC({ ...c, active: e.target.checked })} />{t('active')}</label>
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
      <label>{t('email')}</label><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={{ width: '100%' }} />
      <label>{t('name')}</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ width: '100%' }} />
      <label>{t('role')}</label><Select value={f.role} onChange={(v) => setF({ ...f, role: v })} options={[{ value: 'user', label: t('role_user') }, { value: 'admin', label: t('role_admin') }]} />
      <label>{t('temp_password')}</label>
      <div className="row" style={{ flexWrap: 'nowrap' }}><input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" style={{ flex: 1, fontFamily: 'monospace' }} /><button type="button" onClick={() => setF({ ...f, password: generatePassword() })}>{t('generate_password')}</button></div>
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
  const [rows, setRows] = useState<any[]>([])
  const [filter, setFilter] = useState('')
  useEffect(() => { api(`/api/admin/audit?action=${encodeURIComponent(filter)}&limit=300`).then(setRows) }, [filter])
  return (
    <div className="card">
      <div className="row"><h3 style={{ margin: 0 }}>{t('audit_log')}</h3><span className="spacer" /><input placeholder="action…" onChange={(e) => setFilter(e.target.value)} /></div>
      <table className="list">
        <thead><tr><th>{t('date')}</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td className="small">{fmtDate(r.at, true)}</td><td className="small">{r.user || '—'}</td><td>{r.action}</td><td className="small">{r.target}</td>
            <td className="small muted" style={{ maxWidth: 360, wordBreak: 'break-all' }}>{Object.keys(r.details || {}).length ? JSON.stringify(r.details) : ''}</td><td className="small">{r.ip}</td></tr>
        ))}</tbody>
      </table>
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
