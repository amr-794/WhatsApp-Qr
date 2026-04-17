const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    phone    TEXT,
    status   TEXT DEFAULT 'connecting',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS agents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT    NOT NULL,
    phone        TEXT    NOT NULL,
    contact_name TEXT,
    agent_id     INTEGER,
    status       TEXT    DEFAULT 'open',
    rating       INTEGER,
    created_at   INTEGER DEFAULT (unixepoch()),
    updated_at   INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id)   REFERENCES agents(id)   ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    from_number     TEXT,
    body            TEXT,
    type            TEXT CHECK(type IN ('incoming','outgoing')),
    timestamp       INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conv_session  ON conversations(session_id);
  CREATE INDEX IF NOT EXISTS idx_conv_agent    ON conversations(agent_id);
  CREATE INDEX IF NOT EXISTS idx_msg_conv      ON messages(conversation_id);
`);

// ─── Sessions ─────────────────────────────────────────────────────────────────
const getSessions   = () => db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all();
const createSession = (id, name) => db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(id, name);
const updateSession = (id, data) => {
  const cols = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE sessions SET ${cols} WHERE id = @id`).run({ ...data, id });
};
const deleteSession = (id) => db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

// ─── Agents ───────────────────────────────────────────────────────────────────
const getAgents   = () => db.prepare('SELECT * FROM agents ORDER BY name').all();
const createAgent = ({ name, email }) => {
  const r = db.prepare('INSERT INTO agents (name, email) VALUES (?, ?)').run(name, email || null);
  return { id: r.lastInsertRowid, name, email };
};
const deleteAgent = (id) => db.prepare('DELETE FROM agents WHERE id = ?').run(id);

// ─── Conversations ────────────────────────────────────────────────────────────
const getConversations = ({ sessionId, agentId, status } = {}) => {
  let sql = `
    SELECT c.*,
           a.name AS agent_name,
           (SELECT body      FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message,
           (SELECT timestamp FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) AS last_message_at,
           (SELECT COUNT(*)  FROM messages WHERE conversation_id = c.id AND type = 'incoming')            AS incoming_count
    FROM conversations c
    LEFT JOIN agents a ON c.agent_id = a.id
    WHERE 1=1
  `;
  const params = [];
  if (sessionId) { sql += ' AND c.session_id = ?'; params.push(sessionId); }
  if (agentId)   { sql += ' AND c.agent_id = ?';   params.push(agentId); }
  if (status)    { sql += ' AND c.status = ?';     params.push(status); }
  sql += ' ORDER BY c.updated_at DESC';
  return db.prepare(sql).all(...params);
};

const getConversation = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);

const getOrCreateConversation = (sessionId, phone, contactName) => {
  let c = db.prepare(
    'SELECT * FROM conversations WHERE session_id = ? AND phone = ? AND status = "open" LIMIT 1'
  ).get(sessionId, phone);

  if (!c) {
    const r = db.prepare(
      'INSERT INTO conversations (session_id, phone, contact_name) VALUES (?, ?, ?)'
    ).run(sessionId, phone, contactName || phone);
    c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(r.lastInsertRowid);
  } else {
    db.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(c.id);
  }
  return c;
};

const updateConversation = (id, data) => {
  const allowed = ['agent_id', 'status', 'rating', 'contact_name'];
  const cols = Object.keys(data).filter(k => allowed.includes(k));
  if (!cols.length) return;
  const set = [...cols.map(c => `${c} = @${c}`), 'updated_at = unixepoch()'].join(', ');
  db.prepare(`UPDATE conversations SET ${set} WHERE id = @id`).run({ ...data, id });
};

// ─── Messages ─────────────────────────────────────────────────────────────────
const getMessages  = (convId) =>
  db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(convId);

const saveMessage  = ({ conversationId, from, body, type, timestamp }) =>
  db.prepare('INSERT INTO messages (conversation_id, from_number, body, type, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId, from, body, type, timestamp || Math.floor(Date.now() / 1000));

// ─── Stats ────────────────────────────────────────────────────────────────────
const getStats = () => ({
  total:       db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c,
  open:        db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE status = "open"').get().c,
  closed:      db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE status = "closed"').get().c,
  avgRating:   db.prepare('SELECT ROUND(AVG(rating),1) AS r FROM conversations WHERE rating IS NOT NULL').get().r || 0,
  agentStats:  db.prepare(`
    SELECT a.id, a.name,
           COUNT(c.id)                                           AS total,
           SUM(CASE WHEN c.status = 'closed' THEN 1 ELSE 0 END) AS closed,
           ROUND(AVG(c.rating), 1)                              AS avg_rating
    FROM agents a
    LEFT JOIN conversations c ON a.id = c.agent_id
    GROUP BY a.id ORDER BY total DESC
  `).all(),
  todayMessages: db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE timestamp >= unixepoch('now','start of day')"
  ).get().c,
});

module.exports = {
  getSessions, createSession, updateSession, deleteSession,
  getAgents, createAgent, deleteAgent,
  getConversations, getConversation, getOrCreateConversation, updateConversation,
  getMessages, saveMessage,
  getStats,
};
