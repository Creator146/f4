
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, clients: clients.size, rankedQueued: rankedQueue.length });
});
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function makeId(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const clients = new Map(); // ws -> { id, room, profile, rankedRoom, rankedFinished }
const rooms = new Map();   // room -> Set<ws>
const rankedQueue = [];
const rankedResults = new Map(); // room -> Map<id, place>

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function info(ws) { return clients.get(ws); }

function roomSet(room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  return rooms.get(room);
}
function broadcastRoomPeers(room) {
  const set = rooms.get(room);
  if (!set) return;
  const ids = [...set].map(ws => info(ws)?.id).filter(Boolean);
  for (const ws of set) send(ws, { t: "peers", ids });
}
function joinRoom(ws, room, msgType="joined") {
  leaveRoom(ws);
  const inf = info(ws);
  if (!inf) return;
  roomSet(room).add(ws);
  inf.room = room;
  send(ws, { t: msgType, room });
  broadcastRoomPeers(room);
}
function leaveRoom(ws) {
  const inf = info(ws);
  if (!inf || !inf.room) return;
  const room = inf.room;
  const set = rooms.get(room);
  if (set) {
    set.delete(ws);
    for (const peer of set) send(peer, { t:"left", id: inf.id });
    if (set.size === 0) rooms.delete(room);
    else broadcastRoomPeers(room);
  }
  inf.room = null;
}
function removeFromRankedQueue(ws) {
  const idx = rankedQueue.indexOf(ws);
  if (idx >= 0) rankedQueue.splice(idx, 1);
}
function currentProfile(ws) {
  const inf = info(ws);
  return inf?.profile || { name: "Driver", rating: 1000, wins:0, losses:0 };
}
function broadcastQueueStatus() {
  for (const ws of rankedQueue) {
    send(ws, { t:"queue_status", message:`Searching… ${rankedQueue.length}/3 players in queue` });
  }
}
function maybeStartRanked() {
  while (rankedQueue.length >= 3) {
    const trio = rankedQueue.splice(0, 3).filter(ws => clients.has(ws));
    if (trio.length < 3) break;
    const room = "RANKED-" + makeId(6);
    for (const ws of trio) {
      const inf = info(ws);
      inf.rankedRoom = room;
      inf.rankedFinished = false;
      joinRoom(ws, room, "joined");
    }
    rankedResults.set(room, new Map());
    for (const ws of trio) {
      const inf = info(ws);
      const opponents = trio.filter(p => p !== ws).map(p => {
        const pr = currentProfile(p);
        return { id: info(p)?.id, name: pr.name, rating: pr.rating };
      });
      send(ws, { t:"matched", room, opponents });
    }
  }
  broadcastQueueStatus();
}
function finalizeRanked(room) {
  const set = rooms.get(room);
  const results = rankedResults.get(room);
  if (!set || !results || results.size < 3) return;
  const ordered = [...results.entries()].sort((a,b)=>a[1]-b[1]); // low place better
  const deltas = [24, 8, -14];
  ordered.forEach(([id, place], idx) => {
    const ws = [...set].find(s => info(s)?.id === id);
    if (!ws) return;
    const inf = info(ws);
    const profile = currentProfile(ws);
    profile.rating = Math.max(0, (profile.rating|0) + deltas[idx]);
    if (idx === 0) profile.wins = (profile.wins|0) + 1;
    else profile.losses = (profile.losses|0) + 1;
    inf.profile = profile;
    inf.rankedRoom = null;
    inf.rankedFinished = false;
    send(ws, { t:"ranked_update", delta:deltas[idx], place: idx+1, profile });
  });
  rankedResults.delete(room);
}

wss.on("connection", (ws) => {
  const id = makeId(8);
  clients.set(ws, { id, room:null, profile:{ name:"Driver", rating:1000, wins:0, losses:0 }, rankedRoom:null, rankedFinished:false });
  send(ws, { t:"hello", id });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const inf = info(ws);
    if (!inf || !msg || typeof msg.t !== "string") return;

    if (msg.t === "profile") {
      const p = msg.profile || {};
      inf.profile = {
        name: String(p.name || inf.profile.name || "Driver").slice(0,18),
        rating: Number.isFinite(+p.rating) ? (+p.rating|0) : (inf.profile.rating|0),
        wins: Number.isFinite(+p.wins) ? (+p.wins|0) : (inf.profile.wins|0),
        losses: Number.isFinite(+p.losses) ? (+p.losses|0) : (inf.profile.losses|0)
      };
      return;
    }

    if (msg.t === "join_public") {
      removeFromRankedQueue(ws);
      joinRoom(ws, "PUBLIC", "joined_public");
      return;
    }

    if (msg.t === "create") {
      removeFromRankedQueue(ws);
      let room;
      do room = makeId(6); while (rooms.has(room));
      joinRoom(ws, room, "created");
      return;
    }

    if (msg.t === "join") {
      removeFromRankedQueue(ws);
      const room = String(msg.room || "").trim().toUpperCase();
      if (!room || !rooms.has(room)) {
        send(ws, { t:"error", message:"Room not found" });
        return;
      }
      joinRoom(ws, room, "joined");
      return;
    }

    if (msg.t === "leave") {
      removeFromRankedQueue(ws);
      leaveRoom(ws);
      send(ws, { t:"left_room" });
      return;
    }

    if (msg.t === "queue_ranked") {
      if (!rankedQueue.includes(ws)) rankedQueue.push(ws);
      send(ws, { t:"queue_status", message:`Searching… ${rankedQueue.length}/3 players in queue` });
      maybeStartRanked();
      return;
    }

    if (msg.t === "cancel_ranked") {
      removeFromRankedQueue(ws);
      send(ws, { t:"queue_status", message:"Queue cancelled" });
      broadcastQueueStatus();
      return;
    }

    if (msg.t === "state") {
      const room = inf.room;
      if (!room || !rooms.has(room)) return;
      for (const peer of rooms.get(room)) {
        if (peer !== ws) send(peer, { t:"state", from: inf.id, s: msg.s });
      }
      return;
    }

    if (msg.t === "ranked_finish") {
      const room = inf.rankedRoom || inf.room;
      if (!room) return;
      if (!rankedResults.has(room)) rankedResults.set(room, new Map());
      rankedResults.get(room).set(inf.id, Math.max(1, Number(msg.place)||3));
      inf.rankedFinished = true;
      finalizeRanked(room);
      return;
    }
  });

  ws.on("close", () => {
    removeFromRankedQueue(ws);
    leaveRoom(ws);
    clients.delete(ws);
    broadcastQueueStatus();
  });
  ws.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
