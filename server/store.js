// Хранилище пользователей: Neon Postgres по HTTP (без зависимостей) или файл для локальной разработки.
//
// Если задан DATABASE_URL вида postgresql://user:pass@ep-xxx.neon.tech/db,
// используется HTTP-эндпоинт Neon (POST /sql). Иначе — users.json рядом с файлом.

const fs = require('fs');
const path = require('path');

const NEON_URL = process.env.DATABASE_URL || '';
const FILE = path.join(__dirname, 'users.json');

let fileDb = { users: {} };
try { fileDb = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { fileDb = { users: {} }; }

function saveFile() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fileDb, null, 2));
  fs.renameSync(tmp, FILE);
}

async function neon(text, params) {
  const host = new URL(NEON_URL).host;
  const r = await fetch('https://' + host + '/sql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'neon-connection-string': NEON_URL
    },
    body: JSON.stringify({ query: text, params: params || [] })
  });
  const j = await r.json().catch(() => ({}));
  if (j.message) throw new Error('neon: ' + j.message);
  return j.rows || [];
}

const SCHEMA_PROFILES = `CREATE TABLE IF NOT EXISTS profiles (
  email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated TIMESTAMPTZ DEFAULT NOW()
)`;

const SCHEMA_PAYMENTS = `CREATE TABLE IF NOT EXISTS payments (
  dp_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  created TIMESTAMPTZ DEFAULT NOW()
)`;

const SCHEMA = `CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created TIMESTAMPTZ DEFAULT NOW(),
  confirmed BOOLEAN DEFAULT FALSE,
  totp_secret TEXT,
  totp_on BOOLEAN DEFAULT FALSE
)`;

async function init() {
  if (NEON_URL) {
    await neon(SCHEMA);
    await neon(SCHEMA_PROFILES);
    await neon(SCHEMA_PAYMENTS);
    console.log('[db] Neon Postgres');
  } else {
    console.log('[db] файл users.json (DATABASE_URL не задан)');
  }
}

function rowToUser(r) {
  if (!r) return null;
  return {
    email: r.email,
    salt: r.salt,
    hash: r.hash,
    created: r.created instanceof Date ? r.created.toISOString() : String(r.created || ''),
    confirmed: r.confirmed === true || r.confirmed === 't',
    totpSecret: r.totp_secret || null,
    totpOn: r.totp_on === true || r.totp_on === 't'
  };
}

async function getUser(email) {
  if (NEON_URL) {
    const rows = await neon('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
    return rowToUser(rows[0]);
  }
  const u = fileDb.users[email];
  if (!u) return null;
  return Object.assign({}, u, { confirmed: !!u.confirmed, totpOn: !!u.totpOn });
}

async function createUser(user) {
  if (NEON_URL) {
    await neon(
      'INSERT INTO users (email, salt, hash, confirmed) VALUES ($1, $2, $3, FALSE)',
      [user.email, user.salt, user.hash]
    );
    return;
  }
  fileDb.users[user.email] = {
    email: user.email,
    salt: user.salt,
    hash: user.hash,
    created: new Date().toISOString(),
    confirmed: false,
    totpSecret: null,
    totpOn: false
  };
  saveFile();
}

async function updateUser(email, patch) {
  if (NEON_URL) {
    const cur = await getUser(email);
    if (!cur) return;
    const next = Object.assign({}, cur, patch);
    await neon(
      'UPDATE users SET confirmed = $2, totp_secret = $3, totp_on = $4 WHERE email = $1',
      [email, !!next.confirmed, next.totpSecret, !!next.totpOn]
    );
    return;
  }
  const u = fileDb.users[email];
  if (!u) return;
  Object.assign(u, patch);
  saveFile();
}

async function getProfile(email) {
  if (NEON_URL) {
    const rows = await neon('SELECT data FROM profiles WHERE email = $1 LIMIT 1', [email]);
    return rows[0] ? rows[0].data : null;
  }
  return (fileDb.profiles && fileDb.profiles[email]) || null;
}

async function saveProfile(email, data) {
  if (NEON_URL) {
    await neon(
      'INSERT INTO profiles (email, data, updated) VALUES ($1, $2::jsonb, NOW()) ' +
      'ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated = NOW()',
      [email, JSON.stringify(data)]
    );
    return;
  }
  if (!fileDb.profiles) fileDb.profiles = {};
  fileDb.profiles[email] = data;
  saveFile();
}

async function seenPayments() {
  if (NEON_URL) {
    const rows = await neon('SELECT dp_id FROM payments', []);
    return new Set(rows.map(r => String(r.dp_id)));
  }
  return new Set(Object.keys(fileDb.payments || {}));
}

async function recordPayment(dpId, email, amount) {
  if (NEON_URL) {
    await neon('INSERT INTO payments (dp_id, email, amount) VALUES ($1, $2, $3) ON CONFLICT (dp_id) DO NOTHING',
      [String(dpId), email, amount]);
    return;
  }
  if (!fileDb.payments) fileDb.payments = {};
  fileDb.payments[String(dpId)] = { email, amount };
  saveFile();
}

module.exports = { init, getUser, createUser, updateUser, getProfile, saveProfile, seenPayments, recordPayment, backing: () => (NEON_URL ? 'neon' : 'file') };
