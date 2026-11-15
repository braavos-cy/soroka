import { useRef, useState } from 'react'
import { plural, useT } from '../i18n'
import { FolderSelect, TagAdder, TagChips } from './Pickers'
import { Modal } from './Reauth'
import { NewUpload, useUploads } from './uploads'
import { Camera, FilePlus, FolderUp, UploadCloud, X } from 'lucide-react'

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
  const { t, lang } = useT()
  const uploads = useUploads()
  const [items, setItems] = useState<Item[]>([])
  const [folder, setFolder] = useState<number | null>(folderId ?? null)
  const [tagIds, setTagIds] = useState<number[]>([])
  const [combine, setCombine] = useState(false)
  const [low, setLow] = useState(false)
  const [over, setOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)

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

  // uploads run in the background and show as cards in the document list (pause / resume / cancel there)
  const submit = () => {
    const groups = new Map<string, Item[]>()
    items.forEach((it) => { const k = it.path.join('/'); groups.set(k, [...(groups.get(k) || []), it]) })
    const list: NewUpload[] = []
    for (const group of groups.values()) {
      const base = { path: group[0].path, folder, tagIds, combine, low }
      if (combine) list.push({ ...base, files: group.map((it) => it.file) })
      else group.forEach((it) => list.push({ ...base, files: [it.file] }))
    }
    uploads.add(list)
    onClose()
  }

  return (
    <Modal onClose={onClose}>
      <h2>{t('upload_title')}</h2>
      <div className={'dropzone' + (over ? ' over' : '')} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        {/* drag & drop and folders only where there is a mouse; phones get the camera instead */}
        <div className="hover-only"><UploadCloud size={28} className="dz-icon" /><div>{t('drop_here')}</div></div>
        <div className="row dz-buttons">
          <button type="button" onClick={() => fileRef.current?.click()}><FilePlus size={15} /> {t('choose_files_btn')}</button>
          <button type="button" className="touch-only" onClick={() => camRef.current?.click()}><Camera size={15} /> {t('take_photo')}</button>
          <button type="button" className="hover-only" onClick={() => dirRef.current?.click()}><FolderUp size={15} /> {t('choose_folder_btn')}</button>
        </div>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        <input ref={dirRef} type="file" multiple hidden {...({ webkitdirectory: '' } as any)} onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        {items.length > 0 && <div className="dz-count">{plural(t, lang, items.length, 'pl_files')} <button className="link" title={t('clear_selection')} onClick={() => setItems([])}><X size={14} /></button></div>}
      </div>
      <label>{t('target_folder')}</label>
      <FolderSelect value={folder} allowEmpty onChange={setFolder} />
      <label>{t('tags')}</label>
      <div className="row" style={{ gap: 6 }}><TagChips ids={tagIds} onRemove={(id) => setTagIds(tagIds.filter((x) => x !== id))} /><TagAdder exclude={tagIds} onAdd={(id) => setTagIds([...tagIds, id])} /></div>
      <div className="col" style={{ marginTop: 12 }}>
        <label className="inline"><input type="radio" checked={!combine} onChange={() => setCombine(false)} />{t('one_doc_per_file')}</label>
        <label className="inline"><input type="radio" checked={combine} onChange={() => setCombine(true)} />{t('one_doc_all')}</label>
        <label className="inline"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} />{t('bulk_low_priority')}</label>
      </div>
      <div className="row dlg-actions">
        <span className="spacer" />
        <button onClick={onClose}>{t('cancel')}</button>
        <button className="primary" onClick={submit} disabled={!items.length}>{t('upload')}</button>
      </div>
    </Modal>
  )
}
