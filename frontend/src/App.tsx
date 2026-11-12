import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { api, setUnauthHandler, User } from './api'
import { Lang, LangCtx, makeT, useT } from './i18n'
import { StoreProvider, useStore } from './store'
import Login, { ChangePassword } from './pages/Login'
import Sidebar from './components/Sidebar'
import DocumentsPage from './pages/Documents'
import DocumentView from './pages/DocumentView'
import ReviewPage from './pages/Review'
import AdminPage from './pages/Admin'
import AccountPage from './pages/Account'
import { ReauthModal } from './components/Reauth'

export default function App() {
  const [lang, setLangState] = useState<Lang>(() => {
    try { return (localStorage.getItem('lang') as Lang) || 'ru' } catch { return 'ru' }
  })
  const [me, setMe] = useState<{ user: User | null; next: string; email?: string } | null>(null)
  const load = useCallback(() => {
    api('/api/auth/me').then(setMe).catch(() => setMe({ user: null, next: 'login' }))
  }, [])
  useEffect(() => { load(); setUnauthHandler(() => setMe({ user: null, next: 'login' })) }, [load])
  const setLang = (l: Lang) => {
    setLangState(l)
    try { localStorage.setItem('lang', l) } catch { /* */ }
    if (me?.user) api('/api/auth/lang', { body: { ui_lang: l } }).catch(() => {})
  }
  useEffect(() => { if (me?.user?.ui_lang && me.user.ui_lang !== lang) setLangState(me.user.ui_lang as Lang) }, [me?.user?.ui_lang])
  const ctx = useMemo(() => ({ lang, t: makeT(lang), setLang }), [lang, me])
  useEffect(() => { document.title = ctx.t('app') }, [ctx])

  let body: React.ReactNode
  if (me === null) body = <div className="login-wrap muted">{ctx.t('loading')}</div>
  else if (!me.user) body = <Login step={me.next} onDone={load} />
  else if (me.user.must_change_password) body = <ChangePassword forced onDone={load} />
  else body = <StoreProvider user={me.user}><Shell onLogout={() => setMe({ user: null, next: 'login' })} /></StoreProvider>
  return <LangCtx.Provider value={ctx}>{body}<ReauthModal /></LangCtx.Provider>
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { t, lang, setLang } = useT()
  const { user, reviewCount } = useStore()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('q') || '')
  useEffect(() => { setQ(params.get('q') || '') }, [params.get('q')])
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const p = new URLSearchParams(location.pathname === '/' ? params : undefined)
    if (q.trim()) p.set('q', q.trim()); else p.delete('q')
    nav('/?' + p.toString())
  }
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }); onLogout() }
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="logo">🐦 {t('app')}</NavLink>
        <form className="search" onSubmit={submit}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} type="search" />
        </form>
        <nav>
          <NavLink to="/" end>📄 <span className="lbl">{t('documents')}</span></NavLink>
          <NavLink to="/review">✅ <span className="lbl">{t('review')}</span>{reviewCount > 0 && <span className="badge">{reviewCount}</span>}</NavLink>
          <NavLink to="/rejected">🚫 <span className="lbl">{t('rejected')}</span></NavLink>
          <NavLink to="/trash">🗑 <span className="lbl">{t('trash')}</span></NavLink>
          {user.role === 'admin' && <NavLink to="/admin">⚙️ <span className="lbl">{t('admin')}</span></NavLink>}
          <NavLink to="/account">👤 <span className="lbl">{t('account')}</span></NavLink>
        </nav>
        <button className="icon" title={t('language')} onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? 'EN' : 'RU'}</button>
        <button className="icon" onClick={logout} title={t('logout')}>⎋</button>
      </header>
      <div className="main">
        <Sidebar />
        <div className="content">
          <Routes>
            <Route path="/" element={<DocumentsPage view="active" />} />
            <Route path="/rejected" element={<DocumentsPage view="rejected" />} />
            <Route path="/trash" element={<DocumentsPage view="trash" />} />
            <Route path="/doc/:id" element={<DocumentView />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/admin/*" element={<AdminPage />} />
            <Route path="/account" element={<AccountPage />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
