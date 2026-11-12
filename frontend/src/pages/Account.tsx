import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { useStore } from '../store'
import { ChangePassword, RecoveryCodes } from './Login'
import { Modal, QR } from '../components/Reauth'
import { useDialog } from '../components/ui'
import { fmtDate } from '../components/Pickers'

export default function AccountPage() {
  const { t, lang, setLang } = useT()
  const { user, toast } = useStore()
  const dlg = useDialog()
  const [sessions, setSessions] = useState<any[]>([])
  const [tokens, setTokens] = useState<any[]>([])
  const [newToken, setNewToken] = useState<string | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [setup, setSetup] = useState<any>(null)
  const [code, setCode] = useState('')
  const load = () => { api('/api/auth/sessions').then(setSessions); api('/api/auth/tokens').then(setTokens) }
  useEffect(() => { load() }, [])
  const createToken = async () => {
    const name = await dlg.prompt({ title: t('create_token'), label: t('name'), placeholder: t('token_name_hint'), ok: t('create_token') })
    if (!name) return
    const r = await api('/api/auth/tokens', { body: { name, scopes: ['ingest'] } })
    setNewToken(r.token); load()
  }
  const startSetup = async () => { try { setSetup(await api('/api/auth/totp/setup', { method: 'POST' })) } catch (e: any) { toast(e.detail) } }
  const finishSetup = async () => { try { const r = await api('/api/auth/totp/enable', { body: { code } }); setSetup(null); setCode(''); setCodes(r.recovery_codes) } catch (e: any) { toast(e.detail) } }
  // sessions card spans both rows; keep it at least as tall as the first row (language / 2FA)
  const row1 = useRef<HTMLDivElement>(null)
  const [row1H, setRow1H] = useState(0)
  useEffect(() => {
    const el = row1.current
    if (!el) return
    const ro = new ResizeObserver(() => setRow1H(el.getBoundingClientRect().height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="page-pad">
      <div className="account-head">
        <h1>{user.name || user.email}</h1>
        <div className="muted">{user.name ? user.email + ' · ' : ''}{t('role_' + user.role)}</div>
      </div>
      <div className="account-grid">
          <div className="card col acc-lang" ref={row1}>
            <h3>{t('language')}</h3>
            <div className="seg" style={{ alignSelf: 'flex-start' }}><button className={lang === 'ru' ? 'active' : ''} onClick={() => setLang('ru')}>Русский</button><button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>English</button></div>
          </div>
          <div className="card col acc-pw">
            <ChangePassword email={user.email} onDone={() => toast(t('saved'))} />
          </div>
          <div className="card col acc-2fa">
            <h3>{t('two_factor')}: {user.totp_enabled ? t('enabled') : '—'}</h3>
            <div className="row">
              <button onClick={startSetup}>{t('reconfigure_2fa')}</button>
              <button onClick={async () => { try { setCodes((await api('/api/auth/recovery-codes', { method: 'POST' })).recovery_codes) } catch (e: any) { toast(e.detail) } }}>{t('regenerate_codes')}</button>
            </div>
            <div className="small muted">WebAuthn / passkeys: phase 2</div>
          </div>
          <div className="card acc-tokens">
            <div className="row"><h3 style={{ margin: 0 }}>{t('api_tokens')}</h3><span className="spacer" /><button onClick={createToken}>{t('create_token')}</button></div>
            {newToken && <div className="col" style={{ margin: '10px 0' }}><span className="small">{t('token_once')}</span><code style={{ wordBreak: 'break-all' }}>{newToken}</code></div>}
            <table className="list"><tbody>
              {tokens.map((tk) => (
                <tr key={tk.id} style={{ opacity: tk.revoked_at ? 0.4 : 1 }}><td>{tk.name}<div className="small muted">{tk.prefix}… · {tk.scopes.join(',')} · {fmtDate(tk.last_used_at, true)}</div></td>
                  <td>{!tk.revoked_at && <button className="link" onClick={async () => { await api(`/api/auth/tokens/${tk.id}`, { method: 'DELETE' }); load() }}>{t('revoke')}</button>}</td></tr>
              ))}
            </tbody></table>
          </div>
          <div className="card acc-sessions" style={{ minHeight: row1H || undefined }}>
            <h3>{t('sessions')}</h3>
            <table className="list"><tbody>
              {sessions.map((s) => (
                <tr key={s.id}><td className="small">{s.user_agent.slice(0, 60)}<div className="muted">{s.ip} · {fmtDate(s.last_seen_at, true)}</div></td>
                  <td>{s.current ? <span className="chip">{t('current')}</span> : <button className="link" onClick={async () => { await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }); load() }}>{t('revoke')}</button>}</td></tr>
              ))}
            </tbody></table>
          </div>
      </div>
      {setup && (
        <Modal onClose={() => setSetup(null)}>
          <h2>{t('setup_2fa')}</h2>
          <div style={{ textAlign: 'center' }}><QR value={setup.uri} /></div>
          <div className="small muted">{t('secret_key')}: <code>{setup.secret}</code></div>
          <label>{t('totp_code')}</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" />
          <div className="row" style={{ marginTop: 12 }}><span className="spacer" /><button className="primary" onClick={finishSetup}>{t('verify')}</button></div>
        </Modal>
      )}
      {codes && <Modal onClose={() => setCodes(null)}><RecoveryCodes codes={codes} onDone={() => setCodes(null)} /></Modal>}
    </div>
  )
}
