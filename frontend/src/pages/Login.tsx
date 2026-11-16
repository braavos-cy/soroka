import { useEffect, useState } from 'react'
import { api } from '../api'
import { errText, useT } from '../i18n'
import { passwordRules } from '../password'
import { QR } from '../components/Reauth'
import { TextInput } from '../components/ui'
import { Bird, Check, Circle, Eye, EyeOff, X } from 'lucide-react'

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
    try { await fn() } catch (e: any) { setErr(errText(t, e.detail)) } finally { setBusy(false) }
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
        <div className="row"><h2 className="logo-h"><Bird size={22} strokeWidth={2.2} /> {t('app')}</h2><span className="spacer" />
          <button className="icon" onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? 'EN' : 'RU'}</button></div>
        {cur === 'login' && (
          <form onSubmit={doLogin} className="col">
            <label>{t('email')}</label>
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
            <label>{t('password')}</label>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
            {err && <div className="err">{err}</div>}
            <button className="primary" disabled={busy}>{t('login')}</button>
          </form>
        )}
        {cur === 'totp' && (
          <form onSubmit={doVerify} className="col">
            <label>{useRecovery ? t('recovery_code') : t('totp_code')}</label>
            <TextInput value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" />
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
            <TextInput value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
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

/** Password field with an eye icon that toggles visibility. */
export function PasswordInput({ show, onToggle, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { show: boolean; onToggle: () => void }) {
  const { t } = useT()
  return (
    <div className="pw-input">
      <input {...props} type={show ? 'text' : 'password'} />
      <button type="button" className="pw-eye" onClick={onToggle} aria-label={show ? t('hide') : t('show')} title={show ? t('hide') : t('show')} aria-pressed={show}>
        {show ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  )
}

export function ChangePassword({ forced, email, onDone }: { forced?: boolean; email: string; onDone: () => void }) {
  const { t, lang, setLang } = useT()
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [show, setShow] = useState({ cur: false, pw: false, pw2: false })
  const toggle = (k: keyof typeof show) => () => setShow({ ...show, [k]: !show[k] })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const rules = passwordRules(pw, email, cur)
  const valid = rules.every((r) => r.ok)
  const match = pw !== '' && pw === pw2
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('')
    const bad = rules.find((r) => !r.ok)
    if (bad) return setErr(errText(t, bad.key))
    if (!match) return setErr(t('passwords_dont_match'))
    setBusy(true)
    try {
      await api('/api/auth/password', { body: { current_password: cur, new_password: pw } })
      setCur(''); setPw(''); setPw2(''); setShow({ cur: false, pw: false, pw2: false }); onDone()
    } catch (e: any) { setErr(errText(t, e.detail)) } finally { setBusy(false) }
  }
  const form = (
    <form onSubmit={submit} className="col" autoComplete="on">
      <div className="row"><h3 style={{ margin: 0 }}>{t('change_password')}</h3><span className="spacer" />
        {forced && <button type="button" className="icon" onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? 'EN' : 'RU'}</button>}</div>
      {forced && <div className="muted">{t('must_change_password')}</div>}
      {/* lets browsers / password managers attach the new password to the right account and offer to generate one */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly style={{ display: 'none' }} />
      <label htmlFor="current-password">{t('current_password')}</label>
      <PasswordInput id="current-password" name="current-password" value={cur} onChange={(e) => setCur(e.target.value)}
        autoComplete="current-password" required show={show.cur} onToggle={toggle('cur')} />
      <label htmlFor="new-password">{t('new_password')}</label>
      <PasswordInput id="new-password" name="new-password" value={pw} onChange={(e) => setPw(e.target.value)}
        autoComplete="new-password" required maxLength={128} show={show.pw} onToggle={toggle('pw')}
        {...{ passwordrules: 'minlength: 12; maxlength: 128; required: lower; required: upper; required: digit; required: special;' } as any} />
      {pw && <>
      <div className="small muted" style={{ marginTop: 6 }}>{t('password_requirements')}</div>
      <ul className="pw-rules small">
        {rules.map((r) => <li key={r.key} className={r.ok ? 'ok' : pw ? 'bad' : ''}>{r.ok ? <Check size={13} /> : <Circle size={11} />} {t('pw_rule_' + r.key)}</li>)}
      </ul>
      </>}
      <label htmlFor="confirm-password">{t('confirm_password')}</label>
      <PasswordInput id="confirm-password" name="confirm-password" value={pw2} onChange={(e) => setPw2(e.target.value)}
        autoComplete="new-password" required maxLength={128} show={show.pw2} onToggle={toggle('pw2')} />
      {pw2 && <div className={'small icon-text ' + (match ? 'ok-text' : 'err')}>{match ? <><Check size={13} /> {t('passwords_match')}</> : <><X size={13} /> {t('passwords_dont_match')}</>}</div>}
      {err && <div className="err">{err}</div>}
      <button className="primary" disabled={busy || !cur || !valid || !match}>{t('save')}</button>
    </form>
  )
  return forced ? <div className="login-wrap"><div className="card">{form}</div></div> : form
}
