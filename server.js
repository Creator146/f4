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
  res.json({ ok: true, rooms: rooms.size, clients: clients.size });
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

const clients = new Map(); // ws -> { id, room }
const rooms = new Map();   // room -> Set<ws>

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastRoomPeers(room) {
  const set = rooms.get(room);
  if (!set) return;
  const ids = [...set].map(ws => clients.get(ws)?.id).filter(Boolean);
  for (const ws of set) send(ws, { t: "peers", ids });
}

function leaveRoom(ws) {
  const info = clients.get(ws);
  if (!info || !info.room) return;
  const room = info.room;
  const set = rooms.get(room);
  if (set) {
    set.delete(ws);
    for (const peer of set) send(peer, { t: "left", id: info.id });
    if (set.size === 0) rooms.delete(room);
    else broadcastRoomPeers(room);
  }
  info.room = null;
}

wss.on("connection", (ws) => {
  const id = makeId(8);
  clients.set(ws, { id, room: null });
  send(ws, { t: "hello", id });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const info = clients.get(ws);
    if (!info) return;

    if (msg.t === "create") {
      leaveRoom(ws);
      let room;
      do room = makeId(6);
      while (rooms.has(room));
      rooms.set(room, new Set([ws]));
      info.room = room;
      send(ws, { t: "created", room });
      broadcastRoomPeers(room);
      return;
    }

    if (msg.t === "join") {
      const room = String(msg.room || "").toUpperCase().trim();
      if (!room || !rooms.has(room)) {
        send(ws, { t: "error", message: "Room not found" });
        return;
      }
      leaveRoom(ws);
      rooms.get(room).add(ws);
      info.room = room;
      send(ws, { t: "joined", room });
      broadcastRoomPeers(room);
      return;
    }

    if (msg.t === "leave") {
      leaveRoom(ws);
      send(ws, { t: "left_room" });
      return;
    }

    if (msg.t === "state") {
      const room = info.room;
      if (!room || !rooms.has(room)) return;
      for (const peer of rooms.get(room)) {
        if (peer !== ws) send(peer, { t: "state", from: info.id, s: msg.s });
      }
      return;
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
