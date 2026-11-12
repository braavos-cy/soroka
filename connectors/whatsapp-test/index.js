// Minimal listen-only WhatsApp bridge test (Baileys, MIT).
// Prints a QR to link as a device, logs every message, saves media to ./downloads.
// Never sends messages, reactions, read receipts or presence.
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, downloadMediaMessage,
  fetchLatestBaileysVersion, getContentType,
} from 'baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'node:fs'
import path from 'node:path'

const logger = pino({ level: 'warn' })
const DL = './downloads'
fs.mkdirSync(DL, { recursive: true })

// Only documents and images (§3.2): no audio, video, video notes, stickers
const EXT = { imageMessage: 'jpg', documentMessage: 'bin', documentWithCaptionMessage: 'bin' }

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version, auth: state, logger,
    markOnlineOnConnect: false,   // stay "offline", no presence
    syncFullHistory: false,       // GDPR: no history backfill
    shouldSyncHistoryMessage: () => false,
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { console.log('\nScan with WhatsApp > Linked devices > Link a device:'); qrcode.generate(qr, { small: true }) }
    if (connection === 'open') console.log('✅ connected as', sock.user?.id)
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('❌ closed, code', code)
      if (code === DisconnectReason.loggedOut) console.log('Logged out / possibly banned. Delete ./auth and re-link.')
      else setTimeout(start, 3000) // auto-reconnect
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue
      const ct = getContentType(m.message)
      const body = (ct === 'documentWithCaptionMessage' ? m.message[ct]?.message?.documentMessage : m.message[ct]) ?? {}
      const text = m.message.conversation || body.text || body.caption || ''
      const chat = m.key.remoteJid
      let chatName = chat
      if (chat.endsWith('@g.us')) { try { chatName = (await sock.groupMetadata(chat)).subject } catch {} }
      const ctx = body.contextInfo
      console.log(JSON.stringify({
        time: new Date(Number(m.messageTimestamp) * 1000).toISOString(),
        chat, chatName, sender: m.key.participant || chat, senderPhone: m.key.participantPn || m.key.senderPn, pushName: m.pushName,
        msgId: m.key.id, type: ct, text,
        forwarded: !!ctx?.isForwarded, replyTo: ctx?.stanzaId, mentions: ctx?.mentionedJid,
        fileName: body.fileName, mime: body.mimetype,
      }))
      if (EXT[ct]) {
        try {
          const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
          const name = body.fileName || `${m.key.id}.${EXT[ct]}`
          const f = path.join(DL, `${Date.now()}_${name.replace(/[\/:*?"<>|]/g, '_')}`)
          fs.writeFileSync(f, buf)
          console.log('   💾 saved', f, buf.length, 'bytes')
        } catch (e) { console.log('   ⚠ download failed:', e.message) }
      }
    }
  })
}
start()
