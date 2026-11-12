import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { QR } from '../components/Reauth'

const ERR: Record<string, string> = {
  invalid_credentials: 'Неверный email или пароль / Invalid email or password',
  account_locked: 'Аккаунт временно заблокирован / Account temporarily locked',
  invalid_code: 'Неверный код / Invalid code',
  too_many_attempts: 'Слишком много попыток / Too many attempts',
  password_too_short: 'Пароль слишком короткий / Password too short',
}

export default function Login({ step, onDone }: { step: string; onDone: () => void }) {
  const { t, lang, setLang } = useT()
  const [cur, setCur] = useState(step === 'done' ? 'login' : step)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [err, setErr] = useState('')
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (cur === 'totp_setup' && !setup) api('/api/auth/totp/setup', { method: 'POST' }).then(setSetup).catch((e) => setErr(e.detail))
  }, [cur])

  const run = async (fn: () => Promise<void>) => {
    setErr(''); setBusy(true)
    try { await fn() } catch (e: any) { setErr(ERR[e.detail] || e.detail) } finally { setBusy(false) }
  }
  const doLogin = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    const r = await api('/api/auth/login', { body: { email, password: pw } })
    if (r.next === 'done') onDone(); else setCur(r.next)
  }) }
  const doVerify = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    await api('/api/auth/totp/verify', { body: useRecovery ? { recovery_code: code } : { code } }); onDone()
  }) }
  const doEnable = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    const r = await api('/api/auth/totp/enable', { body: { code } }); setCodes(r.recovery_codes)
  }) }

  return (
    <div className="login-wrap">
      <div className="card col">
        <div className="row"><h2 style={{ margin: 0 }}>🐦 {t('app')}</h2><span className="spacer" />
          <button className="icon" onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? 'EN' : 'RU'}</button></div>
        {cur === 'login' && (
          <form onSubmit={doLogin} className="col">
            <label>{t('email')}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
            <label>{t('password')}</label>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
            {err && <div className="err">{err}</div>}
            <button className="primary" disabled={busy}>{t('login')}</button>
          </form>
        )}
        {cur === 'totp' && (
          <form onSubmit={doVerify} className="col">
            <label>{useRecovery ? t('recovery_code') : t('totp_code')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" />
            {err && <div className="err">{err}</div>}
            <button className="primary" disabled={busy}>{t('verify')}</button>
            <button type="button" className="link" onClick={() => { setUseRecovery(!useRecovery); setCode('') }}>{useRecovery ? t('totp_code') : t('use_recovery')}</button>
          </form>
        )}
        {cur === 'totp_setup' && !codes && (
          <form onSubmit={doEnable} className="col">
            <h3>{t('setup_2fa')}</h3>
            <div className="muted small">{t('setup_2fa_text')}</div>
            {setup && <div style={{ textAlign: 'center' }}><QR value={setup.uri} /></div>}
            {setup && <div className="small muted">{t('secret_key')}: <code>{setup.secret}</code></div>}
            <label>{t('totp_code')}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
            {err && <div className="err">{err}</div>}
            <button className="primary" disabled={busy || !setup}>{t('verify')}</button>
          </form>
        )}
        {codes && <RecoveryCodes codes={codes} onDone={onDone} />}
      </div>
    </div>
  )
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useT()
  return (
    <div className="col">
      <h3>{t('recovery_codes')}</h3>
      <div className="muted small">{t('recovery_codes_text')}</div>
      <div className="codes">{codes.map((c) => <span key={c}>{c}</span>)}</div>
      <button className="primary" onClick={onDone}>{t('continue')}</button>
    </div>
  )
}

export function ChangePassword({ forced, onDone }: { forced?: boolean; onDone: () => void }) {
  const { t } = useT()
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('')
    try { await api('/api/auth/password', { body: { current_password: cur, new_password: pw } }); onDone() }
    catch (e: any) { setErr(ERR[e.detail] || e.detail) }
  }
  const form = (
    <form onSubmit={submit} className="col">
      <h3>{t('change_password')}</h3>
      {forced && <div className="muted">{t('must_change_password')}</div>}
      <label>{t('current_password')}</label>
      <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
      <label>{t('new_password')}</label>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={10} />
      {err && <div className="err">{err}</div>}
      <button className="primary">{t('save')}</button>
    </form>
  )
  return forced ? <div className="login-wrap"><div className="card">{form}</div></div> : form
}
