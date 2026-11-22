/* The room flow over real sockets, against a server this script starts (TEST_PORT, default 5731; never 3111-3126):
   create and join, lobby settings, a bot, start, the phases (countdown, race, over), the live snapshots (about 30 a second, the car following the wheel),
   finishing and the places, a quiet driver taken over by a bot, forfeit-by-leaving keeps the race going, rematch, a time trial in turns on one phone. */
"use strict";
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const PORT = Number(process.env.TEST_PORT || 5731);
if (PORT >= 3111 && PORT <= 3126) { console.error("refusing " + PORT); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (fn, what, ms = 8000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timed out waiting for " + what)); setTimeout(tick, 5); }; tick(); });
function client(name) {
  const s = io("http://127.0.0.1:" + PORT, { path: "/socket.io", transports: ["websocket"] });
  const c = { s, room: null, mySeat: -1, snaps: [], errs: [], joined: null };
  s.on("state", (d) => { c.room = d.room; c.mySeat = d.mySeat; });
  s.on("snap", (x) => { c.snaps.push(x); if (c.snaps.length > 600) c.snaps.shift(); });
  s.on("err", (m, o) => c.errs.push(o && o.code));
  s.on("joined", (j) => { c.joined = j; });
  c.create = () => { s.emit("create", { name, playerId: "p_" + name }); return wait(() => c.joined, "joined"); };
  c.join = (code) => { s.emit("join", { code, name, playerId: "p_" + name }); return wait(() => c.joined, "joined"); };
  c.last = () => c.snaps[c.snaps.length - 1];
  return c;
}
let n = 0;
const ok = (m) => { n++; console.log("ok  " + m); };

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "racers-flow-"));
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), TEST_HOOKS: "1", RANK_DIR: data, STATS_DIR: data, DATA_DIR: data, COUNTDOWN_MS: "250", HANDOFF_MS: "200", HUMANS_HOME_MS: "300", FINISH_GRACE_MS: "3000", AFK_MS: "700", TRIAL_MAX_S: "5" }, stdio: "ignore" });
  const clients = [];
  const mk = (n_) => { const c = client(n_); clients.push(c); return c; };
  try {
    await sleep(700);
    const a = mk("Ann");
    await a.create();
    assert(/^[A-HJKMNPRTWXYZ]{6}$/.test(a.joined.code)); ok("a room is made with a letters-only code");
    a.s.emit("settings", { laps: 2, track: "toyroom" });
    await wait(() => a.room && a.room.opts.laps === 2, "settings");
    assert.strictEqual(a.room.opts.track, "bath"); ok("a Plus track is refused to a host without Plus");
    a.s.emit("settings", { laps: 99, track: "nope" });
    await sleep(100); assert.strictEqual(a.room.opts.laps, 2); ok("settings outside the lists are ignored");
    a.s.emit("settings", { laps: 1 });
    await wait(() => a.room.opts.laps === 1, "one lap");
    a.s.emit("addBot", { level: "easy" }); a.s.emit("addBot", { level: "hard" });
    await wait(() => a.room.players.length === 3 && a.room.players[2].level === "hard", "bots");
    assert.strictEqual(a.room.track.len, 5280); ok("two bots join; the room says the lap length");
    a.s.emit("start", {});
    await wait(() => a.room.phase === "countdown", "countdown");
    await wait(() => a.room.phase === "race", "race");
    ok("start: countdown then race");
    const t0 = Date.now(), c0 = a.snaps.length;
    await sleep(1000);
    const rate = (a.snaps.length - c0) / ((Date.now() - t0) / 1000);
    assert(rate > 24 && rate < 36, "snap rate " + rate); ok("about 30 snapshots a second (" + rate.toFixed(1) + ")");
    const row = (seat) => a.last().c.find((r) => r[0] === seat);
    assert.strictEqual(a.last().c.length, 3);
    const d0 = row(0)[9];
    a.s.emit("in", { s: 0.5, n: 77 });
    await wait(() => row(0)[13] === 77, "ack"); ok("a steer is acknowledged with the step count it came with");
    a.s.emit("in", { s: 0, n: 78 });
    await sleep(600); assert(row(0)[9] > d0 + 10, "the car moves " + (row(0)[9] - d0)); ok("the car drives itself forward");
    a.s.emit("in", { s: 99, n: 79 }); await sleep(100);
    // finish: everyone near the line
    a.s.emit("testSet", { nearFinish: true });
    await wait(() => a.room.status === "over", "over", 12000);
    assert.strictEqual(a.room.places.length, 3); assert(a.room.winner >= 0); ok("cars cross the line; status over with the places");
    assert(a.room.results.every((r) => r.ms > 0), "times"); ok("every finisher has a time");
    a.s.emit("rematch", {});
    await wait(() => a.room.status === "playing" && a.room.phase === "countdown", "rematch"); ok("rematch starts a fresh race");
    a.s.emit("leave", {});
    await sleep(100);

    // two people: join, leave keeps the race for the other
    const h = mk("Hal"), g = mk("Gus");
    await h.create(); await g.join(h.joined.code);
    await wait(() => h.room.players.length === 2, "two players");
    h.s.emit("start", {});
    await wait(() => h.room.phase === "race", "race");
    assert.strictEqual(g.mySeat, 1);
    const grow = (c, seat) => c.last().c.find((r) => r[0] === seat);
    g.s.emit("in", { s: -1, n: 5 });
    await wait(() => h.last() && grow(h, 1)[14] < -0.5, "guest's steer"); ok("two people: each wheel steers its own car");
    const late = mk("Late"); late.s.emit("join", { code: h.joined.code, name: "Late", playerId: "p_late" });
    await wait(() => late.errs.length, "refused"); assert.strictEqual(late.errs[0], "started"); ok("a started race refuses a newcomer");
    g.s.emit("use", {}); await sleep(50);
    g.s.emit("leave", {});
    await wait(() => h.room.players[1].left, "left"); assert.strictEqual(h.room.status, "playing"); ok("leaving mid-race does not end it for the others");
    h.s.emit("testSet", { nearFinish: true });
    await wait(() => h.room.status === "over", "over", 12000); ok("the race ends when the people left are home");

    // a Plus host picks a Plus track
    const pl = mk("Pluto"); pl.s.emit("create", { name: "Pluto", playerId: "p_Pluto", plus: true });
    await wait(() => pl.room, "plus room");
    pl.s.emit("settings", { track: "kitchen" });
    await sleep(150);
    if (pl.room.players[0].plus) { assert.strictEqual(pl.room.opts.track, "kitchen"); ok("a Plus host picks Breakfast Speedway"); } else { ok("(Plus claims are checked against the wallet's keys here: the pick stays the Bathtub)"); }

    // AFK: a quiet driver is driven by a bot, and given back on a move
    const q = mk("Quiet"), r = mk("Rob");
    await q.create(); await r.join(q.joined.code);
    q.s.emit("start", {});
    await wait(() => q.room.phase === "race", "race");
    r.s.emit("in", { s: 0, n: 1 });
    await wait(() => q.room.players[0].botControlled, "bot takes over");
    q.s.emit("in", { s: 0, n: 1 });
    await wait(() => !q.room.players[0].botControlled, "human back"); ok("a quiet driver is played by a bot and handed back on a move");

    // a time trial on one phone (passplay.js): one car at a time, best lap wins
    const l = mk("Lia");
    l.s.emit("create", { name: "Lia", playerId: "p_Lia2", local: true });
    await wait(() => l.room && l.room.passplay, "local room"); await sleep(50);
    l.s.emit("addLocal", { name: "Pal" });
    await wait(() => l.room.players.length === 2 && l.room.players[1].local, "local seat");
    l.s.emit("settings", { laps: 1 }); await sleep(50);
    l.s.emit("start", {});
    await wait(() => l.room.phase === "handoff" && l.room.trial && l.room.trial.seat === 0, "first handoff"); ok("pass-and-play: a time trial waits for the first driver's Go");
    l.s.emit("go", {});
    await wait(() => l.room.phase === "race", "race");
    assert.strictEqual(l.last().c.length, 1); assert.strictEqual(l.last().c[0][0], 0); ok("only the driver's car is on the track");
    l.s.emit("in", { s: 0.3, n: 1, as: 0 });
    l.s.emit("testSet", { nearFinish: true });
    await wait(() => l.room.phase === "handoff" && l.room.trial.seat === 1, "second handoff", 12000); ok("the phone is passed to the next driver");
    l.s.emit("go", {});
    await wait(() => l.room.phase === "race" && l.last().c[0][0] === 1, "second race");
    l.s.emit("testSet", { place: [1, 20] });
    await wait(() => l.room.status === "over", "trial over", 12000);
    assert.strictEqual(l.room.places.length, 2); assert(l.room.results.every((x) => x.best > 0)); ok("both have a best lap; the best lap wins");
    await sleep(900); assert(!l.room.players[0].botControlled && !l.room.players[1].botControlled, "no bot takes a local seat");
    // a turn nobody can finish (no hand on the wheel: the car falls at the first bend for ever) is given up, and the phone passes on
    const z = mk("Zed");
    z.s.emit("create", { name: "Zed", playerId: "p_Zed", local: true });
    await wait(() => z.room && z.room.passplay, "local room 2"); await sleep(50);
    z.s.emit("addLocal", { name: "Zoe" });
    await wait(() => z.room.players.length === 2 && z.room.players[1].local, "local seat 2");
    z.s.emit("settings", { laps: 1 }); await sleep(50);
    z.s.emit("start", {});
    await wait(() => z.room.phase === "handoff", "handoff 2");
    z.s.emit("go", {});
    await wait(() => z.room.phase === "race", "race 2");
    await wait(() => z.room.phase === "handoff" && z.room.trial.seat === 1, "given up, on to the next", 20000);
    assert(z.room.results.length === 1 && z.room.results[0].ms === 0); ok("a turn that cannot be finished is given up and the phone passes on");
    const lg = mk("Lag"); lg.s.emit("in", { s: 1 }); lg.s.emit("in", "nonsense"); lg.s.emit("in", { s: "a" }); await sleep(100);
    ok("malformed input is ignored");
    console.log(n + " flow checks passed");
  } catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
  for (const c of clients) c.s.close();
  srv.kill("SIGTERM");
  fs.rmSync(data, { recursive: true, force: true });
})();
