/* Gear step 5 (2026-11-21): Toy Racers' gear. The table's slots, clamps, the effects (engine top speed, tyres' grip, boost length), no gear = exactly the base, the host's switch,
   bands, bots. Port TEST_PORT_GEAR (default 5645; never 3111-3131). */
"use strict";
const os = require("os"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const G = require("../gear");
const Sim = require("../physics");
const PORT = Number(process.env.TEST_PORT_GEAR || 5645);
if ((PORT >= 3111 && PORT <= 3131) || PORT === 5702 || PORT === 5930) { console.error("refusing " + PORT); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
const check = (ok, what, extra) => { if (ok) passed++; else failed++; console.log((ok ? "PASS " : "FAIL ") + what + (!ok && extra !== undefined ? "  " + JSON.stringify(extra) : "")); };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };
const MAX = { rengine: { item: "rengine:dragon", level: 12 }, tyres: { item: "tyres:sapphire", level: 10 }, rboost: { item: "rboost:pearl", level: 8 } };
function mk(name) {
  const s = io("http://127.0.0.1:" + PORT, { path: "/socket.io", transports: ["websocket"], reconnection: false, forceNew: true });
  const c = { s, room: null, joined: null, id: "g_" + name };
  s.on("state", (d) => { c.room = d.room; });
  s.on("joined", (j) => { c.joined = j; });
  c.create = (gear) => { s.emit("create", { name, playerId: c.id, gear }); return until(() => c.joined); };
  c.join = (code, gear) => { s.emit("join", { code, name, playerId: c.id, gear }); return until(() => c.joined); };
  return c;
}
(async () => {
  console.log("\nthe table");
  check(JSON.stringify(G.slotsOf("racers")) === '["rengine","tyres","rboost"]' && JSON.stringify(G.T.games.racers.stats) === '["speed","grip","boost"]', "Toy Racers: engine, tyres, boost; speed, grip, boost");
  for (const slot of G.slotsOf("racers")) {
    const items = Object.keys(G.T.items).filter((k) => G.T.items[k].slot === slot);
    check(items.length === 4 && ["common", "rare", "epic", "legendary"].every((x, i) => G.rarityOf(items[i]) === x), `${slot}: COMMON, RARE, EPIC, LEGENDARY`, items);
  }
  const g = G.clean("racers", MAX);
  check(g.score === 30 && g.stats.speed === 10 && g.stats.grip === 9 && g.stats.boost === 7, "clean: levels and stats", g);
  check(G.clean("racers", { tyres: { item: "tyres:classic", level: 99 } }).slots.tyres.level === 6 && G.clean("racers", null) === null, "caps and no gear");
  console.log("\nthe effects, small and clamped");
  const e0 = G.racersEffects(null), e10 = G.racersEffects({ speed: 99, grip: 99, boost: 99 });
  check(e0.speed === 1 && e0.grip === 1 && e0.boost === 1, "no gear: the base", e0);
  check(e10.speed === 1.15 && e10.grip === 1.2 && e10.boost === 1.3, "a stat over 10 is held at 10", e10);
  const run = (fx, steer, steps) => {
    const w = Sim.newWorld("bath", 3, 1); const c = w.cars[0]; if (fx) c.fx = fx;
    for (let i = 0; i < steps; i++) Sim.stepWorld(w, [steer], null, true, 1 / 120);
    return c;
  };
  const b = run(null, 0, 1200), n = run(G.racersEffects(null), 0, 1200);
  check(b.x === n.x && b.y === n.y && b.vx === n.vx, "no-gear effects are exactly the base physics");
  const sp = (c) => Math.hypot(c.vx, c.vy);
  const topAt = (fx) => { const w = Sim.newWorld("bath", 3, 1); const c = w.cars[0]; if (fx) c.fx = fx; c.vx = Math.cos(c.h) * Sim.P.MAX_SPEED * 1.14; c.vy = Math.sin(c.h) * Sim.P.MAX_SPEED * 1.14; for (let i = 0; i < 300; i++) Sim.stepCar(c, 0, 1 / 120, w, null, true); return sp(c); };
  check(topAt(G.racersEffects({ speed: 10 })) > topAt(null) * 1.1 && topAt(G.racersEffects({ speed: 10 })) <= Sim.P.MAX_SPEED * 1.15 * 1.001, "engine: the top speed settles about 15% higher at 10", [topAt(null), topAt(G.racersEffects({ speed: 10 }))]);
  const slide = (fx) => { const c = run(fx, 0, 600); const h = c.h; c.vx += -Math.sin(h) * 30; c.vy += Math.cos(h) * 30; const w = { track: Sim.TRACKS.bath }; for (let i = 0; i < 30; i++) Sim.stepCar(c, 0, 1 / 120, w, null, true); return Math.abs(c.vx * -Math.sin(c.h) + c.vy * Math.cos(c.h)); };
  check(slide(G.racersEffects({ grip: 10 })) < slide(null) * 0.8, "tyres: a slide dies away faster (the car holds the road)", [slide(null), slide(G.racersEffects({ grip: 10 }))]);
  const boost = (fx) => { const c = Sim.newCar(0, Sim.TRACKS.bath); c.fx = fx; c.item = 1; Sim.useItem(c, null); return c.boost; };
  check(boost(null) === 1.8 && Math.abs(boost(G.racersEffects({ boost: 10 })) - 1.8 * 1.3) < 1e-9, "boost: the item's burst is 30% longer at 10");
  console.log("\nthe server");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "racers-gear-"));
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT: String(PORT), TEST_HOOKS: "1", RANK_DIR: data, STATS_DIR: data, DATA_DIR: data, COUNTDOWN_MS: "100" }), stdio: "ignore" });
  const cl = []; const m = (n) => { const c = mk(n); cl.push(c); return c; };
  try {
    await sleep(800);
    const a = m("Ann"); await a.create(MAX); await until(() => a.room);
    check(a.room.players[0].gear.score === 30 && a.room.players[0].gear.stats.speed === 10 && a.room.gearOn === true, "the room shows the clamped gear, on by default", a.room.players[0].gear);
    const bb = m("Bob"); await bb.join(a.joined.code, { tyres: { item: "tyres:classic", level: 99 } });
    await until(() => a.room.players.length === 2);
    check(a.room.players[1].gear.levels.tyres === 6, "a joiner's level is clamped to its rarity");
    bb.s.emit("settings", { gear: false }); await sleep(150);
    check(a.room.gearOn === true, "only the host may switch gear");
    a.s.emit("settings", { gear: false }); await until(() => a.room.gearOn === false);
    check(a.room.players[0].gear.stats.speed === 0, "off: the stats shown are the base");
    a.s.emit("settings", { gear: true }); await until(() => a.room.gearOn === true);
    a.s.emit("gear", { rengine: { item: "rengine:sapphire", level: 7 } }); await until(() => a.room.players[0].gear.items.rengine === "rengine:sapphire");
    check(a.room.players[0].gear.levels.rengine === 7, "a lobby gear event is cleaned and applied");
    const c = m("Cat"); await c.create(MAX); await until(() => c.room);
    c.s.emit("addBot", { level: "easy" }); await until(() => c.room.players.length === 2);
    check(c.room.players[1].gear && c.room.players[1].gear.score === 30, "a bot wears the humans' mean gear score");
    check(G.bandOk(30, 3) === false && G.bandOk(10, 14) === true, "quick play matches within 6 gear score");
  } finally { for (const x of cl) x.s.close(); srv.kill(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
