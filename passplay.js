/* Pass-and-play (2026-11-18): several players on ONE phone. The same file in every GameNest room server that offers it.

   One socket owns several seats of a PRIVATE room it made as pass-and-play ("local": true at create). The owner's own
   seat is the one the room was created with; "addLocal" { name } seats more people through the game's own join handler
   (so names, limits and seat rules stay the game's). Every later action may carry "as": a seat INDEX. The server accepts it
   only when this socket owns the room and that seat is local; the game's own handler then runs as that seat, so "is it
   that seat's turn" stays the game's own check (nothing here knows a game).

   Never rated, never counted: ratable() in quickmatch.js says no for a local room; a local room is not a quick room and
   nobody else can join it by its code. If the phone drops, the owner's reconnect (a join with the owner's id) brings every
   local seat back at once. hook() must run first thing in the connection handler (before Quick.hook). */
"use strict";

let cfg = { rooms: null, broadcast: null, max: 4, drop: null, app: null, base: "" };
/** init() also mounts GET <base>/passplay, the answer the app asks before it shows "Play on this phone" (an old server has no such route). */
function init(opts) {
  cfg = Object.assign(cfg, opts);
  if (cfg.app && !cfg.app.__passplayRoute) {
    cfg.app.__passplayRoute = true;
    cfg.app.get((cfg.base || "") + "/passplay", (req, res) => { res.set("Cache-Control", "no-store"); res.json({ passplay: 1, max: cfg.max }); });
  }
  return module.exports;
}

/* Events that are the host's (the phone's owner) or the phone's own, never a seat's: they run as the owner. */
const NOT_AS = new Set(["create", "join", "leave", "quick", "quickCancel", "addLocal", "removeLocal", "disconnect", "pushToken", "presence", "start",
  "rematch", "settings", "gear", "setMode", "look", "fillBots", "reassign", "endGame", "addBot", "removeBot"]);
const clean = (n) => String(n == null ? "" : n).replace(/[<>&"'`]/g, "").trim().slice(0, 14);

/* Most servers keep the room code in socket.data.roomCode, some in socket.data.code (with socket.data.as, the player the socket sits as). */
const codeOf = (socket) => socket.data.roomCode || socket.data.code;
const isLocal = (room) => !!(room && room.local && room.local.owner);
const seatsOf = (room) => room.players.map((p, i) => (p.local ? i : -1)).filter((i) => i >= 0);

/** Every seat this phone plays (its own first seat included). */
function playedSeats(room) {
  const o = room.players.findIndex((p) => p.id === room.local.owner);
  return (o >= 0 ? [o] : []).concat(seatsOf(room)).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
}

/** Fields to spread into the state sent to clients. */
function view(room) {
  if (!isLocal(room)) return {};
  return { passplay: { seats: playedSeats(room) } };
}

function hook(socket) {
  socket.data = socket.data || {};
  const orig = socket.on.bind(socket);
  const roomOf = () => (cfg.rooms ? cfg.rooms.get(codeOf(socket)) : null);
  socket.on = (event, fn) => {
    if (typeof fn !== "function") return orig(event, fn);
    return orig(event, (payload, ...rest) => {
      const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
      const room = roomOf();
      if (event === "create") {
        if (!p || p.local !== true) return fn(payload, ...rest);
        const q = Object.assign({}, p); delete q.crew;   // a private room no friend joins: no crew code
        fn(q, ...rest);
        const r = roomOf();
        if (r && r.host === socket.data.playerId && r.status === "lobby" && !r.quick) { r.local = { owner: socket.data.playerId }; r.log = "Pass the phone round."; r.v = (r.v || 0) + 1; if (cfg.broadcast) cfg.broadcast(r.code); }
        return;
      }
      if (event === "join") {
        const target = p && cfg.rooms ? cfg.rooms.get(String(p.code || "").trim().toUpperCase()) : null;
        if (target && isLocal(target) && !(p.playerId && p.playerId === target.local.owner)) return socket.emit("err", "Room not found. Check the code.");
        fn(payload, ...rest);
        const r = roomOf();
        if (r && isLocal(r) && socket.data.playerId === r.local.owner) {   // the phone is back: all its seats come back together
          for (const q of r.players) if (q.local) { q.connected = true; q.left = false; }
          r.v = (r.v || 0) + 1; if (cfg.broadcast) cfg.broadcast(r.code);
        }
        return;
      }
      if (event === "leave" && isLocal(room) && socket.data.playerId === room.local.owner) {   // the phone walked away on purpose: the whole room goes (its other seats are the phone's)
        const code = room.code;
        fn(payload, ...rest);
        if (cfg.drop && cfg.rooms.get(code)) { try { cfg.drop(code); } catch (e) { console.error("passplay drop failed:", (e && e.stack) || e); } }
        return;
      }
      if (event === "disconnect" && isLocal(room) && socket.data.playerId === room.local.owner) {
        for (const q of room.players) if (q.local) q.connected = false;
        return fn(payload, ...rest);
      }
      if (!NOT_AS.has(event) && p && p.as !== undefined && isLocal(room)) {
        const owner = room.local.owner;
        const seat = Number.isInteger(p.as) ? room.players[p.as] : null;
        if (socket.data.playerId !== owner || !seat || !(seat.local || seat.id === owner)) return;   // not this phone's seat
        if (seat.id === owner) return fn(payload, ...rest);
        socket.data.playerId = seat.id;
        try { return fn(payload, ...rest); } finally { socket.data.playerId = owner; }
      }
      return fn(payload, ...rest);
    });
  };
}

/** A seat of this phone is the one to act: no turn clock runs and no bot ever takes the seat over; the game waits (the phone may be set down, passed, or reconnecting). */
function hold(room) {
  if (!isLocal(room)) return false;
  for (const k of ["phaseEndsAt", "turnEndsAt"]) if (k in room) room[k] = null;
  return true;
}
/** Turn-index games: the seat on turn is a person of this phone. */
function waits(room) {
  if (!isLocal(room) || room.status !== "playing") return false;
  const cur = room.players[room.turn];
  return !!(cur && !cur.bot && (cur.local || cur.id === room.local.owner)) && hold(room);
}

function connection(socket) {
  const h = () => socket.data.__h || {};
  const on = (event, fn) => socket.on(event, (payload) => {
    try { fn(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}); }
    catch (e) { console.error(`[${new Date().toISOString()}] ${event} failed:`, (e && e.stack) || e); }
  });
  const mine = () => { const r = cfg.rooms.get(codeOf(socket)); return r && isLocal(r) && r.local.owner === socket.data.playerId && r.status === "lobby" ? r : null; };
  on("addLocal", ({ name, avatar } = {}) => {
    const room = mine();
    if (!room || !h().join) return;
    if (room.players.length >= cfg.max) return socket.emit("err", `That is every seat (${cfg.max}).`);
    const owner = socket.data.playerId, n = room.players.length;
    const id = "loc_" + Math.random().toString(36).slice(2, 12);
    const emit = socket.emit.bind(socket);
    socket.emit = (ev, ...a) => (ev === "joined" ? true : emit(ev, ...a));   // the phone already knows its own id
    try { h().join({ code: room.code, name: clean(name) || `Player ${n + 1}`, playerId: id, avatar }); }
    finally { socket.emit = emit; socket.data.playerId = owner; if ("as" in socket.data) socket.data.as = owner; if ("roomCode" in socket.data) socket.data.roomCode = room.code; if ("code" in socket.data) socket.data.code = room.code; }
    const seat = room.players.find((p) => p.id === id);
    if (!seat) return;
    seat.local = true; seat.connected = true;
    room.v = (room.v || 0) + 1; if (cfg.broadcast) cfg.broadcast(room.code);
  });
  on("removeLocal", ({ as } = {}) => {
    const room = mine();
    if (!room || !Number.isInteger(as) || !room.players[as] || !room.players[as].local) return;
    room.players.splice(as, 1);
    room.v = (room.v || 0) + 1; if (cfg.broadcast) cfg.broadcast(room.code);
  });
}

module.exports = { init, hook, connection, view, isLocal, seatsOf, playedSeats, hold, waits };
