/* Toy Racers' physics: small toy cars on a closed track. Pure functions of a world and its inputs, so the server can step a race live and the
   app (Games/Racers/RacersSim.cpp, ported from this file) can run the same rules for its own car between snapshots.

   Units: centimetres-ish "u" and seconds; one step is 1/120 s. A track is a closed loop of evenly spaced centreline points (tracks.json, the same
   points the app has in RacersTracks.inl), HALF_W each side of it. A car accelerates on its own to MAX_SPEED; the only input is a steer in -1..1.
   Falling off the edge respawns you on the track after a moment. Boost pads, item boxes (boost or shield), drift mini-boosts, bumping. */
"use strict";
const DATA = require("./tracks.json");

/* Units are centimetres on the toy table (a lane is 80 wide, a car about 60 long); the speeds are in cm/s. K scales the tuned speeds of the first version (100 cm/s) to this one. */
const S = 2.2;   // the track and everything on it, at the scale the pictures draw (a loop several lanes round, a car about a tenth of the screen wide)
const K = 0.8 * S;
const P = Object.freeze({
  DT: 1 / 120,
  HALF_W: DATA.halfW,        // the track's half width
  EDGE: 13.0,                 // past the edge by this much and the car is falling
  CAR_R: 26,
  MAX_SPEED: 100 * K, BOOST_SPEED: 152 * K,
  ACCEL: 62 * K, DECEL: 85 * K,
  TURN: 2.35,                // rad/s at full steer and speed
  STEER_RATE: 9,             // how fast the steer follows the input (per second)
  GRIP: 9.5, DRIFT_GRIP: 4.5,
  DRIFT_SLIP: 15 * K, DRIFT_MIN: 0.7, DRIFT_MAX: 1.6,
  DRIFT_FWD: 62 * K, TURN_FWD: 45 * K, DRIFT_LOW: 40 * K, SLIP_LOW: 6 * K,
  PAD_BOOST: 1.1, ITEM_BOOST: 1.8, SHIELD_T: 4.0, MINI_K: 0.6,
  FALL_T: 1.1, GHOST_T: 1.6, RESPAWN_BACK: 35,
  PAD_R: 60, BOX_R: 30, BOX_RESPAWN: 6,
  LAPS: 3,
  RESTITUTION: 0.55,
  RAMP: 330,                 // a bridge rises and falls over this much track at each end
  BRIDGE_H: 90,
});

const TRACKS = {};
for (const [name, t] of Object.entries(DATA.tracks)) TRACKS[name] = makeTrack(name, t.pts);
const TRACK_NAMES = Object.keys(TRACKS);

/* Pads and boxes: where along a lap (a fraction of its length) and how far off the centre. */
const PADS = [[0.17, 0], [0.50, 0], [0.82, 0]];
const BOXES = [[0.11, -30], [0.11, 30], [0.40, -30], [0.40, 30], [0.69, -30], [0.69, 30]];

function makeTrack(name, pts) {
  const n = pts.length, tan = [];
  let L = 0;
  for (let i = 0; i < n; i++) L += Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]);
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
    tan.push([dx / d, dy / d]);
  }
  return { name, pts, tan, n, L, sp: L / n, bridge: DATA.tracks[name].bridge || null };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/* How high the lane is at arc position s: a bridge rises over P.RAMP, stays up, and comes down; elsewhere 0. */
function heightAt(tr, s) {
  if (!tr.bridge) return 0;
  const x = ((s % tr.L) + tr.L) % tr.L, a = tr.bridge[0], b = tr.bridge[1];
  if (x <= a || x >= b) return 0;
  const k = Math.min(1, (x - a) / P.RAMP, (b - x) / P.RAMP);
  return P.BRIDGE_H * k * k * (3 - 2 * k);
}
const wrapS = (s, L) => ((s % L) + L) % L;

/* The centreline's point and heading at arc position s. */
function at(tr, s) {
  s = wrapS(s, tr.L);
  const f = s / tr.sp, i = Math.floor(f) % tr.n, j = (i + 1) % tr.n, t = f - Math.floor(f);
  const a = tr.pts[i], b = tr.pts[j];
  let tx = tr.tan[i][0] + (tr.tan[j][0] - tr.tan[i][0]) * t, ty = tr.tan[i][1] + (tr.tan[j][1] - tr.tan[i][1]) * t;
  const d = Math.hypot(tx, ty) || 1; tx /= d; ty /= d;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, tx, ty };
}

/* The nearest centreline point to (x, y), looked for round a hint index: { i, s, d } where d is the signed distance (right of the heading is positive). */
function nearest(tr, x, y, hint) {
  const W = 40, n = tr.n;
  let best = 1e18, bi = hint, bt = 0;
  for (let k = -W; k <= W; k++) {
    const i = (((hint + k) % n) + n) % n, j = (i + 1) % n;
    const ax = tr.pts[i][0], ay = tr.pts[i][1], dx = tr.pts[j][0] - ax, dy = tr.pts[j][1] - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
    const px = ax + dx * t - x, py = ay + dy * t - y, dd = px * px + py * py;
    if (dd < best) { best = dd; bi = i; bt = t; }
  }
  const j = (bi + 1) % n;
  const cx = tr.pts[bi][0] + (tr.pts[j][0] - tr.pts[bi][0]) * bt, cy = tr.pts[bi][1] + (tr.pts[j][1] - tr.pts[bi][1]) * bt;
  const tx = tr.tan[bi][0], ty = tr.tan[bi][1];
  const side = (x - cx) * -ty + (y - cy) * tx;   // + to the right of the heading (y down: right-hand normal is (-ty, tx))
  return { i: bi, s: (bi + bt) * tr.sp, d: side, dist: Math.sqrt(best) };
}

function newCar(seat, tr, slotCount) {
  /* The grid (the app draws the same boxes: Grid* in RacersSim.h): a car is about 70 wide and 156 long, on a lane 120 wide, so two abreast cannot be:
     the cars stand staggered one behind another, a box 170 apart, left lane then right lane (a real grid), each centred in its own box on the lane's heading. */
  const lane = seat % 2 === 0 ? -22 : 22;
  const s = tr.L - 80 - seat * 170;
  const c = at(tr, s);
  const h = Math.atan2(c.ty, c.tx);
  return {
    seat, x: c.x - c.ty * lane * -1, y: c.y + c.tx * lane * -1, h, vx: 0, vy: 0, steer: 0, boost: 0, shield: 0, item: 0, drift: 0,
    idx: Math.round(s / tr.sp) % tr.n, s, dist: s - tr.L, fall: -1, ghost: 0, finishAt: -1, lastOk: s, hits: 0,
  };
}
function newWorld(trackName, laps, seats) {
  const tr = TRACKS[trackName] || TRACKS.bath;
  const w = { track: tr, laps: laps || P.LAPS, cars: [], boxes: BOXES.map(() => 0), t: 0 };
  for (let i = 0; i < seats; i++) w.cars.push(newCar(i, tr));
  return w;
}

/* One car, one step: the steer input -1..1. Fills ev (when given) with { k, seat } moments. Pickups (item boxes) are the world's, handled in stepWorld. */
/* Gear (gear.js racersEffects): a car's own fx { speed, grip, boost } multiplies its top speed, its tyres' hold (and a little of its turn) and the length of its boosts; absent or 1 is the base. Held inside the gear table's own limits here too. */
const fxOf = (c, k, hi) => (c.fx && Number.isFinite(c.fx[k]) ? clamp(c.fx[k], 1, hi) : 1);

function stepCar(c, input, dt, w, ev, racing) {
  const tr = w.track;
  const gs = fxOf(c, "speed", 1.15), gg = fxOf(c, "grip", 1.2), gb = fxOf(c, "boost", 1.3);
  c.steer += (clamp(input, -1, 1) - c.steer) * Math.min(1, P.STEER_RATE * dt);
  if (c.ghost > 0) c.ghost = Math.max(0, c.ghost - dt);
  if (c.shield > 0) c.shield = Math.max(0, c.shield - dt);
  if (c.fall >= 0) {
    // falling: carried on, no steering, then put back on the track
    c.fall += dt;
    c.x += c.vx * dt; c.y += c.vy * dt;
    c.vx *= 1 - 1.5 * dt; c.vy *= 1 - 1.5 * dt;
    if (c.fall >= P.FALL_T) respawn(c, tr, ev);
    return;
  }
  if (!racing) { c.vx = c.vy = 0; return; }
  // turn first, then split the velocity along and across the new heading: what the turn did not carry is the slide
  {
    const hx0 = Math.cos(c.h), hy0 = Math.sin(c.h), f0 = c.vx * hx0 + c.vy * hy0;
    const drifting0 = Math.abs(c.steer) > 0.55 && f0 > P.DRIFT_FWD && c.boost <= 0;
    c.h += c.steer * P.TURN * (1 + (gg - 1) * 0.5) * Math.min(1, f0 / P.TURN_FWD) * (drifting0 ? 1.12 : 1) * dt;
  }
  const hx = Math.cos(c.h), hy = Math.sin(c.h);
  let fwd = c.vx * hx + c.vy * hy, side = c.vx * -hy + c.vy * hx;
  const target = c.boost > 0 ? P.BOOST_SPEED : P.MAX_SPEED * gs * (c.cap || 1);
  if (c.boost > 0) c.boost = Math.max(0, c.boost - dt);
  if (fwd < target) fwd = Math.min(target, fwd + (c.boost > 0 ? P.ACCEL * 3 : P.ACCEL) * dt);
  else fwd = Math.max(target, fwd - P.DECEL * dt);
  const sp = Math.hypot(fwd, side);
  if (sp > target * 1.06) { const k = target * 1.06 / sp; fwd *= k; side *= k; }
  const drifting = Math.abs(c.steer) > 0.55 && fwd > P.DRIFT_FWD && c.boost <= 0;
  side *= Math.exp(-(drifting ? P.DRIFT_GRIP : P.GRIP) * gg * dt);
  const slip = Math.abs(side);
  if (drifting && slip > P.DRIFT_SLIP * 0.6 && fwd > P.DRIFT_FWD) c.drift = Math.min(P.DRIFT_MAX, c.drift + dt);
  else if (slip < P.SLIP_LOW || fwd < P.DRIFT_LOW) {
    if (c.drift >= P.DRIFT_MIN) { c.boost = Math.max(c.boost, (c.drift * P.MINI_K + 0.3) * gb); if (ev) ev.push({ k: "mini", seat: c.seat }); }
    c.drift = 0;
  }
  const nhx = Math.cos(c.h), nhy = Math.sin(c.h);
  c.vx = nhx * fwd + -nhy * side; c.vy = nhy * fwd + nhx * side;
  c.x += c.vx * dt; c.y += c.vy * dt;
  // where on the track
  const nr = nearest(tr, c.x, c.y, c.idx);
  c.idx = nr.i;
  let ds = nr.s - c.s;
  if (ds > tr.L / 2) ds -= tr.L; else if (ds < -tr.L / 2) ds += tr.L;
  c.s = nr.s; c.dist += ds;
  const off = Math.abs(nr.d);
  if (off <= P.HALF_W) c.lastOk = c.s;
  if (off > P.HALF_W + P.EDGE) { c.fall = 0; if (ev) ev.push({ k: "fall", seat: c.seat }); return; }
  // pads
  for (let i = 0; i < PADS.length; i++) {
    const ps = PADS[i][0] * tr.L;
    let dd = Math.abs(wrapS(c.s - ps + tr.L / 2, tr.L) - tr.L / 2);
    if (dd < P.PAD_R && Math.abs(nr.d - PADS[i][1]) < P.HALF_W) {
      if (c.boost < P.PAD_BOOST * 0.7) { c.boost = P.PAD_BOOST * gb; if (ev) ev.push({ k: "pad", seat: c.seat }); }
    }
  }
}

function respawn(c, tr, ev) {
  const s = wrapS(c.lastOk - P.RESPAWN_BACK, tr.L), p = at(tr, s);
  let ds = s - c.s;   // put back where it was, its progress goes back with it (a retraced stretch must not count twice)
  if (ds > tr.L / 2) ds -= tr.L; else if (ds < -tr.L / 2) ds += tr.L;
  c.dist += ds;
  c.x = p.x; c.y = p.y; c.h = Math.atan2(p.ty, p.tx); c.vx = c.vy = 0; c.steer = 0;
  c.s = s; c.idx = Math.round(s / tr.sp) % tr.n; c.fall = -1; c.ghost = P.GHOST_T; c.drift = 0; c.boost = 0;
  if (ev) ev.push({ k: "respawn", seat: c.seat });
}

/* Cars bumping: a push apart and an impulse. A shield takes no push and gives double. */
function bump(w, ev) {
  const cs = w.cars;
  for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
    const A = cs[a], B = cs[b];
    if (A.fall >= 0 || B.fall >= 0 || A.ghost > 0 || B.ghost > 0) continue;
    if (Math.abs(heightAt(w.track, A.s) - heightAt(w.track, B.s)) > 40) continue;   // one on the bridge, one under it
    const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy), min = P.CAR_R * 2;
    if (d >= min || d < 1e-6) continue;
    const nx = dx / d, ny = dy / d, over = min - d;
    const wa = A.shield > 0 ? 0 : B.shield > 0 ? 2 : 1, wb = B.shield > 0 ? 0 : A.shield > 0 ? 2 : 1;
    const tot = wa + wb || 1;
    A.x -= nx * over * wa / tot; A.y -= ny * over * wa / tot;
    B.x += nx * over * wb / tot; B.y += ny * over * wb / tot;
    const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
    if (rv < 0) {
      const j = -(1 + P.RESTITUTION) * rv / 2;
      A.vx -= nx * j * wa; A.vy -= ny * j * wa; B.vx += nx * j * wb; B.vy += ny * j * wb;
      if (ev && rv < -8) ev.push({ k: "hit", seat: a, other: b, s: Math.min(1, -rv / 80), x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
    }
  }
}

/* One step of every car; inputs[seat] is the steer. racing false holds the cars still (the countdown). Item boxes: w.boxes[i] is the time left until it is back (0: there). */
function stepWorld(w, inputs, ev, racing, dt) {
  dt = dt || P.DT;
  const tr = w.track;
  for (const c of w.cars) stepCar(c, inputs[c.seat] || 0, dt, w, ev, racing);
  if (racing) {
    bump(w, ev);
    for (let i = 0; i < BOXES.length; i++) {
      if (w.boxes[i] > 0) { w.boxes[i] = Math.max(0, w.boxes[i] - dt); continue; }
      const bs = BOXES[i][0] * tr.L, bp = at(tr, bs), bx = bp.x - bp.ty * -BOXES[i][1], by = bp.y + bp.tx * -BOXES[i][1];
      for (const c of w.cars) {
        if (c.fall >= 0 || c.item) continue;
        if (Math.hypot(c.x - bx, c.y - by) < P.BOX_R + P.CAR_R) {
          w.boxes[i] = P.BOX_RESPAWN;
          c.item = ((c.seat + Math.floor(w.t * 7) + i) % 5) < 3 ? 1 : 2;   // boost more often than shield; no random: the server may reproduce a race
          if (ev) ev.push({ k: "item", seat: c.seat, i });
          break;
        }
      }
    }
    w.t += dt;
  }
}

/* Use the held item (boost: a burst; shield: bumps cannot move you for a while). Returns true when used. */
function useItem(c, ev) {
  if (!c.item || c.fall >= 0) return false;
  if (c.item === 1) c.boost = Math.max(c.boost, P.ITEM_BOOST * fxOf(c, "boost", 1.3));
  else c.shield = P.SHIELD_T;
  if (ev) ev.push({ k: "use", seat: c.seat, item: c.item });
  c.item = 0;
  return true;
}

/* Laps done (0 before the line) and whether this car has finished the race. */
const lapOf = (w, c) => clamp(Math.floor(c.dist / w.track.L) + 1, 1, w.laps);
function lapsDone(w, c) { return Math.max(0, Math.floor(c.dist / w.track.L)); }
function finished(w, c) { return c.dist >= w.laps * w.track.L; }

/* Places: finished cars by their finish time, the rest by how far they have got. Returns the seats, first first. */
function order(w) {
  return w.cars.slice().sort((a, b) => {
    const fa = a.finishAt >= 0, fb = b.finishAt >= 0;
    if (fa && fb) return a.finishAt - b.finishAt || a.seat - b.seat;
    if (fa !== fb) return fa ? -1 : 1;
    return b.dist - a.dist || a.seat - b.seat;
  }).map((c) => c.seat);
}

module.exports = { heightAt, P, TRACKS, TRACK_NAMES, PADS, BOXES, at, nearest, newWorld, newCar, stepCar, stepWorld, useItem, lapsDone, finished, order, wrapS, clamp, lapOf };
