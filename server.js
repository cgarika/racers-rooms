/* Toy Racers Rooms: self-hosted live toy-car racing for two to four (GameNest's `racers`, dev port 3131).

   Same shape as the other GameNest game servers: rooms behind a 6-letter code, bots fill the empty seats, a seat that goes quiet is driven by the bot
   brain. The server runs the whole race LIVE: a fixed 120 Hz physics step (physics.js) for every room that is racing, the players' steering arriving as
   `in` events (a steer -1..1 and the client's own step count, so the app can reconcile its prediction), and a `snap` event 30 times a second carrying
   every car. Pass-and-play (a room made with `local: true`) is a time trial in turns: one car alone on the track, the phone passed round, best lap wins.
   README.md has the wire. */

const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const Sim = require("./physics");
const Bots = require("./bots");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Voice = require("./voice");   // voice chat in private rooms, EOS (2026-11-18; the file every server shares)
const Played = require("./friendsplayed");   // Friends: "last played with" when a game ends (2026-11-19; the file every server shares)
const Quick = require("./quickmatch");   // quick play and ranked (2026-10-24)
const PassPlay = require("./passplay");   // several players on one phone (2026-11-18)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)
const Gear = require("./gear");   // gear: the one table and its effects (gear step 5, 2026-11-21)
const Moderation = require("./moderation");   // what players type, kept friendly (2026-10-18)

const app = express();
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const PING = {};
if (Number(process.env.PING_INTERVAL_MS) > 0) PING.pingInterval = Number(process.env.PING_INTERVAL_MS);
if (Number(process.env.PING_TIMEOUT_MS) > 0) PING.pingTimeout = Number(process.env.PING_TIMEOUT_MS);
const io = new Server(server, { path: BASE + "/socket.io", cors: { origin: true }, ...PING });

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const TEST_HOOKS = process.env.TEST_HOOKS === "1";
/* The clocks, in ms. SIM_SPEED > 1 runs the world faster than real time (tests only). */
const SIM_SPEED = Math.max(0.1, Number(process.env.SIM_SPEED || 1));
const COUNTDOWN_MS = Math.max(50, Number(process.env.COUNTDOWN_MS || 3200));   // 3, 2, 1, GO
const FINISH_GRACE_MS = Math.max(50, Number(process.env.FINISH_GRACE_MS || 12000)); // after the first car is home the rest have this long
const HUMANS_HOME_MS = Math.max(50, Number(process.env.HUMANS_HOME_MS || 2500));    // everyone who is a person is home: the bots are not waited for
const HANDOFF_MS = Math.max(50, Number(process.env.HANDOFF_MS || 1500));            // a time trial: the finished car is shown this long before the phone is passed
const AFK_MS = Math.max(300, Number(process.env.AFK_MS || 8000));              // a hand that sends nothing this long is driven by a bot
const ROOM_IDLE_MS = 2 * 3600e3;
const TRIAL_MAX_S = Math.max(1, Number(process.env.TRIAL_MAX_S || 75));          // a time trial's turn: this many seconds a lap at most, then it is given up
const SNAP_EVERY = Math.max(1, Number(process.env.SNAP_EVERY || 4));            // one snapshot every 4 steps of 1/120 s: 30 a second
const NAME_GRAPHEMES = 18;             // one cap on every GameNest server, in whole characters
/* What an app may say it knows ("caps" on create and join). "grid4" (qa1126): the wide tracks with walls and four cars abreast on the line (physics.js geometry 2). */
const CAPS = ["grid4"];
const LAPS = [1, 2, 3, 5];
const TRACKS = ["bath", "kitchen", "toyroom"];   // Bathtub Grand Prix (free), Breakfast Speedway and Midnight Toy Room (GameNest Plus)
const LEVELS = Bots.LEVELS;

const BOT_NAMES = { easy: ["Pebble", "Bolt", "Sprocket"], normal: ["Zippy", "Skid", "Nitro"], hard: ["Turbo", "Blitz", "Vroom"] };
const AVATARS = ["\u{1F60E}", "\u{1F913}", "\u{1F451}", "\u{1F42F}", "\u{1F43C}", "\u{1F98A}"];
const CODE_ALPHABET = "ABCDEFGHJKMNPRTWXYZ";

const rooms = new Map();
app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
/* GameNest Plus: a player says on create and join that they own Plus; a room
   whose host owns it is a Plus room, and every client shows its extras.
   The client's word is taken for now (checking Apple's receipt is a later step). */
function stampPlus(code, socket, said) {
  const room = rooms.get(code);
  const p = room && socket && socket.data && room.players.find((q) => q.id === socket.data.playerId);
  if (p) { Plus.stampFor(p, said, socket); Plus.dedupe(room, p); }
}
const roomSockets = new Map();

const newId = () => crypto.randomBytes(8).toString("hex");
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
function clearT(map, code) { const t = map.get(code); if (t) { clearTimeout(t); map.delete(code); } }

/* A payload is an object or nothing. `42["create",null]` used to throw inside the
   handler and take the whole process, and every room in it, down. */
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

/* ---------- text ---------- */

/* A string, whatever arrives: a string, a number or a boolean as itself, anything else (an object with a hostile
   toString, an array) as nothing. String() on `{toString: 1}` throws. */
const text = (s) => (typeof s === "string" ? s : typeof s === "number" || typeof s === "boolean" ? String(s) : "");

const SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/* At most `max` whole characters (grapheme clusters: an emoji with its skin tone, a flag,
   a letter and its accents) in at most `units` UTF-16 units, never cutting one in half. */
function graphemes(s, max, units) {
  s = text(s);
  if (s.length > 4 * units) s = s.slice(0, 4 * units);    // bounds the work on a 100 KB name
  let out = "", n = 0;
  const parts = SEGMENTER ? Array.from(SEGMENTER.segment(s), (x) => x.segment) : Array.from(s);
  for (const g of parts) {
    if (n >= max || out.length + g.length > units) break;
    out += g; n++;
  }
  return out;
}
const strip = (s) => text(s).replace(/[<>&"'`\u0000-\u001f\u007f]/g, "").trim();
const cleanName = (s) => { const c = graphemes(strip(s), NAME_GRAPHEMES, 96).trim(); return c ? Moderation.name(c) : c; };   // a bad name is "Player"
const cleanAvatar = (s) => graphemes(strip(s), 1, 16);
const cleanId = (s) => (typeof s === "string" && s.length > 0 && s.length <= 128 ? s : null);
const cleanCaps = (c) => (Array.isArray(c) ? CAPS.filter((k) => c.includes(k)) : []);

/* A refusal: today's words for today's app, and a code a newer one can switch on without
   reading English. The code rides as a second argument, which an app that reads only the
   first never sees. Codes: not_found, started, full, name, nobody. */
function refuse(socket, op, code, message) { socket.emit("err", message, { code, op }); }

/* ---------- chat, voice and push ----------

   Copied from the other room servers rather than reinvented, because a client that already
   speaks them must not find another that is subtly different. */

const CHAT_KEEP = 60;
const CHAT_COOLDOWN_MS = 800;
const STICKERS = ["lol","cry","fire","dice","snail","devil","pray","skull","party","angry","pinch","run"];
const cleanChat = (n) => graphemes(text(n).replace(/[<>&"'`]/g, "").trim(), 140, 140);

const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TITLE = "Toy Racers";

function pushTo(p, body, data, collapse) {
  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;
  // only someone who cannot see the screen
  if (!(p.away || !p.connected)) return;
  const now = Date.now();
  if (p._lastPush && now - p._lastPush < 4000) return;
  p._lastPush = now;
  fetch(PUSH_URL + "/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }),
  }).catch(() => {});
}


const clampN = (v) => Math.max(-500, Math.min(500, v));

/* ---------- room shape ---------- */

function newRoom(code, host) {
  return {
    v: 1, code, host, status: "lobby",
    gearOn: true,                  // the host's gear switch (private rooms); quick and ranked rooms always play with gear
    players: [],
    opts: { laps: 3, track: "bath" },       // the host's choices
    phase: "lobby",                // lobby, countdown, race, handoff (a time trial between turns), over
    phaseEndsAt: null,             // server ms
    phaseLeft: 0,                  // the same, as sim ms still to run (the loop's own clock)
    world: null,
    tick: 0,
    places: [],                    // seats, first first (when the race is over, or as it stands)
    winner: null,
    log: "Share the code with your friends.",
    chat: [],
    round: 0,
    acc: 0, lastAt: 0, ev: [],
    firstHomeAt: 0,
    touched: Date.now(),
  };
}

/* ---------- gear (gear.js, gear step 5) ---------- */
/* A seat's gear does its work when the room's gear switch is on and a person plays the seat. A bot's gear (and a person a bot plays for) is only the score it shows: it plays the base game. */
const gearOf = (room, p) => (room.gearOn !== false && p && !p.bot && !p.botControlled && !p.left && p.gear ? Gear.racersEffects(p.gear.stats) : null);
const gearView = (room, p) => (p && p.gear ? { score: p.gear.score, items: Object.fromEntries(Object.entries(p.gear.slots).map(([k, v]) => [k, v.item])), levels: Object.fromEntries(Object.entries(p.gear.slots).map(([k, v]) => [k, v.level])), stats: room.gearOn !== false ? p.gear.stats : { speed: 0, grip: 0, boost: 0 } } : null);
/* The bots' gear fits the humans' band: the mean of the humans' gear scores, and none when no human sent any (old apps: everyone at the base). */
function botGearFor(room) {
  const hs = room.players.filter((p) => !p.bot);
  if (!hs.length || !hs.some((p) => p.gear)) return null;
  return Gear.botGear("racers", Math.round(hs.reduce((n, p) => n + Gear.scoreFor(p.gear, "racers"), 0) / hs.length));
}
function gearBots(room) { for (const p of room.players) if (p.bot) p.gear = botGearFor(room); }

function publicRoom(room) {
  const now = Date.now();
  const w = room.world;
  return {
    code: room.code, status: room.status,
    players: room.players.map((p) => ({
      name: p.name, avatar: p.avatar, ...Plus.seat(p), bot: !!p.bot, ...(p.bot ? { level: p.level } : {}), gear: gearView(room, p),
      botControlled: !!p.botControlled, left: p.left, connected: p.connected, local: !!p.local,
    })),
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    gearOn: room.gearOn !== false,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    opts: { laps: room.opts.laps, track: room.opts.track },
    track: trackView(room),
    phase: room.phase, phaseEndsAt: room.phaseEndsAt,
    places: room.places, winner: room.winner,
    results: (room.results || []).map((r) => ({ seat: r.seat, ms: r.ms, best: r.best })),
    ...(room.trial ? { trial: { order: room.trial.order, turn: room.trial.turn, seat: room.trial.order[room.trial.turn] != null ? room.trial.order[room.trial.turn] : -1 } } : {}),
    log: room.log, chat: room.chat, voice: room.voice ? Array.from(room.voice) : [],
    serverNow: now, tick: room.tick,
    v: room.v,
    ...Reactions.view(room),
    ...Quick.view(room),
    ...Voice.view(room),   // voice chat (2026-11-18): gnVoice { on, peers }
    ...Played.view(room, "racers"),   // Friends (2026-11-19): reports a finished game once; adds no field
    ...PassPlay.view(room),   // pass-and-play: which seats this phone plays
  };
}

/* The geometry a race in this room plays (physics.js): the wide one, with walls and four abreast on the line, when every person in the room has an app that knows it
   ("grid4" in its caps); else the first one, which every app knows. A race keeps the geometry it started with. */
function geoFor(room) {
  const people = room.players.filter((p) => !p.bot && !p.local && !p.left);
  return people.length > 0 && people.every((p) => Array.isArray(p.caps) && p.caps.includes("grid4")) ? 2 : 1;
}
/* The room's track as the apps draw it: its points' count and length, its half width and its geometry (an old app reads n, len and halfW; a new one geo too). */
function trackView(room) {
  const tr = room.world ? room.world.track : Sim.trackOf(room.opts.track, geoFor(room));
  return { n: tr.n, len: Math.round(tr.L), halfW: tr.halfW, geo: tr.geo };
}

function sendState(code) {
  const room = rooms.get(code), sockets = roomSockets.get(code);
  if (!room || !sockets) return;
  const pub = publicRoom(room);
  for (const s of sockets) {
    const mySeat = room.players.findIndex((p) => p.id === s.data.playerId);
    s.emit("state", { room: Object.assign({}, pub), mySeat });
  }
}
function bump(room) { room.v++; room.touched = Date.now(); sendState(room.code); }

/* ---------- play ---------- */

const r2 = (v) => Math.round(v * 100) / 100;
const setPhase = (room, phase, ms) => { room.phase = phase; room.phaseLeft = ms; room.phaseEndsAt = ms == null ? null : Date.now() + ms / SIM_SPEED; };

function brainFor(room, seat) {
  const p = room.players[seat];
  if (!p) return null;
  if (p.bot) return p.level;
  if (p.botControlled || p.left) return "normal";
  return null;
}

/* A race: every seat on the grid (a time trial: one car, the seat whose turn it is). */
function startMatch(room) {
  room.status = "playing";
  room.round = (room.round || 0) + 1;
  room.winner = null; room.places = []; room.results = []; room.firstHomeAt = 0;
  room.mems = room.players.map((_, i) => Bots.newMem(i, 1000 * (i + 1) + room.round));
  for (const p of room.players) { p.lastIn = Date.now(); p.botControlled = false; p.steer = 0; p.ack = -1; }
  room.tick = 0; room.acc = 0; room.lastAt = Date.now();
  if (PassPlay.isLocal(room)) {
    room.trial = { order: room.players.map((_, i) => i), turn: 0, laps: [] };
    room.world = null;
    setPhase(room, "handoff", null);
    room.log = `${room.players[0].name}: your turn. Tap Go when you have the phone.`;
    return;
  }
  room.trial = null;
  gearBots(room);
  room.world = Sim.newWorld(room.opts.track, room.opts.laps, room.players.length, geoFor(room));
  for (const c of room.world.cars) { c.fx = gearOf(room, room.players[c.seat]); c.lapsSeen = 0; c.lapStart = 0; c.lapBest = 0; }   // gear: the seat's engine, tyres and boost (null at the base)
  setPhase(room, "countdown", COUNTDOWN_MS);
  room.log = `Get ready! ${room.opts.laps} lap${room.opts.laps === 1 ? "" : "s"}.`;
}

/* A time trial's turn: one car alone, its seat's. */
function startTurn(room) {
  const seat = room.trial.order[room.trial.turn];
  room.world = Sim.newWorld(room.opts.track, room.opts.laps, 1, geoFor(room));
  const c = room.world.cars[0];
  c.seat = seat; c.lapsSeen = 0; c.lapStart = 0; c.lapBest = 0;
  room.firstHomeAt = 0;
  room.tick = 0; room.acc = 0;
  room.players[seat].lastIn = Date.now();
  setPhase(room, "countdown", COUNTDOWN_MS);
  room.log = `${room.players[seat].name}: get ready!`;
}

function finishMatch(room, log) {
  const w = room.world;
  room.status = "over";
  room.phase = "over"; room.phaseEndsAt = null;
  if (room.trial) {
    const rs = room.results.slice().sort((a, b) => (a.best || 1e12) - (b.best || 1e12) || (a.ms || 1e12) - (b.ms || 1e12));
    room.places = rs.map((r) => r.seat);
  } else {
    room.places = Sim.order(w);
    room.results = w.cars.map((c) => ({ seat: c.seat, ms: c.finishAt >= 0 ? Math.round(c.finishAt * 1000) : 0, best: Math.round((c.lapBest || 0) * 1000) }));
  }
  room.winner = room.places.length ? room.places[0] : null;
  room.winners = room.winner != null ? [room.winner] : [];
  room.log = log || `${room.players[room.winner] ? room.players[room.winner].name : "Nobody"} wins!`;
  if (room.winner != null && !room.trial) {
    Reactions.event(room, room.winner, "win", bump, 0);
    for (const s of room.places.slice(-1)) if (s !== room.winner) Reactions.event(room, s, "bad", bump, 0);
  }
}

/* Counting laps and a car home. */
function track(room, ev) {
  const w = room.world;
  for (const c of w.cars) {
    const done = Math.max(0, Math.floor(c.dist / w.track.L));
    if (done > c.lapsSeen && c.finishAt < 0) {
      const ms = w.t - c.lapStart;
      c.lapStart = w.t; c.lapsSeen = done;
      if (!c.lapBest || ms < c.lapBest) c.lapBest = ms;
      ev.push({ k: "lap", seat: c.seat, lap: done, ms: Math.round(ms * 1000) });
    }
    if (c.finishAt < 0 && Sim.finished(w, c)) {
      c.finishAt = w.t;
      ev.push({ k: "finish", seat: c.seat, ms: Math.round(w.t * 1000), place: w.cars.filter((o) => o.finishAt >= 0).length });
      if (!room.firstHomeAt) room.firstHomeAt = Date.now();
    }
  }
}

function endPhase(room) {
  if (room.phase === "countdown") {
    setPhase(room, "race", null);
    room.log = "Go!";
    bump(room);
  } else if (room.phase === "handoff-show") {
    // a time trial: the finished car was shown; pass the phone on or finish
    const t = room.trial;
    t.turn++;
    if (t.turn >= t.order.length) {
      const first = room.results.slice().sort((a, b) => (a.best || 1e12) - (b.best || 1e12))[0];
      finishMatch(room, first ? `${room.players[first.seat].name} has the best lap!` : "All done.");
    } else {
      room.world = null;
      setPhase(room, "handoff", null);
      room.log = `${room.players[t.order[t.turn]].name}: your turn. Tap Go when you have the phone.`;
    }
    bump(room);
  }
}

const standings = (room) => Sim.order(room.world);

/* One step of one room's world. */
function stepRoom(room, ev) {
  const w = room.world;
  if (!w) return;
  const dt = Sim.P.DT;
  const racing = room.phase === "race";
  const inputs = [];
  for (const c of w.cars) {
    const seat = c.seat;
    const lvl = c.finishAt >= 0 ? "normal" : brainFor(room, seat);
    let steer = 0;
    if (lvl) {
      if (room.tick % 2 === 0 || !room.mems[seat].last) {
        const r = Bots.think(w, c, lvl, room.mems[seat], dt * 2);
        room.mems[seat].last = r;
        if (r.use && racing) Sim.useItem(c, ev);
      }
      steer = room.mems[seat].last.steer;
    } else {
      c.cap = 1;
      steer = room.players[seat].steer || 0;
    }
    inputs[seat] = steer;
  }
  Sim.stepWorld(w, inputs, ev, racing, dt);
  if (racing) {
    track(room, ev);
    if (room.phase === "race") {
      const homeAll = w.cars.every((c) => c.finishAt >= 0);
      const humans = w.cars.filter((c) => { const p = room.players[c.seat]; return p && !p.bot && !p.left && (p.connected || p.local); });
      const humansHome = humans.length > 0 && humans.every((c) => c.finishAt >= 0);
      if (room.trial) {
        // a turn that cannot be finished (a hand that never steers falls at the first bend for ever) is given up after a while
        const gaveUp = w.t > TRIAL_MAX_S * room.opts.laps;
        if (gaveUp && !homeAll) {
          const c0 = w.cars[0];
          room.results.push({ seat: c0.seat, ms: 0, best: Math.round((c0.lapBest || 0) * 1000) });
          setPhase(room, "handoff-show", HANDOFF_MS);
          room.phase = "handoff-show";
          room.log = `${room.players[c0.seat].name} ran out of time.`;
          bump(room);
          return;
        }
        if (homeAll) {
          const c = w.cars[0];
          room.results.push({ seat: c.seat, ms: Math.round(c.finishAt * 1000), best: Math.round(c.lapBest * 1000) });
          setPhase(room, "handoff-show", HANDOFF_MS);
          room.phase = "handoff-show";
          room.log = `${room.players[c.seat].name}: ${(c.finishAt).toFixed(1)} s, best lap ${c.lapBest.toFixed(1)} s.`;
          bump(room);
          return;
        }
      } else {
        const now = Date.now();
        const late = room.firstHomeAt && (now - room.firstHomeAt) * SIM_SPEED > FINISH_GRACE_MS;
        const humansLate = humansHome && (now - room.firstHomeAt) * SIM_SPEED > HUMANS_HOME_MS;
        if (homeAll || late || humansLate) {
          finishMatch(room);
          bump(room);
          return;
        }
      }
    }
  } else if (room.phaseLeft != null) {
    room.phaseLeft -= dt * 1000;
    if (room.phaseLeft <= 0) endPhase(room);
  }
  room.tick++;
}

const snapOf = (room) => {
  const w = room.world;
  return {
    k: room.tick, t: Date.now(), ph: room.phase,
    c: w.cars.map((c) => [c.seat, r2(c.x), r2(c.y), Math.round(c.h * 1000) / 1000, r2(c.vx), r2(c.vy), r2(c.boost), r2(c.shield), c.item, r2(c.dist), c.fall >= 0 ? r2(c.fall) : -1, r2(c.ghost), r2(c.drift), room.players[c.seat] ? room.players[c.seat].ack : -1, Math.round(c.steer * 1000) / 1000, r2(c.lastOk)]),
    bx: w.boxes.reduce((m, t, i) => m | (t > 0 ? 1 << i : 0), 0),
    pl: room.phase === "race" ? Sim.order(w) : room.places,
    ...(room.ev.length ? { e: room.ev.map((e) => ({ ...e, x: e.x != null ? r2(e.x) : undefined, y: e.y != null ? r2(e.y) : undefined, s: e.s != null ? r2(e.s) : undefined })) } : {}),
  };
};

/* The loop: real time in, whole steps out (never more than 12 at once after a stall). */
const STEP_MS = Sim.P.DT * 1000;
let lastLoop = Date.now();
setInterval(() => {
  const now = Date.now();
  const dtReal = Math.min(100, now - lastLoop) * SIM_SPEED;
  lastLoop = now;
  for (const room of rooms.values()) {
    if (room.status !== "playing") continue;
    room.acc += dtReal;
    let n = 0;
    while (room.acc >= STEP_MS && n < 12 * SIM_SPEED) {
      room.acc -= STEP_MS; n++;
      if (room.world) stepRoom(room, room.ev);
      else room.acc = 0;
      if (room.status !== "playing") break;
      if (room.world && room.tick % SNAP_EVERY === 0) { sendSnap(room); }
    }
    if (room.status !== "playing") { room.ev.length = 0; }
    // a driver that has gone quiet is driven by a bot (given back the moment the human sends a move)
    for (let s = 0; s < room.players.length; s++) {
      const p = room.players[s];
      if (!p.bot && !p.botControlled && !p.local && !PassPlay.isLocal(room) && room.phase === "race" && now - (p.lastIn || now) > (p.connected ? AFK_MS : Math.min(AFK_MS, 1500))) {
        p.botControlled = true; room.log = `A bot is driving for ${p.name}.`; bump(room);
      }
    }
  }
}, 8);

function sendSnap(room) {
  const sockets = roomSockets.get(room.code);
  const snap = snapOf(room);
  room.ev.length = 0;
  if (!sockets) return;
  for (const s of sockets) s.emit("snap", snap);
}

function addBotTo(room, level) {
  if (room.players.length >= MAX_PLAYERS) return null;
  level = LEVELS.includes(level) ? level : "normal";
  const used = room.players.map((q) => q.name);
  const all = [...BOT_NAMES[level], ...LEVELS.flatMap((l) => BOT_NAMES[l])];
  const name = all.find((n) => !used.includes(n)) || "Bot" + (room.players.length + 1);
  const p = { id: "bot_" + newId(), name, avatar: "\u{1F916}", bot: true, level, left: false, connected: true, gear: botGearFor(room) };
  room.players.push(p);
  return p;
}

/* ---------- sockets ---------- */

function attach(socket, code, playerId) {
  const was = socket.data.roomCode;
  /* (a pass-and-play room's own phone seating one of its local people: the same socket, still in the room) */
  if (was && (was !== code || socket.data.playerId !== playerId) && !(was === code && PassPlay.isLocal(rooms.get(code)))) dropFromRoom(socket);
  socket.data.playerId = playerId;
  socket.data.roomCode = code;
  if (!roomSockets.has(code)) roomSockets.set(code, new Set());
  roomSockets.get(code).add(socket);
}
function detach(socket) {
  const code = socket.data.roomCode;
  const set = roomSockets.get(code);
  if (set) { set.delete(socket); if (!set.size) roomSockets.delete(code); }
  socket.data.roomCode = null;
}
function heldElsewhere(room, id) {
  const set = roomSockets.get(room.code);
  if (set) for (const s of set) if (s.data.playerId === id) return true;
  return false;
}
function dropFromRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  const p = room ? room.players.find((q) => q.id === socket.data.playerId) : null;
  detach(socket);
  if (!room || !p || heldElsewhere(room, p.id)) return;
  p.connected = false;
  bump(room);
}

function forgetRoom(room) { rooms.delete(room.code); }

PassPlay.init({ app, base: BASE, rooms, broadcast: sendState, max: MAX_PLAYERS, drop: (c) => { const r = rooms.get(c); if (r) forgetRoom(r); } });
Quick.init({ game: 'racers', model: 'openskill', seats: 4, codeKey: 'roomCode', app, io, rooms, base: BASE, broadcast: sendState,
  /* Quick and ranked play match within gear-score bands (gear.js BAND): an open room takes a player whose gear score is within it of the host's. Nothing on screen says so. */
  accept: (room, payload) => { const host = room.players.find((p) => p.id === room.host); return Gear.bandOk(Gear.scoreFor(host && host.gear, "racers"), Gear.scoreFor(Gear.clean("racers", payload.gear), "racers")); } });
io.on("connection", (socket) => {
  Plus.guardSocket(socket);
  PassPlay.hook(socket);   // before Quick.hook: the seats a phone plays
  Quick.hook(socket); Quick.connection(socket); PassPlay.connection(socket);
  const currentRoom = () => rooms.get(socket.data.roomCode);
  Voice.wire({ on: (ev, fn) => socket.on(ev, (payload) => fn(obj(payload))), room: currentRoom, me: () => socket.data.playerId, bump, emit: (ev, d) => socket.emit(ev, d) });   // voice chat in private rooms (2026-11-18)
  Reactions.wire({ on: (ev, fn) => socket.on(ev, (payload) => fn(obj(payload))), room: currentRoom, me: () => socket.data.playerId,
    isHost: (r) => r.host === socket.data.playerId, bump });
  const me = () => { const r = currentRoom(); return r ? r.players.find((p) => p.id === socket.data.playerId) : null; };

  socket.on("create", (payload) => {
    const { name: rawName, playerId, avatar, caps, plus, look, crew, gear } = obj(payload);
    const name = cleanName(rawName);
    if (!name) return refuse(socket, "create", "name", "Pick a name first.");
    let code = genCode(); let guard = 0;
    while (rooms.has(code) && guard++ < 10) code = genCode();
    code = Plus.crewCode({ plus, crew }, rooms, () => code);
    const id = cleanId(playerId) || newId();
    const room = newRoom(code, id);
    room.players.push({ id, name, avatar: cleanAvatar(avatar) || AVATARS[0], left: false, connected: true, caps: cleanCaps(caps), gear: Gear.clean("racers", gear) });
    rooms.set(code, room);
    attach(socket, code, id);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: id });
    bump(room);
  });

  socket.on("join", (payload) => {
    const { code: rawCode, name, playerId, avatar, caps, plus, look, gear } = obj(payload);
    const code = text(rawCode).trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return refuse(socket, "join", "not_found", "No room with that code.");
    const known = cleanId(playerId);
    let p = known ? room.players.find((q) => q.id === known) : null;
    if (p) {
      p.connected = true; p.left = false; p.lastIn = Date.now();
      p.caps = cleanCaps(caps);
      if (gear !== undefined && room.status === "lobby") p.gear = Gear.clean("racers", gear);   // gear changes between matches, never in one
      const n = cleanName(name);
      if (n) p.name = n;
    } else {
      if (room.status !== "lobby") return refuse(socket, "join", "started", "That match already started.");
      if (room.players.length >= MAX_PLAYERS) return refuse(socket, "join", "full", `Room is full (${MAX_PLAYERS}).`);
      const n = cleanName(name);
      if (!n) return refuse(socket, "join", "name", "Pick a name first.");
      const id = known || newId();
      p = { id, name: n, avatar: cleanAvatar(avatar) || AVATARS[room.players.length % AVATARS.length], left: false, connected: true, caps: cleanCaps(caps), gear: Gear.clean("racers", gear) };
      room.players.push(p);
      room.log = `${n} joined.`;
    }
    attach(socket, code, p.id);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: p.id });
    bump(room);
  });

  /* The host's choices, in the lobby or between races: { laps: 1|2|3|5, track: "bath"|"kitchen"|"toyroom" }. */
  socket.on("settings", (payload) => {
    const { laps, track, gear } = obj(payload);
    const room = currentRoom();
    if (!room || room.status === "playing" || room.host !== socket.data.playerId) return;
    /* The host's gear switch (private rooms only; a quick or ranked room is matched by gear score and has none). */
    if (typeof gear === "boolean") { if (!room.quick && gear !== (room.gearOn !== false)) { room.gearOn = gear; room.log = gear ? "Gear is on." : "Gear is off: everyone plays at the base."; bump(room); } return; }
    let changed = false;
    if (LAPS.includes(laps) && laps !== room.opts.laps) { room.opts.laps = laps; changed = true; }
    /* The Plus tracks (Breakfast Speedway, Midnight Toy Room) are GameNest Plus's: a host who owns Plus picks them, anyone else keeps the Bathtub. */
    const hostP = room.players.find((q) => q.id === room.host);
    if (TRACKS.includes(track) && track !== room.opts.track && (track === "bath" || (hostP && hostP.plus) || (TEST_HOOKS && process.env.TEST_PLUS === "1"))) { room.opts.track = track; changed = true; }
    if (changed) { room.log = `${room.opts.laps} lap${room.opts.laps === 1 ? "" : "s"}.`; bump(room); }
  });

  /* A player's gear changed while they sat in the lobby (they upgraded or bought something on the gear page): { slot: { item, level } } for rengine, tyres, rboost. Clamped as on join. */
  socket.on("gear", (payload) => {
    const room = currentRoom(), self = me();
    if (!room || !self || room.status !== "lobby" || self.bot) return;
    self.gear = Gear.clean("racers", obj(payload));
    room.log = `${self.name} changed their gear.`;
    bump(room);
  });

  socket.on("addBot", (payload) => {
    const { level } = obj(payload);
    const room = currentRoom();
    if (!room || room.status === "playing" || room.host !== socket.data.playerId) return;
    if (room.players.length >= MAX_PLAYERS) return refuse(socket, "addBot", "full", "Room is full.");
    const b = addBotTo(room, level);
    if (!b) return;
    room.log = `${b.name} (${b.level} bot) joined.`;
    bump(room);
  });

  socket.on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].bot) { room.log = `${room.players[i].name} left.`; room.players.splice(i, 1); break; }
    }
    bump(room);
  });

  socket.on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby" || room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < MIN_PLAYERS) return refuse(socket, "start", "nobody", "Nobody to play against.");
    startMatch(room);
    bump(room);
  });

  /* The wheel: { s } the steer -1..1, { n } the app's own step count when it was read (echoed back as `ack` in the snapshots so the app can
     reconcile what it predicted), in a pass-and-play room { as } for the seat of this phone that is driving. Up to 60 a second. */
  socket.on("in", (payload) => {
    const { s: steer, n } = obj(payload);
    const room = currentRoom(), self = me();
    if (!room || !self || room.status !== "playing") return;
    if (!Number.isFinite(steer)) return;
    const seat = room.players.indexOf(self);
    if (seat < 0 || room.players[seat].bot) return;
    const p = room.players[seat];
    p.steer = Math.max(-1, Math.min(1, steer));
    if (Number.isFinite(n)) p.ack = Math.floor(n);
    p.lastIn = Date.now();
    if (p.botControlled) { p.botControlled = false; room.log = `${p.name} is back.`; bump(room); }
  });

  /* The item button. */
  socket.on("use", () => {
    const room = currentRoom(), self = me();
    if (!room || !self || room.status !== "playing" || room.phase !== "race" || !room.world) return;
    const seat = room.players.indexOf(self);
    const c = room.world.cars.find((q) => q.seat === seat);
    if (c && Sim.useItem(c, room.ev)) self.lastIn = Date.now();
  });

  /* A time trial: the phone is in the next driver's hands. */
  socket.on("go", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "handoff" || !PassPlay.isLocal(room) || socket.data.playerId !== room.local.owner) return;
    startTurn(room);
    bump(room);
  });

  /* Clock sync for the app: { c } back with the server's time. */
  socket.on("ping", (payload) => { const { c } = obj(payload); socket.emit("pong", { c: Number.isFinite(c) ? c : 0, s: Date.now() }); });

  socket.on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over" || room.host !== socket.data.playerId) return;
    room.players = room.players.filter((q) => !q.left);
    if (room.players.length < MIN_PLAYERS) return refuse(socket, "rematch", "nobody", "Nobody to play against.");
    if (!room.players.some((q) => q.id === room.host)) room.host = room.players.find((q) => !q.bot).id;
    startMatch(room);
    room.log = `Rematch! ${room.log}`;
    bump(room);
  });

  socket.on("takeSeat", () => {
    const room = currentRoom(), p = me();
    if (room && p && p.botControlled) { p.botControlled = false; p.lastIn = Date.now(); room.log = `${p.name} is back.`; bump(room); }
  });

  function handleLeave() {
    const room = currentRoom(), p = me();
    detach(socket);
    if (!room || !p) return;
    room.log = `${p.name} left.`;
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q !== p);
      if (room.host === p.id) { const h = room.players.find((q) => !q.bot); if (h) room.host = h.id; }
    } else {
      p.left = true; p.connected = false;
      if (room.host === p.id) { const h = room.players.find((q) => !q.bot && !q.left && !q.local); if (h) room.host = h.id; }
      if (room.status === "playing") {
        room.log = `${p.name} left; a bot drives the car.`;
      }
    }
    if (room.players.every((q) => q.left || q.bot || (q.local && !PassPlay.isLocal(room)))) { forgetRoom(room); return; }
    bump(room);
  }

  socket.on("pushToken", (payload) => {
    const { token } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token;
  });

  socket.on("presence", (payload) => {
    const { away } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (p) p.away = !!away;
  });

  socket.on("chat", (payload) => {
    let { text, sticker } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const p = room.players.find((q) => q.id === socket.data.playerId);
    if (!p) return;
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < CHAT_COOLDOWN_MS) return;

    let msg = null;
    if (sticker) {
      if (!STICKERS.includes(sticker)) return;
      msg = { k: "s", s: sticker };
    } else {
      text = cleanChat(text);
      if (!text) return;
      msg = { k: "t", x: text };
    }
    socket.data.lastChat = now;
    const finish = () => {
      const room = rooms.get(code), p = room && room.players.find((q) => q.id === pid);   // gone while it was read
      if (!p) return;
      msg.n = p.name; msg.c = p.color; msg.a = p.avatar; msg.t = now;
      room.chat.push(msg);
      // a sticker is not worth waking someone for; words are
      if (msg.k === "t") {
        for (const q of room.players) {
          if (q !== p) pushTo(q, p.name + ": " + msg.x, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
        }
      }
      if (room.chat.length > CHAT_KEEP) room.chat.shift();
      room.touched = Date.now();
      bump(room);
    };
    const code = room.code, pid = p.id;
    if (msg.k === "t") Moderation.chat(msg.x).then((shown) => { msg.x = shown; finish(); }); else finish();
  });

  /* Voice is peer to peer; the server only carries the handshake, never audio.
     The 20k ceiling is what stops a signal being used as a data channel. */
  socket.on("voice", (payload) => {
    const { kind, to, data } = obj(payload);
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;

    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat);
      else room.voice.delete(seat);
      room.touched = Date.now();
      bump(room);
      return;
    }

    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0;
      try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const sockets = roomSockets.get(room.code);
      if (!sockets) return;
      for (const s of sockets) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  /* Tests only (TEST_HOOKS=1): put the race where a test needs it. { nearFinish: true } puts every car a few metres before the line of its last lap, side by side;
     { place: [seat, metresToGo] } one car; { botControlled: [bool, ...] }; { phase: "race" } skips the countdown. */
  if (TEST_HOOKS) socket.on("testSet", (payload) => {
    const o = obj(payload);
    const room = currentRoom();
    if (!room || !me() || !room.world) return;
    const w = room.world;
    const placeCar = (c, toGo, lane) => {
      const L = w.track.L, s = ((w.laps * L - toGo) % L + L) % L, p = Sim.at(w.track, s);
      c.x = p.x - p.ty * -lane; c.y = p.y + p.tx * -lane; c.h = Math.atan2(p.ty, p.tx); c.s = s; c.idx = Math.round(s / w.track.sp) % w.track.n;
      c.dist = w.laps * L - toGo; c.lastOk = s; c.lapsSeen = w.laps - 1; c.vx = Math.cos(c.h) * 60; c.vy = Math.sin(c.h) * 60;
    };
    if (o.nearFinish) w.cars.forEach((c, i) => (w.geo === 2 ? placeCar(c, 130, (i - (w.cars.length - 1) / 2) * Sim.P.GRID_PITCH2) : placeCar(c, 130 + i * 26, (i % 2 ? 1 : -1) * 6)));   // (geometry 2: side by side, never on top of each other)
    if (Array.isArray(o.place) && o.place.length === 2) { const c = w.cars.find((q) => q.seat === o.place[0]); if (c) placeCar(c, o.place[1], 0); }
    if (Array.isArray(o.botControlled)) o.botControlled.slice(0, 4).forEach((b, i) => { if (room.players[i] && !room.players[i].bot) room.players[i].botControlled = !!b; });
    if (o.phase === "race" && room.status === "playing" && room.phase === "countdown") setPhase(room, "race", null);
    bump(room);
  });

  socket.on("leave", handleLeave);
  socket.on("disconnect", () => dropFromRoom(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) forgetRoom(room);
  }
}, 60000).unref();

server.listen(PORT, () => console.log(`Toy Racers Rooms running on port ${PORT}${BASE ? " under " + BASE : ""}`));

module.exports = { app, server, io };
