import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { api, setReauthHandler } from '../api'
import { errText, useT } from '../i18n'

export function ReauthModal() {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  useEffect(() => {
    setReauthHandler(() => new Promise<boolean>((res) => { resolver.current = res; setOpen(true); setErr('') }))
  }, [])
  const finish = (ok: boolean) => { setOpen(false); setPw(''); setCode(''); resolver.current?.(ok) }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try { await api('/api/auth/reauth', { body: { password: pw, code } }); finish(true) } catch (e: any) { setErr(errText(t, e.detail)) }
  }
  if (!open) return null
  return (
    <Modal onClose={() => finish(false)}>
      <form onSubmit={submit} className="col">
        <h2>{t('reauth_title')}</h2>
        <div className="muted">{t('reauth_text')}</div>
        <label>{t('password')}</label>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
        <label>{t('totp_code')}</label>
        <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
        {err && <div className="err">{err}</div>}
        <div className="row"><span className="spacer" /><button type="button" onClick={() => finish(false)}>{t('cancel')}</button><button className="primary">{t('confirm')}</button></div>
      </form>
    </Modal>
  )
}

export function Modal({ children, onClose, wide, small }: { children: React.ReactNode; onClose: () => void; wide?: boolean; small?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '') + (small ? ' small' : '')} role="dialog" aria-modal="true">{children}</div>
    </div>
  )
}

/** QR code as a vector image: sharp at any size (a bitmap scaled to a non-integer module size scans badly),
 *  with the 4-module quiet zone scanners expect; never wider than its container. */
export function QR({ value, size = 220, level = 'M' }: { value: string; size?: number; level?: 'L' | 'M' | 'Q' | 'H' }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let live = true
    QRCode.toString(value, { type: 'svg', margin: 4, errorCorrectionLevel: level })
      .then((svg) => { if (live) setSrc('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)) })
      .catch(() => { if (live) setSrc('') })
    return () => { live = false }
  }, [value, level])
  return src ? <div className="qr" style={{ width: size }}><img src={src} alt="QR" /></div> : null
}
