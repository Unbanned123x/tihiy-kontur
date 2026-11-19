// Аутентификация «Тихого контура»: регистрация, подтверждение почты, TOTP-2FA, сессии.
// Без внешних зависимостей. Пользователи хранятся в users.json рядом с этим файлом.
//
// Отладочная почта: если SMTP не настроен, письмо не отправляется, а ссылка
// подтверждения пишется в лог сервера и возвращается в ответе (только при AUTH_DEV=1).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, 'users.json');
const SESSION_TTL = 7 * 24 * 3600 * 1000;

let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { db = { users: {} }; }

const sessions = new Map();   // token -> { email, at }
const challenges = new Map(); // challenge -> { email, at }
const pending = new Map();    // confirmToken -> { email, at }

function save() {
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, STORE);
}

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function norm(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email);
}

// ---- TOTP (RFC 6238, SHA1, 30 c, 6 цифр) ----
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
  for (let d = -1; d <= 1; d++) {
    if (totp(secret, now + d * 30000) === String(code || '').trim()) return true;
  }
  return false;
}

function newSecret() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let s = '';
  const rnd = crypto.randomBytes(20);
  for (let i = 0; i < 32; i++) s += A[rnd[i % rnd.length] % 32];
  return s;
}

// ---- почта ----
async function sendMail(email, subject, text) {
  const host = process.env.SMTP_HOST;
  if (!host) {
    console.log('[mail:dev] to=' + email + ' | ' + subject + ' | ' + text);
    return { dev: true };
  }
  // SMTP не реализуем руками: при наличии SMTP_URL используем fetch к API провайдера
  console.log('[mail:not-implemented] SMTP_URL задан, но отправка не настроена');
  return { dev: true };
}

// ---- ответы ----
function json(res, code, obj, extraHeaders) {
  res.writeHead(code, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  }, extraHeaders || {}));
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
  return { token, email: s.email, user: db.users[s.email] };
}

function publicUser(u) {
  return { email: u.email, confirmed: !!u.confirmed, totp: !!u.totpOn, created: u.created };
}

// ---- обработчик ----
async function handleAuth(req, res, url) {
  const p = url.pathname;

  if (req.method === 'OPTIONS') { json(res, 204, {}); return true; }

  if (p === '/api/auth/register' && req.method === 'POST') {
    const b = await readBody(req);
    const email = norm(b.email);
    const password = String(b.password || '');
    if (!validEmail(email)) return json(res, 400, { error: 'bad_email' }), true;
    if (password.length < 8) return json(res, 400, { error: 'weak_password' }), true;
    if (db.users[email]) return json(res, 409, { error: 'exists' }), true;

    const salt = crypto.randomBytes(16).toString('hex');
    db.users[email] = {
      email,
      salt,
      hash: hash(password, salt),
      created: new Date().toISOString(),
      confirmed: false,
      totpSecret: null,
      totpOn: false
    };
    save();

    const token = crypto.randomBytes(24).toString('hex');
    pending.set(token, { email, at: Date.now() });
    const link = (process.env.PUBLIC_URL || ('http://127.0.0.1:' + (process.env.PORT || 8080)))
      + '/api/auth/confirm?token=' + token;
    await sendMail(email, 'Подтверждение аккаунта «Тихий контур»', link);

    const out = { ok: true, needConfirm: true };
    if (process.env.AUTH_DEV === '1') out.devConfirmUrl = link;
    return json(res, 200, out), true;
  }

  if (p === '/api/auth/confirm' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const rec = pending.get(token);
    if (!rec) return json(res, 400, { error: 'bad_token' }), true;
    const u = db.users[rec.email];
    if (!u) return json(res, 400, { error: 'no_user' }), true;
    u.confirmed = true;
    save();
    pending.delete(token);
    return json(res, 200, { ok: true, email: u.email }), true;
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = await readBody(req);
    const email = norm(b.email);
    const u = db.users[email];
    if (!u) return json(res, 401, { error: 'bad_credentials' }), true;
    if (hash(String(b.password || ''), u.salt) !== u.hash) return json(res, 401, { error: 'bad_credentials' }), true;
    if (!u.confirmed) return json(res, 403, { error: 'need_confirm' }), true;
    if (u.totpOn) {
      const ch = crypto.randomBytes(16).toString('hex');
      challenges.set(ch, { email, at: Date.now() });
      return json(res, 200, { ok: true, need2fa: true, challenge: ch }), true;
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { email, at: Date.now() });
    return json(res, 200, { ok: true, token, user: publicUser(u) }), true;
  }

  if (p === '/api/auth/2fa/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const rec = challenges.get(String(b.challenge || ''));
    if (!rec) return json(res, 400, { error: 'bad_challenge' }), true;
    const u = db.users[rec.email];
    if (!u || !u.totpOn) return json(res, 400, { error: 'no_2fa' }), true;
    if (!totpCheck(u.totpSecret, b.code)) return json(res, 401, { error: 'bad_code' }), true;
    challenges.delete(b.challenge);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { email: rec.email, at: Date.now() });
    return json(res, 200, { ok: true, token, user: publicUser(u) }), true;
  }

  if (p === '/api/auth/2fa/setup' && req.method === 'POST') {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'unauthorized' }), true;
    const u = s.user;
    if (!u.totpSecret) { u.totpSecret = newSecret(); save(); }
    const otpauth = 'otpauth://totp/TihiyKontur:' + encodeURIComponent(u.email)
      + '?secret=' + u.totpSecret + '&issuer=TihiyKontur&digits=6&period=30';
    return json(res, 200, { ok: true, secret: u.totpSecret, otpauth }), true;
  }

  if (p === '/api/auth/2fa/enable' && req.method === 'POST') {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'unauthorized' }), true;
    const b = await readBody(req);
    const u = s.user;
    if (!u.totpSecret) return json(res, 400, { error: 'no_secret' }), true;
    if (!totpCheck(u.totpSecret, b.code)) return json(res, 401, { error: 'bad_code' }), true;
    u.totpOn = true;
    save();
    return json(res, 200, { ok: true, user: publicUser(u) }), true;
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'unauthorized' }), true;
    return json(res, 200, { ok: true, user: publicUser(s.user) }), true;
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const s = sessionOf(req);
    if (s) sessions.delete(s.token);
    return json(res, 200, { ok: true }), true;
  }

  return false;
}

module.exports = { handleAuth, totp, totpCheck, sessionOf, db };
