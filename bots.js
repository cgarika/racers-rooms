/* The bot brain: a bot is a driver. Each step it looks a little way down the track, picks a line (the hard ones cut the inside of a bend), steers toward it
   and presses its item when it pays. It gives a steer in -1..1 and changes only `mem`; the level sets how far ahead it looks, how well it holds the line,
   how fast it may go and how it uses what it picked up. Pure. */
"use strict";
const { P, at, clamp } = require("./physics");

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
  let off = clamp(bend * 88, -P.HALF_W * 0.55, P.HALF_W * 0.55) * K.line;
  if (w.t >= mem.wobbleAt) { mem.wobbleAt = w.t + 0.6; mem.wobble = (rnd(mem) - 0.5) * 2 * K.noise * P.HALF_W; }
  off += mem.wobble + (mem.lane + Math.sin(w.t * mem.swayRate + seatPhase(mem)) * 0.18) * P.HALF_W * K.spread;
  off = clamp(off, -P.HALF_W * 0.72, P.HALF_W * 0.72);
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

module.exports = { LEVELS, SKILL, newMem, think };
