// «Тихий контур» — сервер комнат для кооператива.
// Без зависимостей: только Node.js (http, crypto). WebSocket реализован вручную.
// Запуск: node server/index.js   (порт 8080)

const http = require('http');
const crypto = require('crypto');
const { handleAuth } = require('./auth');

const PORT = process.env.PORT || 8080;
const rooms = new Map();       // code -> { clients: Set<Client>, host: Client }
const clients = new Set();

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer, onMessage) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;

    if (len === 126) {
      if (p + 2 > buffer.length) break;
      len = buffer.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (p + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(p)); p += 8;
    }

    let mask = null;
    if (masked) {
      if (p + 4 > buffer.length) break;
      mask = buffer.slice(p, p + 4); p += 4;
    }
    if (p + len > buffer.length) break;

    const data = buffer.slice(p, p + len);
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];

    if (opcode === 0x8) { onMessage(null, true); }
    else if (opcode === 0x1 || opcode === 0x2) { onMessage(data.toString('utf8'), false); }

    offset = p + len;
  }
  return buffer.slice(offset);
}

function send(client, obj) {
  if (client.socket.destroyed) return;
  try { client.socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) {}
}

function roomBroadcast(code, obj, except) {
  const room = rooms.get(code);
  if (!room) return;
  for (const c of room.clients) if (c !== except) send(c, obj);
}

function leaveRoom(client) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (room) {
    room.clients.delete(client);
    roomBroadcast(client.room, { t: 'leave', id: client.id });
    if (room.clients.size === 0) rooms.delete(client.room);
    else if (room.host === client) {
      room.host = room.clients.values().next().value;
      send(room.host, { t: 'host' });
    }
  }
  client.room = null;
}


// ---- донаты: прокси к DonatePay с кэшем -------------------------------------------------
const DP_KEY = process.env.DP_KEY || '';
let donationsCache = { at: 0, body: { updated: '', top: [], latest: [] } };

function buildDonations(rows) {
  const totals = new Map();
  const latest = [];
  for (const r of rows) {
    const amount = Number(r.sum || 0);
    const name = String(r.payer || '').trim() || 'Аноним';
    totals.set(name, (totals.get(name) || 0) + amount);
    latest.push({ name, amount, date: String(r.date || '').slice(0, 10) });
  }
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }));
  return {
    updated: new Date().toISOString().slice(0, 10),
    top,
    latest: latest.slice(0, 8)
  };
}

function refreshDonations() {
  if (!DP_KEY) return Promise.resolve(donationsCache.body);
  const url = 'https://donatepay.ru/api/v1/transactions?access_token=' + encodeURIComponent(DP_KEY)
    + '&type=donation&limit=50&order=desc';
  return fetch(url, { headers: { 'User-Agent': 'tihiy-kontur', Accept: 'application/json' } })
    .then(r => r.json())
    .then(data => {
      const rows = (data && data.data) || [];
      donationsCache = { at: Date.now(), body: buildDonations(rows) };
      return donationsCache.body;
    })
    .catch(() => donationsCache.body);
}

const server = http.createServer(async (req, res) => {
  const _url = new URL(req.url, 'http://localhost');
  if (await handleAuth(req, res, _url)) return;
  if (req.url.startsWith('/api/donations')) {
    const fresh = Date.now() - donationsCache.at < 60000;
    const send = body => {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=60'
      });
      res.end(JSON.stringify(body));
    };
    if (fresh) { send(donationsCache.body); return; }
    refreshDonations().then(send).catch(() => send(donationsCache.body));
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: clients.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Tihiy Kontur server\nrooms: ' + rooms.size + '\nplayers: ' + clients.size + '\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const client = { id: crypto.randomBytes(4).toString('hex'), socket, room: null, name: 'player' };
  clients.add(client);

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    buf = decodeFrames(buf, (msg, close) => {
      if (close) { socket.end(); return; }
      let data;
      try { data = JSON.parse(msg); } catch (e) { return; }

      if (data.t === 'join') {
        const code = String(data.room || '').toUpperCase().slice(0, 6) || 'MAIN';
        leaveRoom(client);
        if (!rooms.has(code)) rooms.set(code, { clients: new Set(), host: client });
        const room = rooms.get(code);
        if (room.clients.size >= 4) { send(client, { t: 'full' }); return; }
        room.clients.add(client);
        client.room = code;
        client.name = String(data.name || 'player').slice(0, 16);
        send(client, { t: 'joined', id: client.id, room: code, host: room.host === client });
        roomBroadcast(code, { t: 'peer', id: client.id, name: client.name }, client);
        const peers = [];
        for (const c of room.clients) if (c !== client) peers.push({ id: c.id, name: c.name });
        send(client, { t: 'peers', list: peers });
        roomBroadcast(code, { t: 'peer', id: client.id, name: client.name }, client);
      } else if (data.t === 'state' && client.room) {
        roomBroadcast(client.room, {
          t: 'state', id: client.id,
          x: Math.round(data.x), y: Math.round(data.y),
          a: Math.round((data.a || 0) * 100) / 100,
          w: data.wave || 0, hp: data.hp || 0, dead: !!data.dead
        }, client);
      } else if (data.t === 'event' && client.room) {
        roomBroadcast(client.room, { t: 'event', id: client.id, kind: data.kind, x: data.x, y: data.y }, client);
      } else if (data.t === 'ping') {
        send(client, { t: 'pong' });
      }
    });
  });

  socket.on('close', () => { leaveRoom(client); clients.delete(client); });
  socket.on('error', () => { leaveRoom(client); clients.delete(client); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('TIHIY KONTUR server on http://0.0.0.0:' + PORT);
  console.log('health: /health');
});
