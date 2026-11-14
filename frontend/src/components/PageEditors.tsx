// Manual editors for a page's crop (page outline or 4 corners) and its flattening mesh.
import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { CROP_COLORS, cropLabel, cropOptions } from './cropOptions'
import { Maximize, RotateCcw } from 'lucide-react'

export type Pt = [number, number]
type Mag = { x: number; y: number; px: number; py: number } | null

/** Shared pointer handling: drag point i of a list, with a magnifier, in image pixel coordinates. */
function useDrag(svgRef: React.RefObject<SVGSVGElement>, W: number, H: number) {
  const [drag, setDrag] = useState<number | null>(null)
  const [mag, setMag] = useState<Mag>(null)
  const toImg = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(W - 1, ((e.clientX - r.left) / r.width) * W)), y: Math.max(0, Math.min(H - 1, ((e.clientY - r.top) / r.height) * H)), px: e.clientX - r.left, py: e.clientY - r.top }
  }
  const end = () => { setDrag(null); setMag(null) }
  return { drag, setDrag, mag, setMag, toImg, end }
}

function Magnifier({ mag, src, W, H, scale }: { mag: Mag; src: string; W: number; H: number; scale: number }) {
  if (!mag) return null
  const zoom = 3
  return (
    <div className="magnifier" style={{
      left: mag.px + 20, top: mag.py - 160, backgroundImage: `url(${src})`,
      backgroundSize: `${W * scale * zoom}px ${H * scale * zoom}px`,
      backgroundPosition: `${-(mag.x * scale * zoom - 70)}px ${-(mag.y * scale * zoom - 70)}px`,
    }}><svg viewBox="0 0 140 140" style={{ width: 140, height: 140 }}><path d="M70 55V85M55 70H85" stroke="#dc2626" strokeWidth="1.5" /></svg></div>
  )
}

// ---------------------------------------------------------------- crop: page outline or 4 corners
export function CropEditor({ page, onApply, onCancel }: { page: any; onApply: (v: any) => void; onCancel: () => void }) {
  const { t } = useT()
  const W = page.width, H = page.height
  const crop = page.recipe.crop
  const full: Pt[] = [[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]]
  const initialQuad: Pt[] = crop.quad || full
  const [mode, setMode] = useState<'mask' | 'quad'>(crop.mode === 'mask' || (crop.mode !== 'quad' && crop.polygon) ? 'mask' : 'quad')
  const [quad, setQuad] = useState<Pt[]>(initialQuad)
  const [poly, setPoly] = useState<Pt[]>(crop.polygon || initialQuad)
  const svgRef = useRef<SVGSVGElement>(null)
  const d = useDrag(svgRef, W, H)
  const scale = svgRef.current ? svgRef.current.getBoundingClientRect().width / W : 1
  const opts = cropOptions(page.stages_detail, W, H)
  const pts = mode === 'mask' ? poly : quad
  const setPts = mode === 'mask' ? setPoly : setQuad
  const move = (e: React.PointerEvent) => {
    if (d.drag == null) return
    const p = d.toImg(e)
    setPts(pts.map((q, i) => (i === d.drag ? [p.x, p.y] : q)) as Pt[])
    d.setMag({ x: p.x, y: p.y, px: p.px, py: p.py })
  }
  // outline: double-click an edge to add a point there, double-click a point to remove it (at least 4 stay)
  const addPoint = (i: number, e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect()
    const p: Pt = [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]
    setPoly([...poly.slice(0, i + 1), p, ...poly.slice(i + 1)])
  }
  const removePoint = (i: number) => { if (poly.length > 4) setPoly(poly.filter((_, k) => k !== i)) }
  const autoPoly = page.stages_detail?.crop?.auto
  const hasAutoPoly = Array.isArray(autoPoly) && autoPoly.length > 4
  return (
    <div className="col" style={{ alignItems: 'center' }}>
      <div className="row">
        <div className="seg">
          <button className={mode === 'mask' ? 'active' : ''} onClick={() => setMode('mask')}>{t('crop_outline')}</button>
          <button className={mode === 'quad' ? 'active' : ''} onClick={() => setMode('quad')}>{t('crop_corners')}</button>
        </div>
        <span className="small muted">{mode === 'mask' ? t('outline_hint') : t('corners_hint')}</span>
      </div>
      <div className="imgwrap" style={{ touchAction: 'none' }}>
        <img src={page.original_url} alt="" draggable={false} />
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={move} onPointerUp={d.end} onPointerLeave={d.end}>
          {mode === 'quad' && opts.map((o, i) => (
            <polygon key={o.key} points={o.quad.map((p: Pt) => p.join(',')).join(' ')} fill="none" stroke={CROP_COLORS[i % CROP_COLORS.length]} strokeWidth={2 / scale} strokeDasharray={`${8 / scale} ${6 / scale}`} opacity={0.8} />
          ))}
          <polygon points={pts.map((p) => p.join(',')).join(' ')} fill="rgba(47,111,237,.12)" stroke="#2f6fed" strokeWidth={2.5 / scale} />
          {mode === 'mask' && pts.map((p, i) => {
            const q = pts[(i + 1) % pts.length]
            return <line key={'e' + i} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="transparent" strokeWidth={14 / scale} style={{ cursor: 'copy' }}
              onDoubleClick={(e) => addPoint(i, e)} />
          })}
          {pts.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={(mode === 'mask' ? 8 : 12) / scale} fill="#fff" stroke="#2f6fed" strokeWidth={3 / scale} style={{ cursor: 'grab' }}
              onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); d.setDrag(i) }}
              onDoubleClick={() => mode === 'mask' && removePoint(i)} />
          ))}
        </svg>
        <Magnifier mag={d.mag} src={page.original_url} W={W} H={H} scale={scale} />
      </div>
      <div className="row">
        {mode === 'quad' && opts.map((o, i) => (
          <button key={o.key} onClick={() => setQuad(o.quad)} title={o.method ? t('crop_option_hint') : t('crop_auto_hint')}
            style={{ borderColor: CROP_COLORS[i % CROP_COLORS.length], borderWidth: 2 }}>{cropLabel(o, t)}</button>
        ))}
        {mode === 'mask' && hasAutoPoly && <button onClick={() => setPoly(autoPoly)}><RotateCcw size={15} /> {t('crop_auto')}</button>}
        <button title={t('full_page')} onClick={() => setPts(full)}><Maximize size={15} /></button>
        <span className="spacer" />
        <button onClick={onCancel}>{t('cancel')}</button>
        <button className="primary" onClick={() => onApply(mode === 'mask' ? { polygon: poly } : { quad })}>{t('apply')}</button>
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

export function MeshEditor({ page, onApply, onReset, onToggle, onCancel }: {
  page: any; onApply: (mesh: Pt[][]) => void; onReset: () => void; onToggle: (on: boolean) => void; onCancel: () => void
}) {
  const { t } = useT()
  const dw = page.recipe.dewarp
  const [mesh, setMesh] = useState<Pt[][] | null>(dw.mesh)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  useEffect(() => setMesh(dw.mesh), [page.recipe_version])
  const W = size?.w || 1, H = size?.h || 1
  const d = useDrag(svgRef, W, H)
  const scale = svgRef.current ? svgRef.current.getBoundingClientRect().width / W : 1
  // the preview redraws on every change of the mesh (cheap: ~150 triangles)
  useEffect(() => {
    const c = canvasRef.current, im = imgRef.current
    if (!c || !im || !size || !mesh) return
    const k = Math.min(1, 900 / size.h)
    c.width = Math.round(size.w * k); c.height = Math.round(size.h * k)
    drawFlat(c, im, mesh)
  }, [mesh, size])
  const cols = mesh ? mesh[0].length : 0
  const move = (e: React.PointerEvent) => {
    if (d.drag == null || !mesh) return
    const p = d.toImg(e)
    const r = Math.floor(d.drag / cols), c = d.drag % cols
    setMesh(mesh.map((row, rr) => row.map((q, cc) => (rr === r && cc === c ? [p.x / (W - 1), p.y / (H - 1)] : q)) as Pt[]))
    d.setMag({ x: p.x, y: p.y, px: p.px, py: p.py })
  }
  const P = (q: Pt): Pt => [q[0] * (W - 1), q[1] * (H - 1)]
  if (!page.flatten_source_url) return null
  return (
    <div className="col" style={{ alignItems: 'stretch', width: '100%' }}>
      <div className="row">
        <span className="small muted">{dw.enabled ? t('mesh_hint') : t('flatten_off_hint')}</span>
        <span className="spacer" />
        {dw.enabled ? <button onClick={() => onToggle(false)}>{t('flatten_off')}</button> : <button className="primary" onClick={() => onToggle(true)}>{t('flatten_on')}</button>}
      </div>
      <div className="mesh-grid">
        <div className="imgwrap" style={{ touchAction: 'none' }}>
          <img ref={imgRef} src={page.flatten_source_url} alt="" draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {size && mesh && dw.enabled && (
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={move} onPointerUp={d.end} onPointerLeave={d.end}>
              {mesh.map((row, r) => <polyline key={'r' + r} points={row.map((q) => P(q).join(',')).join(' ')} fill="none" stroke="#2f6fed" strokeWidth={1.5 / scale} />)}
              {mesh[0].map((_, c) => <polyline key={'c' + c} points={mesh.map((row) => P(row[c]).join(',')).join(' ')} fill="none" stroke="#2f6fed" strokeWidth={1.5 / scale} />)}
              {mesh.flatMap((row, r) => row.map((q, c) => {
                const [x, y] = P(q)
                return <circle key={r + '-' + c} cx={x} cy={y} r={7 / scale} fill="#fff" stroke="#2f6fed" strokeWidth={2.5 / scale} style={{ cursor: 'grab' }}
                  onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); d.setDrag(r * cols + c) }} />
              }))}
            </svg>
          )}
          {size && <Magnifier mag={d.mag} src={page.flatten_source_url} W={W} H={H} scale={scale} />}
        </div>
        {dw.enabled && mesh && <div className="col" style={{ gap: 4 }}><span className="small muted">{t('preview')}</span><canvas ref={canvasRef} className="mesh-preview" /></div>}
      </div>
      <div className="row">
        {dw.enabled && <button onClick={onReset}><RotateCcw size={15} /> {t('reset_mesh')}</button>}
        <span className="spacer" />
        <button onClick={onCancel}>{t('cancel')}</button>
        {dw.enabled && mesh && <button className="primary" onClick={() => onApply(mesh)}>{t('apply')}</button>}
      </div>
    </div>
  )
}
