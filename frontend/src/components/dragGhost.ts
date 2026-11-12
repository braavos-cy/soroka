// Custom drag preview for dragging several documents: a stack of cards with the dragged card's
// thumbnail on top and a badge with the number of documents. Drawn on a canvas from the already
// loaded thumbnail so it is ready synchronously (setDragImage needs it immediately).

export function setMultiDragImage(e: React.DragEvent, count: number, thumb: HTMLImageElement | null) {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const panel = v('--panel', '#fff'), border = v('--border', '#dfe3e8'), accent = v('--accent', '#2f6fed')
  const muted = v('--muted', '#6b7686'), panel2 = v('--panel2', '#f0f2f5')

  const W = 128, H = 148, cw = 104, ch = 124, dpr = window.devicePixelRatio || 1
  const canvas = document.createElement('canvas')
  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.cssText = `width:${W}px;height:${H}px;position:fixed;top:-1000px;left:-1000px;pointer-events:none;`
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)

  const card = (x: number, y: number, alpha = 1) => {
    ctx.globalAlpha = alpha
    ctx.fillStyle = panel
    ctx.strokeStyle = border
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x + 0.5, y + 0.5, cw, ch, 4)
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  // cards behind (two when 3+, one when 2), then the front card
  if (count >= 3) card(16, 20, 0.85)
  card(8, 14, 0.92)
  card(0, 8)

  // thumbnail (contain) or a generic page drawing
  const pad = 6, bx = pad, by = 8 + pad, bw = cw - 2 * pad, bh = ch - 2 * pad
  ctx.fillStyle = panel2
  ctx.fillRect(bx, by, bw, bh)
  if (thumb && thumb.complete && thumb.naturalWidth) {
    const s = Math.min(bw / thumb.naturalWidth, bh / thumb.naturalHeight)
    const iw = thumb.naturalWidth * s, ih = thumb.naturalHeight * s
    ctx.drawImage(thumb, bx + (bw - iw) / 2, by + (bh - ih) / 2, iw, ih)
  } else {
    ctx.strokeStyle = muted
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 2
    for (let i = 0; i < 6; i++) {
      ctx.beginPath()
      ctx.moveTo(bx + 14, by + 20 + i * 14)
      ctx.lineTo(bx + bw - (i % 3 === 2 ? 40 : 14), by + 20 + i * 14)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // count badge in the top-right corner
  const label = count > 99 ? '99+' : String(count)
  ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  const r = Math.max(12, ctx.measureText(label).width / 2 + 7)
  const cx = W - r - 2, cy = r + 1
  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = panel
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx, cy + 0.5)

  document.body.appendChild(canvas)
  e.dataTransfer.setDragImage(canvas, 24, 30)
  setTimeout(() => canvas.remove(), 0)
}
