import { useRef, useState } from 'react'
import { api, Folder } from '../api'
import { useT } from '../i18n'
import { useStore } from '../store'
import { FolderSelect, TagAdder, TagChips } from './Pickers'
import { Modal } from './Reauth'

type Item = { file: File; path: string[] } // path = sub-folders (from folder uploads / drag & drop)

async function readEntry(entry: any, path: string[], out: Item[]): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej))
    out.push({ file, path })
  } else if (entry.isDirectory) {
    const reader = entry.createReader()
    let batch: any[]
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej))
      for (const e of batch) await readEntry(e, [...path, entry.name], out)
    } while (batch.length)
  }
}

export default function UploadModal({ folderId, onClose }: { folderId: number | null; onClose: () => void }) {
  const { t } = useT()
  const { folders, reload, toast } = useStore()
  const [items, setItems] = useState<Item[]>([])
  const [folder, setFolder] = useState<number | null>(folderId ?? folders.find((f) => f.is_system)?.id ?? null)
  const [tagIds, setTagIds] = useState<number[]>([])
  const [combine, setCombine] = useState(false)
  const [low, setLow] = useState(false)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)

  const addFiles = (list: FileList | null) => {
    if (!list) return
    const arr: Item[] = []
    for (const f of Array.from(list)) {
      const rel = (f as any).webkitRelativePath as string
      arr.push({ file: f, path: rel ? rel.split('/').slice(0, -1) : [] })
    }
    setItems((x) => [...x, ...arr])
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setOver(false)
    const out: Item[] = []
    const entries = Array.from(e.dataTransfer.items).map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean)
    if (entries.length) { for (const en of entries) await readEntry(en, [], out) } else addFiles(e.dataTransfer.files)
    setItems((x) => [...x, ...out])
  }

  const ensureFolder = async (root: number | null, path: string[], cache: Map<string, number>, known: Folder[]): Promise<number | null> => {
    let cur = root
    for (let i = 0; i < path.length; i++) {
      const key = path.slice(0, i + 1).join('/')
      if (cache.has(key)) { cur = cache.get(key)!; continue }
      const existing = known.find((f) => f.parent_id === cur && f.name === path[i])
      if (existing) cur = existing.id
      else {
        const parent = cur
        const r = await api('/api/folders', { body: { name: path[i], parent_id: parent } })
        known.push({ id: r.id, parent_id: parent, name: path[i] } as any)
        cur = r.id
      }
      cache.set(key, cur!)
    }
    return cur
  }

  const submit = async () => {
    setBusy(true)
    let docs = 0, dups = 0
    try {
      const groups = new Map<string, Item[]>()
      items.forEach((it) => { const k = it.path.join('/'); groups.set(k, [...(groups.get(k) || []), it]) })
      const cache = new Map<string, number>()
      const known = [...folders]
      let n = 0
      for (const [k, group] of groups) {
        const target = await ensureFolder(folder, k ? k.split('/') : [], cache, known)
        // send in chunks to keep requests reasonable
        const chunk = combine ? group.length : 20
        for (let i = 0; i < group.length; i += chunk) {
          const part = group.slice(i, i + chunk)
          const fd = new FormData()
          part.forEach((it) => fd.append('files', it.file, it.file.name))
          fd.append('meta', JSON.stringify({ platform: 'upload', folder_id: target, tag_ids: tagIds, combine, priority: low ? 'low' : 'high' }))
          const r = await api('/api/ingest', { form: fd })
          docs += r.document_ids.length; dups += r.duplicates.length
          n += part.length
          setProgress(`${n} / ${items.length}`)
        }
      }
      toast(`${t('uploaded')}: ${docs}${dups ? ` (${t('duplicates')}: ${dups})` : ''}`)
      reload(); window.dispatchEvent(new Event('soroka:reload'))
      onClose()
    } catch (e: any) { toast(e.detail) } finally { setBusy(false) }
  }

  return (
    <Modal onClose={() => !busy && onClose()}>
      <h2>{t('upload_title')}</h2>
      <div className={'dropzone' + (over ? ' over' : '')} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        {t('drop_here')} <button className="link" onClick={() => fileRef.current?.click()}>{t('choose_files')}</button> / <button className="link" onClick={() => dirRef.current?.click()}>{t('choose_folder')}</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        <input ref={dirRef} type="file" multiple hidden {...({ webkitdirectory: '' } as any)} onChange={(e) => addFiles(e.target.files)} />
        {items.length > 0 && <div style={{ marginTop: 10, color: 'var(--text)' }}>{items.length} {t('files')} <button className="link" onClick={() => setItems([])}>×</button></div>}
      </div>
      <label>{t('target_folder')}</label>
      <FolderSelect value={folder} onChange={setFolder} />
      <label>{t('tags')}</label>
      <div className="row"><TagChips ids={tagIds} onRemove={(id) => setTagIds(tagIds.filter((x) => x !== id))} /><TagAdder exclude={tagIds} onAdd={(id) => setTagIds([...tagIds, id])} /></div>
      <div className="col" style={{ marginTop: 12 }}>
        <label className="inline"><input type="radio" checked={!combine} onChange={() => setCombine(false)} />{t('one_doc_per_file')}</label>
        <label className="inline"><input type="radio" checked={combine} onChange={() => setCombine(true)} />{t('one_doc_all')}</label>
        <label className="inline"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} />{t('bulk_low_priority')}</label>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        {busy && <span className="muted">{t('uploading')} {progress}</span>}
        <span className="spacer" />
        <button onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button className="primary" onClick={submit} disabled={busy || !items.length}>{t('upload')}</button>
      </div>
    </Modal>
  )
}
