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

  if (p === '/api/donations/claim' && req.method === 'POST') {
    return await handleClaim(req, res);
  }

  return false;
}



// ---- магазин: пакеты монет ----
const PACKS = [
  { id: 'p500',   rub: 49,   credits: 500,   bonus: 0,    case: true  },
  { id: 'p1200',  rub: 99,   credits: 1100,  bonus: 10,   case: false },
  { id: 'p2600',  rub: 199,  credits: 2400,  bonus: 20,   case: false },
  { id: 'p6000',  rub: 399,  credits: 5200,  bonus: 30,   case: false },
  { id: 'p13000', rub: 699,  credits: 11000, bonus: 50,   case: true  }
];
const VIP = [0, 499, 1499, 2999, 5999, 9999]; // пороги в рублях -> уровень

function vipLevel(spent) {
  let lvl = 0;
  for (let i = 0; i < VIP.length; i++) if (spent >= VIP[i]) lvl = i;
  return lvl;
}

function packByAmount(rub) {
  const sorted = PACKS.slice().sort((a, b) => Math.abs(a.rub - rub) - Math.abs(b.rub - rub));
  return Math.abs(sorted[0].rub - rub) <= 5 ? sorted[0] : null;
}

// ---- донат: проверка платежа и начисление кредитов ----
const MIN_DONATION = 49;       // рублей
const CREDITS_PER_MIN = 500;   // 49 ₽ = 500 кредитов
const CREDITS_PER_RUBLE = CREDITS_PER_MIN / MIN_DONATION;

async function fetchDonations() {
  const key = process.env.DP_KEY || '';
  if (!key) return [];
  const url = 'https://donatepay.ru/api/v1/transactions?access_token=' + encodeURIComponent(key)
    + '&type=donation&limit=100&order=desc';
  const r = await fetch(url, { headers: { 'User-Agent': 'tihiy-kontur', Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.data) ? j.data : [];
}

async function handleClaim(req, res) {
  const s = sessionOf(req);
  if (!s) { json(res, 401, { error: 'unauthorized' }); return true; }

  const rows = await fetchDonations();
  const seen = await store.seenPayments();
  const email = s.email;
  let credited = 0;
  let bonusCase = false;
  let spent = 0;

  for (const t of rows) {
    const id = String(t.id || '');
    if (!id || seen.has(id)) continue;
    const msg = String(t.what || '');
    const payer = String(t.payer || '');
    if (!msg.toLowerCase().includes(email) && payer.toLowerCase() !== email) continue;

    const amount = Number(t.sum || 0);
    if (!Number.isFinite(amount) || amount < MIN_DONATION) continue;

    const pack = packByAmount(amount);
    const units = pack ? pack.credits : Math.round(amount * CREDITS_PER_RUBLE);
    credited += units;
    spent += amount;
    if (pack && pack.case) bonusCase = true;
    await store.recordPayment(id, email, amount);
  }

  let profile = (await store.getProfile(email)) || Object.assign({}, EMPTY);
  if (credited > 0) {
    profile.credits = Math.max(0, Math.min(1e9, (profile.credits || 0) + credited));
    profile.spent = Math.max(0, Math.min(1e9, (profile.spent || 0) + spent));
    if (!profile.bonusCaseUsed && bonusCase) profile.bonusCase = true;
    profile.vip = vipLevel(profile.spent || 0);
    await store.saveProfile(email, profile);
  }

  json(res, 200, {
    ok: true,
    credited,
    credits: profile.credits || 0,
    spent: profile.spent || 0,
    vip: profile.vip || 0,
    bonusCase: !!profile.bonusCase,
    packs: PACKS,
    minDonation: MIN_DONATION
  });
  return true;
}

module.exports = { handleProfile, handleClaim, sanitize, PACKS, vipLevel };
