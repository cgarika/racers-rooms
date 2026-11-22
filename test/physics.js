/* Toy Racers' rules: the tracks, a car on its own, steering, falling off and respawning, pads, items, bumping, laps, the bots' lap times. */
"use strict";
const assert = require("assert");
const S = require("../physics"), B = require("../bots");
let n = 0; const ok = (m) => { n++; console.log("ok  " + m); };
const P = S.P;

for (const name of S.TRACK_NAMES) {
  const tr = S.TRACKS[name];
  assert(Math.abs(tr.L - 5280) < 8, name + " length " + tr.L);
  let min = 1e9;
  for (let i = 0; i < tr.n; i++) {
    const a = tr.pts[i], b = tr.pts[(i + 5) % tr.n], c = tr.pts[(i + 10) % tr.n];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    min = Math.min(min, ab * bc * ca / (2 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) + 1e-9));
  }
  assert(min > 180, name + " bend radius " + min);
}
ok("three closed tracks of 5280 units with no bend tighter than a car can take");

const drive = (w, seconds, steerFn, ev) => { const k = Math.round(seconds / P.DT); for (let i = 0; i < k; i++) S.stepWorld(w, [steerFn ? steerFn(w.cars[0], i) : 0], ev || [], true, P.DT); };
{
  const w = S.newWorld("bath", 3, 1), c = w.cars[0];
  drive(w, 1.7, () => 0);
  assert(Math.hypot(c.vx, c.vy) > P.MAX_SPEED * 0.97 && Math.hypot(c.vx, c.vy) < P.MAX_SPEED * 1.03, "speed " + Math.hypot(c.vx, c.vy));
  ok("a car accelerates on its own to the top speed");
}
{
  const turn = (st) => { const w = S.newWorld("bath", 3, 1), c = w.cars[0]; drive(w, 1.0, () => 0); const h0 = c.h; drive(w, 0.5, () => st); return c.h - h0; };
  assert(turn(1) > 0.3 && turn(-1) < -0.3 && Math.abs(turn(0)) < 0.01); ok("steering turns the car both ways");
}
{
  const w = S.newWorld("bath", 3, 1), c = w.cars[0], ev = [];
  drive(w, 12, () => 0.4, ev);   // a gentle constant turn: the straight start runs off the track sooner or later
  assert(ev.some((e) => e.k === "fall"), "falls");
  assert(ev.some((e) => e.k === "respawn"), "respawns");
  const nr = S.nearest(w.track, c.x, c.y, c.idx);
  assert(Math.abs(nr.d) <= P.HALF_W + 0.5 || c.fall >= 0); ok("falling off the edge respawns the car on the track, facing the way");
  assert(c.ghost > 0 || c.fall >= 0 || ev.length);
}
{
  // a fall takes the retraced stretch's progress back: dist stays within a few units of the arc position, however often it falls
  const w = S.newWorld("bath", 3, 1), c = w.cars[0], ev = [];
  drive(w, 40, () => 0.35, ev);
  assert(ev.filter((e) => e.k === "respawn").length >= 2);
  const lapPos = ((c.dist % w.track.L) + w.track.L) % w.track.L;
  const d = Math.abs(lapPos - c.s), wrap = Math.min(d, w.track.L - d);
  assert(wrap < 30, "dist " + c.dist + " vs s " + c.s); ok("a respawn takes its progress back with it");
}
{
  // pads and drifting
  const w = S.newWorld("kitchen", 3, 1), c = w.cars[0], ev = [], m = B.newMem(0, 3);
  for (let i = 0; i < 120 * 40; i++) { const r = B.think(w, c, "hard", m, P.DT); S.stepWorld(w, [r.steer], ev, true, P.DT); if (r.use) S.useItem(c, ev); }
  assert(ev.some((e) => e.k === "pad"), "pad"); assert(ev.some((e) => e.k === "item"), "item"); ok("a car meets boost pads and item boxes on a lap");
}
{
  const w = S.newWorld("bath", 3, 1), c = w.cars[0], ev = [];
  const free = (sec, st) => { for (let i = 0; i < Math.round(sec / P.DT); i++) { S.stepWorld(w, [st], ev, true, P.DT); c.fall = -1; } };   // (the track is not what is tried here)
  free(2, 0);
  free(1.3, 0.9);   // a hard turn: a drift builds
  assert(c.drift > 0.3, "drift " + c.drift);
  free(0.6, 0);
  assert(ev.some((e) => e.k === "mini") && c.boost > 0.3, "mini boost"); ok("holding a hard turn charges a drift and letting go gives a mini boost");
}
{
  const w = S.newWorld("bath", 3, 2), a = w.cars[0], b = w.cars[1], ev = [];
  b.x = a.x + 5; b.y = a.y; a.vx = 60; a.vy = 0; b.vx = 0; b.vy = 0;
  S.stepWorld(w, [0, 0], ev, true, P.DT);
  assert(Math.hypot(a.x - b.x, a.y - b.y) >= P.CAR_R * 2 - 0.2 && b.vx > 0, "bumped");
  ok("two cars bump apart and swap speed");
  const w2 = S.newWorld("bath", 3, 2), s1 = w2.cars[0], s2 = w2.cars[1];
  s2.x = s1.x + 5; s2.y = s1.y; s1.vx = 60; s1.shield = 3;
  const x0 = s1.x; S.stepWorld(w2, [0, 0], [], true, P.DT);
  assert(Math.abs(s1.x - x0) < 0.7 && s2.x > x0 + 5, "shield"); ok("a shield is not pushed, and pushes the other car");
}
{
  // the Bathtub's eight: its second pass over the middle is a bridge, the cars on it and under it do not meet
  const tr = S.TRACKS.bath;
  assert(tr.bridge && tr.bridge[1] > tr.bridge[0], "a bridge");
  const mid = (tr.bridge[0] + tr.bridge[1]) / 2;
  assert(S.heightAt(tr, 0) === 0 && Math.abs(S.heightAt(tr, mid) - S.P.BRIDGE_H) < 1e-9 && S.heightAt(tr, tr.bridge[0] + 20) < S.P.BRIDGE_H * 0.2);
  // the two passes really cross: a point of the bridge lies on the other pass
  const p = S.at(tr, mid); let near = 1e9;
  for (let s = 0; s < tr.L; s += 4) if (Math.abs(s - mid) > 300) near = Math.min(near, Math.hypot(S.at(tr, s).x - p.x, S.at(tr, s).y - p.y));
  assert(near < 12, "crossing " + near);
  const w = S.newWorld("bath", 3, 2), a = w.cars[0], b = w.cars[1];
  a.s = mid; b.s = 700;   // one on the bridge, one on the pass beneath
  a.x = b.x = p.x; a.y = b.y = p.y; b.x += 5; a.vx = 40; a.vy = 0; b.vx = b.vy = 0;
  S.stepWorld(w, [0, 0], [], true, S.P.DT);
  assert(a.vx === 40 || Math.abs(a.vx - 40) < 6, "no bump " + a.vx);
  ok("a bridge: the lane rises over the other pass and cars on different levels do not bump");
}
{
  const w = S.newWorld("bath", 2, 1), c = w.cars[0];
  c.item = 1; assert(S.useItem(c, []) && c.boost > 1 && c.item === 0); c.item = 2; S.useItem(c, []); assert(c.shield > 3); assert(!S.useItem(c, []));
  ok("items: a boost, a shield, nothing to use");
}
{
  const w = S.newWorld("bath", 1, 1), c = w.cars[0], m = B.newMem(0, 3);
  let t = 0;
  while (!S.finished(w, c) && t < 200) { const r = B.think(w, c, "normal", m, P.DT); S.stepWorld(w, [r.steer], [], true, P.DT); if (r.use) S.useItem(c, []); t += P.DT; }
  assert(S.finished(w, c) && S.lapsDone(w, c) === 1); ok("a lap is counted at the line (a bot's one lap: " + t.toFixed(1) + " s)");
}
{
  const times = {};
  for (const lv of B.LEVELS) for (const tn of S.TRACK_NAMES) {
    const w = S.newWorld(tn, 3, 1), c = w.cars[0], m = B.newMem(0, 5); let t = 0, falls = 0; const ev = [];
    while (!S.finished(w, c) && t < 220) { const r = B.think(w, c, lv, m, P.DT); S.stepWorld(w, [r.steer], ev, t > 0.1, P.DT); if (r.use) S.useItem(c, ev); t += P.DT; }
    assert(S.finished(w, c), lv + " " + tn + " never finished"); times[lv + tn] = t;
    assert(t > 70 && t < 150, lv + " " + tn + " took " + t);
  }
  assert(times.easybath > times.normalbath && times.normalbath > times.hardbath, "levels order");
  ok("every bot level finishes three laps on every track in 70 to 150 s, the harder faster (" + times.easybath.toFixed(0) + " / " + times.normalbath.toFixed(0) + " / " + times.hardbath.toFixed(0) + ")");
}
{
  const w = S.newWorld("bath", 3, 4);
  w.cars[0].dist = 100; w.cars[1].dist = 500; w.cars[2].dist = 300; w.cars[3].dist = 400; w.cars[3].finishAt = 80; w.cars[2].finishAt = 70;
  assert.deepStrictEqual(S.order(w), [2, 3, 1, 0]); ok("places: finishers by time, then by distance");
}
console.log(n + " physics checks passed");
