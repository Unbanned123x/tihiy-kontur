const BASE = 'http://127.0.0.1:8080';
const { totp } = require('./auth');
let pass = 0, fail = 0;
const check = (n, ok, i) => { console.log((ok?'PASS  ':'FAIL  ')+n+(i?'  ['+i+']':'')); ok?pass++:fail++; };
async function call(p, body, token) {
  const r = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({'content-type':'application/json'}, token?{authorization:'Bearer '+token}:{}),
    body: body ? JSON.stringify(body) : undefined
  });
  let d = null; try { d = await r.json(); } catch(e){}
  return { status: r.status, data: d || {} };
}
(async () => {
  const email = 'prof' + Date.now() + '@example.com';
  const reg = await call('/api/auth/register', { email, password: 'password12345' });
  await call(reg.data.devConfirmUrl.replace(BASE,''));
  const login = await call('/api/auth/login', { email, password: 'password12345' });
  const token = login.data.token;

  const empty = await call('/api/profile', null, token);
  check('профиль пустой при первом входе', empty.status === 200 && empty.data.exists === false, String(empty.status));

  const save = await call('/api/profile', { profile: { skinChar: 'gold', skinGun: 'plasma', owned: { char: ['field','gold'], gun: ['steel','plasma'] }, credits: 777, waveBest: 12 } }, token);
  check('профиль сохранён', save.status === 200 && save.data.profile.credits === 777, String(save.status));

  const read = await call('/api/profile', null, token);
  check('предметы вернулись', read.data.profile.owned.char.includes('gold') && read.data.profile.waveBest === 12, JSON.stringify(read.data.profile.owned).slice(0,50));

  const hack = await call('/api/profile', { profile: { credits: -999, owned: { char: 'взлом', gun: [] } } }, token);
  check('мусор отфильтрован', hack.data.profile.credits === 0 && hack.data.profile.owned.char.includes('field'), 'credits=' + hack.data.profile.credits);

  const noAuth = await call('/api/profile');
  check('без токена профиль недоступен', noAuth.status === 401, String(noAuth.status));

  console.log('\n' + pass + '/' + (pass+fail) + ' проверок профиля');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
