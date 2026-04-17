require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode   = require('qrcode');
const path     = require('path');
const db       = require('./database');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory client registry ────────────────────────────────────────────────
const clients = new Map(); // sessionId → { client, status, name }

// ─── WhatsApp Client Factory ──────────────────────────────────────────────────
async function createClient(sessionId, sessionName) {
  if (clients.has(sessionId)) return;

  const wwa = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: '.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
      ],
    },
  });

  clients.set(sessionId, { client: wwa, status: 'initializing', name: sessionName });

  wwa.on('qr', async (qr) => {
    try {
      const qrImage = await QRCode.toDataURL(qr);
      clients.get(sessionId).status = 'qr';
      db.updateSession(sessionId, { status: 'qr' });
      io.emit('qr', { sessionId, qrImage });
    } catch (e) { console.error('QR error:', e); }
  });

  wwa.on('authenticated', () => {
    clients.get(sessionId).status = 'authenticated';
    db.updateSession(sessionId, { status: 'authenticated' });
    io.emit('session_update', { sessionId, status: 'authenticated' });
  });

  wwa.on('ready', () => {
    const entry = clients.get(sessionId);
    entry.status = 'ready';
    const phone = wwa.info?.wid?.user || '';
    db.updateSession(sessionId, { status: 'ready', phone });
    io.emit('session_update', { sessionId, status: 'ready', phone });
    console.log(`✅ Session ready: ${sessionName} (${phone})`);
  });

  wwa.on('disconnected', (reason) => {
    console.log(`⚠️  Session disconnected: ${sessionName} — ${reason}`);
    if (clients.has(sessionId)) clients.get(sessionId).status = 'disconnected';
    db.updateSession(sessionId, { status: 'disconnected' });
    io.emit('session_update', { sessionId, status: 'disconnected' });
    clients.delete(sessionId);
  });

  wwa.on('message', async (msg) => {
    if (msg.isStatus || msg.type !== 'chat') return;
    try {
      const contact = await msg.getContact();
      const conv    = db.getOrCreateConversation(sessionId, msg.from, contact.pushname || msg.from);
      db.saveMessage({ conversationId: conv.id, from: msg.from, body: msg.body, type: 'incoming', timestamp: msg.timestamp });
      io.emit('new_message', {
        sessionId,
        conversation: db.getConversations({ sessionId }).find(c => c.id === conv.id),
        message: { id: Date.now(), body: msg.body, type: 'incoming', timestamp: msg.timestamp, from_number: msg.from },
      });
    } catch (e) { console.error('Message error:', e); }
  });

  wwa.on('auth_failure', (msg) => {
    console.error('Auth failed:', msg);
    db.updateSession(sessionId, { status: 'auth_failure' });
    io.emit('session_update', { sessionId, status: 'auth_failure' });
    clients.delete(sessionId);
  });

  await wwa.initialize();
}

// ─── API: Sessions ────────────────────────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  const sessions = db.getSessions().map(s => ({
    ...s,
    live_status: clients.get(s.id)?.status || 'offline',
  }));
  res.json(sessions);
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const sessionId = `sess_${Date.now()}`;
    db.createSession(sessionId, name);
    createClient(sessionId, name).catch(console.error);
    res.json({ sessionId, name, status: 'initializing' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    if (clients.has(id)) {
      await clients.get(id).client.destroy().catch(() => {});
      clients.delete(id);
    }
    db.deleteSession(id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Conversations ───────────────────────────────────────────────────────
app.get('/api/conversations', (req, res) => {
  res.json(db.getConversations(req.query));
});

app.patch('/api/conversations/:id', (req, res) => {
  db.updateConversation(req.params.id, req.body);
  io.emit('conversation_updated', { id: +req.params.id, ...req.body });
  res.json({ success: true });
});

app.post('/api/conversations/:id/rate', (req, res) => {
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1–5 required' });
  db.updateConversation(req.params.id, { rating });
  res.json({ success: true });
});

// ─── API: Messages ────────────────────────────────────────────────────────────
app.get('/api/conversations/:id/messages', (req, res) => {
  res.json(db.getMessages(req.params.id));
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  const conv = db.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const entry = clients.get(conv.session_id);
  if (!entry || entry.status !== 'ready')
    return res.status(400).json({ error: 'WhatsApp session not connected' });

  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  try {
    await entry.client.sendMessage(conv.phone, message.trim());
    const ts = Math.floor(Date.now() / 1000);
    db.saveMessage({ conversationId: conv.id, from: 'me', body: message.trim(), type: 'outgoing', timestamp: ts });
    db.updateConversation(conv.id, {});          // bump updated_at
    const msgObj = { body: message.trim(), type: 'outgoing', timestamp: ts, from_number: 'me' };
    io.emit('new_message', { sessionId: conv.session_id, conversationId: conv.id, message: msgObj });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Agents ──────────────────────────────────────────────────────────────
app.get('/api/agents', (req, res) => res.json(db.getAgents()));

app.post('/api/agents', (req, res) => {
  const { name, email } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(db.createAgent({ name, email }));
});

app.delete('/api/agents/:id', (req, res) => {
  db.deleteAgent(req.params.id);
  res.json({ success: true });
});

// ─── API: Stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => res.json(db.getStats()));

// ─── Catch-all → SPA ─────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Restore active sessions on startup ───────────────────────────────────────
(async () => {
  const saved = db.getSessions().filter(s => ['ready', 'authenticated', 'connecting'].includes(s.status));
  console.log(`🔄 Restoring ${saved.length} session(s)…`);
  for (const s of saved) {
    await createClient(s.id, s.name).catch(e => console.error(`Failed to restore ${s.name}:`, e));
    await new Promise(r => setTimeout(r, 1500)); // stagger init
  }
})();

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀  WhatsApp CRM running → http://localhost:${PORT}`));
