/* Writes the app's geometry 2 parity fixture (qa1126): four bots race the wide Bathtub for 8 s on this physics; the steers each step and the cars at a few steps go to
   <worktree>/Source/GameNest/Private/Tests/Fixtures/racers/geo2_parity.json, so GameNest.Racers.Sim.Geo2ParityWithTheServer can replay them on the app's port.
   node tools/gen_parity2.js <worktree> */
"use strict";
const fs = require("fs"), path = require("path");
const S = require("../physics"), B = require("../bots");
const wt = process.argv[2];
if (!wt) { console.error("usage: node tools/gen_parity2.js <worktree>"); process.exit(2); }
const out = { track: "bath", geo: 2, seats: 4, steps: 960, steers: [], at: {} };
for (const name of ["bath", "kitchen"]) {
  const w = S.newWorld(name, 3, 4, 2), mems = [0, 1, 2, 3].map((i) => B.newMem(i, 91 + i)), lv = ["hard", "normal", "easy", "hard"];
  const steers = [], at = {};
  for (let k = 1; k <= out.steps; k++) {
    const inp = w.cars.map((c) => Math.round(B.think(w, c, lv[c.seat], mems[c.seat], S.P.DT).steer * 1e6) / 1e6);
    steers.push(inp);
    S.stepWorld(w, inp, [], true, S.P.DT);
    if (k === 1 || k === 120 || k === 240 || k === 480 || k === 960) at[k] = w.cars.map((c) => [c.x, c.y, c.h, c.vx, c.vy, c.dist]);
  }
  out[name] = { steers, at, caps: w.cars.map((c) => c.cap) };   // (a bot's speed cap: its level and its own pace, set by think)
}
delete out.steers; delete out.at;
const dest = path.join(wt, "Source/GameNest/Private/Tests/Fixtures/racers");
fs.mkdirSync(dest, { recursive: true });
fs.writeFileSync(path.join(dest, "geo2_parity.json"), JSON.stringify(out));
console.log("wrote", path.join(dest, "geo2_parity.json"));
