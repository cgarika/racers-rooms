/* Builds tracks.json: three closed tracks as evenly spaced centreline points (units are centimetres on the toy table). The Bathtub is a figure of eight (a lemniscate)
   whose crossing is a raised sponge bridge; the others are loops smoothed until no bend is tighter than a lane can take.
   The app's Games/Racers/RacersTracks.inl is generated from tracks.json (tools/gen_inl.js), so phone and server share the very same points.
   node tools/gen_tracks.js */
"use strict";
const fs = require("fs"), path = require("path");
const HALF_W = 60, LAP = 5280, SP = 4;
const CONTROL = {
  kitchen: [[0, 380], [300, 380], [450, 300], [470, 100], [350, -20], [380, -200], [250, -330], [0, -380], [-250, -330], [-420, -200], [-440, 0], [-330, 120], [-440, 260], [-300, 370]],
  toyroom: [[0, 380], [300, 380], [460, 250], [380, 60], [120, 60], [-40, -40], [120, -160], [400, -200], [460, -340], [250, -440], [-50, -400], [-250, -440], [-440, -320], [-440, -100], [-300, 60], [-440, 200], [-360, 350], [-180, 410]],
};
const PASSES = { kitchen: 90, toyroom: 420 };
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1].map((i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3));
}
function spline(ctrl) {
  const raw = [], n = ctrl.length;
  for (let i = 0; i < n; i++) for (let k = 0; k < 40; k++) raw.push(cr(ctrl[(i + n - 1) % n], ctrl[i], ctrl[(i + 1) % n], ctrl[(i + 2) % n], k / 40));
  return raw;
}
function smooth(pts, passes, win) {
  let p = pts.map((q) => q.slice());
  const n = p.length;
  for (let k = 0; k < passes; k++) p = p.map((_, i) => { let x = 0, y = 0; for (let j = -win; j <= win; j++) { const q = p[(i + j + n) % n]; x += q[0]; y += q[1]; } return [x / (2 * win + 1), y / (2 * win + 1)]; });
  return p;
}
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
function scaleTo(p, wanted) { const k = wanted / perimeter(p); const cx = p.reduce((a, q) => a + q[0], 0) / p.length, cy = p.reduce((a, q) => a + q[1], 0) / p.length; return p.map((q) => [(q[0] - cx) * k, (q[1] - cy) * k]); }
function minRadius(pts) {
  const n = pts.length; let min = 1e9;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 8) % n], c = pts[(i + 16) % n];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    min = Math.min(min, ab * bc * ca / (2 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) + 1e-9));
  }
  return min;
}
const out = { halfW: HALF_W, tracks: {} };
// the Bathtub: a figure of eight standing up the screen (long axis along y), crossing at the middle
{
  const raw = [];
  for (let i = 0; i < 2400; i++) { const t = (2 * Math.PI * i) / 2400, d = 1 + Math.sin(t) ** 2; raw.push([Math.sin(t) * Math.cos(t) / d, Math.cos(t) / d]); }
  const pts = resample(scaleTo(raw, LAP), SP);
  // the start: on the straightest stretch of the lobe (an end of the eight, where it is widest)
  let best = 0;
  for (let i = 0; i < pts.length; i++) if (pts[i][1] > pts[best][1]) best = i;
  best = (best - 20 + pts.length) % pts.length;   // a little before the very end of the lobe: the grid stands on the way into it
  const rot = pts.slice(best).concat(pts.slice(0, best));
  // where the two passes cross: the pairs of points close together and far apart along the loop
  const n = rot.length; let cross = null, cd = 1e9;
  for (let i = 0; i < n; i++) for (let j = i + 100; j < n - 100; j++) { const d = Math.hypot(rot[i][0] - rot[j][0], rot[i][1] - rot[j][1]); if (d < cd) { cd = d; cross = [i, j]; } }
  const sp = perimeter(rot) / n;
  out.tracks.bath = { pts: rot, bridge: [Math.round((cross[1] - 110) * sp), Math.round((cross[1] + 110) * sp)], crossAt: [cross[0] * sp, cross[1] * sp] };
  console.log("bath points", n, "length", perimeter(rot).toFixed(0), "min radius", minRadius(rot).toFixed(0), "crossing at s", out.tracks.bath.crossAt.map((v) => v.toFixed(0)).join(", "), "bridge", out.tracks.bath.bridge, "gap", cd.toFixed(1));
}
for (const [name, ctrl] of Object.entries(CONTROL)) {
  const pts = resample(scaleTo(smooth(spline(ctrl), PASSES[name], 6), LAP), SP);
  let far = 1e9; const N = pts.length;
  for (let i = 0; i < N; i++) for (let j = i + 40; j < N; j++) { if (N - (j - i) < 40) continue; far = Math.min(far, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])); }
  console.log(name, "points", N, "length", perimeter(pts).toFixed(0), "min radius", minRadius(pts).toFixed(0), "closest far-apart approach", far.toFixed(0));
  out.tracks[name] = { pts };
}
fs.writeFileSync(path.join(__dirname, "..", "tracks.json"), JSON.stringify(out));
