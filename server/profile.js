// Профиль игрока: инвентарь, кредиты, рекорд. Требует авторизации.
// Данные хранятся в Postgres (таблица profiles) или в users.json при локальной разработке.

const store = require('./store');
const { sessionOf } = require('./auth');

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

const EMPTY = {
  skinChar: 'field',
  skinGun: 'steel',
  owned: { char: ['field'], gun: ['steel'] },
  credits: 0,
  waveBest: 0,
  xp: 0,
  level: 1
};

// Оставляем только известные поля и валидируем типы: клиент не должен
// записывать произвольные структуры в базу.
function sanitize(input) {
  const out = Object.assign({}, EMPTY);
  if (!input || typeof input !== 'object') return out;

  if (typeof input.skinChar === 'string') out.skinChar = input.skinChar.slice(0, 24);
  if (typeof input.skinGun === 'string') out.skinGun = input.skinGun.slice(0, 24);

  const own = input.owned || {};
  out.owned = {
    char: Array.isArray(own.char) ? own.char.filter(x => typeof x === 'string').slice(0, 64).map(x => x.slice(0, 24)) : ['field'],
    gun: Array.isArray(own.gun) ? own.gun.filter(x => typeof x === 'string').slice(0, 64).map(x => x.slice(0, 24)) : ['steel']
  };
  if (!out.owned.char.includes('field')) out.owned.char.unshift('field');
  if (!out.owned.gun.includes('steel')) out.owned.gun.unshift('steel');

  const num = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : 0;
  };
  out.credits = num(input.credits, 1e9);
  out.waveBest = num(input.waveBest, 1e6);
  out.xp = num(input.xp, 1e9);
  out.level = Math.max(1, num(input.level, 1000));
  return out;
}

async function handleProfile(req, res, url) {
  const p = url.pathname;

  if (req.method === 'OPTIONS') { json(res, 204, {}); return true; }

  if (p === '/api/profile' && req.method === 'GET') {
    const s = sessionOf(req);
    if (!s) { json(res, 401, { error: 'unauthorized' }); return true; }
    const row = await store.getProfile(s.email);
    json(res, 200, { ok: true, profile: row || Object.assign({}, EMPTY), exists: !!row });
    return true;
  }

  if (p === '/api/profile' && req.method === 'POST') {
    const s = sessionOf(req);
    if (!s) { json(res, 401, { error: 'unauthorized' }); return true; }
    const body = await readBody(req);
    const clean = sanitize(body.profile || body);
    await store.saveProfile(s.email, clean);
    json(res, 200, { ok: true, profile: clean });
    return true;
  }

  return false;
}

module.exports = { handleProfile, sanitize };
