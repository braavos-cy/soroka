import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api, Folder, Tag, User } from './api'
import { errText, useT } from './i18n'

type Store = {
  user: User
  folders: Folder[]
  tags: Tag[]
  reviewCount: number
  rejectedNew: number
  tagMaxLen: number
  docTotal: number
  reload: () => void
  updateUser: (patch: Partial<User>) => void
  toast: (msg: string) => void
}
export const StoreCtx = createContext<Store>(null as any)
export const useStore = () => useContext(StoreCtx)

export function StoreProvider({ user: initialUser, children }: { user: User; children: React.ReactNode }) {
  const [user, setUser] = useState<User>(initialUser)
  useEffect(() => setUser(initialUser), [initialUser])
  const updateUser = useCallback((patch: Partial<User>) => setUser((u) => ({ ...u, ...patch })), [])
  const [folders, setFolders] = useState<Folder[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [reviewCount, setReviewCount] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const { t } = useT()
  const [rejectedNew, setRejectedNew] = useState(0)
  const [tagMaxLen, setTagMaxLen] = useState(40)
  const [docTotal, setDocTotal] = useState(0)
  const loc = useLocation()
  const path = useRef(loc.pathname)
  path.current = loc.pathname
  const version = useRef<string | null>(null)
  const loadLists = useCallback(() => {
    api<Folder[]>('/api/folders').then(setFolders).catch(() => {})
    api<Tag[]>('/api/tags').then(setTags).catch(() => {})
  }, [])
  // stats carry a fingerprint of all listed data: when it changes (new upload, a reject, processing finished,
  // another user's edit…) every open page is told to reload via the 'soroka:reload' event
  const poll = useCallback(async () => {
    try {
      const s = await api('/api/stats')
      setReviewCount(s.review)
      if (path.current === '/rejected' && s.rejected_new > 0) { await api('/api/rejected/seen', { method: 'POST' }); s.rejected_new = 0 }
      setRejectedNew(s.rejected_new)
      if (s.tag_max_length) setTagMaxLen(s.tag_max_length)
      setDocTotal(Object.entries(s.documents || {}).filter(([k]) => k !== 'rejected').reduce((a, [, v]) => a + Number(v), 0))
      if (version.current !== null && version.current !== s.version) { loadLists(); window.dispatchEvent(new Event('soroka:reload')) }
      version.current = s.version
    } catch { /* offline / logged out */ }
  }, [loadLists])
  const reload = useCallback(() => { loadLists(); poll() }, [loadLists, poll])
  useEffect(() => {
    reload()
    const i = setInterval(() => { if (!document.hidden) poll() }, 5000)
    const vis = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', vis)
    return () => { clearInterval(i); document.removeEventListener('visibilitychange', vis) }
  }, [reload, poll])
  useEffect(() => { if (loc.pathname === '/rejected') poll() }, [loc.pathname])
  const toast = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500) }, [])
  return (
    <StoreCtx.Provider value={{ user, folders, tags, reviewCount, rejectedNew, tagMaxLen, docTotal, reload, updateUser, toast }}>
      {children}
      {msg && <div className="toast">{errText(t, msg)}</div>}
    </StoreCtx.Provider>
  )
}

export function folderPath(folders: Folder[], id: number | null | undefined): string {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const parts: string[] = []
  let f = id != null ? byId.get(id) : undefined
  let guard = 0
  while (f && guard++ < 50) { parts.unshift(f.name); f = f.parent_id != null ? byId.get(f.parent_id) : undefined }
  return parts.join(' / ')
}

/** Folders in tree order (depth-first, sorted by name) with their depth. */
export function folderTree(folders: Folder[]): (Folder & { depth: number })[] {
  const kids = new Map<number | null, Folder[]>()
  folders.forEach((f) => kids.set(f.parent_id, [...(kids.get(f.parent_id) || []), f]))
  const out: (Folder & { depth: number })[] = []
  const walk = (p: number | null, depth: number) => {
    if (depth > 50) return
    for (const f of (kids.get(p) || []).sort((a, b) => a.name.localeCompare(b.name))) { out.push({ ...f, depth }); walk(f.id, depth + 1) }
  }
  walk(null, 0)
  return out
}
