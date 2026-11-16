import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, setUnauthHandler, User } from './api'
import { Lang, LangCtx, makeT, useT } from './i18n'
import { StoreProvider, useStore } from './store'
import Login, { ChangePassword } from './pages/Login'
import Sidebar, { DND, DND_DOCS } from './components/Sidebar'
import DocumentsPage from './pages/Documents'
import DocumentView from './pages/DocumentView'
import ReviewPage from './pages/Review'
import AdminPage from './pages/Admin'
import AccountPage from './pages/Account'
import { ReauthModal } from './components/Reauth'
import { DialogProvider } from './components/ui'
import { UploadsProvider } from './components/uploads'
import { PanelLeftClose, PanelLeftOpen, Bird, CircleUser, Files, ListChecks, LogOut, Menu, Search, Settings, ShieldX, Trash2, X } from 'lucide-react'

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
  const { t } = useT()
  const { user, reviewCount, rejectedNew, toast, reload: reloadStore } = useStore()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('q') || '')
  const searchInput = useRef<HTMLInputElement>(null)
  // follow the URL (back/forward, links), but never overwrite what is being typed: the URL lags behind the keys
  useEffect(() => { if (document.activeElement !== searchInput.current) setQ(params.get('q') || '') }, [params.get('q')])
  const searching = location.pathname === '/' && !!params.get('q')
  const beforeSearch = useRef<string | null>(null) // where the user was when the search started
  // emptying the box ends the search: back to the page it was started from
  const leaveSearch = () => {
    // inside a document opened from a search: stay there, only drop the search and with it the highlights
    if (location.pathname.startsWith('/doc/') && params.get('q')) {
      const p = new URLSearchParams(params)
      for (const k of ['q', 'focus', 'at', 'ao']) p.delete(k)
      return nav(location.pathname + (p.toString() ? '?' + p : ''), { replace: true })
    }
    if (!searching) return
    const back = beforeSearch.current
    beforeSearch.current = null
    if (back) return nav(back)
    const p = new URLSearchParams(params)
    p.delete('q')
    nav('/?' + p.toString())
  }
  // a press anywhere outside a text field takes the cursor out of it (the search box, the filters, any field).
  // The browser does not always do this by itself: the document list cancels the default mouse-down (drag
  // selection), and that also cancels the blur. A press on the field's own parts (its clear button, the search
  // form) or in an open suggestion / dropdown list keeps the focus.
  useEffect(() => {
    const h = (e: PointerEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (!el || !el.matches('input, textarea')) return
      const t = e.target as Node
      const own = el.closest('form.search, .clearable') || el
      if (own.contains(t) || (t instanceof Element && t.closest('.dd-pop'))) return
      el.blur()
    }
    document.addEventListener('pointerdown', h, true)
    return () => document.removeEventListener('pointerdown', h, true)
  }, [])
  // reads the address bar, not React state: it also runs from the typing timer, after several renders
  const runSearch = (text: string) => {
    const onList = location.pathname === '/'
    const cur = new URLSearchParams(onList ? location.search : '')
    if (cur.get('q') === text) return
    const already = onList && !!cur.get('q')
    if (!already) beforeSearch.current = location.pathname + location.search
    cur.set('q', text)
    nav('/?' + cur.toString(), { replace: already }) // one history entry per search, not one per key
  }
  // search as you type, a moment after the last key
  const typing = useRef<number>()
  const onSearchChange = (v: string) => {
    setQ(v)
    window.clearTimeout(typing.current)
    if (!v.trim()) return leaveSearch()
    if (v.trim().length < 2) return // one character matches almost everything: wait for the second (Enter still searches)
    typing.current = window.setTimeout(() => runSearch(v.trim()), 250)
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    window.clearTimeout(typing.current)
    if (!q.trim()) return leaveSearch()
    runSearch(q.trim())
  }
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault() // handled here: the page-wide Esc below must not end the search a second time
    window.clearTimeout(typing.current)
    setQ('')
    leaveSearch()
    e.currentTarget.blur()
  }
  // Esc anywhere ends an active search too (in the list or in a document opened from it), unless something nearer
  // takes it: a dialog, a menu, a field being edited, picked words in the page preview (those mark it handled)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !new URLSearchParams(window.location.search).get('q')) return
      const el = document.activeElement as HTMLElement | null
      if (el && el !== searchInput.current && el.matches('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('.modal-bg')) return
      window.clearTimeout(typing.current)
      setQ('')
      leaveSearch()
      searchInput.current?.blur()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })
  // documents dragged from the list onto the Trash tab go to the trash (no other tab takes drops)
  // Enter and over must both accept the drag, also when they come from the tab's icon or label: an unaccepted
  // dragenter shows the "no drop" cursor for a moment (the flicker). Leaving into the tab's own parts is not leaving.
  const isDocDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(DND_DOCS)
  const dropOff = (e: React.DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop')
  const accept = (e: React.DragEvent) => {
    if (!isDocDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    ;(e.currentTarget as HTMLElement).classList.add('drop')
  }
  const trashDrop = {
    onDragEnter: accept,
    onDragOver: accept,
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropOff(e) },
    onDrop: async (e: React.DragEvent) => {
      dropOff(e)
      if (!isDocDrag(e)) return
      e.preventDefault()
      let ids: number[] = []
      try { ids = JSON.parse(e.dataTransfer.getData(DND)).ids || [] } catch { return }
      if (!ids.length) return
      try {
        await api('/api/documents/bulk', { body: { ids, action: 'trash' } })
        toast(`${t('dropped_to_trash')}: ${ids.length}`)
        reloadStore(); window.dispatchEvent(new Event('soroka:reload'))
      } catch (err: any) { toast(err.detail) }
    },
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
          <input ref={searchInput} value={q} onChange={(e) => onSearchChange(e.target.value)} onKeyDown={onSearchKey} placeholder={t('search')} type="search" />
          {/* own clear button: the browser's one only shows while the box is hovered or focused */}
          {q && <button type="button" className="icon search-clear" title={t('clear_selection')} onClick={() => { window.clearTimeout(typing.current); setQ(''); leaveSearch() }}><X size={15} /></button>}
        </form>
        {/* desktop: sections in the top bar; phone (< 640px): a bottom tab bar with labels */}
        <nav className="sections">
          <NavLink to="/" title={t('nav_documents')} className={() => 'nav-docs' + (loc.pathname === '/' || loc.pathname.startsWith('/doc/') ? ' active' : '')}><Files size={16} /> <span className="lbl">{t('nav_documents')}</span></NavLink>
          <NavLink to="/review" title={t('review')}><ListChecks size={16} /> <span className="lbl">{t('review')}</span>{reviewCount > 0 && <span className="badge">{reviewCount}</span>}</NavLink>
          <NavLink to="/rejected" title={t('rejected')}><ShieldX size={16} /> <span className="lbl lbl-full">{t('rejected')}</span><span className="lbl lbl-short">{t('nav_rejected')}</span>{rejectedNew > 0 && <span className="badge">{rejectedNew}</span>}</NavLink>
          <NavLink to="/trash" title={t('trash')} className="nav-trash" {...trashDrop}><Trash2 size={16} /> <span className="lbl">{t('trash')}</span></NavLink>
          {user.role === 'admin' && <NavLink to="/admin" title={t('admin')} className="nav-admin"><Settings size={16} /> <span className="lbl">{t('admin')}</span></NavLink>}
          <NavLink to="/account" title={t('account')}><CircleUser size={16} /> <span className="lbl">{t('account')}</span></NavLink>
        </nav>
        <span className="spacer" />
        {/* language is in Account → Preferences; on phones logging out is there too */}
        <button className="icon logout-btn" onClick={logout} title={t('logout')}><LogOut size={17} /></button>
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
