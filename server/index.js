// Contrail.io room relay.
// The room host's phone runs the whole game; this server only creates rooms, admits players,
// and forwards messages: guest -> host (inputs) and host -> guests (snapshots, events).
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const MAX_PLAYERS = 8;                       // host + 7 guests
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // no I or O, so codes are easy to read aloud
const rooms = new Map();                     // code -> { host, guests: Map(id -> ws), started }
let nextId = 1;

const server = http.createServer((req, res) => {
  // Railway health check and a quick way to see it's alive
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

function send(ws, msg){ if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function newCode(){
  for (let tries = 0; tries < 200; tries++){
    let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no free room codes');
}
function roster(room){
  const list = [{ id: room.host.id, name: room.host.name, host: true }];
  for (const g of room.guests.values()) list.push({ id: g.id, name: g.name, host: false });
  return list;
}
function broadcastRoster(room){
  const msg = JSON.stringify({ t: 'roster', players: roster(room), started: room.started });
  send(room.host, msg); for (const g of room.guests.values()) send(g, msg);
}
function cleanName(n){ return String(n || '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim().slice(0, 10) || 'PILOT'; }

wss.on('connection', (ws) => {
  ws.id = nextId++; ws.room = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const room = ws.room ? rooms.get(ws.room) : null;

    if (m.t === 'create' && !ws.room){
      const code = newCode();
      ws.name = cleanName(m.name); ws.room = code; ws.isHost = true;
      rooms.set(code, { host: ws, guests: new Map(), started: false });
      send(ws, { t: 'created', code, id: ws.id });
      broadcastRoster(rooms.get(code));
      return;
    }
    if (m.t === 'join' && !ws.room){
      const code = String(m.code || '').toUpperCase().trim(), r = rooms.get(code);
      if (!r) return send(ws, { t: 'error', code: 'no_room', message: 'No room with that code. Check the letters with your friend.' });
      if (r.guests.size + 1 >= MAX_PLAYERS) return send(ws, { t: 'error', code: 'full', message: 'That room is full (8 pilots).' });
      ws.name = cleanName(m.name); ws.room = code; ws.isHost = false;
      r.guests.set(ws.id, ws);
      send(ws, { t: 'joined', code, id: ws.id, hostId: r.host.id, started: r.started });
      send(r.host, { t: 'guest-join', id: ws.id, name: ws.name });
      broadcastRoster(r);
      return;
    }
    if (!room) return;

    if (ws.isHost){
      if (m.t === 'start'){ room.started = true; broadcastRoster(room); }
      // host -> one guest, or host -> all guests (snapshots, events)
      if (m.to){ const g = room.guests.get(m.to); if (g) send(g, raw.toString()); }
      else if (m.t !== 'start'){ const s = raw.toString(); for (const g of room.guests.values()) send(g, s); }
      if (m.t === 'start'){ const s = raw.toString(); for (const g of room.guests.values()) send(g, s); }
    } else {
      // guest -> host only, stamped with who sent it
      m.from = ws.id; send(room.host, m);
    }
  });

  ws.on('close', () => {
    const room = ws.room ? rooms.get(ws.room) : null;
    if (!room) return;
    if (ws.isHost){
      for (const g of room.guests.values()){ send(g, { t: 'host-left' }); g.room = null; }
      rooms.delete(ws.room);
    } else {
      room.guests.delete(ws.id);
      send(room.host, { t: 'guest-leave', id: ws.id });
      broadcastRoster(room);
    }
  });
});

// drop dead connections (phone locked, signal lost) so rooms don't fill with ghosts
setInterval(() => {
  for (const ws of wss.clients){
    if (!ws.isAlive){ ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  }
}, 15000);

server.listen(PORT, () => console.log(`contrail relay listening on ${PORT}`));
