// Contrail.io room relay.
// The room host's phone runs the whole game; this server only creates rooms, admits players,
// and forwards messages: guest -> host (inputs) and host -> guests (snapshots, events).
//
// Seats survive a dropped connection for AWAY_MS. Phones suspend the page when you switch apps
// (say, to text the room code), so a player who drops is marked away, not removed. They come back
// with { t:'resume', code, id, key } and keep their seat, even after the page reloads.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const MAX_PLAYERS = 8;                       // host + 7 guests
const AWAY_MS = +process.env.AWAY_MS || 120000;   // how long a seat waits for its player to come back
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // no I or O, so codes are easy to read aloud
const rooms = new Map();                     // code -> { code, host: seat, guests: Map(id -> seat), started }
let nextId = 1;

const server = http.createServer((req, res) => {
  // Railway health check and a quick way to see it's alive
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

function sendWs(ws, msg){ if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
const send = (seat, msg) => seat && sendWs(seat.ws, msg);
function newCode(){
  for (let tries = 0; tries < 200; tries++){
    let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no free room codes');
}
function roster(room){
  const list = [{ id: room.host.id, name: room.host.name, host: true, away: !room.host.ws }];
  for (const g of room.guests.values()) list.push({ id: g.id, name: g.name, host: false, away: !g.ws });
  return list;
}
function broadcastRoster(room){
  const msg = JSON.stringify({ t: 'roster', players: roster(room), started: room.started });
  send(room.host, msg); for (const g of room.guests.values()) send(g, msg);
}
function toGuests(room, msg){ const s = typeof msg === 'string' ? msg : JSON.stringify(msg); for (const g of room.guests.values()) send(g, s); }
function cleanName(n){ return String(n || '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim().slice(0, 10) || 'PILOT'; }
function newSeat(ws, name){ return { id: nextId++, key: crypto.randomBytes(12).toString('hex'), name: cleanName(name), ws, awayTimer: null }; }
function attach(ws, room, seat, isHost){ ws.room = room.code; ws.seat = seat; ws.isHost = isHost; seat.ws = ws; clearTimeout(seat.awayTimer); seat.awayTimer = null; }

function closeRoom(room){
  toGuests(room, { t: 'host-left' });
  for (const g of room.guests.values()){ clearTimeout(g.awayTimer); if (g.ws) g.ws.room = null; }
  clearTimeout(room.host.awayTimer); if (room.host.ws) room.host.ws.room = null;
  rooms.delete(room.code);
}
function dropGuest(room, seat){
  clearTimeout(seat.awayTimer);
  if (!room.guests.delete(seat.id)) return;
  if (seat.ws) seat.ws.room = null;
  send(room.host, { t: 'guest-leave', id: seat.id });
  broadcastRoster(room);
}

wss.on('connection', (ws) => {
  ws.room = null; ws.seat = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const room = ws.room ? rooms.get(ws.room) : null;

    if (m.t === 'create' && !ws.room){
      const code = newCode(), seat = newSeat(ws, m.name), r = { code, host: seat, guests: new Map(), started: false };
      rooms.set(code, r); attach(ws, r, seat, true);
      sendWs(ws, { t: 'created', code, id: seat.id, key: seat.key });
      broadcastRoster(r);
      return;
    }
    if (m.t === 'join' && !ws.room){
      const code = String(m.code || '').toUpperCase().trim(), r = rooms.get(code);
      if (!r) return sendWs(ws, { t: 'error', code: 'no_room', message: 'No room with that code. Check the letters with your friend.' });
      if (r.guests.size + 1 >= MAX_PLAYERS) return sendWs(ws, { t: 'error', code: 'full', message: 'That room is full (8 pilots).' });
      const seat = newSeat(ws, m.name);
      r.guests.set(seat.id, seat); attach(ws, r, seat, false);
      sendWs(ws, { t: 'joined', code, id: seat.id, key: seat.key, hostId: r.host.id, started: r.started });
      send(r.host, { t: 'guest-join', id: seat.id, name: seat.name });
      broadcastRoster(r);
      return;
    }
    if (m.t === 'resume' && !ws.room){
      // a player whose connection dropped takes their seat back
      const r = rooms.get(String(m.code || '').toUpperCase());
      const seat = r && (r.host.id === m.id ? r.host : r.guests.get(m.id));
      if (!seat || seat.key !== m.key) return sendWs(ws, { t: 'error', code: 'gone', message: 'That room closed while you were away.' });
      const isHost = seat === r.host;
      if (seat.ws && seat.ws !== ws){ seat.ws.room = null; try { seat.ws.close(); } catch (e) {} }   // an older socket for the same seat
      attach(ws, r, seat, isHost);
      sendWs(ws, { t: 'resumed', code: r.code, id: seat.id, host: isHost, started: r.started, players: roster(r) });
      if (isHost) toGuests(r, { t: 'host-back' });
      else send(r.host, { t: 'guest-back', id: seat.id, name: seat.name });
      broadcastRoster(r);
      return;
    }
    if (!room) return;

    if (m.t === 'leave'){
      // left on purpose: no waiting around
      if (ws.isHost) closeRoom(room); else dropGuest(room, ws.seat);
      ws.room = null; return;
    }
    if (ws.isHost){
      if (m.t === 'start'){ room.started = true; broadcastRoster(room); }
      // host -> one guest, or host -> all guests (snapshots, events)
      if (m.to){ const g = room.guests.get(m.to); if (g) send(g, raw.toString()); }
      else toGuests(room, raw.toString());
    } else {
      // guest -> host only, stamped with who sent it
      m.from = ws.seat.id; send(room.host, m);
    }
  });

  ws.on('close', () => {
    const room = ws.room ? rooms.get(ws.room) : null, seat = ws.seat;
    if (!room || !seat || seat.ws !== ws) return;
    seat.ws = null;
    if (ws.isHost){
      toGuests(room, { t: 'host-away' });
      seat.awayTimer = setTimeout(() => closeRoom(room), AWAY_MS);
    } else {
      send(room.host, { t: 'guest-away', id: seat.id });
      seat.awayTimer = setTimeout(() => dropGuest(room, seat), AWAY_MS);
    }
    broadcastRoster(room);
  });
});

// drop dead connections (phone locked, signal lost); their seats then wait AWAY_MS for them
setInterval(() => {
  for (const ws of wss.clients){
    if (!ws.isAlive){ ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) {}
  }
}, 15000);

server.listen(PORT, () => console.log(`contrail relay listening on ${PORT}`));
