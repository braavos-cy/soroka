// Crop choices offered to the user: the automatic crop (detector result after trimming leftover background)
// followed by the best few *distinct* detector outlines. The raw candidate list has up to ~10 entries, several from
// the same detector and many nearly identical, labelled with internal method names.
export type Pt = [number, number]

export interface CropOption {
  key: string
  quad: Pt[]
  auto: boolean
  score?: number
  method?: string
  n?: number  // 1-based number among the non-automatic options
}

const isQuad = (q: any): q is Pt[] => Array.isArray(q) && q.length === 4 && q.every((p) => Array.isArray(p) && p.length === 2)

function similar(a: Pt[], b: Pt[], tol: number): boolean {
  return a.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) < tol)
}

function isFullFrame(q: Pt[], W: number, H: number, tol: number): boolean {
  return similar(q, [[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], tol)
}

export function cropOptions(stages: any, W: number, H: number, maxOthers = 3): CropOption[] {
  const tol = 0.03 * Math.hypot(W, H)
  const out: CropOption[] = []
  const auto = stages?.crop?.auto
  if (isQuad(auto)) out.push({ key: 'auto', quad: auto, auto: true })
  const cands: any[] = [...(stages?.crop?.info?.candidates || [])]
    .filter((c) => isQuad(c.quad))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  let n = 0
  for (const c of cands) {
    if (n >= maxOthers) break
    // the whole image has its own button; near-duplicates of an option already shown add nothing
    if (c.method === 'full_frame' || isFullFrame(c.quad, W, H, tol)) continue
    if (out.some((o) => similar(o.quad, c.quad, tol))) continue
    out.push({ key: `c${n}`, quad: c.quad, auto: false, score: c.score, method: c.method, n: n + 1 })
    n++
  }
  return out
}

export const CROP_COLORS = ['#2f6fed', '#f59e0b', '#10b981', '#ec4899']

export function cropLabel(o: CropOption, t: (k: string) => string): string {
  if (o.auto) return t('crop_auto')
  const pct = o.score != null ? ` · ${Math.round(o.score * 100)}%` : ''
  return `${t('crop_option')} ${o.n}${pct}`
}
