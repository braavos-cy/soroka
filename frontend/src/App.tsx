import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
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
import { DialogProvider } from './components/ui'
import { UploadsProvider } from './components/uploads'
import { PanelLeftClose, PanelLeftOpen, Bird, CircleUser, ListChecks, LogOut, Menu, Search, Settings, ShieldX, Trash2 } from 'lucide-react'

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
  else if (me.user.must_change_password) body = <ChangePassword forced email={me.user.email} onDone={load} />
  else body = <StoreProvider user={me.user}><UploadsProvider><Shell onLogout={() => setMe({ user: null, next: 'login' })} /></UploadsProvider></StoreProvider>
  return <LangCtx.Provider value={ctx}><DialogProvider>{body}<ReauthModal /></DialogProvider></LangCtx.Provider>
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { t, lang, setLang } = useT()
  const { user, reviewCount, rejectedNew } = useStore()
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
  // narrow screens (phones): the folder / tag pane is a drawer opened from the menu button; closes on navigation
  const [drawer, setDrawer] = useState(false)
  const loc = useLocation()
  useEffect(() => setDrawer(false), [loc.pathname, loc.search])
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }); onLogout() }
  // left pane: collapsible + resizable, remembered per browser
  const SIDE_DEFAULT = 260, SIDE_MIN = 180, SIDE_MAX = 520
  const [sideW, setSideW] = useState<number>(() => { try { return Number(localStorage.getItem('sideW')) || SIDE_DEFAULT } catch { return SIDE_DEFAULT } })
  const [sideOpen, setSideOpen] = useState<boolean>(() => { try { return localStorage.getItem('sideOpen') !== '0' } catch { return true } })
  useEffect(() => { try { localStorage.setItem('sideW', String(sideW)); localStorage.setItem('sideOpen', sideOpen ? '1' : '0') } catch { /* */ } }, [sideW, sideOpen])
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const x0 = e.clientX, w0 = sideW
    const move = (ev: MouseEvent) => setSideW(Math.max(SIDE_MIN, Math.min(SIDE_MAX, w0 + ev.clientX - x0)))
    const up = () => { document.body.classList.remove('resizing'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <div className="app">
      <header className="topbar">
        <button className="icon side-toggle" onClick={() => setSideOpen(!sideOpen)} title={sideOpen ? t('hide_sidebar') : t('show_sidebar')}>{sideOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
        <button className="icon drawer-toggle" onClick={() => setDrawer(true)} title={t('show_sidebar')}><Menu size={20} /></button>
        <NavLink to="/" className="logo"><Bird size={20} strokeWidth={2.2} /> <span className="logo-txt">{t('app')}</span></NavLink>
        <form className="search" onSubmit={submit}>
          <Search size={15} className="search-icon" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} type="search" />
        </form>
        <nav>
          <NavLink to="/review"><ListChecks size={16} /> <span className="lbl">{t('review')}</span>{reviewCount > 0 && <span className="badge">{reviewCount}</span>}</NavLink>
          <NavLink to="/rejected"><ShieldX size={16} /> <span className="lbl">{t('rejected')}</span>{rejectedNew > 0 && <span className="badge">{rejectedNew}</span>}</NavLink>
          <NavLink to="/trash"><Trash2 size={16} /> <span className="lbl">{t('trash')}</span></NavLink>
          {user.role === 'admin' && <NavLink to="/admin"><Settings size={16} /> <span className="lbl">{t('admin')}</span></NavLink>}
          <NavLink to="/account"><CircleUser size={16} /> <span className="lbl">{t('account')}</span></NavLink>
        </nav>
        <span className="spacer" />
        <button className="icon lang" title={t('language')} onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>{lang === 'ru' ? 'EN' : 'RU'}</button>
        <button className="icon" onClick={logout} title={t('logout')}><LogOut size={17} /></button>
      </header>
      <div className="main" style={{ gridTemplateColumns: sideOpen ? `${sideW}px 1fr` : '1fr' }}>
        {sideOpen && (
          <div className="side-wrap">
            <Sidebar />
            <div className="side-resizer" onMouseDown={startResize} onDoubleClick={() => setSideW(SIDE_DEFAULT)} title={t('resize_sidebar')} />
          </div>
        )}
        {drawer && <div className="drawer-bg" onClick={() => setDrawer(false)}><div className="drawer" onClick={(e) => e.stopPropagation()}><Sidebar /></div></div>}
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
