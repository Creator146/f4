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
const PUBLIC_ROOM = "PUBLIC";

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
  for (const ws of set) send(ws, { t: "peers", ids, room, publicLobby: room === PUBLIC_ROOM });
}
function ensurePublicRoom(){
  if(!rooms.has(PUBLIC_ROOM)) rooms.set(PUBLIC_ROOM, new Set());
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
      if(room !== PUBLIC_ROOM) rooms.delete(room);
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
  if(!meta || !meta.ranked || meta.finished.size < 3) return;
  const set = rooms.get(room) || new Set();
  const results = [];
  for(const ws of set){
    const info = clients.get(ws);
    if(!info) continue;
    const profile = getProfile(info.profileId || "anon", info.name || "Driver");
    const result = meta.finished.get(info.profileId || info.id) || {};
    results.push({ ws, info, profile, result, oldRating: profile.rating });
  }
  if(results.length < 3) return;
  results.sort((a,b)=>{
    const pa = Number(a.result.progress || 0), pb = Number(b.result.progress || 0);
    if(pb !== pa) return pb - pa;
    const fa = a.result.finished ? 1 : 0, fb = b.result.finished ? 1 : 0;
    if(fb !== fa) return fb - fa;
    return Number(a.result.time || 1e9) - Number(b.result.time || 1e9);
  });
  const k = 18;
  const deltas = new Map();
  const scores = new Map();
  for(const r of results){ deltas.set(r.profile.id, 0); scores.set(r.profile.id, 0); }
  for(let i=0;i<results.length;i++){
    for(let j=i+1;j<results.length;j++){
      const A = results[i].profile, B = results[j].profile;
      const ea = expectedScore(A.rating, B.rating);
      const eb = expectedScore(B.rating, A.rating);
      deltas.set(A.id, deltas.get(A.id) + k * (1 - ea));
      deltas.set(B.id, deltas.get(B.id) + k * (0 - eb));
      scores.set(A.id, scores.get(A.id) + 1);
    }
  }
  for(let i=0;i<results.length;i++){
    const r = results[i];
    r.profile.rating = Math.max(0, Math.round(r.profile.rating + deltas.get(r.profile.id)));
    if(i===0) r.profile.wins++;
    if(i===results.length-1) r.profile.losses++;
  }
  const standings = results.map((r, idx)=>({ name:r.profile.name, rating:r.profile.rating, place:idx+1, progress:Number(r.result.progress||0), time:Number(r.result.time||0) }));
  for(let i=0;i<results.length;i++){
    const r = results[i];
    send(r.ws, {
      t:"ranked_update",
      place: i+1,
      standings,
      delta: r.profile.rating - r.oldRating,
      profile: r.profile
    });
  }
  roomMeta.delete(room);
}
function tryMatchmake(){
  while(rankedQueue.length >= 3){
    const picked = [];
    while(rankedQueue.length && picked.length < 3){
      const ws = rankedQueue.shift();
      if(clients.has(ws)) picked.push(ws);
    }
    if(picked.length < 3) {
      for(const ws of picked) rankedQueue.unshift(ws);
      return;
    }
    const infos = picked.map(ws => clients.get(ws));
    infos.forEach(info => info.queueing = false);
    let room;
    do room = makeId(6); while (rooms.has(room));
    rooms.set(room, new Set(picked));
    roomMeta.set(room, { ranked:true, finished:new Map() });
    infos.forEach(info => info.room = room);
    const profilesInRoom = infos.map(info => getProfile(info.profileId || info.id, info.name || "Driver"));
    picked.forEach((ws, idx) => {
      const opponents = profilesInRoom.filter((_, i)=>i!==idx).map(p=>({ name:p.name, rating:p.rating }));
      send(ws, { t:"matched", room, opponents, minPlayers:3 });
    });
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
    if (msg.t === "join_public") {
      leaveRoom(ws);
      ensurePublicRoom();
      rooms.get(PUBLIC_ROOM).add(ws);
      info.room = PUBLIC_ROOM;
      send(ws, { t: "joined_public", room: PUBLIC_ROOM });
      broadcastRoomPeers(PUBLIC_ROOM);
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
      send(ws, { t:"queue_status", message:`Queued in public league (${rankedQueue.length} waiting / need 3 real players)`});
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
