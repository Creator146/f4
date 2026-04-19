const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

const clients = new Map(); // ws -> { id, room, queueing, profileId }
const rooms = new Map();   // room -> Set<ws>
const roomMeta = new Map(); // room -> { ranked:boolean, finished:Map<profileId,result> }
const profiles = new Map(); // profileId -> { id,name,rating,wins,losses }
const rankedQueue = [];

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, clients: clients.size, queue: rankedQueue.length, profiles: profiles.size });
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
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function getProfile(profileId, fallbackName="Driver"){
  let p = profiles.get(profileId);
  if(!p){
    p = { id: profileId, name: fallbackName.slice(0,18), rating: 1000, wins:0, losses:0 };
    profiles.set(profileId, p);
  }
  return p;
}
function broadcastRoomPeers(room) {
  const set = rooms.get(room);
  if (!set) return;
  const ids = [...set].map(ws => clients.get(ws)?.id).filter(Boolean);
  for (const ws of set) send(ws, { t: "peers", ids });
}
function removeFromQueue(ws){
  const idx = rankedQueue.indexOf(ws);
  if(idx >= 0) rankedQueue.splice(idx,1);
  const info = clients.get(ws);
  if(info) info.queueing = false;
}
function leaveRoom(ws) {
  removeFromQueue(ws);
  const info = clients.get(ws);
  if (!info || !info.room) return;
  const room = info.room;
  const set = rooms.get(room);
  if (set) {
    set.delete(ws);
    for (const peer of set) send(peer, { t: "left", id: info.id });
    if (set.size === 0) {
      rooms.delete(room);
      roomMeta.delete(room);
    } else {
      broadcastRoomPeers(room);
    }
  }
  info.room = null;
}
function expectedScore(a,b){ return 1/(1+Math.pow(10,(b-a)/400)); }
function applyRanked(room){
  const meta = roomMeta.get(room);
  if(!meta || !meta.ranked || meta.finished.size < 2) return;
  const entries = [...meta.finished.entries()];
  const [pa, ra] = entries[0];
  const [pb, rb] = entries[1];
  const A = getProfile(pa), B = getProfile(pb);
  let scoreA = 0.5, scoreB = 0.5, resultA = "Draw", resultB = "Draw";
  if(ra.finished && rb.finished){
    if(ra.time < rb.time){ scoreA = 1; scoreB = 0; resultA = "Victory"; resultB = "Defeat"; }
    else if(rb.time < ra.time){ scoreA = 0; scoreB = 1; resultA = "Defeat"; resultB = "Victory"; }
  } else if((ra.progress||0) > (rb.progress||0)) { scoreA = 1; scoreB = 0; resultA = "Victory"; resultB = "Defeat"; }
  else if((rb.progress||0) > (ra.progress||0)) { scoreA = 0; scoreB = 1; resultA = "Defeat"; resultB = "Victory"; }
  const k = 32;
  const ea = expectedScore(A.rating, B.rating);
  const eb = expectedScore(B.rating, A.rating);
  const oldA = A.rating, oldB = B.rating;
  A.rating = Math.max(0, Math.round(A.rating + k * (scoreA - ea)));
  B.rating = Math.max(0, Math.round(B.rating + k * (scoreB - eb)));
  if(scoreA===1){ A.wins++; B.losses++; }
  else if(scoreB===1){ B.wins++; A.losses++; }
  const set = rooms.get(room) || new Set();
  for(const ws of set){
    const info = clients.get(ws);
    const profile = getProfile(info.profileId || "anon");
    const isA = profile.id === A.id;
    send(ws, {
      t:"ranked_update",
      result: isA ? resultA : resultB,
      delta: isA ? (A.rating-oldA) : (B.rating-oldB),
      profile: isA ? A : B
    });
  }
  roomMeta.delete(room);
}
function tryMatchmake(){
  while(rankedQueue.length >= 2){
    const a = rankedQueue.shift();
    const b = rankedQueue.shift();
    if(!clients.has(a) || !clients.has(b)) continue;
    const ai = clients.get(a), bi = clients.get(b);
    ai.queueing = bi.queueing = false;
    let room;
    do room = makeId(6); while (rooms.has(room));
    rooms.set(room, new Set([a,b]));
    roomMeta.set(room, { ranked:true, finished:new Map() });
    ai.room = room; bi.room = room;
    const ap = getProfile(ai.profileId || ai.id, ai.name || "Driver A");
    const bp = getProfile(bi.profileId || bi.id, bi.name || "Driver B");
    send(a, { t:"matched", room, opponent:{ name: bp.name, rating: bp.rating } });
    send(b, { t:"matched", room, opponent:{ name: ap.name, rating: ap.rating } });
    broadcastRoomPeers(room);
  }
}

wss.on("connection", (ws) => {
  const id = makeId(8);
  clients.set(ws, { id, room: null, queueing:false, profileId:id, name:"Driver" });
  send(ws, { t: "hello", id });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const info = clients.get(ws);
    if (!info) return;

    if(msg.t === "profile"){
      const incoming = msg.profile || {};
      const profileId = String(incoming.id || info.id).slice(0,32);
      const name = String(incoming.name || "Driver").trim().slice(0,18) || "Driver";
      info.profileId = profileId;
      info.name = name;
      const p = getProfile(profileId, name);
      p.name = name;
      send(ws, { t:"profile_ok", profile:p });
      return;
    }
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
    if(msg.t === "queue_ranked"){
      leaveRoom(ws);
      removeFromQueue(ws);
      info.queueing = true;
      rankedQueue.push(ws);
      send(ws, { t:"queue_status", message:`Queued (${rankedQueue.length} waiting)`});
      tryMatchmake();
      return;
    }
    if(msg.t === "cancel_queue"){
      removeFromQueue(ws);
      send(ws, { t:"queue_status", message:"Queue cancelled"});
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
    if(msg.t === "ranked_result"){
      const room = String(msg.room || info.room || "");
      const meta = roomMeta.get(room);
      if(!meta || !meta.ranked) return;
      meta.finished.set(info.profileId || info.id, msg.result || {});
      applyRanked(room);
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
