# Toy Racers Rooms (self-hosted)

The room server for **Toy Racers** (slug `racers`, dev port 3131, path `/racers`): live toy-car racing for two to four. Express and Socket.IO, rooms behind a
6-letter code (letters only), quick play and ranked (OpenSkill, `quickmatch.js`), bots Easy / Normal / Hard, cartoon reactions, chat, voice signalling, push, Plus.
No ads, no gear.

## How it plays

The server runs the race live: `physics.js` at a fixed 120 Hz (cars, track, boost pads, item boxes, drifting, bumping, falling off and respawning),
bots (`bots.js`) as drivers (a look-ahead point, an inside line for the harder ones). A player sends the **steer** (`in {s: -1..1, n}`; `n` is the app's own
step count, echoed as `ack` so the app reconciles its prediction); the car accelerates on its own. `use` presses the held item (boost or shield).
1, 2, 3 (default) or 5 laps. The race ends when every car is home, or 12 s after the first car (2.5 s once every person is home); places by finishing
time, then by distance. A driver who goes quiet for 8 s is driven by a bot until the next `in`. Leaving mid-race hands the car to a bot.
Pass-and-play (`create {local: true}` + `addLocal {name}`, passplay.js) is a **time trial in turns**: phase `handoff` waits for `go`, then one car alone for
the laps, the phone passed on; best lap wins; never rated.

Tracks (`tracks.json`, built by `tools/gen_tracks.js`; the app has the same points in `Games/Racers/RacersTracks.inl`): `bath` (Bathtub Grand Prix, free),
`kitchen` (Breakfast Speedway, Plus), `toyroom` (Midnight Toy Room, Plus). Each is 3000 units round; the track is 44 wide; a car about 7 long.

## The wire

Client to server: `create`, `join`, `settings {laps: 1|2|3|5, track}`, `addBot {level}`, `removeBot`, `start`, `in {s, n, as?}`, `use`, `go` (time trial),
`ping {c}` (answered `pong {c, s}`), `rematch`, `takeSeat`, `leave`, `chat`, `voice`, `react`, `quick` / `quickCancel`, `pushToken`, `presence`; with
`TEST_HOOKS=1` also `testSet {nearFinish, place: [seat, unitsToGo], botControlled, phase}`.

Server to client: `state {room, mySeat}` on every change of situation (phases `lobby, countdown, race, handoff, handoff-show, over`; `places`, `results`,
`trial`), and `snap` 30 times a second: `{k, t, ph, c: [[seat, x, y, heading, vx, vy, boost, shield, item(0|1|2), dist, fall(-1|s), ghost, drift, ack, steer, lastOk]],
bx (a bit per item box that is away), pl (places), e: [{k: pad|item|use|mini|fall|respawn|hit|lap|finish, seat, ...}]}`.

Run: `PORT=3131 node server.js`. Tests: `npm test` (physics, flow, roomcode, plus, moderation, reactions).
