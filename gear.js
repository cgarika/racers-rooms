/* Gear (2026-11-08; Carrom and Table Soccer 2026-11-09; Mini Golf and Bowling 2026-11-10; Air Hockey, Flick Hoops, Toy Racers and Paint Splat 2026-11-21): the one gear table (gear.json, the same file in the app, the room servers and the wallet) and what a server does with it.
   The same file in every gear server (the first six, and hockey-rooms, hoops-rooms, racers-rooms and splat-rooms). Pure: no I/O after load.

   A player's gear is one item per slot and a level for each (Pool: cue, chalk, glove; Bumper Bash: body, engine, bumper; Carrom: striker, powder, cglove; Table Soccer: discs,
   keeper, boots; Mini Golf: putter, gball, grip; Bowling: bball, shoes, wrist; Air Hockey: mallet, hgrip, puck; Flick Hoops: hball, hshoes, band; Toy Racers: rengine, tyres, rboost; Paint Splat: blaster, tank, sboots). The app sends it when it joins: { cue: { item: "cue:sapphire", level: 5 }, chalk: {...}, glove: {...} }. clean() clamps every level to its item's rarity range (COMMON 1-6,
   RARE 2-8, EPIC 3-10, LEGENDARY 5-12; PLUS counts as EPIC) and throws away an item the table does not know (that slot plays as the starter item).
   A stat is the sum of what the equipped pieces give at their levels, never over 10. A player who sent no gear at all gets null: base values. */
"use strict";

const fs = require("fs");
const path = require("path");
const T = JSON.parse(fs.readFileSync(path.join(__dirname, "gear.json"), "utf8"));

const CAP = T.statCap;
const RULES = { lm1: (L) => L - 1, half: (L) => Math.floor(L / 2) };
const clampStat = (v) => Math.max(0, Math.min(CAP, v));
const rarityOf = (item) => { const i = T.items[item]; return i ? i.rarity : null; };
const range = (rarity) => T.rarity[rarity];
const slotsOf = (game) => (T.games[game] ? T.games[game].slots : []);
const starterOf = (slot) => T.starter[slot];

function clampLevel(item, level) {
  const r = range(rarityOf(item));
  const L = Number.isFinite(level) ? Math.trunc(level) : r.min;
  return Math.max(r.min, Math.min(r.max, L));
}

/** What one piece gives at a level: { statId: points } (before the 10 cap across pieces). */
function pieceStats(slot, level) {
  const out = {};
  for (const s of T.slots[slot].stats) out[s.id] = clampStat(RULES[s.rule](level));
  return out;
}

/** The sum of the equipped pieces' stats, each stat at most 10. */
function statsOf(game, slotsEq) {
  const out = {};
  for (const id of T.games[game].stats) out[id] = 0;
  for (const slot of slotsOf(game)) {
    const e = slotsEq[slot];
    const p = pieceStats(slot, e.level);
    for (const id of Object.keys(p)) out[id] = clampStat(out[id] + p[id]);
  }
  return out;
}

const scoreOf = (game, slotsEq) => slotsOf(game).reduce((n, s) => n + slotsEq[s].level, 0);

/** A player's gear from what the app sent (or null for none: base values). Always returns every slot, clamped. */
function clean(game, raw) {
  if (!T.games[game] || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const eq = {};
  for (const slot of slotsOf(game)) {
    const r = raw[slot] && typeof raw[slot] === "object" ? raw[slot] : {};
    const item = typeof r.item === "string" && T.items[r.item] && T.items[r.item].slot === slot ? r.item : starterOf(slot);
    eq[slot] = { item, level: clampLevel(item, typeof r.level === "number" ? r.level : NaN) };
  }
  return { slots: eq, stats: statsOf(game, eq), score: scoreOf(game, eq) };
}

/** A bot's gear for a gear score (3 to 36): the levels split as evenly as the rarities allow, each in the lowest-rarity item whose range holds it. */
function botGear(game, score) {
  const slots = slotsOf(game);
  let left = Math.max(slots.length, Math.min(slots.length * 12, Math.round(score)));
  const lv = slots.map(() => 1); left -= slots.length;
  for (let i = 0; left > 0 && i < 1000; i++) { const k = i % slots.length; if (lv[k] < 12) { lv[k]++; left--; } }
  const raw = {};
  slots.forEach((slot, k) => {
    const L = lv[k];
    const order = ["common", "rare", "epic", "legendary"];
    const have = (x) => Object.keys(T.items).find((i) => T.items[i].slot === slot && T.items[i].rarity === x && !T.items[i].plus);
    const r = order.find((x) => L >= range(x).min && L <= range(x).max && have(x)) || order.filter(have).pop();   // a slot with no LEGENDARY item tops out at its best
    const key = have(r);
    raw[slot] = { item: key, level: L };
  });
  return clean(game, raw);
}

/** Two players' scores are in one band when they are within BAND points of each other (quick and ranked play match within it). */
const BAND = 6;
const bandOk = (a, b) => Math.abs((a || 0) - (b || 0)) <= BAND;
/** No gear counts as the starter set (3). */
const scoreFor = (g, game) => (g ? g.score : slotsOf(game || "pool").length);

/* ---------- what the server does with the stats ---------- */

/** Pool: power +3% top speed a point, spin +6% a point, shot time +1 s a point. The aim line (+8% a point) is the app's. */
function poolEffects(stats) {
  const s = stats || {};
  return { speed: 1 + 0.03 * (s.power || 0), spin: 1 + 0.06 * (s.spin || 0), shotMs: 1000 * (s.shot || 0), aim: 1 + 0.08 * (s.aim || 0) };
}

/** Bumper Bash: weight +5% mass a point; bump power +4% of an impact's push a point; speed +3% acceleration and +2% top speed a point;
    boost cooldown -4% a point (120 ticks down to 72 at 10). Integers, so the phone's port is exact. */
const BOOST_CD_BY = [120, 115, 110, 106, 101, 96, 91, 86, 82, 77, 72];
function brawlEffects(stats) {
  const s = stats || {};
  const i = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(CAP, Math.trunc(v))) : 0);
  return { gw: i(s.weight), gp: i(s.bump), gs: i(s.speed), gc: i(s.boost) };
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** Carrom: power +3% striker top speed a point; glide -3% board friction a point (the slide's deceleration, for that player's shots); shot time +1 s a point; aim line +8% a point (the app's). */
function carromEffects(stats) {
  const s = stats || {};
  const p = (k) => (Number.isFinite(s[k]) ? Math.max(0, Math.min(CAP, s[k])) : 0);
  return { speed: r4(1 + 0.03 * p("power")), glide: r4(1 - 0.03 * p("glide")), shotMs: 1000 * p("shot"), aim: r4(1 + 0.08 * p("aim")) };
}

/** Table Soccer: power +3% flick top speed a point; reach +4% keeper block radius a point; shot time +1 s a point; aim line +8% a point (the app's). */
function soccerEffects(stats) {
  const s = stats || {};
  const p = (k) => (Number.isFinite(s[k]) ? Math.max(0, Math.min(CAP, s[k])) : 0);
  return { speed: r4(1 + 0.03 * p("power")), reach: r4(1 + 0.04 * p("reach")), shotMs: 1000 * p("shot"), aim: r4(1 + 0.08 * p("aim")) };
}

/** Mini Golf: power +3% putt top speed a point; roll -3% green friction and drag a point (the ball carries further, that player's own putts); shot time +1 s a point; aim line +8% a point (the app's stub). */
function golfEffects(stats) {
  const s = stats || {};
  const p = (k) => (Number.isFinite(s[k]) ? Math.max(0, Math.min(CAP, s[k])) : 0);
  return { speed: r4(1 + 0.03 * p("power")), roll: r4(1 - 0.03 * p("roll")), shotMs: 1000 * p("shot"), aim: r4(1 + 0.08 * p("aim")) };
}

/** Bowling: power +3% release top speed a point (the cap on the wire: Math.round(9800 * speed), the app scales its swipe by the same); hook +4% a point (the app's flick); steadiness -4% release
    wobble a point (wobbleRelease below); aim line +8% a point (the app's guide). */
function bowlingEffects(stats) {
  const s = stats || {};
  const p = (k) => (Number.isFinite(s[k]) ? Math.max(0, Math.min(CAP, s[k])) : 0);
  const speed = r4(1 + 0.03 * p("power"));
  return { speed, speedMax: Math.round(9800 * speed), hook: r4(1 + 0.04 * p("hook")), steady: r4(1 - 0.04 * p("steady")), aim: r4(1 + 0.08 * p("aim")) };
}


/* Gear step 5 (2026-11-21). Every effect is a few percent a point (points 0-10, so the most a stat can give is the effect at 10) and is clamped here: the app never sends a number, only items and levels. */
const pt = (s, k) => (s && Number.isFinite(s[k]) ? Math.max(0, Math.min(CAP, s[k])) : 0);

/** Air Hockey: mallet power +3% a point on the speed the puck leaves that seat's mallet with (the puck is still capped by the table); grip control +2% a point on how fast the mallet follows the hand
    (the hand cap MALLET_MAX x hand); puck spin: 0.05 rad/s of bend a point that the seat's own hits put on the puck (curve), decaying as it flies. */
function hockeyEffects(stats) {
  return { power: r4(1 + 0.03 * pt(stats, "power")), hand: r4(1 + 0.02 * pt(stats, "control")), curve: r4(0.05 * pt(stats, "curve")) };
}

/** Flick Hoops: ball arc assist pulls a flick's aim toward the hoop by 4% of its miss a point (never past the hoop); shoes: +0.5 s a point of extra shot time after the bell (extraMs, for that seat only); wristband: from the second basket in a row, +1 point
    on the basket for every four points (streakBonus). */
function hoopsEffects(stats) {
  return { arc: r4(0.04 * pt(stats, "arc")), extraMs: 500 * pt(stats, "time"), streakPts: pt(stats, "streak") };
}
const streakBonus = (fx, streak) => (fx && streak >= 1 ? Math.floor((fx.streakPts || 0) / 4) : 0);

/** Toy Racers: engine top speed +1.5% a point, tyres grip (cornering) +2% a point, boost charge +3% a point (that car's boost fills and lasts that much more). */
function racersEffects(stats) {
  return { speed: r4(1 + 0.015 * pt(stats, "speed")), grip: r4(1 + 0.02 * pt(stats, "grip")), boost: r4(1 + 0.03 * pt(stats, "boost")) };
}

/** Paint Splat: blaster splat size +1.5% a point (the swath's radius), tank ink +2% a point (the radius of the ink bomb's blast), boots move speed +1.5% a point. */
function splatEffects(stats) {
  return { size: r4(1 + 0.015 * pt(stats, "size")), ink: r4(1 + 0.02 * pt(stats, "ink")), move: r4(1 + 0.015 * pt(stats, "move")) };
}

/* Bowling's release wobble (gear step 4): a uniform nudge of the angle (up to 0.08 degrees), the speed (0.06 m/s) and the spin (0.02) drawn from the release's own integers (FNV-1a over their halves,
   then a mix), scaled by `mul` (1 at the base, the shoes' steadiness takes it down to 0.6), the result on the wire's grid and clamps (speedMax: the seat's cap). The same swipe always wobbles the same
   way, so a replay agrees; the phone applies the same to its own release before it rolls the ball (BowlingCore's WobbleRelease, the same integers). */
const WOBBLE = Object.freeze({ angle: 80, speed: 60, spin: 20 });
const WIRE = Object.freeze({ x: 4000, angle: 3500, speedMin: 5400, speedMax: 9800, spin: 1000 });
function wobbleRelease(w, mul, speedMax) {
  if (!w || !(mul > 0)) return w;
  const cap = speedMax > 0 ? Math.max(WIRE.speedMin, speedMax) : WIRE.speedMax;
  let h = 2166136261 >>> 0;
  for (const v of [w.x, w.angle, w.speed, w.spin]) {
    const u = v >>> 0;
    h = Math.imul(h ^ (u & 0xffff), 16777619) >>> 0;
    h = Math.imul(h ^ ((u >>> 16) & 0xffff), 16777619) >>> 0;
  }
  const draw = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return ((h >>> 8) / 16777216) * 2 - 1;
  };
  const ua = draw(), us = draw(), up = draw();
  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    x: w.x,
    angle: clampI(w.angle + Math.round(WOBBLE.angle * mul * ua), -WIRE.angle, WIRE.angle),
    speed: clampI(w.speed + Math.round(WOBBLE.speed * mul * us), WIRE.speedMin, cap),
    spin: clampI(w.spin + Math.round(WOBBLE.spin * mul * up), -WIRE.spin, WIRE.spin),
  };
}

module.exports = { T, CAP, BAND, BOOST_CD_BY, WOBBLE, rarityOf, range, slotsOf, starterOf, clampLevel, pieceStats, statsOf, scoreOf, clean, botGear, bandOk, scoreFor, poolEffects, brawlEffects, carromEffects, soccerEffects, golfEffects, bowlingEffects, wobbleRelease, hockeyEffects, hoopsEffects, streakBonus, racersEffects, splatEffects };
