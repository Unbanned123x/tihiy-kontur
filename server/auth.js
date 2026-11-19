// Аутентификация «Тихого контура»: регистрация, подтверждение почты, TOTP-2FA, сессии.
// Пользователи — в Postgres (Neon) или users.json, см. store.js.

const crypto = require('crypto');
const store = require('./store');

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const sessions = new Map();
const challenges = new Map();
const pending = new Map();

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function norm(email) { return String(email || '').trim().toLowerCase(); }
function validEmail(e) { return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(e); }

// ---- TOTP (RFC 6238) ----
function b32decode(str) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of str.toUpperCase().replace(/=+$/, '')) {
    const i = A.indexOf(ch);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, step) {
  const key = b32decode(secret);
  const counter = Math.floor((step === undefined ? Date.now() : step) / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  buf.writeUInt32BE(counter % 4294967296, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1000000;
  return String(code).padStart(6, '0');
}
function totpCheck(secret, code) {
  const now = Date.now();
  for (let d = -1; d <= 1; d++) if (totp(secret, now + d * 30000) === String(code || '').trim()) return true;
  return false;
}
function newSecret() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let s = '';
  const rnd = crypto.randomBytes(20);
  for (let i = 0; i < 32; i++) s += A[rnd[i % rnd.length] % 32];
  return s;
}

async function sendMail(email, subject, text) {
  if (!process.env.SMTP_HOST) {
    console.log('[mail:dev] to=' + email + ' | ' + subject + ' | ' + text);
    return { dev: true };
  }
  console.log('[mail:not-implemented] SMTP задан, но отправка не настроена');
  return { dev: true };
}

function json(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function sessionOf(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_TTL) { sessions.delete(token); return null; }
  return { token, email: s.email };
}

function publicUser(u) {
  return { email: u.email, confirmed: !!u.confirmed, totp: !!u.totpOn, created: u.created };
}

function newSession(email) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { email, at: Date.now() });
  return token;
}

async function handleAuth(req, res, url) {
  const p = url.pathname;

  if (req.method === 'OPTIONS') { json(res, 204, {}); return true; }

  if (p === '/api/auth/register' && req.method === 'POST') {
    const b = await readBody(req);
    const email = norm(b.email);
    const password = String(b.password || '');
    if (!validEmail(email)) { json(res, 400, { error: 'bad_email' }); return true; }
    if (password.length < 8) { json(res, 400, { error: 'weak_password' }); return true; }
    if (await store.getUser(email)) { json(res, 409, { error: 'exists' }); return true; }

    const salt = crypto.randomBytes(16).toString('hex');
    await store.createUser({ email, salt, hash: hash(password, salt) });

    const token = crypto.randomBytes(24).toString('hex');
    pending.set(token, { email, at: Date.now() });
    const link = (process.env.PUBLIC_URL || ('http://127.0.0.1:' + (process.env.PORT || 8080)))
      + '/api/auth/confirm?token=' + token;
    await sendMail(email, 'Подтверждение аккаунта «Тихий контур»', link);

    const out = { ok: true, needConfirm: true };
    if (process.env.AUTH_DEV === '1') out.devConfirmUrl = link;
    json(res, 200, out);
    return true;
  }

  if (p === '/api/auth/confirm' && req.method === 'GET') {
    const rec = pending.get(url.searchParams.get('token') || '');
    if (!rec) { json(res, 400, { error: 'bad_token' }); return true; }
    const u = await store.getUser(rec.email);
    if (!u) { json(res, 400, { error: 'no_user' }); return true; }
    await store.updateUser(u.email, { confirmed: true });
    pending.delete(url.searchParams.get('token'));
    json(res, 200, { ok: true, email: u.email });
    return true;
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = await readBody(req);
    const email = norm(b.email);
    const u = await store.getUser(email);
    if (!u) { json(res, 401, { error: 'bad_credentials' }); return true; }
    if (hash(String(b.password || ''), u.salt) !== u.hash) { json(res, 401, { error: 'bad_credentials' }); return true; }
    if (!u.confirmed) { json(res, 403, { error: 'need_confirm' }); return true; }
    if (u.totpOn) {
      const ch = crypto.randomBytes(16).toString('hex');
      challenges.set(ch, { email, at: Date.now() });
      json(res, 200, { ok: true, need2fa: true, challenge: ch });
      return true;
    }
    json(res, 200, { ok: true, token: newSession(email), user: publicUser(u) });
    return true;
  }

  if (p === '/api/auth/2fa/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const rec = challenges.get(String(b.challenge || ''));
    if (!rec) { json(res, 400, { error: 'bad_challenge' }); return true; }
    const u = await store.getUser(rec.email);
    if (!u || !u.totpOn) { json(res, 400, { error: 'no_2fa' }); return true; }
    if (!totpCheck(u.totpSecret, b.code)) { json(res, 401, { error: 'bad_code' }); return true; }
    challenges.delete(b.challenge);
    json(res, 200, { ok: true, token: newSession(rec.email), user: publicUser(u) });
    return true;
  }

  if (p === '/api/auth/2fa/setup' && req.method === 'POST') {
    const s = sessionOf(req);
    if (!s) { json(res, 401, { error: 'unauthorized' }); return true; }
    const u = await store.getUser(s.email);
    if (!u) { json(res, 401, { error: 'unauthorized' }); return true; }
    let secret = u.totpSecret;
    if (!secret) { secret = newSecret(); await store.updateUser(u.email, { totpSecret: secret }); }
    const otpauth = 'otpauth://totp/TihiyKontur:' + encodeURIComponent(u.email)
      + '?secret=' + secret + '&issuer=TihiyKontur&digits=6&period=30';
    json(res, 200, { ok: true, secret, otpauth });
    return true;
  }

  if (p === '/api/auth/2fa/enable' && req.method === 'POST') {
    const s = sessionOf(req);
    if (!s) { json(res, 401, { error: 'unauthorized' }); return true; }
    const b = await readBody(req);
    const u = await store.getUser(s.email);
    if (!u || !u.totpSecret) { json(res, 400, { error: 'no_secret' }); return true; }
    if (!totpCheck(u.totpSecret, b.code)) { json(res, 401, { error: 'bad_code' }); return true; }
    await store.updateUser(u.email, { totpOn: true });
    json(res, 200, { ok: true, user: publicUser(Object.assign({}, u, { totpOn: true })) });
    return true;
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const s = sessionOf(req);
    if (!s) { json(res, 401, { error: 'unauthorized' }); return true; }
    const u = await store.getUser(s.email);
    if (!u) { json(res, 401, { error: 'unauthorized' }); return true; }
    json(res, 200, { ok: true, user: publicUser(u) });
    return true;
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const s = sessionOf(req);
    if (s) sessions.delete(s.token);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleAuth, totp, totpCheck, sessionOf, store };
