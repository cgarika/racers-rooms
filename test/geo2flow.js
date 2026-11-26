/* Geometry 2 over real sockets (qa1126), against a server this script starts (TEST_PORT6, default 5736; never 3111-3131): a room of apps that say "grid4" races the
   wide track with four abreast on the line; a room with one app that does not (an old 2.0 app) races the first track exactly as before; the room says which. */
"use strict";
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const Sim = require("../physics");
const PORT = Number(process.env.TEST_PORT6 || 5736);
if (PORT >= 3111 && PORT <= 3131) { console.error("refusing " + PORT); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (fn, what, ms = 8000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timed out waiting for " + what)); setTimeout(tick, 5); }; tick(); });
function client(name, caps) {
  const s = io("http://127.0.0.1:" + PORT, { path: "/socket.io", transports: ["websocket"] });
  const c = { s, room: null, snaps: [], joined: null };
  s.on("state", (d) => { c.room = d.room; });
  s.on("snap", (x) => { c.snaps.push(x); if (c.snaps.length > 600) c.snaps.shift(); });
  s.on("joined", (j) => { c.joined = j; });
  const who = { name, playerId: "p_" + name, ...(caps ? { caps } : {}) };
  c.create = () => { s.emit("create", who); return wait(() => c.joined, "joined"); };
  c.join = (code) => { s.emit("join", { code, ...who }); return wait(() => c.joined, "joined"); };
  return c;
}
let n = 0;
const ok = (m) => { n++; console.log("ok  " + m); };

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "racers-geo2-"));
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), TEST_HOOKS: "1", RANK_DIR: data, STATS_DIR: data, DATA_DIR: data, COUNTDOWN_MS: "400" }, stdio: "ignore" });
  const clients = [];
  const mk = (a, b) => { const c = client(a, b); clients.push(c); return c; };
  try {
    await sleep(700);
    // new apps only: the wide track
    const a = mk("Ann", ["waitList", "grid4"]);
    await a.create();
    await wait(() => a.room && a.room.track, "room");
    assert.strictEqual(a.room.track.geo, 2); assert.strictEqual(a.room.track.halfW, 150); assert.strictEqual(a.room.track.len, Math.round(Sim.TRACKS2.bath.L));
    const b = mk("Bob", ["grid4"]);
    await b.join(a.joined.code);
    a.s.emit("addBot", { level: "hard" }); a.s.emit("addBot", { level: "easy" });
    await wait(() => a.room.players.length === 4, "bots");
    assert.strictEqual(a.room.track.geo, 2);
    ok("a room of apps that know the wide track (\"grid4\") says geometry 2, half width 150");
    a.s.emit("start", {});
    await wait(() => a.room.phase === "countdown" && a.snaps.length > 0, "countdown snaps");
    const row = a.snaps[a.snaps.length - 1].c;
    const w = Sim.newWorld("bath", 3, 4, 2);
    for (const r of row) { const g = w.cars[r[0]]; assert(Math.abs(r[1] - g.x) < 0.02 && Math.abs(r[2] - g.y) < 0.02, "seat " + r[0] + " on its grid place"); }
    const cs = row.map((r) => ({ x: r[1], y: r[2], h: r[3] }));
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) assert.strictEqual(Sim.overlap(cs[i], cs[j]), null);
    ok("the countdown's cars stand on the wide grid, four abreast on the line, apart");
    await wait(() => a.room.phase === "race", "race");
    await sleep(2500);
    const last = a.snaps[a.snaps.length - 1].c;
    for (const r of last) { assert(r[10] < 0, "nobody falls"); assert(Sim.wallExcess({ x: r[1], y: r[2], h: r[3], idx: Sim.nearest(Sim.TRACKS2.bath, r[1], r[2], 0, 2000).i }, Sim.TRACKS2.bath).e <= 0.06, "inside the walls"); }
    ok("the race runs on the wide track: every car inside its walls");
    // a room with one old app: the first track, as the 2.0 apps know it
    const c = mk("Cat", ["grid4"]);
    await c.create();
    const d = mk("Dan", null);   // an old app: no caps
    await d.join(c.joined.code);
    await wait(() => c.room && c.room.players.length === 2, "two");
    assert.strictEqual(c.room.track.geo, 1); assert.strictEqual(c.room.track.halfW, 60); assert.strictEqual(c.room.track.len, 5280);
    c.s.emit("start", {});
    await wait(() => c.room.phase === "countdown" && c.snaps.length > 0, "countdown");
    const w1 = Sim.newWorld("bath", 3, 2);
    for (const r of c.snaps[c.snaps.length - 1].c) { const g = w1.cars[r[0]]; assert(Math.abs(r[1] - g.x) < 0.02 && Math.abs(r[2] - g.y) < 0.02, "old grid"); }
    ok("one app without \"grid4\" in the room: the first track and its grid, as the 2.0 apps expect (geometry 1, 5280 round, half width 60)");
    // the old app leaves before the start: the room goes wide again
    const e = mk("Eve", ["grid4"]);
    await e.create();
    const f = mk("Fay", null);
    await f.join(e.joined.code);
    await wait(() => e.room && e.room.players.length === 2 && e.room.track.geo === 1, "mixed");
    f.s.emit("leave", {});
    await wait(() => e.room.track.geo === 2, "wide again", 3000);
    ok("the lobby follows who is in it: wide again when the old app leaves");
  } finally {
    for (const c of clients) c.s.close();
    srv.kill();
  }
  console.log(n + " geometry 2 room checks passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
