// Upload manager: uploads run in the background (the dialog only queues them) and show as cards in the
// document list until the server has created the document. Files go in chunks to a resumable upload session
// (/api/uploads), so an upload can be paused and resumed from where it stopped, or cancelled.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api, ApiError, Folder } from '../api'
import { useStore } from '../store'
import { useT } from '../i18n'

const CHUNK = 8 * 1024 * 1024
const PARALLEL = 2

export type UpState = 'queued' | 'uploading' | 'paused' | 'saving' | 'error'
export type UpTask = {
  id: string
  name: string
  files: File[]
  size: number
  sent: number
  state: UpState
  error?: string
  path: string[] // sub-folders below the target folder (folder uploads)
  folder: number | null
  tagIds: number[]
  combine: boolean
  low: boolean
  sessions: (string | null)[] // server upload session per file
  done: number[] // bytes confirmed by the server per file
}
export type NewUpload = Pick<UpTask, 'files' | 'path' | 'folder' | 'tagIds' | 'combine' | 'low'>

type Ctx = {
  tasks: UpTask[]
  add: (u: NewUpload[]) => void
  pause: (ids: string[]) => void
  resume: (ids: string[]) => void
  cancel: (ids: string[]) => Promise<void>
}
const UploadsCtx = createContext<Ctx>(null as any)
export const useUploads = () => useContext(UploadsCtx)

export const isActive = (s: UpState) => s === 'queued' || s === 'uploading' || s === 'saving'

class Stopped extends Error {}

function putChunk(url: string, blob: Blob, onProgress: (n: number) => void, setXhr: (x: XMLHttpRequest | null) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('PUT', url)
    x.withCredentials = true
    x.setRequestHeader('x-requested-with', 'soroka')
    x.setRequestHeader('content-type', 'application/octet-stream')
    x.upload.onprogress = (e) => onProgress(e.loaded)
    x.onabort = () => reject(new Stopped())
    x.onerror = () => reject(new ApiError(0, 'network_error'))
    x.onload = () => {
      let j: any = null
      try { j = JSON.parse(x.responseText) } catch { /* */ }
      if (x.status === 200) return resolve(j.received)
      // the server has a different amount than we thought (retry after a dropped connection): continue from there
      if (x.status === 409 && j?.detail?.code === 'offset_mismatch') return resolve(j.detail.received)
      reject(new ApiError(x.status, typeof j?.detail === 'string' ? j.detail : x.statusText))
    }
    setXhr(x)
    x.send(blob)
  })
}

async function ensureFolder(root: number | null, path: string[]): Promise<number | null> {
  if (!path.length) return root
  const known = await api<Folder[]>('/api/folders')
  let cur = root
  for (const name of path) {
    const hit = known.find((f) => f.parent_id === cur && f.name === name)
    if (hit) { cur = hit.id; continue }
    const r = await api('/api/folders', { body: { name, parent_id: cur } })
    known.push({ id: r.id, parent_id: cur, name } as Folder)
    cur = r.id
  }
  return cur
}

export function UploadsProvider({ children }: { children: React.ReactNode }) {
  const { reload, toast } = useStore()
  const { t } = useT()
  const tasks = useRef<UpTask[]>([])
  const xhrs = useRef(new Map<string, XMLHttpRequest | null>())
  const [, setTick] = useState(0)
  const frame = useRef(0)
  // progress events are frequent: re-render at most once per animation frame
  const render = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => { frame.current = 0; setTick((n) => n + 1) })
  }, [])
  const find = (id: string) => tasks.current.find((x) => x.id === id)
  const remove = (id: string) => { tasks.current = tasks.current.filter((x) => x.id !== id); xhrs.current.delete(id); render() }

  const run = useCallback(async (task: UpTask) => {
    task.state = 'uploading'; task.error = undefined; render()
    xhrs.current.set(task.id, null)
    const stopped = () => task.state !== 'uploading'
    try {
      for (let i = 0; i < task.files.length; i++) {
        const f = task.files[i]
        if (!task.sessions[i]) {
          const s = await api('/api/uploads', { body: { filename: f.name, size: f.size } })
          task.sessions[i] = s.id
          task.done[i] = 0
          // cancelled while the session was being created: cancel() did not know this id yet
          if (!tasks.current.includes(task)) { api(`/api/uploads/${s.id}`, { method: 'DELETE' }).catch(() => {}); throw new Stopped() }
        } else {
          const s = await api(`/api/uploads/${task.sessions[i]}`)  // resume: how much did the server keep?
          task.done[i] = s.received
        }
        while (task.done[i] < f.size) {
          if (stopped()) throw new Stopped()
          const base = task.done.reduce((a, b) => a + b, 0)
          const start = task.done[i]
          task.done[i] = await putChunk(`/api/uploads/${task.sessions[i]}?offset=${start}`, f.slice(start, start + CHUNK),
            (n) => { task.sent = base + n; render() }, (x) => xhrs.current.set(task.id, x))
          task.sent = task.done.reduce((a, b) => a + b, 0); render()
        }
      }
      if (stopped()) throw new Stopped()
      task.state = 'saving'; render()
      const folder = await ensureFolder(task.folder, task.path)
      const fd = new FormData()
      fd.append('meta', JSON.stringify({ platform: 'upload', folder_id: folder, tag_ids: task.tagIds, combine: task.combine,
        priority: task.low ? 'low' : 'high' }))
      fd.append('upload_ids', JSON.stringify(task.sessions))
      const r = await api('/api/ingest', { form: fd })
      if (r.duplicates?.length && !r.document_ids?.length) toast(`${t('duplicates')}: ${task.name}`)
      remove(task.id)
      reload(); window.dispatchEvent(new Event('soroka:reload'))
    } catch (e: any) {
      if (e instanceof Stopped) return  // paused or cancelled: state already set by pause()/cancel()
      if (task.state === 'uploading' || task.state === 'saving') {
        task.state = 'error'; task.error = e?.detail || String(e); render()
      }
    } finally {
      xhrs.current.set(task.id, null)
      pump()
    }
  }, [render, reload, toast, t])

  const pump = useCallback(() => {
    let active = tasks.current.filter((x) => x.state === 'uploading' || x.state === 'saving').length
    for (const task of tasks.current) {
      if (active >= PARALLEL) break
      if (task.state === 'queued') { active++; run(task) }
    }
  }, [run])

  const add = useCallback((list: NewUpload[]) => {
    for (const u of list) {
      tasks.current.push({
        ...u, id: Math.random().toString(36).slice(2), state: 'queued', sent: 0,
        name: u.files.length === 1 ? u.files[0].name : `${u.files[0].name} +${u.files.length - 1}`,
        size: u.files.reduce((a, f) => a + f.size, 0), sessions: u.files.map(() => null), done: u.files.map(() => 0),
      })
    }
    render(); pump()
  }, [render, pump])

  const pause = useCallback((ids: string[]) => {
    for (const id of ids) {
      const task = find(id)
      if (!task || !(task.state === 'queued' || task.state === 'uploading')) continue  // 'saving' cannot be paused
      task.state = 'paused'
      xhrs.current.get(id)?.abort()
    }
    render(); pump()
  }, [render, pump])

  const resume = useCallback((ids: string[]) => {
    for (const id of ids) { const task = find(id); if (task && (task.state === 'paused' || task.state === 'error')) task.state = 'queued' }
    render(); pump()
  }, [render, pump])

  const cancel = useCallback(async (ids: string[]) => {
    const gone = ids.map(find).filter((x): x is UpTask => !!x && x.state !== 'saving')
    for (const task of gone) { task.state = 'paused'; xhrs.current.get(task.id)?.abort(); remove(task.id) }
    pump()
    // discard what the server already received (best effort; the scheduler removes leftovers after 48 h)
    await Promise.all(gone.flatMap((task) => task.sessions.filter(Boolean).map((s) =>
      api(`/api/uploads/${s}`, { method: 'DELETE' }).catch(() => {}))))
  }, [pump])

  // closing or reloading the tab loses the files (the browser does not keep them): warn while uploads are open
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (tasks.current.length) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  // task objects are mutated in place; every progress tick re-renders this provider with a fresh array
  const value: Ctx = { tasks: [...tasks.current], add, pause, resume, cancel }
  return <UploadsCtx.Provider value={value}>{children}</UploadsCtx.Provider>
}

export const fmtMB = (b: number) => (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)
