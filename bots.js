/* The bot brain: a bot is a driver. Each step it looks a little way down the track, picks a line (the hard ones cut the inside of a bend), steers toward it
   and presses its item when it pays. It gives a steer in -1..1 and changes only `mem`; the level sets how far ahead it looks, how well it holds the line,
   how fast it may go and how it uses what it picked up. Pure. */
"use strict";
const { P, at, clamp, nearest } = require("./physics");

const LEVELS = ["easy", "normal", "hard"];
const seatPhase = (mem) => mem.seat * 1.7;
const SKILL = {
  easy:   { look: 115, gain: 1.15, noise: 0.12, cap: 0.84, line: 0.0, spread: 0.3, useAfter: 2.6, lag: 0.22 },
  normal: { look: 145, gain: 1.5,  noise: 0.08, cap: 0.93, line: 0.5, spread: 1.0, useAfter: 1.2, lag: 0.10 },
  hard:   { look: 172, gain: 1.9,  noise: 0.02, cap: 1.00, line: 1.0, spread: 1.0, useAfter: 0.3, lag: 0.04 },
};

function newMem(seat, seed) {
  const m = { seat, s: (seed >>> 0) || 1, steer: 0, itemAt: -1, wobble: 0, wobbleAt: 0 };
  /* Each driver has a line of its own across the lane (left, right, middle, other side) that drifts slowly, and a pace of its own, so a field spreads out and passes. */
  m.lane = [-0.5, 0.5, -0.15, 0.2][seat % 4] * (0.8 + rnd(m) * 0.4);
  m.pace = 0.955 + rnd(m) * 0.05;
  m.swayRate = 0.25 + rnd(m) * 0.3;
  return m;
}
function rnd(mem) {
  mem.s = (mem.s + 0x6D2B79F5) >>> 0;
  let t = mem.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/* The steer for a car this step; `useItem` set true when the bot wants to press its item. */
function think(w, car, level, mem, dt) {
  const K = SKILL[level] || SKILL.normal;
  const tr = w.track;
  car.cap = K.cap * mem.pace;
  if (car.fall >= 0) return { steer: 0, use: false };
  const sp = Math.hypot(car.vx, car.vy);
  const look = K.look + sp * 0.12;
  // how sharply the track bends ahead: the heading now against the heading a way on
  const a0 = at(tr, car.s + 22), a1 = at(tr, car.s + look + 110);
  let bend = Math.atan2(a1.ty, a1.tx) - Math.atan2(a0.ty, a0.tx);
  while (bend > Math.PI) bend -= 2 * Math.PI; while (bend < -Math.PI) bend += 2 * Math.PI;
  const p = at(tr, car.s + look);
  // the inside of the bend: toward the side it turns to (the right-hand normal of the heading is (-ty, tx); a right turn is a positive bend in y-down)
  const HW = tr.halfW || P.HALF_W;
  let off = clamp(bend * 88, -HW * 0.55, HW * 0.55) * K.line;
  if (w.t >= mem.wobbleAt) { mem.wobbleAt = w.t + 0.6; mem.wobble = (rnd(mem) - 0.5) * 2 * K.noise * HW; }
  off += mem.wobble + (mem.lane + Math.sin(w.t * mem.swayRate + seatPhase(mem)) * 0.18) * HW * K.spread;
  if (tr.geo === 2) off += passLine(w, car, tr, off, mem);
  off = clamp(off, -HW * 0.72, HW * 0.72);
  const tx = p.x - p.ty * off, ty = p.y + p.tx * off;
  const want = Math.atan2(ty - car.y, tx - car.x);
  let d = want - car.h; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  const target = clamp(d * K.gain, -1, 1);
  mem.steer += (target - mem.steer) * Math.min(1, dt / Math.max(0.001, K.lag));
  let use = false;
  if (car.item) {
    if (mem.itemAt < 0) mem.itemAt = w.t + K.useAfter * (0.6 + rnd(mem));
    if (w.t >= mem.itemAt && (car.item === 2 || Math.abs(bend) < 0.25)) { use = true; mem.itemAt = -1; }
  }
  return { steer: mem.steer, use };
}

/* Geometry 2: a car a little way ahead on the line this bot wants is passed on the side with more room (eased, so the bot does not twitch). Returns the change to the line. */
function passLine(w, car, tr, off, mem) {
  let want = 0;
  for (const o of w.cars) {
    if (o === car || o.fall >= 0) continue;
    let ds = o.s - car.s; if (ds > tr.L / 2) ds -= tr.L; else if (ds < -tr.L / 2) ds += tr.L;
    if (ds < 40 || ds > 230) continue;
    const them = nearest(tr, o.x, o.y, o.idx, 12);
    if (Math.abs(them.d - off) > P.CAR_HW2 * 2 + 14) continue;   // not on my line
    // round the side with more room between them and the wall
    const side = them.d > 0 ? -1 : 1;
    want += side * (P.CAR_HW2 * 2 + 18) * (1 - (ds - 40) / 190);
  }
  mem.pass = (mem.pass || 0) + (want - (mem.pass || 0)) * 0.08;
  return mem.pass;
}

module.exports = { LEVELS, SKILL, newMem, think };
