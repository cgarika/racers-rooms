/* Builds the wide tracks (geometry 2, qa1126) into tracks.json beside the first ones, which stay as they were for the apps that know only them.
   A lane of geometry 2 is HALF_W2 each side of the centreline: four cars stand abreast on the start line (a car is CAR_L2 by CAR_W2, physics.js) and race between
   solid walls. The Bathtub is a figure of eight made of two round ends joined by two straight diagonals (the picture's sponge bridge is one of them, straight),
   the others are loops smoothed until no bend is tighter than the lane can take and no two far-apart stretches come near enough for their walls to touch.
   node tools/gen_tracks2.js   (then node tools/gen_inl.js <worktree>) */
"use strict";
const fs = require("fs"), path = require("path");
const HALF_W2 = 150, SP = 4, MIN_R2 = 225;   // no bend tighter than this: the inner wall a gentle curve, not a corner
const file = path.join(__dirname, "..", "tracks.json");
const data = JSON.parse(fs.readFileSync(file, "utf8"));

function perimeter(p) { let L = 0; for (let i = 0; i < p.length; i++) L += Math.hypot(p[(i + 1) % p.length][0] - p[i][0], p[(i + 1) % p.length][1] - p[i][1]); return L; }
function resample(p, sp0) {
  const n = p.length, acc = [0];
  for (let i = 1; i <= n; i++) acc.push(acc[i - 1] + Math.hypot(p[i % n][0] - p[i - 1][0], p[i % n][1] - p[i - 1][1]));
  const L = acc[n], N = Math.round(L / sp0), sp = L / N, out = [];
  let j = 1;
  for (let i = 0; i < N; i++) {
    const s = i * sp;
    while (acc[j] < s) j++;
    const t = (s - acc[j - 1]) / (acc[j] - acc[j - 1]), a = p[j - 1], b = p[j % n];
    out.push([Math.round((a[0] + (b[0] - a[0]) * t) * 100) / 100, Math.round((a[1] + (b[1] - a[1]) * t) * 100) / 100]);
  }
  return out;
}
function smooth(pts, passes, win) {
  let p = pts.map((q) => q.slice());
  const n = p.length;
  for (let k = 0; k < passes; k++) p = p.map((_, i) => { let x = 0, y = 0; for (let j = -win; j <= win; j++) { const q = p[(i + j + n) % n]; x += q[0]; y += q[1]; } return [x / (2 * win + 1), y / (2 * win + 1)]; });
  return p;
}
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1].map((i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3));
}
function spline(ctrl) {
  const raw = [], n = ctrl.length;
  for (let i = 0; i < n; i++) for (let k = 0; k < 60; k++) raw.push(cr(ctrl[(i + n - 1) % n], ctrl[i], ctrl[(i + 1) % n], ctrl[(i + 2) % n], k / 60));
  return raw;
}
/* The tightest bend (radius through points 32 units apart) and the closest approach of two stretches more than a lane's worth apart along the loop. */
function minRadius(pts) {
  const n = pts.length; let min = 1e9;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 8) % n], c = pts[(i + 16) % n];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    min = Math.min(min, ab * bc * ca / (2 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) + 1e-9));
  }
  return min;
}
function closest(pts, skip, sp) {
  const N = pts.length, gap = Math.ceil(skip / sp); let far = 1e9;
  for (let i = 0; i < N; i += 2) for (let j = i + gap; j < N; j += 2) { if (N - (j - i) < gap) continue; far = Math.min(far, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])); }
  return far;
}
const centred = (p) => { const cx = p.reduce((a, q) => a + q[0], 0) / p.length, cy = p.reduce((a, q) => a + q[1], 0) / p.length; return p.map((q) => [q[0] - cx, q[1] - cy]); };
const rotateTo = (p, i) => p.slice(i).concat(p.slice(0, i));

const out = {};
// The Bathtub: round ends of radius R centred (0, -D) and (0, D), joined by the two straight diagonals that cross at the middle. The way round: down the right-to-left
// diagonal (y grows down the screen), round the bottom end, up the other diagonal over the bridge, round the top end. The line is on the lower diagonal, just before it
// meets the bottom end: the grid stands on the straight, clear of the bridge.
{
  const R = 285, D = 590;
  const th = Math.asin(R / D), hl = Math.sqrt(D * D - R * R);   // half a diagonal: from the middle to where it meets an end
  const ux = Math.sin(th), uy = Math.cos(th);   // the diagonal from the middle toward the bottom-left end's tangent point: (-ux, uy)
  const raw = [];
  const line = (x0, y0, x1, y1) => { const L = Math.hypot(x1 - x0, y1 - y0), k = Math.ceil(L / 1); for (let i = 0; i < k; i++) raw.push([x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k]); };
  const arc = (cx, cy, a0, a1) => { const k = Math.ceil(Math.abs(a1 - a0) * R / 1); for (let i = 0; i < k; i++) { const a = a0 + (a1 - a0) * i / k; raw.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); } };
  // tangent points: on the bottom end (centre (0, D)) the diagonal from the middle going down-left touches at angle -(PI - th) .. measured from +x
  const tB1 = [-hl * ux, hl * uy];               // the down-left diagonal meets the bottom end
  const tB2 = [hl * ux, hl * uy];                // the bottom end hands over to the up-right... (mirror)
  const tT1 = [hl * ux, -hl * uy], tT2 = [-hl * ux, -hl * uy];
  const ang = (p, c) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  line(0 + hl * ux, -hl * uy, tB1[0], tB1[1]);          // from the top-right tangent point down through the middle to the bottom-left one
  { const c = [0, D]; let a0 = ang(tB1, c), a1 = ang(tB2, c); while (a1 > a0) a1 -= 2 * Math.PI; arc(c[0], c[1], a0, a1); }   // round the bottom end (clockwise on screen)
  line(tB2[0], tB2[1], tT2[0], tT2[1]);                 // up through the middle (the bridge) to the top-left
  { const c = [0, -D]; let a0 = ang(tT2, c), a1 = ang(tT1, c); while (a1 < a0) a1 += 2 * Math.PI; arc(c[0], c[1], a0, a1); }   // round the top end
  let pts = resample(smooth(resample(raw, 2), 30, 6), SP);
  pts = centred(pts);
  const n = pts.length, sp = perimeter(pts) / n;
  // where the passes cross
  let cross = null, cd = 1e9;
  for (let i = 0; i < n; i++) for (let j = i + 150; j < n - 150; j++) { const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); if (d < cd) { cd = d; cross = [i, j]; } }
  // the line: on the first diagonal (the lower pass), LINE_AT past the crossing
  const LINE_AT = 430;
  const start = (cross[0] + Math.round(LINE_AT / sp)) % n;
  pts = rotateTo(pts, start);
  const c0 = (cross[0] - start + n) % n, c1 = (cross[1] - start + n) % n;
  const BR = 560;   // the bridge: the second pass, this far each side of the crossing (its ramps take the outer RAMP2 of it)
  out.bath = { pts, bridge: [Math.round(c1 * sp - BR), Math.round(c1 * sp + BR)], crossAt: [c0 * sp, c1 * sp] };
}
const CONTROL = {
  // Breakfast Speedway: a tall loop round the table, its right side bitten in (a long sweeping chicane)
  kitchen: [[0, -800], [360, -760], [440, -480], [400, -160], [250, 60], [400, 300], [440, 560], [320, 800], [0, 840], [-340, 800], [-450, 520], [-450, -480], [-340, -760]],
  // Midnight Toy Room: a long straight up the left, and on the right an S that swings in toward the middle and out again
  toyroom: [[-460, -820], [300, -820], [470, -620], [420, -400], [190, -310], [30, -120], [190, 70], [420, 160], [470, 380], [470, 640], [300, 820], [-460, 820], [-490, 500], [-490, -500]],
};
for (const [name, ctrl] of Object.entries(CONTROL)) {
  let base = resample(spline(ctrl), 4), pts = null, passes = 0;
  for (passes = 20; passes <= 600; passes += 10) { pts = resample(smooth(base, passes, 6), SP); if (minRadius(pts) >= MIN_R2) break; }
  pts = centred(pts);
  // the line: in the middle of the straightest stretch (the heading turns least over 300 units either side of it), so the grid stands on a straight
  const N = pts.length, hd = (i) => { const a = pts[(i + N - 2) % N], b = pts[(i + 2) % N]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  let bestI = 0, bestTurn = 1e9;
  for (let i = 0; i < N; i += 2) {
    let turn = 0;
    for (let k = -75; k < 75; k++) { let d = hd((i + k + 1 + N) % N) - hd((i + k + N) % N); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; turn += Math.abs(d); }
    if (turn < bestTurn) { bestTurn = turn; bestI = i; }
  }
  pts = rotateTo(pts, (bestI + 30) % N);   // (the line a little past the middle of it: the grid on the straight behind)
  out[name] = { pts, passes };
}
const report = [];
for (const [name, t] of Object.entries(out)) {
  const p = t.pts; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const q of p) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  const r = { name, points: p.length, length: Math.round(perimeter(p)), minRadius: Math.round(minRadius(p)), closest: name === "bath" ? null : Math.round(closest(p, 3 * HALF_W2 * 1.6, perimeter(p) / p.length)), box: [Math.round(x1 - x0), Math.round(y1 - y0)], bridge: t.bridge || null };
  report.push(r);
  console.log(JSON.stringify(r));
}
data.halfW2 = HALF_W2;
data.tracks2 = out;
if (process.argv[2] === "--out") fs.writeFileSync(process.argv[3], JSON.stringify(data));   // (a preview: tools/../tracks.json untouched)
else if (process.argv[2] !== "--dry") fs.writeFileSync(file, JSON.stringify(data));
