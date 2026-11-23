// Soroka WhatsApp connector (Baileys, MIT; depends on libsignal GPL-3.0 — isolated container).
// Never sends text messages, read receipts or presence. Talks to the core API only.
// What it does in a chat: reacts to a message once it was saved or rejected (can be switched off globally and
// per chat), confirms a private chat activated with the secret word (✅ reaction), and leaves a group when an
// admin asks for it in the admin UI.
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion,
  getContentType, jidNormalizedUser, isJidGroup, Browsers,
} from 'baileys'
import pino from 'pino'
import fs from 'node:fs'

const CORE = process.env.CORE_URL || 'http://api:8000'
const TOKEN = process.env.CONNECTOR_TOKEN || ''
const AUTH_DIR = process.env.AUTH_DIR || './auth'
const PLATFORM = 'whatsapp'
const log = pino({ level: process.env.LOG_LEVEL || 'info' })
const blog = pino({ level: 'warn' })

const MEDIA_TYPES = new Set(['imageMessage', 'documentMessage', 'documentWithCaptionMessage'])
const BUFFER_MAX = 60

let sock = null
let state = { status: 'starting', detail: '', qr: null }
let config = { chats: new Map(), privateCode: '' }
const textBuffer = new Map() // chatId -> [{id, sender, sender_name, time, text}]
const pendingAfter = new Map() // chatId -> [{eventId, deadline, remaining}]

// ------------------------------------------------------------------ core API
async function core(method, path, body, isForm = false) {
  const headers = { 'x-connector-token': TOKEN }
  if (!isForm && body) headers['content-type'] = 'application/json'
  const r = await fetch(CORE + path, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined })
  const txt = await r.text()
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${txt.slice(0, 200)}`)
  return txt ? JSON.parse(txt) : null
}

async function reportStatus() {
  try {
    const me = sock?.user
    const res = await core('POST', '/api/connector/status', {
      platform: PLATFORM, status: state.status, detail: state.detail, qr: state.qr,
      self_id: me ? jidNormalizedUser(me.id) : '', self_name: me?.name || '',
    })
    if (res?.command === 'logout') await relink('logout requested from admin UI')
  } catch (e) { log.warn({ err: e.message }, 'status report failed') }
}

async function refreshConfig() {
  try {
    const c = await core('GET', `/api/connector/config?platform=${PLATFORM}`)
    config = { chats: new Map(c.chats.map(x => [x.chat_id, x])), privateCode: c.private_code || '' }
    if (c.command === 'logout') return relink('logout requested from admin UI')
    await processLeaves(c.leave_chats || [])
    processReactions(c.reactions || []) // not awaited: paced sending must not hold up config refreshes
  } catch (e) { log.warn({ err: e.message }, 'config refresh failed') }
}

// The core decides which message gets which reaction (saved / rejected) and whether reactions are switched on;
// here they are only delivered: one attempt each, spaced out, then taken off the core's queue.
let reacting = false
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function processReactions(list) {
  if (reacting || !list.length || state.status !== 'connected') return
  reacting = true
  const done = []
  try {
    for (const r of list) {
      if (state.status !== 'connected') break
      const key = { remoteJid: r.chat_id, id: r.message_id, fromMe: false }
      if (isJidGroup(r.chat_id) && r.sender_id) key.participant = r.sender_id
      try { await sock.sendMessage(r.chat_id, { react: { text: r.emoji, key } }) }
      catch (e) { log.warn({ err: e.message, chat: r.chat_id }, 'reaction failed') }
      done.push(r.event_id)
      await sleep(1000 + Math.random() * 2000)
    }
  } finally {
    try { if (done.length) await core('POST', '/api/connector/reactions-sent', { platform: PLATFORM, event_ids: done }) }
    catch (e) { log.warn({ err: e.message }, 'reactions-sent report failed') }
    reacting = false
  }
}

// Leave requests come only from the admin UI (never from chat messages). One attempt per request: the core
// drops the request when we report a failure.
const leaving = new Set() // in flight
const left = new Set() // left, but the report to the core has not gone through yet
async function processLeaves(ids) {
  if (state.status !== 'connected') return
  for (const chatId of ids) {
    if (leaving.has(chatId)) continue
    leaving.add(chatId)
    let error = ''
    try {
      if (!left.has(chatId)) {
        if (!isJidGroup(chatId)) throw new Error('not a group chat')
        await sock.groupLeave(chatId)
        left.add(chatId)
        log.info({ chatId }, 'left chat on admin request')
      }
    } catch (e) { error = e.message || 'leave failed'; log.warn({ chatId, err: error }, 'leaving chat failed') }
    try {
      await core('POST', '/api/connector/left-chat', { platform: PLATFORM, chat_id: chatId, error })
      left.delete(chatId)
      if (!error) for (const m of [config.chats, groupNames, textBuffer, pendingAfter]) m.delete(chatId)
    } catch (e) { log.warn({ err: e.message }, 'left-chat report failed') }
    finally { leaving.delete(chatId) }
  }
}

function setState(status, detail = '', qr = null) {
  state = { status, detail, qr }
  reportStatus()
}

// ------------------------------------------------------------------ helpers
function myJids() {
  const u = sock?.user
  if (!u) return new Set()
  return new Set([u.id, u.lid].filter(Boolean).map(j => jidNormalizedUser(j)))
}

function unwrap(message) {
  // ephemeral / view-once / captioned-document wrappers
  let m = message
  for (let i = 0; i < 4 && m; i++) {
    const t = getContentType(m)
    if (['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'].includes(t)) {
      m = m[t]?.message
    } else break
  }
  return m
}

function textOf(m) {
  if (!m) return ''
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.documentMessage?.caption || ''
}

function ctxInfoOf(m) {
  const t = getContentType(m)
  return t ? m[t]?.contextInfo : undefined
}

function senderOf(msg, chatId) {
  const k = msg.key
  const id = k.participant || chatId
  const pnJid = k.participantPn || k.senderPn || (id.endsWith("@s.whatsapp.net") ? id : null)
  return {
    sender_id: id,
    sender_phone: pnJid ? "+" + pnJid.split("@")[0].split(":")[0] : "",
    sender_name: msg.pushName || "",
  }
}

function tsOf(msg) {
  const t = Number(msg.messageTimestamp?.toNumber ? msg.messageTimestamp.toNumber() : msg.messageTimestamp)
  return new Date((t || Date.now() / 1000) * 1000)
}

function bufferText(chatId, msg, text) {
  const arr = textBuffer.get(chatId) || []
  const s = senderOf(msg, chatId)
  arr.push({ id: msg.key.id, sender: s.sender_phone || s.sender_id, sender_name: s.sender_name, time: tsOf(msg).toISOString(), text })
  while (arr.length > BUFFER_MAX) arr.shift()
  textBuffer.set(chatId, arr)
}

function contextBefore(chatId, at, reg) {
  const n = reg?.ctx_before ?? 5
  const win = (reg?.ctx_minutes ?? 10) * 60 * 1000
  return (textBuffer.get(chatId) || [])
    .filter(m => at - new Date(m.time) <= win && new Date(m.time) <= at)
    .slice(-n).map(m => ({ ...m, position: 'before' }))
}

async function pushAfterContext(chatId, entry) {
  const list = pendingAfter.get(chatId)
  if (!list) return
  const now = Date.now()
  for (const p of [...list]) {
    if (now > p.deadline || p.remaining <= 0) { list.splice(list.indexOf(p), 1); continue }
    p.remaining--
    try { await core('POST', `/api/ingest/${p.eventId}/context`, { messages: [{ ...entry, position: 'after' }] }) }
    catch (e) { log.warn({ err: e.message }, 'context append failed') }
  }
}

// ------------------------------------------------------------------ ingest
async function ingestMedia({ fakeMsg, inner, chatId, chatName, origMsg, forced, forceReason, reg }) {
  const type = getContentType(inner)
  const body = inner[type] || {}
  let buf
  try {
    buf = await downloadMediaMessage({ key: fakeMsg.key, message: inner }, 'buffer', {},
      { logger: blog, reuploadRequest: sock.updateMediaMessage })
  } catch (e) { log.error({ err: e.message, id: fakeMsg.key.id }, 'download failed'); return }
  const ext = type === 'imageMessage' ? 'jpg' : 'bin'
  const filename = body.fileName || `${type === 'imageMessage' ? 'IMG' : 'file'}_${fakeMsg.key.id}.${ext}`
  const at = tsOf(origMsg)
  const ci = body.contextInfo || {}
  const sender = senderOf(fakeMsg, chatId)
  const meta = {
    platform: PLATFORM, chat_id: chatId, chat_name: chatName, message_id: fakeMsg.key.id,
    ...sender, sent_at: at.toISOString(),
    caption: body.caption || '',
    forwarded: !!ci.isForwarded, forward_info: ci.isForwarded ? { score: ci.forwardingScore || 1 } : null,
    reply_to: ci.quotedMessage ? { id: ci.stanzaId, sender: ci.participant, text: textOf(unwrap(ci.quotedMessage)).slice(0, 2000) } : null,
    context: contextBefore(chatId, at, reg),
    forced: !!forced, force_reason: forceReason || '',
  }
  if (forceReason === 'mention_reply') {
    // the media is the quoted message; the mentioning reply is context
    meta.extra = { trigger: { by: senderOf(origMsg, chatId), text: textOf(unwrap(origMsg.message)) } }
  }
  const fd = new FormData()
  fd.append('meta', JSON.stringify(meta))
  fd.append('files', new Blob([buf], { type: body.mimetype || 'application/octet-stream' }), filename)
  try {
    const res = await core('POST', '/api/ingest', fd, true)
    log.info({ chat: chatName, file: filename, docs: res.document_ids, dup: res.duplicates?.length, forced: forceReason }, 'ingested')
    if (reg && (reg.ctx_after ?? 5) > 0) {
      const list = pendingAfter.get(chatId) || []
      list.push({ eventId: res.ingest_event_id, deadline: Date.now() + (reg.ctx_minutes ?? 10) * 60000, remaining: reg.ctx_after ?? 5 })
      pendingAfter.set(chatId, list)
    }
  } catch (e) {
    if (String(e.message).includes('409')) log.info({ chat: chatName, reason: e.message }, 'ingest skipped by core')
    else log.error({ err: e.message }, 'ingest failed')
  }
}

const groupNames = new Map()
async function chatNameOf(chatId) {
  if (!isJidGroup(chatId)) return ''
  if (groupNames.has(chatId)) return groupNames.get(chatId)
  try { const md = await sock.groupMetadata(chatId); groupNames.set(chatId, md.subject); return md.subject } catch { return '' }
}

async function onMessage(msg) {
  if (!msg.message || msg.key.fromMe) return
  const chatId = msg.key.remoteJid
  if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) return
  const isGroup = !!isJidGroup(chatId)
  const inner = unwrap(msg.message)
  if (!inner) return
  const type = getContentType(inner)
  const text = textOf(inner)
  const reg = config.chats.get(chatId)
  const mine = myJids()
  const ci = ctxInfoOf(inner) || {}
  const mentionsMe = (ci.mentionedJid || []).some(j => mine.has(jidNormalizedUser(j)))

  // a person's private chat counts only once activated with the secret word (set in the admin UI): otherwise
  // anybody could flood the archive. The word must be the whole message; the bot confirms with a reaction only.
  if (!isGroup && !reg) {
    const norm = (s) => s.split(/\s+/).filter(Boolean).join(' ').toLowerCase()
    if (!config.privateCode || !text || norm(text) !== norm(config.privateCode)) return
    try {
      await core('POST', '/api/connector/private-activate', { platform: PLATFORM, code: text, chat_id: chatId, chat_name: msg.pushName || '' })
      log.info({ chatId }, 'private chat activated')
      await refreshConfig()
      try { await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } }) } catch (e) { log.warn({ err: e.message }, 'activation reaction failed') }
    } catch (e) { log.warn({ err: e.message }, 'private activation failed') }
    return
  }

  if (isGroup && !reg) return // unregistered chats are ignored entirely (privacy)
  const chatName = isGroup ? await chatNameOf(chatId) : (msg.pushName || '')

  // reply that mentions the bot -> force-save the quoted media
  if (mentionsMe && ci.quotedMessage) {
    const quoted = unwrap(ci.quotedMessage)
    if (quoted && MEDIA_TYPES.has(getContentType(quoted))) {
      const fakeMsg = { key: { remoteJid: chatId, id: ci.stanzaId, participant: ci.participant, fromMe: false } }
      await ingestMedia({ fakeMsg, inner: quoted, chatId, chatName, origMsg: msg, forced: true, forceReason: 'mention_reply', reg })
      return
    }
  }

  if (MEDIA_TYPES.has(type)) {
    let forced = false, reason = ''
    if (!isGroup) { forced = true; reason = 'private_forward' } // sent/forwarded to the bot's private chat
    else if (mentionsMe) { forced = true; reason = 'mention_caption' }
    if (isGroup && reg.mode === 'override' && !forced) return
    await ingestMedia({ fakeMsg: msg, inner, chatId, chatName, origMsg: msg, forced, forceReason: reason, reg })
    return
  }

  if (text && isGroup) {
    bufferText(chatId, msg, text)
    const s = senderOf(msg, chatId)
    await pushAfterContext(chatId, { id: msg.key.id, sender: s.sender_phone || s.sender_id, sender_name: s.sender_name, time: tsOf(msg).toISOString(), text })
  }
}

let lastGroupFetch = 0
// Full group list is a WhatsApp query: at most once per 30 min (rate limits = ban risk).
async function reportGroups() {
  if (Date.now() - lastGroupFetch < 30 * 60 * 1000) return
  lastGroupFetch = Date.now()
  try {
    const groups = await sock.groupFetchAllParticipating()
    await sendSeen(Object.values(groups))
  } catch (e) { log.warn({ err: e.message }, "group report failed") }
}

// Group events carry their own metadata: report without querying WhatsApp.
async function sendSeen(list) {
  const chats = list.filter(g => g?.id && g.subject).map(g => ({ chat_id: g.id, chat_name: g.subject, is_group: true }))
  chats.forEach(c => groupNames.set(c.chat_id, c.chat_name))
  if (!chats.length) return
  try { await core("POST", "/api/connector/seen-chats", { platform: PLATFORM, chats }) }
  catch (e) { log.warn({ err: e.message }, "seen-chats report failed") }
}

// ------------------------------------------------------------------ connection
let relinking = false
async function relink(reason, unlinkOnPhone = true) {
  if (relinking) return
  relinking = true
  log.warn({ reason }, 'relinking: clearing session')
  const s = sock
  sock = null // from here on, events of the old socket are ignored (see the handlers in start)
  try {
    const me = s?.authState?.creds?.me?.id
    if (unlinkOnPhone && s && me) {
      // Baileys' own logout() closes the socket without waiting for WhatsApp to take the request, so the phone
      // kept listing the device. query() waits for the answer.
      try {
        await s.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'md' },
          content: [{ tag: 'remove-companion-device', attrs: { jid: me, reason: 'user_initiated' } }] }, 8000)
        log.info('device unlinked on the phone')
      } catch (e) { log.warn({ err: e.message }, 'unlink request failed: remove the device on the phone by hand') }
    }
    try { s?.end(undefined) } catch {}
    // AUTH_DIR is a volume mount point: the directory itself cannot be removed (EBUSY), only its contents
    try {
      for (const f of fs.readdirSync(AUTH_DIR)) fs.rmSync(`${AUTH_DIR}/${f}`, { recursive: true, force: true })
    } catch (e) { if (e.code !== 'ENOENT') log.error({ err: e.message }, 'could not clear the session') }
    groupNames.clear(); textBuffer.clear(); pendingAfter.clear()
    lastGroupFetch = 0 // the next account's groups are reported as soon as it connects
    setState('disconnected', reason)
  } finally { relinking = false }
  start()
}

let starting = false
async function start() {
  if (starting) return
  starting = true
  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))
    const s = sock = makeWASocket({
      version, auth, logger: blog,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false, // no presence
      syncFullHistory: false, shouldSyncHistoryMessage: () => false, // never import chat history (GDPR)
      fireInitQueries: true,
      generateHighQualityLinkPreview: false,
    })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (s !== sock) return // a socket that relink() already replaced
      if (qr) setState('qr', 'scan the QR code with the bot phone: WhatsApp > Linked devices', qr)
      if (connection === 'open') {
        setState('connected', '')
        log.info({ me: sock.user?.id }, 'connected')
        reportGroups()
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const msg = lastDisconnect?.error?.message || ''
        if (code === DisconnectReason.loggedOut || code === 403) {
          setState('logged_out', `logged out or banned (code ${code}). Re-link with a QR code.`)
          starting = false
          return relink(`logged_out ${code}`, false) // WhatsApp already dropped the device
        }
        setState('disconnected', `code ${code} ${msg}`.trim())
        starting = false
        setTimeout(start, code === DisconnectReason.restartRequired ? 500 : 5000)
        return
      }
    })
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const m of messages) {
        try { await onMessage(m) } catch (e) { log.error({ err: e.message, stack: e.stack }, 'message handling failed') }
      }
    })
    sock.ev.on("groups.upsert", (gs) => sendSeen(gs))
    sock.ev.on("groups.update", (ups) => sendSeen(ups))
  } catch (e) {
    log.error({ err: e.message }, 'start failed')
    setState('disconnected', e.message)
    setTimeout(start, 10000)
  } finally { starting = false }
}

if (!TOKEN) { log.error('CONNECTOR_TOKEN missing'); process.exit(1) }
await refreshConfig()
setInterval(refreshConfig, 5000) // also carries admin commands (unlink, leave), so keep it short
setInterval(reportStatus, 20000)
start()
