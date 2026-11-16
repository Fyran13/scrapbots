/* Scrapbots room server.
   Players connect over WebSocket, make or join a room by a four-letter code (up to MAX players), and the server relays
   messages between them. Each player's own browser runs its bot; the server only keeps the room list and passes messages on. */
const http = require('http');
const { WebSocketServer } = require('ws');

const MAX = 12;
const PORT = process.env.PORT || 8080;
const rooms = new Map();          // code -> { code, host, started, players: Map(id -> player) }
let nextId = 1;

// Public arenas: always open, anyone can drop in or leave at any time, no host needed.
const PUBLIC = ['PUBA', 'PUBB', 'PUBC', 'PUBD'];
PUBLIC.forEach((c, i) => rooms.set(c, { code: c, name: 'Arena ' + (i + 1), pub: true, host: 0, started: true, seed: 1000 + i, players: new Map() }));

const server = http.createServer((req, res) => {   // Render pings this to check the server is up (and to wake it)
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('scrapbots ok ' + rooms.size + ' rooms\n');
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function toRoom(room, o, exceptId) { const s = JSON.stringify(o); for (const p of room.players.values()) if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s); }
function code() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let k = 0; k < 50; k++) { let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; if (!rooms.has(c)) return c; }
  return null;
}
function clean(name) { return String(name || 'Pilot').replace(/[^\w \-.]/g, '').slice(0, 14) || 'Pilot'; }
function pub(p) { return { id: p.id, name: p.name, spec: p.spec, spawn: p.spawn }; }
function list() { return { t: 'rooms', rooms: PUBLIC.map(c => { const r = rooms.get(c); return { code: c, name: r.name, n: r.players.size, max: MAX }; }) }; }
function lobby(room) { return { t: 'lobby', code: room.code, host: room.host, started: room.started, pub: !!room.pub, players: [...room.players.values()].map(p => ({ id: p.id, name: p.name })) }; }
function sane(spec) { return spec && Array.isArray(spec.b) && spec.b.length > 0 && spec.b.length <= 400 && spec.b.every(k => Array.isArray(k) && typeof k[0] === 'string'); }

function leave(ws) {
  const room = ws.room; if (!room) return;
  room.players.delete(ws.id); ws.room = null;
  if (!room.players.size) { if (!room.pub) rooms.delete(room.code); return; }
  if (!room.pub && room.host === ws.id) room.host = room.players.keys().next().value;     // the next player takes over as host
  toRoom(room, { t: 'leave', id: ws.id });
  toRoom(room, lobby(room));
}

wss.on('connection', (ws) => {
  ws.id = nextId++; ws.alive = true; ws.room = null; ws.last = 0;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.id });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room;
    switch (m.t) {
      case 'create': case 'join': {
        if (room) return;
        if (!sane(m.spec)) return send(ws, { t: 'err', msg: 'That bot design could not be used.' });
        let r;
        if (m.t === 'create') {
          const c = code(); if (!c) return send(ws, { t: 'err', msg: 'Server is busy, try again.' });
          r = { code: c, host: ws.id, started: false, players: new Map() }; rooms.set(c, r);
        } else {
          r = rooms.get(String(m.code || '').toUpperCase().trim());
          if (!r) return send(ws, { t: 'err', msg: 'No room with that code.' });
          if (r.players.size >= MAX) return send(ws, { t: 'err', msg: 'That room is full (' + MAX + ' players).' });
        }
        ws.name = clean(m.name);
        const p = { id: ws.id, name: ws.name, spec: m.spec, spawn: Math.floor(Math.random() * 1e6), ws };
        r.players.set(ws.id, p); ws.room = r;
        send(ws, { t: 'joined', id: ws.id, code: r.code, host: r.host, pub: !!r.pub });
        toRoom(r, lobby(r));
        if (r.started) {      // joining a match already under way: send the roster, tell the others
          send(ws, { t: 'start', seed: r.seed, pub: !!r.pub, players: [...r.players.values()].map(pub) });
          toRoom(r, { t: 'peer', player: pub(p) }, ws.id);
        }
        break;
      }
      case 'start':
        if (!room || room.pub || room.host !== ws.id || room.started) return;
        room.started = true; room.seed = Math.floor(Math.random() * 1e9);
        toRoom(room, { t: 'start', seed: room.seed, players: [...room.players.values()].map(pub) });
        break;
      case 's': {      // a bot's state, many times a second: pass it straight on
        if (!room) return;
        const now = Date.now(); if (now - ws.last < 30) return; ws.last = now;
        m.id = ws.id; toRoom(room, m, ws.id); break;
      }
      case 'atk': case 'dead': case 'respawn': case 'fx':
        if (!room) return; m.id = ws.id; toRoom(room, m, ws.id); break;
      case 'hit': {    // damage dealt to one player by another
        if (!room) return; const to = room.players.get(m.to); if (!to) return;
        const dmg = Math.min(Math.max(+m.dmg || 0, 0), 3000);
        send(to.ws, { t: 'hit', from: ws.id, dmg, fx: +m.fx || 0, fz: +m.fz || 0, kb: Math.min(+m.kb || 0, 40) });
        break;
      }
      case 'list': send(ws, list()); break;
      case 'ping': send(ws, { t: 'pong', n: m.n }); break;
      case 'leave': leave(ws); break;
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

setInterval(() => {      // drop connections that stopped answering
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
}, 20000);

server.listen(PORT, () => console.log('Scrapbots server on :' + PORT));
