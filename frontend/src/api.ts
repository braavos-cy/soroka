export class ApiError extends Error {
  constructor(public status: number, public detail: string) { super(detail) }
}

type Opts = { method?: string; body?: any; form?: FormData; raw?: boolean; noReauth?: boolean }

// The reauth modal registers itself here; sensitive actions retry after a successful re-auth.
let reauthHandler: (() => Promise<boolean>) | null = null
export function setReauthHandler(h: () => Promise<boolean>) { reauthHandler = h }
let unauthHandler: (() => void) | null = null
export function setUnauthHandler(h: () => void) { unauthHandler = h }

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'soroka' }
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body) }
  const r = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin' })
  if (!r.ok) {
    let detail = r.statusText
    try { const j = await r.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail) } catch { /* */ }
    if (r.status === 403 && detail === 'reauth_required' && !opts.noReauth && reauthHandler) {
      if (await reauthHandler()) return api(path, { ...opts, noReauth: true })
    }
    if (r.status === 401 && (detail === 'not_authenticated' || detail === 'mfa_required') && unauthHandler) unauthHandler()
    throw new ApiError(r.status, detail)
  }
  if (opts.raw) return r as any
  const ct = r.headers.get('content-type') || ''
  return (ct.includes('json') ? r.json() : r.text()) as Promise<T>
}

export async function downloadPost(path: string, body: any, filename: string) {
  const r: Response = await api(path, { body, raw: true })
  const blob = await r.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export type Folder = { id: number; parent_id: number | null; name: string; is_system: boolean; count: number }
export type Tag = { id: number; name: string; color: string; count: number }
export type User = { id: number; email: string; name: string; role: string; totp_enabled: boolean; ui_lang: string; include_subfolders?: boolean; must_change_password: boolean; is_active: boolean; last_login_at?: string; created_at?: string }
export type DocSummary = {
  id: number; title: string; folder_id: number; status: string; tier: string | null; needs_review: boolean
  page_count: number; received_at: string; updated_at: string; source: string; file_type: string
  language: string; tags: number[]; trashed_at: string | null; first_page_id: number | null; thumb_v: string | null; snippet: string | null; hits?: { where: 'title' | 'context' | 'text'; text: string; page?: number | null; field?: string }[]
  sender: string; chat: string
}
