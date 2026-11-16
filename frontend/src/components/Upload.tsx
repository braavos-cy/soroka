import { useEffect, useRef, useState } from 'react'
import { plural, useT } from '../i18n'
import { FolderSelect, TagAdder, TagChips } from './Pickers'
import { Modal } from './Reauth'
import { NewUpload, useUploads } from './uploads'
import { Camera, FilePlus, FolderUp, UploadCloud, X } from 'lucide-react'

export type Item = { file: File; path: string[] } // path = sub-folders (from folder uploads / drag & drop)

// What can be uploaded; the server checks the same (backend/soroka/formats.py: ACCEPT_EXT, MAX_FILE_SIZE)
export const ACCEPT_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.avif', '.pdf',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.rtf', '.txt', '.csv', '.zip']
export const MAX_FILE_MB = 100
const ACCEPT_ATTR = ACCEPT_EXT.join(',') // narrows the file picker; dropped files are checked below
const extOf = (name: string) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase() }

// The same types as MIME types, for judging a drag while it is still in the air: then the browser shows only
// each item's type (no names, no sizes). An empty type (folders, some HEIC / unusual files) counts as acceptable.
const ACCEPT_MIME = /^(image\/(jpeg|png|heic|heif|webp|tiff|bmp|gif|avif)|application\/(pdf|rtf|zip|x-zip-compressed|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\..+|vnd\.oasis\.opendocument\.(text|spreadsheet|presentation))|text\/(plain|csv|rtf))$/i
/** While files are dragged over a drop area: 'ok' (all can be uploaded, as far as the types tell), 'some' (some
 *  cannot) or 'none' (none can). Sizes are only known after the drop. */
export function dragVerdict(dt: DataTransfer): 'ok' | 'some' | 'none' {
  const types = Array.from(dt.items).filter((i) => i.kind === 'file').map((i) => i.type)
  const bad = types.filter((tp) => tp && !ACCEPT_MIME.test(tp)).length
  return bad === 0 ? 'ok' : bad === types.length ? 'none' : 'some'
}

export type Skipped ={ name: string; reason: 'unsupported' | 'too_large' }
/** Splits files into those that can be uploaded and those that cannot (type not supported, over the size limit).
 *  Hidden files from folder uploads (.DS_Store and the like) are dropped without a word. */
export function checkItems(items: Item[]): { ok: Item[]; skipped: Skipped[] } {
  const ok: Item[] = [], skipped: Skipped[] = []
  for (const it of items) {
    const n = it.file.name
    if (n.startsWith('.')) continue
    if (!ACCEPT_EXT.includes(extOf(n))) skipped.push({ name: n, reason: 'unsupported' })
    else if (it.file.size > MAX_FILE_MB * 1024 * 1024) skipped.push({ name: n, reason: 'too_large' })
    else ok.push(it)
  }
  return { ok, skipped }
}
/** One line per reason, naming the first few files: "Not supported (type): a.mp4, b.exe +3". */
export function skippedMessage(t: (k: string) => string, skipped: Skipped[]): string {
  return (['unsupported', 'too_large'] as const).map((r) => {
    const names = skipped.filter((s) => s.reason === r).map((s) => s.name)
    if (!names.length) return ''
    return `${t(r === 'unsupported' ? 'skipped_unsupported' : 'skipped_too_large')}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`
  }).filter(Boolean).join(' · ')
}

/** Files (and folders, with their sub-folder paths) dropped from the computer. */
export async function itemsFromDrop(dt: DataTransfer): Promise<Item[]> {
  // the entries must be taken before the first await: the browser empties the drop data after the event
  const entries = Array.from(dt.items).map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean)
  const files = Array.from(dt.files)
  if (!entries.length) return files.map((file) => ({ file, path: [] }))
  const out: Item[] = []
  for (const en of entries) await readEntry(en, [], out)
  return out
}

/** One upload per file, or with `combine` one per sub-folder holding all its files. */
export function toUploads(items: Item[], o: { folder: number | null; tagIds: number[]; combine: boolean; low: boolean }): NewUpload[] {
  const groups = new Map<string, Item[]>()
  items.forEach((it) => { const k = it.path.join('/'); groups.set(k, [...(groups.get(k) || []), it]) })
  const list: NewUpload[] = []
  for (const group of groups.values()) {
    const base = { ...o, path: group[0].path }
    if (o.combine) list.push({ ...base, files: group.map((it) => it.file) })
    else group.forEach((it) => list.push({ ...base, files: [it.file] }))
  }
  return list
}

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
  const [over, setOver] = useState<false | 'ok' | 'some' | 'none'>(false)
  // a refused drop (unsupported files) leaves no drop event: the first mouse move after the drag clears the state
  useEffect(() => {
    if (!over) return
    const reset = () => setOver(false)
    document.addEventListener('mousemove', reset)
    return () => document.removeEventListener('mousemove', reset)
  }, [over])
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  // files left out of what was picked / dropped, shown under the drop area until the next pick
  const [skipped, setSkipped] = useState<Skipped[]>([])
  const take = (arr: Item[]) => {
    const r = checkItems(arr)
    setSkipped(r.skipped)
    setItems((x) => [...x, ...r.ok])
  }

  const addFiles = (list: FileList | null) => {
    if (!list) return
    const arr: Item[] = []
    for (const f of Array.from(list)) {
      const rel = (f as any).webkitRelativePath as string
      arr.push({ file: f, path: rel ? rel.split('/').slice(0, -1) : [] })
    }
    take(arr)
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setOver(false)
    take(await itemsFromDrop(e.dataTransfer))
  }

  // uploads run in the background and show as cards in the document list (pause / resume / cancel there)
  const submit = () => {
    uploads.add(toUploads(items, { folder, tagIds, combine, low }))
    onClose()
  }

  return (
    <Modal onClose={onClose}>
      <h2>{t('upload_title')}</h2>
      <div className={'dropzone' + (over === 'none' ? ' bad' : over ? ' over' : '')}
        onDragOver={(e) => {
          e.preventDefault()
          const v = dragVerdict(e.dataTransfer)
          e.dataTransfer.dropEffect = v === 'none' ? 'none' : 'copy'
          setOver(v)
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }} onDrop={onDrop}>
        {over === 'none' && <div className="dz-bad">{t('drag_not_supported')}</div>}
        {over === 'some' && <div className="small file-drop-warn">{t('drag_some_not_supported')}</div>}
        {/* drag & drop and folders only where there is a mouse; phones get the camera instead */}
        <div className="hover-only"><UploadCloud size={28} className="dz-icon" /><div>{t('drop_here')}</div></div>
        <div className="row dz-buttons">
          <button type="button" onClick={() => fileRef.current?.click()}><FilePlus size={15} /> {t('choose_files_btn')}</button>
          <button type="button" className="touch-only" onClick={() => camRef.current?.click()}><Camera size={15} /> {t('take_photo')}</button>
          <button type="button" className="hover-only" onClick={() => dirRef.current?.click()}><FolderUp size={15} /> {t('choose_folder_btn')}</button>
        </div>
        <input ref={fileRef} type="file" multiple hidden accept={ACCEPT_ATTR} onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        <input ref={dirRef} type="file" multiple hidden {...({ webkitdirectory: '' } as any)} onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        {items.length > 0 && <div className="dz-count">{plural(t, lang, items.length, 'pl_files')} <button className="link" title={t('clear_selection')} onClick={() => setItems([])}><X size={14} /></button></div>}
        {skipped.length > 0 && <div className="dz-skipped small">{skippedMessage(t, skipped)}</div>}
        <div className="small muted dz-limits">{t('upload_limits')}</div>
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
