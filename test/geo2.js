/* Geometry 2 (qa1126): the wide tracks with walls. The grid (every car on the line, side by side, apart), and every car's footprint inside the walls and clear
   of every other car at EVERY step of whole races: bots of every level, random hands, cars driven into the walls, bumps, the bridge. */
"use strict";
const assert = require("assert");
const S = require("../physics"), B = require("../bots");
const P = S.P;
let n = 0; const ok = (m) => { n++; console.log("ok  " + m); };
const EPS = 0.05;   // how far past a wall, or into another car, a footprint may be after a step (none, to a twentieth of a unit)

// the tracks
for (const name of S.TRACK_NAMES) {
  const tr = S.TRACKS2[name];
  assert.strictEqual(tr.geo, 2); assert.strictEqual(tr.halfW, 150);
  assert(tr.L > 3500 && tr.L < 5000, name + " length " + tr.L);
  let min = 1e9;
  for (let i = 0; i < tr.n; i++) {
    const a = tr.pts[i], b = tr.pts[(i + 8) % tr.n], c = tr.pts[(i + 16) % tr.n];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    min = Math.min(min, ab * bc * ca / (2 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) + 1e-9));
  }
  assert(min > tr.halfW + 40, name + " bend radius " + min);
  // two stretches far apart along the loop never come near enough for their walls to meet (the Bathtub's two passes cross only where the bridge lifts one over the other)
  const gap = Math.ceil(3 * tr.halfW / tr.sp);
  for (let i = 0; i < tr.n; i += 3) for (let j = i + gap; j < tr.n; j += 3) {
    if (tr.n - (j - i) < gap) continue;
    const d = Math.hypot(tr.pts[i][0] - tr.pts[j][0], tr.pts[i][1] - tr.pts[j][1]);
    if (d >= 2 * tr.halfW + 30) continue;   // (two walls of 13 and a gap)
    const hi = S.heightAt(tr, i * tr.sp), hj = S.heightAt(tr, j * tr.sp);
    // lanes that overlap: one over the other with room for a car between (a car is 36 tall, a deck 14); lanes side by side: their walls (28 tall) at different heights
    if (d < 2 * tr.halfW) assert(Math.abs(hi - hj) >= 60, name + ": stretches " + i + " and " + j + " " + d.toFixed(0) + " apart, one not over the other (" + hi.toFixed(0) + " / " + hj.toFixed(0) + ")");
    else assert(Math.abs(hi - hj) >= 30, name + ": stretches " + i + " and " + j + " " + d.toFixed(0) + " apart on one level (their walls would meet)");
  }
}
ok("three wide closed tracks (half width 150), no bend tighter than the lane, no two stretches touching except over the Bathtub's bridge");
assert.strictEqual(S.newWorld("bath", 3, 2).track.halfW, 60); assert.strictEqual(S.newWorld("bath", 3, 2).geo, 1);
ok("a world made without a geometry is the first one (the old apps' track)");

// the grid
for (const name of S.TRACK_NAMES) for (const k of [1, 2, 3, 4]) {
  const w = S.newWorld(name, 3, k, 2), tr = w.track;
  const line = S.at(tr, 0);
  const s0 = w.cars[0].s;
  for (const c of w.cars) {
    assert(Math.abs(c.s - s0) < 4, name + " " + k + ": every car at the same place along the lane");
    assert(Math.abs(c.h - w.cars[0].h) < 1e-9, "all parallel");
    const nose = [c.x + Math.cos(c.h) * P.CAR_HL2, c.y + Math.sin(c.h) * P.CAR_HL2];
    const toLine = (line.x - nose[0]) * line.tx + (line.y - nose[1]) * line.ty;
    assert(toLine > 0 && toLine < 6, name + " " + k + ": nose " + toLine.toFixed(1) + " behind the line");
    const tan = S.at(tr, c.s);
    assert(Math.cos(c.h) * tan.tx + Math.sin(c.h) * tan.ty > Math.cos(0.06), name + " " + k + ": facing down the lane (within 3 degrees)");
    assert(S.wallExcess(c, tr).e < -3, name + " " + k + ": clear of the walls");
  }
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
    assert.strictEqual(S.overlap(w.cars[a], w.cars[b]), null, name + " " + k + ": cars " + a + " and " + b + " overlap");
    const gapAcross = Math.hypot(w.cars[a].x - w.cars[b].x, w.cars[a].y - w.cars[b].y) - 2 * P.CAR_HW2;
    assert(gapAcross >= 12.9, "a clear gap between neighbours " + gapAcross);
  }
  // across the lane: side by side, one row
  const lat = w.cars.map((c) => S.nearest(tr, c.x, c.y, c.idx).d);
  for (let i = 1; i < k; i++) assert(lat[i] > lat[i - 1] + 2 * P.CAR_HW2, "seats left to right");
  if (k > 1) assert(Math.abs(lat[0] + lat[k - 1]) < 5, "the field centred on the lane");
}
ok("the grid: every car on the line, noses just behind it, side by side across the lane (one row), facing down the lane, apart and clear of the walls, 1 to 4 cars on every track");

/* The check: after every step, every car's footprint inside the walls and clear of every other car on its level. */
function check(w, what, t) {
  const cs = w.cars;
  for (const c of cs) {
    assert(c.fall < 0, what + ": nobody falls (t " + t.toFixed(2) + ")");
    const e = S.wallExcess(c, w.track).e;
    assert(e <= EPS, what + ": car " + c.seat + " " + e.toFixed(3) + " past a wall at t " + t.toFixed(2));
  }
  for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
    if (S.onTwoLevels(w.track, cs[a], cs[b])) continue;   // one on the bridge, one under it
    const o = S.overlap(cs[a], cs[b]);
    assert(!o || o.o <= EPS, what + ": cars " + a + " and " + b + " overlap " + (o && o.o.toFixed(3)) + " at t " + t.toFixed(2));
  }
}
let steps = 0, worstWall = -1e9, worstCar = 0;
function race(name, levels, hands, seconds, seed, what) {
  const k = levels.length, w = S.newWorld(name, 3, k, 2), mems = levels.map((_, i) => B.newMem(i, seed * 100 + i));
  const ev = []; let t = 0;
  const hand = hands || (() => null);
  const until = seconds || 240;
  while (t < until && !w.cars.every((c) => S.finished(w, c))) {
    const inputs = [];
    for (const c of w.cars) {
      const h = hand(c, t);
      if (h != null) { inputs[c.seat] = h; c.cap = 1; continue; }
      const r = B.think(w, c, levels[c.seat], mems[c.seat], P.DT);
      inputs[c.seat] = r.steer; if (r.use) S.useItem(c, ev);
    }
    S.stepWorld(w, inputs, ev, true, P.DT);
    for (const c of w.cars) if (c.finishAt < 0 && S.finished(w, c)) c.finishAt = t;
    check(w, what, t);
    for (const c of w.cars) worstWall = Math.max(worstWall, S.wallExcess(c, w.track).e);
    t += P.DT; steps++;
  }
  return { w, ev, t };
}

// whole races of bots: every track, every level, four cars
const times = {};
for (const name of S.TRACK_NAMES) for (const lv of B.LEVELS) {
  const r = race(name, [lv, lv, lv, lv], null, 240, 7, name + " " + lv);
  assert(r.w.cars.every((c) => S.finished(r.w, c)), name + " " + lv + ": every bot finishes three laps");
  times[name + lv] = r.t;
  const walls = r.ev.filter((e) => e.k === "wall").length, hits = r.ev.filter((e) => e.k === "hit").length;
  assert(walls < 40, name + " " + lv + ": the bots hit the walls " + walls + " times");
  console.log("    " + name + " " + lv + ": " + r.t.toFixed(1) + " s, " + walls + " wall hits, " + hits + " bumps");
}
for (const name of S.TRACK_NAMES) assert(times[name + "easy"] > times[name + "hard"], name + " levels order");
ok("whole races of four bots (every track, every level, 3 laps): every footprint inside the walls and clear of the others at every step (" + steps + " steps)");

// mixed fields and random hands (a person steering anyhow: weaving, holding a full lock, letting go)
for (const name of S.TRACK_NAMES) for (let seed = 1; seed <= 3; seed++) {
  let rs = seed * 7919;
  const rnd = () => { rs = (rs * 1103515245 + 12345) % 2147483648; return rs / 2147483648; };
  const hold = [0, 0, 0, 0], until = [0, 0, 0, 0];
  race(name, ["hard", "easy", "normal", "hard"], (c, t) => {
    if (c.seat === 0) return null;
    if (t >= until[c.seat]) { until[c.seat] = t + 0.2 + rnd() * 1.5; hold[c.seat] = rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) : rnd() * 2 - 1; }
    return hold[c.seat];
  }, 70, seed, name + " random hands " + seed);
}
ok("random hands on every track (three bots of them, 70 s each): the footprints stay inside and apart at every step");

// full lock either way (a car going round in circles) and a car aimed into the wall at 40 degrees, held straight: stopped by the wall, slides along, never through it
for (const name of S.TRACK_NAMES) for (const st of [-1, 1]) {
  race(name, ["hard"], (c, t) => (t < 0.6 ? 0 : st), 12, 3, name + " full lock " + st);
  const w = S.newWorld(name, 3, 1, 2), c = w.cars[0], ev = [];
  c.h += st * 0.7;
  let metAt = -1, i = 0;
  for (i = 0; i < 120 * 6 && (metAt < 0 || i < metAt + 60); i++) { S.stepWorld(w, [0], ev, true, P.DT); check(w, name + " into the wall " + st, i * P.DT); if (metAt < 0 && ev.some((e) => e.k === "wall")) metAt = i; }
  assert(metAt >= 0, name + ": the wall was met");
  const f = Math.cos(c.h) * c.vx + Math.sin(c.h) * c.vy;
  assert(f > P.MAX_SPEED * 0.4, name + ": half a second after the hit the car runs on along the wall (" + f.toFixed(0) + ")");
}
ok("full lock either way, and a car aimed into the wall: the wall turns it along, it slides on, never through");

// a field squeezed: four cars side by side on the grid all steering one way at the start
for (const name of S.TRACK_NAMES) for (const st of [-1, 1]) race(name, ["hard", "hard", "hard", "hard"], (c, t) => (t < 2.5 ? st : null), 20, 5, name + " squeeze " + st);
ok("four abreast all steering into one wall from the start: pressed together against it, never into each other or the wall");

// a bump: two cars meeting square on separate exactly and swap speed; a shield is not moved
{
  const w = S.newWorld("bath", 3, 2, 2), a = w.cars[0], b = w.cars[1];
  b.x = a.x + Math.cos(a.h) * (2 * P.CAR_HL2 - 6); b.y = a.y + Math.sin(a.h) * (2 * P.CAR_HL2 - 6); b.h = a.h;
  a.vx = Math.cos(a.h) * 120; a.vy = Math.sin(a.h) * 120; b.vx = b.vy = 0;
  const ev = [];
  S.stepWorld(w, [0, 0], ev, true, P.DT);
  assert.strictEqual(S.overlap(a, b), null, "apart");
  assert(b.vx * Math.cos(a.h) + b.vy * Math.sin(a.h) > 60, "the one behind passes its speed on");
  assert(ev.some((e) => e.k === "hit"), "a hit");
  ok("a car running into the back of another: pushed apart to the footprint, the speed passed on, a hit");
}
// the bridge: on it and under it the cars do not meet
{
  const tr = S.TRACKS2.bath;
  const mid = (tr.bridge[0] + tr.bridge[1]) / 2, p = S.at(tr, mid);
  let low = 0, best = 1e9;
  for (let s = 0; s < tr.L; s += 2) { if (Math.abs(s - mid) < 600) continue; const q = S.at(tr, s), d = Math.hypot(q.x - p.x, q.y - p.y); if (d < best) { best = d; low = s; } }
  assert(best < 8, "the passes cross " + best);
  assert(Math.abs(S.heightAt(tr, mid) - P.BRIDGE_H) < 1e-9 && S.heightAt(tr, low) === 0);
  // wherever the bridge's deck is over the lane beneath (any point of its width over that lane or its walls), it is high enough for a car to pass under (36 tall, a deck 14)
  let over = 0;
  for (let s = mid - 700; s <= mid + 700; s += 4) for (let lat = -tr.halfW; lat <= tr.halfW; lat += 15) {
    const q = S.at(tr, s), x = q.x - q.ty * lat, y = q.y + q.tx * lat;
    const nr = S.nearest(tr, x, y, Math.round(low / tr.sp) % tr.n);
    if (Math.abs(nr.d) < tr.halfW + 16 && Math.abs(nr.s - low) < 700) { over++; assert(S.heightAt(tr, s) >= 60, "the bridge is high enough over the lane beneath at " + s.toFixed(0) + " (" + S.heightAt(tr, s).toFixed(0) + ")"); }
  }
  assert(over > 100);
  const w = S.newWorld("bath", 3, 2, 2), a = w.cars[0], b = w.cars[1];
  const pl = (c, s) => { const q = S.at(tr, s); c.x = q.x; c.y = q.y; c.h = Math.atan2(q.ty, q.tx); c.s = s; c.idx = Math.round(s / tr.sp) % tr.n; c.vx = q.tx * 100; c.vy = q.ty * 100; };
  pl(a, mid); pl(b, low);
  S.stepWorld(w, [0, 0], [], true, P.DT);
  assert(Math.abs(Math.hypot(a.vx, a.vy) - 100) < 10 && Math.abs(Math.hypot(b.vx, b.vy) - 100) < 10, "no bump");
  ok("the Bathtub's bridge is up over the whole lane beneath, and a car on it and one under it do not meet");
}
// item boxes and pads still work on the wide lanes
{
  const w = S.newWorld("kitchen", 3, 1, 2), c = w.cars[0], ev = [], m = B.newMem(0, 3);
  for (let i = 0; i < 120 * 40; i++) { const r = B.think(w, c, "hard", m, P.DT); S.stepWorld(w, [r.steer], ev, true, P.DT); if (r.use) S.useItem(c, ev); }
  assert(ev.some((e) => e.k === "pad"), "pad"); assert(ev.some((e) => e.k === "item"), "item");
  ok("a car meets boost pads and item boxes on a lap of a wide track");
}
console.log("    worst wall excess over all steps " + worstWall.toFixed(3) + " (0 or less: inside)");
console.log(n + " geometry 2 checks passed");
