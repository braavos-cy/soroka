import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, Folder, Tag, User } from './api'

type Store = {
  user: User
  folders: Folder[]
  tags: Tag[]
  reviewCount: number
  reload: () => void
  toast: (msg: string) => void
}
export const StoreCtx = createContext<Store>(null as any)
export const useStore = () => useContext(StoreCtx)

export function StoreProvider({ user, children }: { user: User; children: React.ReactNode }) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [reviewCount, setReviewCount] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const reload = useCallback(() => {
    api<Folder[]>('/api/folders').then(setFolders).catch(() => {})
    api<Tag[]>('/api/tags').then(setTags).catch(() => {})
    api('/api/stats').then((s) => setReviewCount(s.review)).catch(() => {})
  }, [])
  useEffect(() => { reload(); const i = setInterval(reload, 30000); return () => clearInterval(i) }, [reload])
  const toast = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500) }, [])
  return (
    <StoreCtx.Provider value={{ user, folders, tags, reviewCount, reload, toast }}>
      {children}
      {msg && <div className="toast">{msg}</div>}
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

export function sortedFolderOptions(folders: Folder[]): { id: number; label: string }[] {
  return folders.map((f) => ({ id: f.id, label: folderPath(folders, f.id) })).sort((a, b) => a.label.localeCompare(b.label))
}
