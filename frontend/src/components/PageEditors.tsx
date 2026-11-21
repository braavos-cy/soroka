// Manual editors for a page's crop (page outline or 4 corners) and its flattening mesh.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { CROP_COLORS, cropLabel, cropOptions } from './cropOptions'
import { Maximize, RotateCcw } from 'lucide-react'

export type Pt = [number, number]
type Mag = { x: number; y: number; px: number; py: number } | null
/** Called with the dragged item and the pointer in image pixels; returns where the magnifier goes (or null: none). */
type DragMove = (i: number, p: Pt) => Pt | null

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Shared pointer handling: drag item i, with a magnifier, in image pixel coordinates.
 *  Pointer moves are coalesced to one `onMove` per animation frame (mice can report up to 1000/s), and the svg's
 *  screen rectangle is measured once when the drag starts instead of on every move. */
function useDrag(svgRef: React.RefObject<SVGSVGElement>, W: number, H: number, onMove: DragMove) {
  const [drag, setDrag] = useState<number | null>(null)
  const [mag, setMag] = useState<Mag>(null)
  const s = useRef({ drag: null as number | null, rect: null as DOMRect | null, cx: 0, cy: 0, pending: false, raf: 0 })
  const cur = useRef({ W, H, onMove })
  cur.current = { W, H, onMove }
  const toImg = useCallback((cx: number, cy: number): Pt => {
    const r = s.current.rect!, { W, H } = cur.current
    return [clamp(((cx - r.left) / r.width) * W, 0, W - 1), clamp(((cy - r.top) / r.height) * H, 0, H - 1)]
  }, [])
  const flush = useCallback(() => {
    const st = s.current
    st.raf = 0
    if (!st.pending || st.drag == null || !st.rect) return
    st.pending = false
    const at = cur.current.onMove(st.drag, toImg(st.cx, st.cy))
    // the magnifier sits next to the dragged point itself, not the cursor
    const { W, H } = cur.current, r = st.rect
    setMag(at && { x: at[0], y: at[1], px: r.left + (at[0] / W) * r.width, py: r.top + (at[1] / H) * r.height })
  }, [toImg])
  /** Start dragging item i (from its pointerdown); returns the pointer in image pixels. */
  const start = useCallback((i: number, e: React.PointerEvent): Pt => {
    (e.target as Element).setPointerCapture(e.pointerId)
    const st = s.current
    st.rect = svgRef.current!.getBoundingClientRect()
    st.drag = i
    st.pending = false
    setDrag(i)
    return toImg(e.clientX, e.clientY)
  }, [svgRef, toImg])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const st = s.current
    if (st.drag == null) return
    st.cx = e.clientX; st.cy = e.clientY; st.pending = true
    if (!st.raf) st.raf = requestAnimationFrame(flush)
  }, [flush])
  const end = useCallback(() => {
    const st = s.current
    if (st.drag == null) return
    if (st.raf) cancelAnimationFrame(st.raf)
    flush() // the last position still counts
    st.drag = null; st.rect = null
    setDrag(null); setMag(null)
  }, [flush])
  useEffect(() => () => cancelAnimationFrame(s.current.raf), [])
  // screen pixels per image pixel, kept current as the image loads and the window resizes
  // (reading it during render gave 1 on the first render, before the svg existed: tiny handles)
  const [scale, setScale] = useState(1)
  const observed = useRef<{ el: Element; W: number; ro: ResizeObserver } | null>(null)
  useLayoutEffect(() => { // every render: the svg may appear later (mesh editor waits for the image)
    const el = svgRef.current
    if (observed.current?.el === el && observed.current?.W === W) return
    observed.current?.ro.disconnect()
    observed.current = null
    if (!el) return
    const measure = () => { const w = el.getBoundingClientRect().width; if (w > 0) setScale(w / W) }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    observed.current = { el, W, ro }
    measure()
  })
  useEffect(() => () => observed.current?.ro.disconnect(), [])
  const svgProps = { onPointerMove, onPointerUp: end, onPointerLeave: end }
  return { drag, mag, start, svgProps, scale }
}

// handle geometry, in screen pixels
const HANDLE_STROKE = 1.5
const CORNER_R = 5 // corner dot radius (4 corners mode)
const BAR_LEN = 16, BAR_THICK = 6 // edge-midpoint bar
const HANDLE_GAP = 10 // minimum free space between a corner dot and the bar on its edge
/** Shortest edge (screen px) that fits corner dot, gap, bar, gap, corner dot without them touching. */
const MIN_EDGE = 2 * (CORNER_R + HANDLE_STROKE / 2 + HANDLE_GAP + BAR_LEN / 2 + HANDLE_STROKE / 2)

const HANDLE_SHADOW = { filter: 'drop-shadow(0 0 1px rgba(0,0,0,.45))' }
type DragStart = (i: number, e: React.PointerEvent) => void

/** Draggable point i: a small visible dot centred exactly on the point, with a larger invisible area to grab it by
 *  (sizes in screen pixels). At the image border half of it sticks out past the picture (the svg has overflow: visible).
 *  Memoized: while dragging, only the moved point redraws. */
const Handle = memo(function Handle({ i, x, y, r, scale, onDown, onDoubleClick }: {
  i: number; x: number; y: number; r: number; scale: number; onDown: DragStart; onDoubleClick?: (i: number) => void
}) {
  return (
    <g style={{ cursor: 'grab' }} onPointerDown={(e) => onDown(i, e)} onDoubleClick={onDoubleClick && (() => onDoubleClick(i))}>
      <circle cx={x} cy={y} r={Math.max(r + 8, 12) / scale} fill="transparent" />
      <circle cx={x} cy={y} r={r / scale} fill="#fff" stroke="#2f6fed" strokeWidth={HANDLE_STROKE / scale} style={HANDLE_SHADOW} />
    </g>
  )
})

/** Draggable edge i: a small bar lying along the edge from a to b (sizes in screen pixels). */
const EdgeHandle = memo(function EdgeHandle({ i, ax, ay, bx, by, scale, onDown }: {
  i: number; ax: number; ay: number; bx: number; by: number; scale: number; onDown: DragStart
}) {
  const x = (ax + bx) / 2, y = (ay + by) / 2
  const deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI
  const bar = (w: number, h: number) => ({ x: x - w / 2 / scale, y: y - h / 2 / scale, width: w / scale, height: h / scale })
  return (
    <g transform={`rotate(${deg} ${x} ${y})`} style={{ cursor: 'grab' }} onPointerDown={(e) => onDown(i, e)}>
      <rect {...bar(32, 20)} fill="transparent" />
      <rect {...bar(BAR_LEN, BAR_THICK)} rx={1.5 / scale} fill="#fff" stroke="#2f6fed" strokeWidth={HANDLE_STROKE / scale} style={HANDLE_SHADOW} />
    </g>
  )
})

function Magnifier({ mag, src, W, H, scale }: { mag: Mag; src: string; W: number; H: number; scale: number }) {
  if (!mag) return null
  const zoom = 3, size = 140, gap = 20
  // viewport coordinates (position: fixed) so the scrolling stage can't clip it; flips to the other side of the cursor near an edge
  const left = mag.px + gap + size > window.innerWidth ? mag.px - gap - size : mag.px + gap
  const top = mag.py - gap - size < 0 ? mag.py + gap : mag.py - gap - size
  return (
    <div className="magnifier" style={{
      left: Math.max(0, left), top: Math.max(0, Math.min(window.innerHeight - size, top)), backgroundImage: `url(${src})`,
      backgroundSize: `${W * scale * zoom}px ${H * scale * zoom}px`,
      backgroundPosition: `${-(mag.x * scale * zoom - 70)}px ${-(mag.y * scale * zoom - 70)}px`,
    }}><svg viewBox="0 0 140 140" style={{ width: 140, height: 140 }}><path d="M70 55V85M55 70H85" stroke="#dc2626" strokeWidth="1.5" /></svg></div>
  )
}

type Limits = { minGap: number; minEdge: number }

/** A polygon is strictly convex (and so not self-intersecting, for 4 points) when every turn goes the same way.
 *  Each corner must also stay at least `minGap` from the line through its two neighbours, so it can't be squashed flat,
 *  and every edge must be at least `minEdge` long, so its handles don't run into each other. */
function isConvex(pts: Pt[], { minGap, minEdge }: Limits = { minGap: 0, minEdge: 0 }): boolean {
  const n = pts.length
  let sign = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n]
    const abx = b[0] - a[0], aby = b[1] - a[1]
    if (abx * abx + aby * aby < minEdge * minEdge) return false
    const cross = abx * (c[1] - b[1]) - aby * (c[0] - b[0])
    if (cross === 0) return false
    if (Math.abs(cross) < minGap * Math.hypot(c[0] - a[0], c[1] - a[1])) return false // distance from b to line ac
    const sg = cross > 0 ? 1 : -1
    if (sign && sg !== sign) return false
    sign = sg
  }
  return true
}

/** Move corner i of a convex quad towards `to`, stopping at the last point on the way that keeps it convex. */
function convexLimit(quad: Pt[], i: number, to: Pt, lim: Limits): Pt {
  const at = (t: number): Pt => [quad[i][0] + (to[0] - quad[i][0]) * t, quad[i][1] + (to[1] - quad[i][1]) * t]
  const ok = (p: Pt) => isConvex(quad.map((q, k) => (k === i ? p : q)), lim)
  if (ok(to)) return to
  if (!ok(quad[i])) return to // already not convex (e.g. a legacy crop): don't trap the corner
  let lo = 0, hi = 1
  for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (ok(at(m))) lo = m; else hi = m }
  return at(lo)
}

/** Move edge i (corners i and i+1) of a quad, keeping its length and angle, so its midpoint goes to `to`, as far as
 *  it can go while both corners stay inside the W×H image and the quad stays convex. */
function moveEdge(quad: Pt[], i: number, to: Pt, W: number, H: number, lim: Limits): Pt[] {
  const j = (i + 1) % quad.length, a = quad[i], b = quad[j]
  // per axis, so pushing into the image border still lets the edge slide along it
  const dx = clamp(to[0] - (a[0] + b[0]) / 2, -Math.min(a[0], b[0]), W - 1 - Math.max(a[0], b[0]))
  const dy = clamp(to[1] - (a[1] + b[1]) / 2, -Math.min(a[1], b[1]), H - 1 - Math.max(a[1], b[1]))
  const at = (t: number) => quad.map((q, k) => (k === i || k === j ? [q[0] + dx * t, q[1] + dy * t] : q)) as Pt[]
  const ok = (qs: Pt[]) => isConvex(qs, lim)
  if (ok(at(1))) return at(1)
  if (!ok(quad)) return quad
  let lo = 0, hi = 1
  for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (ok(at(m))) lo = m; else hi = m }
  return at(lo)
}

// ---------------------------------------------------------------- crop: page outline or 4 corners
export function CropEditor({ page, onApply, onCancel }: { page: any; onApply: (v: any) => void; onCancel: () => void }) {
  const { t } = useT()
  const W = page.width, H = page.height
  const crop = page.recipe.crop
  const full: Pt[] = [[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]]
  const initialQuad: Pt[] = crop.quad || full
  // outline or 4 corners: follows the crop type chosen in the pipeline panel
  const [mode] = useState<'mask' | 'quad'>(crop.mode === 'mask' || (crop.mode !== 'quad' && crop.polygon) ? 'mask' : 'quad')
  // one list of points: the outline (mask) or the 4 corners (quad); the mode never changes while the editor is open
  const [pts, setPtsState] = useState<Pt[]>(() => (mode === 'mask' ? crop.polygon || initialQuad : initialQuad))
  // the latest points, for the per-frame drag callback (it can run before React re-renders with the new state)
  const ptsRef = useRef(pts)
  const setPts = useCallback((next: Pt[]) => { ptsRef.current = next; setPtsState(next) }, [])
  const svgRef = useRef<SVGSVGElement>(null)
  // dragging the inside of the shape moves all of it (drag = BODY): where it was grabbed, the points then and their bounds
  const BODY = -1
  const grab = useRef<{ at: Pt; pts: Pt[]; x0: number; x1: number; y0: number; y1: number } | null>(null)
  // drag = corner index, 4 + edge index (quad: edge-midpoint bar), or BODY
  const onMove: DragMove = (i, p) => {
    const cur = ptsRef.current
    if (i === BODY) {
      const g = grab.current!
      // per axis, so the shape stays whole inside the picture and slides along its border
      const dx = clamp(p[0] - g.at[0], -g.x0, W - 1 - g.x1), dy = clamp(p[1] - g.at[1], -g.y0, H - 1 - g.y1)
      setPts(g.pts.map((q) => [q[0] + dx, q[1] + dy]))
      return null
    }
    const lim: Limits = { minGap: 0.03 * Math.min(W, H), minEdge: MIN_EDGE / d.scale }
    if (mode === 'quad' && i >= 4) {
      const e = i - 4, q = moveEdge(cur, e, p, W, H, lim), a = q[e], b = q[(e + 1) % 4]
      setPts(q)
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    }
    const to = mode === 'quad' ? convexLimit(cur, i, p, lim) : p
    setPts(cur.map((q, k) => (k === i ? to : q)))
    return to
  }
  const d = useDrag(svgRef, W, H, onMove)
  const scale = d.scale
  const grabBody = useCallback((e: React.PointerEvent) => {
    const at = d.start(BODY, e), cur = ptsRef.current
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [x, y] of cur) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    grab.current = { at, pts: cur, x0, x1, y0, y1 }
  }, [d.start])
  // outline: double-click an edge to add a point there, double-click a point to remove it (at least 4 stay)
  const addPoint = (i: number, e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect(), cur = ptsRef.current
    const p: Pt = [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]
    setPts([...cur.slice(0, i + 1), p, ...cur.slice(i + 1)])
  }
  const removePoint = useCallback((i: number) => {
    const cur = ptsRef.current
    if (cur.length > 4) setPts(cur.filter((_, k) => k !== i))
  }, [setPts])
  // these only change with the page or the zoom, not while dragging
  const opts = useMemo(() => cropOptions(page.stages_detail, W, H), [page.stages_detail, W, H])
  const suggestions = useMemo(() => mode === 'quad' && opts.map((o, i) => (
    <polygon key={o.key} points={o.quad.map((p: Pt) => p.join(',')).join(' ')} fill="none" stroke={CROP_COLORS[i % CROP_COLORS.length]} strokeWidth={2 / scale} strokeDasharray={`${8 / scale} ${6 / scale}`} opacity={0.8} />
  )), [mode, opts, scale])
  const autoPoly = page.stages_detail?.crop?.auto
  const hasAutoPoly = Array.isArray(autoPoly) && autoPoly.length > 4
  return (
    <div className="col" style={{ alignItems: 'center' }}>
      <div className="imgwrap" style={{ touchAction: 'none' }}>
        <img src={page.original_url} alt="" draggable={false} />
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" {...d.svgProps}>
          {suggestions}
          <polygon points={pts.map((p) => p.join(',')).join(' ')} fill="rgba(47,111,237,.12)" stroke="#2f6fed" strokeWidth={1.5 / scale}
            style={{ cursor: d.drag === BODY ? 'grabbing' : 'move' }} onPointerDown={grabBody} />
          {mode === 'mask' && pts.map((p, i) => {
            const q = pts[(i + 1) % pts.length]
            return <line key={'e' + i} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="transparent" strokeWidth={14 / scale} style={{ cursor: 'copy' }}
              onDoubleClick={(e) => addPoint(i, e)} />
          })}
          {mode === 'quad' && pts.map((p, i) => {
            const q = pts[(i + 1) % 4]
            return <EdgeHandle key={'m' + i} i={4 + i} ax={p[0]} ay={p[1]} bx={q[0]} by={q[1]} scale={scale} onDown={d.start} />
          })}
          {pts.map((p, i) => (
            <Handle key={i} i={i} x={p[0]} y={p[1]} r={mode === 'mask' ? 4 : CORNER_R} scale={scale}
              onDown={d.start} onDoubleClick={mode === 'mask' ? removePoint : undefined} />
          ))}
        </svg>
        <Magnifier mag={d.mag} src={page.original_url} W={W} H={H} scale={scale} />
      </div>
      <div className="row">
        {mode === 'quad' && opts.map((o, i) => (
          <button key={o.key} onClick={() => setPts(o.quad)} title={o.method ? t('crop_option_hint') : t('crop_auto_hint')}
            style={{ borderColor: CROP_COLORS[i % CROP_COLORS.length], borderWidth: 2 }}>{cropLabel(o, t)}</button>
        ))}
        {mode === 'mask' && hasAutoPoly && <button onClick={() => setPts(autoPoly)}><RotateCcw size={15} /> {t('crop_auto')}</button>}
        <button title={t('full_page')} onClick={() => setPts(full)}><Maximize size={15} /></button>
        <span className="spacer" />
        <button onClick={onCancel}>{t('cancel')}</button>
        <button className="primary" onClick={() => onApply(mode === 'mask' ? { polygon: pts } : { quad: pts })}>{t('apply')}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- flattening mesh
/** Draw the flattened preview: every mesh cell (2 triangles) of the source mapped onto its cell of the output. */
function drawFlat(canvas: HTMLCanvasElement, img: HTMLImageElement, mesh: Pt[][]) {
  const ctx = canvas.getContext('2d')
  if (!ctx || !img.naturalWidth) return
  const W = canvas.width, H = canvas.height, sw = img.naturalWidth, sh = img.naturalHeight
  const rows = mesh.length, cols = mesh[0].length
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
  const tri = (s: Pt[], dd: Pt[]) => {
    // affine map source triangle -> destination triangle
    const [[x0, y0], [x1, y1], [x2, y2]] = s, [[u0, v0], [u1, v1], [u2, v2]] = dd
    const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (Math.abs(den) < 1e-9) return
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den
    const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / den
    const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / den
    const dd2 = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / den
    const e = u0 - a * x0 - c * y0, f = v0 - b * x0 - dd2 * y0
    ctx.save()
    ctx.beginPath()
    const cx = (u0 + u1 + u2) / 3, cy = (v0 + v1 + v2) / 3, g = 0.6  // grow the clip a little: no hairline seams
    dd.forEach(([u, v], k) => { const ux = u + Math.sign(u - cx) * g, vy = v + Math.sign(v - cy) * g; if (k) ctx.lineTo(ux, vy); else ctx.moveTo(ux, vy) })
    ctx.closePath(); ctx.clip()
    ctx.setTransform(a, b, c, dd2, e, f)
    ctx.drawImage(img, 0, 0)
    ctx.restore()
  }
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const S = (rr: number, cc: number): Pt => [mesh[rr][cc][0] * (sw - 1), mesh[rr][cc][1] * (sh - 1)]
    const D = (rr: number, cc: number): Pt => [(cc / (cols - 1)) * W, (rr / (rows - 1)) * H]
    tri([S(r, c), S(r, c + 1), S(r + 1, c + 1)], [D(r, c), D(r, c + 1), D(r + 1, c + 1)])
    tri([S(r, c), S(r + 1, c + 1), S(r + 1, c)], [D(r, c), D(r + 1, c + 1), D(r + 1, c)])
  }
}

/** An even grid (no flattening): the starting mesh when no model is chosen. */
function identityMesh(rows = 11, cols = 8): Pt[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => [c / (cols - 1), r / (rows - 1)] as Pt))
}

export function MeshEditor({ page, onApply, onReset, onCancel }: {
  page: any; onApply: (mesh: Pt[][]) => void; onReset: () => void; onCancel: () => void
}) {
  const { t } = useT()
  const dw = page.recipe.dewarp
  const [mesh, setMesh] = useState<Pt[][]>(dw.mesh || identityMesh())
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  useEffect(() => setMesh(dw.mesh || identityMesh()), [page.recipe_version])
  const W = size?.w || 1, H = size?.h || 1
  const cols = mesh[0].length
  // the latest mesh, for the per-frame drag callback (it can run before React re-renders with the new state)
  const meshRef = useRef(mesh)
  meshRef.current = mesh
  const d = useDrag(svgRef, W, H, (i, p) => {
    const r = Math.floor(i / cols), c = i % cols
    const next = meshRef.current.map((row, rr) => (rr === r ? row.map((q, cc) => (cc === c ? [p[0] / (W - 1), p[1] / (H - 1)] : q)) : row)) as Pt[][]
    meshRef.current = next
    setMesh(next)
    return p
  })
  const scale = d.scale
  // the preview redraws on every change of the mesh (cheap: ~150 triangles)
  useEffect(() => {
    const c = canvasRef.current, im = imgRef.current
    if (!c || !im || !size) return
    const k = Math.min(1, 900 / size.h)
    c.width = Math.round(size.w * k); c.height = Math.round(size.h * k)
    drawFlat(c, im, mesh)
  }, [mesh, size])
  const P = (q: Pt): Pt => [q[0] * (W - 1), q[1] * (H - 1)]
  if (!page.flatten_source_url) return null
  return (
    <div className="col" style={{ alignItems: 'stretch', width: '100%' }}>
      <div className="row"><span className="small muted">{t('mesh_hint')}</span></div>
      <div className="mesh-grid">
        <div className="imgwrap" style={{ touchAction: 'none' }}>
          <img ref={imgRef} src={page.flatten_source_url} alt="" draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {size && (
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" {...d.svgProps}>
              {mesh.map((row, r) => <polyline key={'r' + r} points={row.map((q) => P(q).join(',')).join(' ')} fill="none" stroke="#2f6fed" strokeWidth={1 / scale} />)}
              {mesh[0].map((_, c) => <polyline key={'c' + c} points={mesh.map((row) => P(row[c]).join(',')).join(' ')} fill="none" stroke="#2f6fed" strokeWidth={1 / scale} />)}
              {mesh.flatMap((row, r) => row.map((q, c) => {
                const [x, y] = P(q)
                return <Handle key={r + '-' + c} i={r * cols + c} x={x} y={y} r={3.5} scale={scale} onDown={d.start} />
              }))}
            </svg>
          )}
          {size && <Magnifier mag={d.mag} src={page.flatten_source_url} W={W} H={H} scale={scale} />}
        </div>
        {<div className="col" style={{ gap: 4 }}><span className="small muted">{t('preview')}</span><canvas ref={canvasRef} className="mesh-preview" /></div>}
      </div>
      <div className="row">
        {dw.mesh_edited && dw.model && <button onClick={onReset}><RotateCcw size={15} /> {t('reset_mesh')}</button>}
        <span className="spacer" />
        <button onClick={onCancel}>{t('cancel')}</button>
        <button className="primary" onClick={() => onApply(mesh)}>{t('apply')}</button>
      </div>
    </div>
  )
}
