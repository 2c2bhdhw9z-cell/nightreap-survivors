# Nightreap Survivors — build scratchpad

Plan of record: `/home/user/plan.md` (approved). This file tracks progress, decisions, and blockers.

## Current phase: 0 — Foundation + renderer go/no-go

### Done
- `app_init` → `/home/user/nightreap-survivors`
- `design.md` written: locked palette (core ramp + meaning-bound accents), co-op player colours with
  pip redundancy, `NightreapGlyph` 6×8 / 10×12 bitmap font spec, 8px grid, 9-slice weights, motion
  rules, screen inventory, non-negotiables
- Deps installed in one command before Metro: `expo-gl@16.0.10`, `expo-asset@12.0.13`,
  `expo-font@14.0.12`, `expo-file-system@19.0.23`, `@react-native-async-storage/async-storage@2.2.0`
- `app.json`: name `Nightreap Survivors`, slug `nightreap-survivors`, bundle id
  `com.nightreap_k7q2.runable` (both platforms), splash/adaptive-icon bg → `#141320`,
  iOS `CADisableMinimumFrameDuration: true` for 120Hz. `expo.extra` and `expo.scheme` untouched.

### In progress
- `constants/theme.ts` recolour to design tokens (dark-only: light == dark)
- `game/core/` — `fx.ts` fixed-point + trig LUTs, fixed-timestep loop, named seeded RNG streams,
  entity pools, spatial hash
- `game/render/` — GL bootstrap, shader, sprite batcher, camera, atlas loader
- Gate A benchmark harness

### Next
- `game/net/` scaffolding (input struct, binary codec, tick buffer, state hash, correction sweep)
- Replay harness `scripts/replay-test.ts`
- Atomic save writes + backup slot; remote-config scaffolding; `devgate.ts` + run-taint plumbing
- HUD + one menu mock images → user approval before any screen code
- Gate A: 5,000 textured quads @ 60fps with overlay

### Decisions made this phase
- Bundle short id: `k7q2`
- Game is dark-only; `Colors.light` and `Colors.dark` hold identical values rather than fighting
  `userInterfaceStyle: "automatic"`
- Engine lives at `packages/mobile/game/` with zero React Native imports (headless CI + future
  web/desktop shell swap)

### Blockers / flags for the user
- No `gh` CLI in the sandbox — GitHub linking is platform-side. Needs confirming from the Runable UI
  so Phase 0 can end with a real backup push.

## Decisions added 2026-08-11
- Injected tweak menus (iOSGods-style) assumed present at launch; see plan.md §5b addendum.
  - Ladder submissions require mandatory server-side replay revalidation (was sampled).
  - Co-op guests run plausibility checks on host events; modded host = session non-counting.
- Dev menu visual direction: first mock generated at mocks/dev-menu_1786425984059.png,
  awaiting user yes/no before any dev-menu screen code (mock-first HARD GATE).
  - Known mock artifact: two steppers rendered "[·]" instead of "[+]" — text render glitch, not design.
- Dev menu structure settled: 8 horizontally-scrolling tabs (SIM/SPAWN/RUN/BUILD/MOD/RNDR/DEV/INPT),
  each its own scroll view. Pinned: top bar, status strip, search, tab bar, bottom taint warning.
  Global search across all toggles + user-configurable FAVORITES row.
  Tabbed mock: mocks/dev-menu-tabbed_1786426225031.png (BUILD tab, density proven).

## Verified 2026-08-11 (first real verification pass)
- `bun run typecheck` PASS (3/3 packages). WebGLRenderingContext DOM types resolve via
  expo/tsconfig.base — structural-GL-interface fallback NOT needed. Assumption closed.
- `bun run lint` PASS (konsistent 17 files + oxlint 66 files, 0 warnings 0 errors).
- `bun run build` PASS.
- Metro running on port 4300. `/dev/bench` route mounts.
- expo-gl web support CONFIRMED (GLView -> WebGL canvas). Assumption closed.
- Headless Chrome default = NO WebGL at all. Forced SwiftShader via
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader to run the harness.
- HARNESS CORRECTNESS VERIFIED: 5172 quads -> 5 draw calls / 5 layers, procedural debug atlas
  uploads and samples correctly, batcher packs pos/uv/colour correctly, overlay reports
  p50/p95/p99 + dropped ticks + quad/draw/layer counts.
- Software-GL baseline (MEANINGLESS for the gate, recorded only as a floor):
  5172 quads @ 126.0ms p50 / 246.0ms p95 / 291.0ms p99, 7.9fps, 684 dropped ticks.
- GATE A STILL UNDECIDED. Requires native hardware (REVVL + iPhone). Blocker for Phase 0 close.

## Fixed 2026-08-11 — preview "open does nothing"
Root cause was two separate bugs, both reproduced and fixed:
1. `/` still rendered the stock template "Welcome" + failing API ping, with NO route into the
   bench. Opening the preview looked like a no-op. -> rewrote app/(tabs)/index.tsx as a dev
   launcher with a GATE A BENCH button + warm-test instructions. Navigation verified by click.
2. `/dev/bench` HARD CRASHED to the error boundary ("Something went wrong / Browser does not
   support WebGL") on any browser without WebGL, because GLView throws during render.
   -> added webglAvailable() guard + explanatory fallback screen. Verified both paths:
      no-WebGL browser shows the fallback, SwiftShader browser still renders 5172 quads / 5 draws.
3. Bench overlay was illegible over the quad storm (no background). -> panel is now opaque ink
   with a 1px stoneLit bottom border. Verified legible.
typecheck + lint pass after each change.

## GitHub — live 2026-08-11
- Private repo: github.com/2c2bhdhw9z-cell/nightreap-survivors (branch `main`, 111 files).
- Push verified by fetch. `.env` confirmed NOT on remote (Turso token / S3 keys / auth secret safe).
- Token stored in gitignored credential store, NOT in .git/config or the remote URL.
- ACTION FOR USER: rotate the PAT — it was pasted in plain chat.
- .gitignore hardened: `*.env` + `.git-credentials*` (a bare `.env` rule would not have caught
  an `ask_secrets` file written as `.git-credentials.env`).
- CONFIRMED BUG in plan: `.gitignore` line 73 excludes `scripts/`, so the planned
  `scripts/replay-test.ts` would be silently untracked. Replay harness moves to
  `packages/mobile/game/replay/` instead. Do not put version-controlled code in `scripts/`.

## Native testing loop — CONFIRMED 2026-08-11
- Metro serves a valid iOS manifest over the public HTTPS proxy (runtimeVersion exposdk:54.0.0).
- iOS Hermes bundle builds clean: HTTP 200, 7.3 MB, no transform errors.
- `ExpoGL` + `ExponentGLObjectManager` present in the iOS bundle, and expo-gl ships inside the
  Expo Go binary for SDK 54 -> **Gate A can be measured in Expo Go. No custom dev build needed.**
  This closes the plan's open "does expo-gl work under Expo Go" assumption for iOS.
- Expo Go URL (manual entry): exp://nightre-oqwfyiy-preview-4300.runable.site
- Android/REVVL: same URL in Expo Go, or just Chrome for a browser-WebGL number.
- iPhone Safari preview datapoint from user (real hardware, browser WebGL):
  8172 quads @ 21.0ms p50 / 47.6fps / 0 dropped ticks / 5 draws / 5 layers.
  Encouraging: 63% above the 5,000 gate, in a browser, with zero dropped ticks.
- STILL OPEN: the 5,000-quad warm number on the REVVL. That is the WebGL-vs-Skia decision.
  User is at work; deferred.

## Bench instrument fixes — 2026-08-11 (two bugs from the native iPhone screenshot)

### Bug 1 — FIXED: frame timing used `Date.now()`
`Date.now()` has 1ms integer resolution, which cannot measure a 16.67ms budget. That is why the
first native readout showed `17.0ms p50 / 17.0 p95 / 17.0 p99 / 17.0 worst` — four identical
numbers are not four measurements, they are one quantised number printed four times. All sub-ms
jitter was invisible and p50 vs p99 was meaningless.
Fix: `nowMs()` helper prefers `performance.now()` (Hermes has it on RN 0.81 / SDK 54) and falls
back to `Date.now()`. Used for both `timer.push()` and `loop.advance()`. `Date.now()` is kept only
for the warm clock, where it measures minutes and 1ms resolution is fine.
Verified in SwiftShader: percentiles now spread (147.5 / 477.8 / 542.8 / 717.7ms) instead of flat.
**Every Gate A number recorded before this fix is void, including the 58.8fps iPhone result.**

### Bug 2 — sprites froze ~30-40s in, panel kept updating. NOT root-caused, now diagnosable.
Ruled out: the sim itself. `game/bench/storm-soak.ts` (new, headless, no GL, no React) ran
200,000 ticks = ~55 min of sim time at 5,000 quads: no freeze, no NaN, nothing escaped the field,
0 entities stuck. `QuadStorm.tick()` is clean.
That leaves three suspects, which the old panel could not tell apart, because the readout is a
React Native view composited *on top of* the GL surface — a climbing counter proved only that
JavaScript was alive, not that anything reached the display.
Instrumentation added so the next run identifies it without guessing:
- `sim Xs / real Ys` row. Sim clock is derived from the tick counter, real from the wall. They must
  stay within ~1s. This survives a screenshot, which a moving sprite does not.
- `ticks/frame` and `stale Nms` (ms since the tick counter last changed) + a `SIM STALLED` banner.
- Two heartbeat bars drawn *inside GL* at the bottom of the screen (`QuadStorm.drawHeartbeat`):
  gold advances per rendered frame, cyan per sim tick.
Reading the result:
- gold frozen + panel still counting frames -> GL stopped presenting (bug is below us in expo-gl).
- cyan frozen + gold moving -> the fixed loop stopped ticking.
- both moving + sprites still -> bug is in the storm after all.
- Also: a throw inside the frame callback used to be invisible, because rAF is rescheduled on the
  first line — the loop kept running while nothing rendered. Now caught, counted, and displayed.
Note: Bug 1's clock also fed `loop.advance()`, so a clock-resolution stall is possible and may
already be fixed by the same change.

### NEXT RUN IS THE GATE A VERDICT
iPhone: exp://nightre-oqwfyiy-preview-4300.runable.site pasted into the **Safari address bar**
(offers "Open in Expo Go"). REVVL: same URL in Expo Go, or plain Chrome for a browser number.
5000 preset, HUD on, ~15 min warm, then screenshot. REVVL is the device that decides WebGL vs Skia.

## Bench crash investigation — 2026-08-11 (session 3)

Symptom from Brett's iPhone 17 Pro Max (Expo Go): background sprites froze at ~1:15–1:30,
readout panel kept reporting ~58.8fps, app vanished straight to the iOS home screen at ~9:30
with no error screen.

**Straight-to-home-screen with no error screen = iOS jetsam.** The OS killed the process for
memory. That single cause explains both symptoms: memory climbs, presentation stalls first,
kill comes later.

### Ruled out: the simulation
`game/bench/soak.test.ts` (new) drives `QuadStorm.tick()` headlessly with no GL at all.
20 minutes of sim (72,000 ticks) at 5,000 quads:

    moving=5000/5000 · nonFinite=0 · outside=0 · maxAbs=574.0
    72000 ticks in 2142ms (29.7us/tick) · heapGrowth=0KB

No freeze, no NaN, no saturation, no allocation. The sim is not the bug. The freeze is the
renderer holding the last frame while JS keeps looping.

### Fixed
- **Bug 1 (frame timing) — DONE.** `Date.now()` has 1ms integer resolution and cannot measure a
  16.67ms budget, which is why all four percentiles read a flat `17.0ms`. Now `performance.now()`
  via a `nowMs()` helper; `Date.now()` kept only for the warm clock, where 1ms is fine.
  **Every Gate A number before this fix is void, including the 58.8fps iPhone result.**
- **`SpriteBatcher.flush` allocated per flush.** `this.bytes.subarray(0, byteCount)` returns a new
  view *object* every call — the old comment claimed "no allocation", which is true of the backing
  memory but not the wrapper. Five per frame at 60fps = 18,000 short-lived objects a minute crossing
  the JSI bridge into native GL. Replaced with views cached per power-of-two byte bucket: ~14 views
  for the batcher's lifetime, uploading at most 2x the needed bytes. Verified flat at 540,672
  bytes/frame across a whole run.
- **Freeze is now visible instead of silent.** `drawHeartbeat` draws two GL-side bars (gold = one
  rendered frame, cyan = one sim tick) so a stalled sim can't read as 60fps. Frame callback wrapped
  in try/catch with an error counter — a throw used to be invisible because rAF is rescheduled on
  the first line. Overlay now shows sim-vs-real clock, ticks/frame, stale ms, upload KB/frame, heap.

### Flight recorder — the key addition
`game/bench/flight-recorder.ts`. A jetsam kill gives no notification, no unwind, and no chance to
render, so asking Brett to screenshot the panel before it dies is asking for the impossible. The
bench now writes a 90-sample tail to AsyncStorage every 2s and displays the *previous* run's log on
mount. Verified in software GL: after a hard reload it correctly reported
`PREVIOUS RUN DIED at 54s — no clean exit (OS kill or hard crash)` plus heap slope, sim-behind, and
the freeze moment.

### Open — what the next iPhone run decides
Note `heapMb` is -1 on Hermes (`performance.memory` unimplemented), so on iOS the argument rests on
`uploadBytes` and the tick trace.
- If it now survives → the subarray churn was the leak; carry on.
- If `uploadBytes` stays flat and it still dies at ~9:30 → the leak is **inside expo-gl's native
  side**, not ours, and nothing in `game/render/` can fix it. **That is a Gate A failure and the
  trigger to pivot to native Skia**, which is contained to `game/render/` by design.

## iPhone flight log recovered — 2026-08-11 (the decisive datapoint)

Brett's iPhone 17 Pro Max, Expo Go, 5000 preset. Recovered PREVIOUS RUN block:

    PREVIOUS RUN DIED at 844s — no clean exit (OS kill or hard crash)
    device ios 1320x2868 · 5176 quads · 90 samples
    heap not reported by this engine (JS heap unavailable)
    sim tick 50652 vs 50640 expected (on time)
    p50 16.7ms · p99 16.7ms · upload 528KB/frame

The flight recorder worked exactly as designed — a jetsam kill left no screenshot opportunity and
we got the data anyway.

### What this settles
- **The freeze is FIXED.** `sim tick 50652 vs 50640 expected (on time)` over the full 844s, and no
  "sim froze between" line at all. The 1:15 freeze was the per-flush `subarray` allocation churn
  (GC pauses starving the loop). It has not recurred.
- **Timing fix confirmed landed.** `16.7ms`, not the old quantised `17.0ms` — `performance.now()`
  is reporting sub-millisecond on Hermes.
- **Speed is not the problem.** 5,176 quads at p50 = p99 = 16.7ms, vsync-locked, zero dropped
  ticks, 14 minutes in and thermally warm. On raw performance an iPhone walks Gate A.
- **The leak is NOT our vertex data.** `upload 528KB/frame` was identical in the first and last
  sample. Nothing in the batcher grows.
- **Lifetime improved 570s -> 844s** with the allocation fix, but it still dies. So there were two
  separate problems, not one: allocation churn (fixed) and a real leak (open).

### Caveat on p50 == p99 == 16.7ms
Identical percentiles are still slightly suspicious even at sub-ms resolution. Frames are
start-to-start under a rigid CADisplayLink, so near-zero jitter is plausible — but treat "perfectly
flat" as unconfirmed until the REVVL, where throttling should produce visible spread. If the REVVL
also reports four identical values, suspect the instrument again, not the hardware.

### Remaining suspect: per-frame GL call marshalling inside expo-gl
Hermes exposes no heap or RSS, so the only available instrument is *time until the OS kills us*.
Built `app/dev/leak.tsx` to bisect it — three modes stripping one layer at a time
(`present` = clear+endFrameEXP only / `draw` = static geometry, no upload / `upload` = bufferSubData
per frame), each with a x1/x4/x16 amplifier that multiplies work per frame without changing the
picture. Amplifying is what makes this affordable: at 14 min a trial, a x16 run that dies in ~50s
turns an afternoon into minutes. Every mode+amplifier pair keeps its own flight log so trials cannot
overwrite each other. Verified in software GL: `upload x16` correctly self-reported
`DIED at 18s · upload 2000KB/frame`.

Decision table:
- `present` dies too              -> leak is in expo-gl frame presentation. Unfixable from
                                     `game/render/`. **Gate A fails -> pivot to native Skia.**
- only `upload` dies              -> per-frame bufferSubData. Fixable (persistent/double-buffered VBO).
- `draw` and `upload` both die    -> per-draw-call marshalling. Fixable by cutting draw calls.
- amplifier shortens death        -> leak scales with bytes/calls, naming the unit.
- amplifier changes nothing       -> leaks per frame, not per call.

**Gate A remains UNDECIDED and the REVVL warm number is still the actual gate.** iPhone is the feel
target only.

## Leak isolation results — 2026-08-11 (session 4)

Three trials on iPhone 17 Pro Max, all ARMED and left running. **None died.**

| mode | amp | lifetime | frames | upload | draws |
|---|---|---|---|---|---|
| upload | ×16 | 35m09s alive | 126,596 | 2000KB/frame | 16 |
| draw | ×16 | 35m03s alive | 126,335 | 0KB/frame | 16 |
| present | ×1 | 32m42s alive | 118,122 | 0KB/frame | 0 |

→ expo-gl frame presentation, draw-call submission, and dynamic buffer uploads are all
**CLEARED**. The bench died at 844s; these ran 2.3–2.5× longer at 16× the work.
**Skia pivot is NOT triggered by this.** Gate A is still undecided on perf grounds only.

### JS heap proven flat
`/tmp/heapwatch.py` ran the real `/dev/bench` in Chrome+SwiftShader, 1000 preset,
6 minutes / 11,033 frames. `usedJSHeapSize` sawtoothed 15.55–19.37MB, `totalJSHeapSize`
pinned ~26.31MB. Net **-0.09MB/min**, **-53.4 bytes/frame**, `ERRORS: none`.
→ **No JS leak.** The 844s kill is native-side memory, not Hermes heap.

### Elimination table
| suspect | verdict | evidence |
|---|---|---|
| sim logic / entity drift | clean | 72k-tick headless soak, heapGrowth=0KB |
| vertex volume | clean | upload ×16 = 2MB/frame for 35 min |
| draw-call count | clean | draw ×16 = 35 min |
| expo-gl presentation | clean | present ×1 = 32 min |
| JS heap | clean | -53.4 bytes/frame over 11k frames |
| `subarray` per flush | FIXED | `uploadView()` pow2 cache; lifetime 570s → 844s |
| uniform write marshalling | **UNTESTED** | new `layers` mode, 5 uniform2f/layer ×amp |

### Next instrument: `layers` mode
Only remaining difference between the surviving harness and the dying bench:
the harness never writes a uniform, but `Renderer.layer()` calls `batch.setCamera()`
→ `gl.uniform2f` 5× per frame. `layers` mode does `uniform2f` + `drawElements` per
layer, `LAYERS_PER_FRAME = 5`, camera value varies per frame so the driver cannot
elide a redundant upload. Verified in SwiftShader: `layers ×16 · 80 draws/frame`.

If `layers ×16` dies fast on device → uniform marshalling is the leak, fixed by
caching the camera uniform and skipping redundant writes.
If it survives ~35 min → bisect `bench.tsx` in place instead (toggles for SIM / HUD /
HEARTBEAT / PANEL / RECORDER). Bench-only elements still untested: the real
`createDebugAtlas` texture, 5,176 per-sprite JS `draw()`/`drawRotated()` calls, the
synthetic HUD, and the 4×/sec React panel re-render.

## Netcode + replay layer — 2026-08-11 (session 3, cont.)

Built while Gate A is blocked on device access. Both layers are headless-testable, so
progress here needed nothing from the phone.

### `game/net/` — complete, self-tested, pushed (`d53bb28`)
`protocol.ts` · `codec.ts` · `input.ts` · `messages.ts` · `state-hash.ts` ·
`correction.ts` · `clock.ts` · `plausibility.ts` · `net.test.ts`

Run: `bun packages/mobile/game/net/net.test.ts` → PASS.

Measured, not assumed:
- stick is circular, not square — cardinal 127.0, diagonal 127.3
- full tilt maps to ≤ 1.0 in Q16.16 (65532)
- correction sweep starves nothing over 60s — worst age 125 ticks, 64.0 entities/tick
- sweep still prefers nearby entities — furthest chosen 78 units
- RTT median ignores an outlier; drift closes over 240 ticks without snapping
- plausibility tolerates a hard legitimate run — peak 150 spawns/s, 1.2M xp/s

**Real bug the self-test caught:** `CorrectionSweep` round-robin over a window larger
than the per-tick budget let the same nearby entities win every pass. With 2,000 enemies
**75% were never corrected in 60 seconds** (worst age 3600 ticks = a full minute of
uncorrected drift on a guest). Fixed with `STARVATION_TICKS = 120` + `STARVED_KEY = -1`
priority override, so anything unswept for 2s outranks proximity. Worst age 3600 → 125.

### `game/replay/` — complete, self-tested
`format.ts` · `recorder.ts` · `player.ts` · `replay.test.ts`

Run: `bun packages/mobile/game/replay/replay.test.ts` → PASS (all sections).

- log format: 48-byte header, magic `NRRP`, `TAINT` bitfield (14 bits), RLE input stream
- **RLE compression 40.0× vs raw — 360 bytes per minute of solo play.** A 30-min run is
  ~11KB, so shipping a full tick log with a bug report is free.
- replay reproduces the recorded state hash exactly (`9af3c464`)
- harness overhead 18,000,000 ticks/s with a do-nothing sim → the harness is never the
  bottleneck in revalidation; the sim is
- **a 30-minute run revalidates in 1.63s** at 66,176 ticks/s against a 256-entity stub.
  This is the number that makes §5b's *mandatory* ladder revalidation affordable.
- tamper rejection: bad magic, version mismatch, truncation, inflated tick count,
  altered input, forged final hash, empty file — all rejected, none throw
- **clearing the taint flag does not defeat revalidation** — acceptance is decided by
  resimulation, exactly as §5b requires. Taint is a courtesy signal; the hash is the gate.
- divergence detection names the first bad tick (60) within one sample window
- stream cap holds: 200k changing ticks → 0.8MB, head-dropping, tick count still true

**Real bug the replay test caught (severe, in `core/rng.ts`):** `nextInt` computed its
rejection limit as `(2**32 - 2**32 % bound) >>> 0`. When `bound` divides 2^32 the limit
is exactly 2^32 and `>>> 0` wrapped it to **0**, so `while (r >= limit)` rejected every
draw and **spun forever**. Powers of two are the most common bounds in the game — coin
flips, 4-way picks, 64-slot tables — so `nextInt(2)`, `nextInt(4)`, `nextInt(64)` were
all infinite loops. It hung this test suite on its first execution. Had it reached a
device it would have read as a hard freeze indistinguishable from the 844s bench death.
Fixed by keeping the limit a plain float; permanent regression section `rng bounds` now
covers termination, range, uniformity, the rejection path, and seed determinism.

Note: `net.test.ts` passed earlier only because it happened to use non-power-of-two
bounds. Two self-tests, two real bugs, both in code that had already typechecked and
linted clean. Keep writing the harness before trusting the layer.

## Dev gate + taint plumbing — 2026-08-11

`game/dev/` — `channel.ts` · `registry.ts` · `devgate.ts` · `lint.ts` · `dev.test.ts`
Run: `bun run test:game` (chains net → replay → dev). All three PASS.

- **Registry, 41 panels: 24 SELF / 17 SYSTEM / 8 read-only.** Plan §5b's two lists are now
  code, not prose. Each entry carries `tier`, `taint`, `readOnly`, optional kill-switch flag.
- **`defineDevPanel` normalises any unrecognised tier to SYSTEM** — a typo locks a tool down
  rather than shipping it. Verified with a deliberately mistyped `"Self"`.
- **`DevGate.open` is the only door.** Taint applies on *open*, not on use: open godmode and
  close it without touching anything and the run is still tainted. Pessimistic on purpose —
  a false taint costs one leaderboard entry, a missed taint costs the ladder its meaning.
- **Read-only panels taint nothing** (overlays, counters, atlas/audio inspectors, flight
  recorder, screenshot, replay inspector), so debugging a real run stays free.
- **Taint is on the run, not the save** — proven: next `ReplayRecorder` starts clean and
  ladder-eligible.
- No `clearTaint` exists on the client, asserted by test.
- Chaos Sandbox Day: taints from tick zero, closes the public ladder, unlocks the menu
  without the secret, and **still does not unlock SYSTEM**.
- Internal channel: every run carries `DEV_CHANNEL`, never counts for the public ladder.
- Guest can self-taint with `IMPLAUSIBLE_HOST` — the §5b addendum's co-op mitigation hook.

### CI content-lint (this is what actually holds §5b together)
`lint.ts` is run by `dev.test.ts`, so the build fails on any violation.
- Data rules: unique ids, explicit tier, SELF+mutating must declare taint, read-only must
  declare zero taint, `account.*`/`ladder.*`/`coop.*`/`ops.*` must be SYSTEM.
- **Reachability is proved by construction, not by reading code:** two channels × 8 flag
  combinations × 41 panels of real `DevGate` calls. Asserts no SYSTEM panel opens on public
  under *any* flag combination, and that `reachable()` never disagrees with `open()` — a
  greyed-out entry that would actually open is how a tier check gets bypassed by accident.
- Source rules over the real files on disk: nothing in `game/dev/` imports a server-write
  module (`SERVER_WRITE_MODULES` declared before those modules exist, so the rule is live
  the day the first one lands), nothing in `game/dev/` imports RN/React/expo, and no file
  outside the gate calls `findDevPanel`.
- The linter is proved to bite: three planted bad files must produce exactly three
  violations, one per rule.

Nothing here is a security boundary and the file comments say so. Hermes decompiles and any
client check is Frida-hookable. The gate makes the honest path correct and auditable and
keeps SYSTEM tools out of a stranger's binary; **the only real boundary is server-side
replay revalidation**, which `game/replay/` now measures at 1.63s per 30-minute run.

New root script: `bun run test:game`.

## Save layer — 2026-08-11

`game/save/` — `schema.ts` · `codec.ts` · `store.ts` · `save.test.ts`
Added to `bun run test:game`. PASS first run. **201 ok checks across the four suites.**

- **Binary, fixed-layout, 1092 bytes.** Cheap enough to write at run end, on every settings
  change, and on app background. Bitsets sized for full scope with room to spare: 512
  characters, 512 weapons, 256 stages, 256 arcanas, 2048 achievements, 512 mastery slots,
  8 ascension ladders — so launch content growing into full content needs no migration.
- **Double-buffered slots, not atomic rename.** There is no portable atomic rename across
  expo-file-system / AsyncStorage / localStorage, so two slots alternate, each with a
  generation counter and a checksum, and load takes the highest generation that validates.
  A torn write can therefore only destroy the *older* copy.
- **Every write is verified by reading it back and decoding it.** Backends lie — AsyncStorage
  can resolve a write that never landed, and the OS can kill us mid-flush. Tested with a
  backend that claims success and stores nothing: caught by the readback.
- Recovery ladder proven: **current → previous → fresh**, and `LoadResult.recovered` tells
  the caller so the player can be informed once instead of silently starting over.

### Hardening actually measured
- **Every single-bit flip in all 1088 non-checksum byte positions is caught.** That is the
  check that proves the checksum covers the whole payload and not just the first block.
- Torn write at byte 100 → previous save intact (gold 600, gen 2), **one run lost, not the
  profile**; the next save repairs the broken slot.
- In-place corruption of the newest slot → falls back. Both slots corrupt → fresh profile
  *and* `recovered` flagged.
- A throwing backend is caught, counted, and leaves the good save untouched.
- A newer `SAVE_VERSION` is refused rather than misread — a downgrade must never eat progress.
- `generation` stays readable from a slot that failed its checksum, so slot selection still
  works when a slot is broken.

### Deliberate non-goals
- The checksum is a hash, not a signature. **Modding your own local save is allowed** (§5b);
  this catches corruption, not cheating. Writing code that looks like security and is not
  would be worse than nothing.
- `everTainted` on the profile is informational only and never gates anything — taint is on
  the run. Chaos Sandbox participation is explicitly *not* recorded: an official event is not
  a black mark.
- Every opt-in (telemetry, crash reports, personalised ads, custom name) defaults to **off**,
  asserted by test.
- `eraseEverything()` exists for the store listings' data-deletion requirement.

## layers ×16 result + why every trial so far was ambiguous — 2026-08-11 (session 4)

`layers ×16` on the iPhone 17 Pro Max: **DIED at 2306s (38m26s)**, 160,000 quads/frame,
80 `uniform2f` writes/frame, p50 8.9ms (≈112fps), upload 0KB/frame, sim on time
(138,360 ticks vs 138,360 expected).

**Uniform marshalling is cleared as the fast killer.** 2306s is *longer* than the three trials
that were called survivors (present 32m42s, draw 35m03s, upload 35m09s) — and those three were
not survivors, they were **stopped by hand while still alive**. So the real shape of the data is:

- every trial that was left alone eventually died
- every trial that was watched was still running when the human ended it

That is not a GL signature. That is the difference between a phone in someone's hand and a phone
on a table with the screen locked. iOS discards suspended apps on its own schedule, and a jetsam
kill and a routine reclaim look **byte-identical** in the flight log: `cleanExit === false`.

Which means **the 844s Gate A death may never have been a leak at all**, and four trials'
worth of conclusions rest on an instrument that cannot tell the two apart.

### Fix: the flight log now records why it died
`game/bench/lifecycle.ts` — `LifecycleProbe` + `explainDeath`, fed by RN `AppState` in both
`app/dev/bench.tsx` and `app/dev/leak.tsx`, sampled into every `FlightSample` as `life`.

Two observables settle it, both readable from JS:
1. **App state at the last sample.** `background` ⇒ trial thrown out, no verdict.
2. **iOS low-memory warnings** (`AppState` `memoryWarning`). iOS warns before it starts killing.

Verdict lines the log now prints itself:
- `TRIAL INCONCLUSIVE — died while not foregrounded` → rerun it, screen awake
- `died FOREGROUND with zero memory warnings — this is not a jetsam OOM` → look at the GPU
  watchdog or a native fault, **not** at memory
- `died FOREGROUND after memory warnings — jetsam OOM confirmed` → the leak is real, and the
  first-warning timestamp bounds when it started

`life` is optional on `FlightSample`, so the four existing trial logs still decode — they just
report `lifecycle not recorded (older trial)`, which is the honest answer for all of them.

`game/bench/lifecycle.test.ts` — 21 checks, PASS, wired into `bun run test:game` (now 5 suites).
Counters checked against hand-computed timelines: in-progress background stretches counted but
never double-counted on resume, repeated state emissions ignored, suspended deaths stay
inconclusive even when warnings did arrive.

### What this changes about the next phone trial
Only one trial matters now, and it is cheap: **any mode, screen kept awake and foregrounded.**
If it dies with warnings, the leak hunt resumes with a real timestamp. If it dies with none, the
whole present/draw/upload/layers matrix has been measuring iOS app suspension for four sessions.

### Stopping a trial on purpose is now the intended workflow
Follow-up to the lifecycle probe. Stopping at 30 minutes was the right instinct but it used to
destroy the trial: `summariseFlight` only printed a verdict when `cleanExit === false`, so a run
ended by hand wrote a log that said nothing. That is why all four watched trials are blanks.

- `explainStop(last, elapsedSeconds)` added; `summariseFlight` now prints a verdict on **both**
  endings. `MEM_TRIAL_MIN_SECONDS = 900`, `MAX_BACKGROUND_MS = 30_000`.
- Precedence, tested: **a memory warning outranks both the duration rule and the foreground rule.**
  A 3-minute trial that warned is a finding, not a short trial. A 3-second `inactive` blip from a
  notification banner does not disqualify anything; 30s+ actually suspended does.
- Live readout on both `/dev/bench` and `/dev/leak`: app state, foreground excursions, warning
  count, and the standing verdict — `keep it foregrounded… ` → `MEMORY CLEARED — safe to stop now`
  → `MEMORY PRESSURE IS REAL`. Verified rendering in Chrome/SwiftShader.
- **`expo-keep-awake@15.0.8`** installed (Metro stopped first, one `npx expo install`, restarted;
  `curl localhost:4300` → 200). `useKeepAwake()` in both dev screens: fixes the confound at the
  source instead of detecting it afterwards.
- `lifecycle.test.ts` now 28 checks incl. the precedence rules and both flight-log endings. PASS.
  The old assertion "a clean exit is not given a death verdict" was inverted by design and rewritten.

**Trial protocol now: 15 foreground minutes, then read the line and stop. No kill required.**

## Phase 1 — started 2026-08-11 (session 5)

### `game/sim/stats.ts` + `game/sim/modifiers.ts` DONE
- `STAT_NAMES` misalignment fixed by **deriving it from `STAT`** instead of retyping the parallel
  list. A hand-written parallel list is the exact thing that drifted in the first place.
- Added a load-time guard: `STAT_COUNT` must equal `Object.keys(STAT).length`, or throw. Appending a
  stat without widening the count would have left it outside every table and silently read 0.
- `ModifierStack.resolve` has **three tiers**: `add` (flat sums) → `mul` (percent, pooled per stat so
  truncation happens exactly once) → `scale` (compounding, sorted canonically) → `clampAll()`.
- Hurry = `scale(timeScale, 2000)`. Hyper = `scale(enemySpeed/enemyHealth/spawnRate, 1200)` +
  `mul(goldGain, 500)`. Disjoint stat sets, zero sim branches. **Phase 1 gate item met.**

### The order-independence test almost lied
First version used factors `1100, 1234, 1777` on base 1000. It passed — and it also passed with
`sortScales()` deleted. `/tmp/ordercheck.ts` over 200,000 random (base, factors) triples:
**96.3% are order-dependent under sequential integer truncation, 3.7% are not.** I had picked one of
the 3.7%.
Replaced with base 97 / factors `1382, 2162, 2461`, which yields **four** different answers across
the six orderings. Verified by commenting out `sortScales()`: 2 checks fail. The test now bites.
Lesson worth keeping: for any "order doesn't matter" claim, prove the ordering was ambiguous in the
first place — the test file now asserts that explicitly as its own check.

### Numbers
- `sim.test.ts` 71 checks PASS. 20,000 resolves of a 40-modifier stack: **62ms, 3.1us each,
  heapGrowth=0KB**.
- `bun run test:game` now **6 suites, all PASS**. typecheck 3/3, lint 0/0.

### Next
`game/sim/entities.ts` — pooled entity arrays, then spawner + wave table + steering with separation.

## Phase 1 started — 2026-08-11 (session 5)

`44a6802` — first two Phase 1 files landed, `bun run test:game` now 6 suites.

- `game/sim/stats.ts` — permille `Int32Array`, 30 append-only `STAT` ids, plan caps/floors.
  `STAT_NAMES` is *derived* from `STAT` rather than hand-written; the earlier misalignment
  (a stale `spawnRate2_unused` slot) can no longer recur.
- `game/sim/modifiers.ts` — `RunModifier` records + `ModifierStack.resolve()`.
  Two tiers: additive sum, then multiplicative permille. Multiplicative factors are **sorted
  ascending before folding** because integer truncation is not commutative — the test proves the
  naive left-to-right fold really does diverge, so the sort is load-bearing, not decorative.
  Without it, card-pick order would change final stats and every co-op state hash / replay
  revalidation becomes a coin flip.
- Modes are data. Hurry = one delta (`timeScale x2`). Hyper = four deltas. They stack with no sim
  branch. Ascension tier 7 is literally the same record seven times (`enemyHealth 3.58x`).
- Dev godmode is a modifier too, so it lands in the replay header like anything else and taints the
  run. Taint is *derived from the stack each resolve*, never latched — remove the toggle, taint goes.
  Note: `armor +1_000_000` clamps to the cap of 50, so godmode's invulnerability comes from
  `enemyDamage x0`, not from armor. Intentional; the cap is not special-cased for dev.
- Resolve allocates nothing: 20,000 resolves grew the heap 0.0KB.

**Next:** entity arrays + spawner + wave table + walk-at-player steering with separation.

## REVVL Gate A first measurement — 2026-08-11 (session 6)

Crash fixed (keep-awake web path). Phone ran the bench correctly. Result:

    5176 quads · 5 draws · 5 layers · buffer 720x1260 @3x
    116.2ms p50 · 321.0ms p95 · 400.4ms p99 · 411.7ms worst
    8.6 fps · 80.2% over 16.7ms · 408 dropped ticks
    0 mem warnings · heap 19.6MB flat · sim 9.3s / real 16s

8.6fps against a 60fps gate. 7x short. NOT a warm number (16s in), but 116ms p50 is not
something 15 minutes of warming improves.

UNATTRIBUTABLE as measured, hence the new diagnostics:
- gpu name: Android Chrome may be on SwiftShader. Unknown until the user reports the line.
- overdraw: the gate scene is 13.5x screen. 5176 blended quads inside a 240x420 world view at
  scale 3. On a Mali-G57 MC2 that is ~12M blended pixels/frame. Plausible sole cause.
- HALF SIZE: same count, quarter the pixels. 4x faster => fill bound. Flat => per-quad bound.

CRITICAL CAVEAT: this is Chrome, not native. The iPhone 16.7ms number was native Expo Go.
Browser WebGL on Android carries compositor overhead the shipped app never pays. Android
manifest confirmed 200, so Expo Go on the REVVL is measurable and is the number that decides
Gate A. Chrome is a lower bound, not the verdict.

Next: user reports gpu line + HALF SIZE delta + native Expo Go run on the REVVL.

## GATE A: PASSED on the REVVL — 2026-08-11 (session 6)

Native Expo Go, Android, REVVL V+ 5G, buffer 720x1640 @3x, Mali-G57 MC2 (real GPU, NOT
SwiftShader — the software-fallback suspicion is dead):

    5176 quads · 5 draws · 5 layers · overdraw 29.0x screen
    17.9ms p50 · 21.9ms p95 · 32.0ms p99 · 33.7ms worst
    56 fps · 71.7% over 16.7ms · 131 dropped ticks
    sim 947.6s / real 951s · 56854 ticks · 52404 frames
    warm 15m51s ✓ · 0 mem warnings · MEMORY CLEARED

VERDICT: WebGL via expo-gl STAYS. No Skia pivot. `game/render/` is settled.

Reasoning: 17.9ms p50 against a 16.67ms budget is 7% over, on a scene carrying 29x overdraw
that no real run will ever produce. Cutting overdraw to a realistic 3-5x has more than 7% in
it. The sim also held: 947.6s of sim against 951s of wall clock is 0.4% behind over 16 minutes,
with 131 dropped ticks out of 56,854 (0.23%).

MEMORY QUESTION CLOSED TOO: 15m51s foregrounded, zero memory warnings, no death. The iPhone
844s death was iOS discarding a suspended app, not a leak. Four trials were misread.

BROWSER IS NOT THE PLATFORM — do not gate on it again:
    Chrome  8.6 fps  (116ms p50)
    Expo Go 56.0 fps (17.9ms p50)
6.5x. Chrome's compositor is the difference. Web stays a convenience harness only.

HALF SIZE bisection (browser, samples too early to weight heavily): overdraw 50.8x -> 12.7x
(clean 4x) moved p50 642ms -> 470ms, only 1.37x. So the browser wall was per-quad/compositor,
not fill rate. Re-run natively before spending anything on overdraw work.

FPS METRIC CORRECTED: user observed ~67fps on a 60Hz panel and was right to distrust it. The
old readout was 1000/p50 — a median of frame *intervals*, which can dip under 16.67ms on a
jittery stream and read above refresh. Now shows frames/wall-second alongside it (52404/951 =
55.1, consistent with the 56 shown). Median-interval kept for headroom, labelled.

PHASE 0 IS CLOSED.

> **Corrected 2026-08-13 by audit.** This line originally read "Remaining Phase 0 debt: none
> blocking", which was wrong. Three Phase 0 deliverables were never built: remote-config
> scaffolding, append-only event-log scaffolding, and the HUD + one-menu mock approval loop.
> None of them block anything today, which is presumably what was meant, but "no debt" and "no
> blocking debt" are different sentences and the second one got written as the first. The real
> list now lives in one place: plan.md, section *Where we actually are*.

## Player subsystem landed — 2026-08-11 (session 7)

`game/sim/player.ts` + `player.test.ts` complete, 8th suite in the `test:game` chain, all green.

Movement, 8-way facing, health, i-frames, downs, revives, regen and enemy contact damage all live.
Solo is the one-player case of the same loops — there is no co-op branch anywhere in the file, which
is what the Phase 1 gate asks for.

Three real bugs the self-test caught:

1. **Armor was 1000x too weak.** Armor is stored as a flat count (3 means 3 armor), but the damage
   path divided it by STAT_SCALE, so maximum armor read as 0.05 and a 10-damage hit landed for 9.95.
   Fixed, and `stats.ts` now documents which stats are counts and which are permille multipliers so
   the next stat added cannot repeat it.
2. **Regen lost a hit point per second.** 5/60 added sixty times as a float is 4.99999, which floors
   to 4. Now accumulated as permille-ticks and paid out at an exact 60,000 threshold — 5/s means 5/s.
3. **`hashablePositions` allocated a subarray every call**, inside the tick, twice a second. Views
   are now pre-cut once in `reset`.

Also: `Math.hypot` in `setMove` replaced with `Math.sqrt` (not bit-guaranteed across engines, and it
moves the player, which lands in the state hash), and `EnemyStore` gained a public `queryNear` +
`neighbourScratch` so the player can ask the grid for nearby bodies without allocating.

Perf: 4 players + 800 enemies, 3600 ticks — 24us per tick, 0.0KB heap growth.

## Floor, weapons and projectiles — 2026-08-11 (session 7)

### The ground under the player
The stage floor is now drawn as tiles that repeat, with scenery (bones, stones, cracks) scattered
through them by a rule instead of by hand. Two things matter about it:
 - Walking a long way costs nothing extra. Half a million pixels from the spawn point draws exactly
   the same number of tiles as standing still — 264. The floor can never be the reason a run slows
   down late.
 - Real bug found: the tile the player spawns on was always the same variant in every single run.
   The scatter rule returned "zero" for that one spot, which the rule then treated as "always the
   first tile". Fixed, so spawn now looks as varied as everywhere else.

### Six weapons, one machine
Whips, homing knives, a fan of bolts, a thrown axe, an orbiting tome and a damage aura are now all
running off the same shared piece of code. Adding weapon seven costs a row of numbers, not new code.
Levelling a weapon edits those numbers, and player upgrades (might, area, cooldown, extra
projectiles, pierce, duration, speed) edit them again on the way out — so a might upgrade strengthens
weapons you already own, which is the whole feeling of the genre.

### Real bug found, and it was a bad one
Re-ticking shapes started their damage clock at the full interval. The whip lives for exactly one
interval, so it expired one tick before its turn ever came — it swung, looked perfect, and dealt
literally zero damage. Nothing crashed and nothing logged; the weapon was purely cosmetic. Fixed so
these shapes damage on the first tick they exist and then on the interval. Also removed a
double-count that was quietly giving three weapons far more pierce than their numbers said.

### What the new self-test proves (50 checks, all passing)
All six weapon types actually damage enemies; a piercing shot cannot hit the same enemy twice on one
pass; pierce is a budget that runs out; more enemies than the memory holds degrades to re-hitting
instead of crashing; an aura damages immediately then exactly on its interval and does no crowd
lookups in between (garlic on screen for a whole run is the most expensive mistake available here);
refreshing an aura adopts new numbers without delaying damage already in flight; boomerangs turn
around at half-life and get a second hit; axes fall under gravity; two orbiters sit opposite each
other and follow a moving player; the whip alternates sides and hits both at once once levelled;
every damage number is a whole number of at least one; the same seed produces identical combat and a
different seed does not; guaranteed crits crit and no-crit weapons never do; heavy enemies ignore
knockback; a downed player fires nothing but comes straight back into the fight on rescue; running
out of room for shots or damage numbers degrades quietly instead of throwing.

Performance, 800 enemies with all six weapons maxed: 45us per tick and zero allocation over 1800
ticks. The frame budget is 16,667us.

Suite status: 493 checks across 10 files, all green. typecheck and lint clean.

## Weapons, projectiles and the floor — 2026-08-12 (session 7)

### The floor now scrolls forever and costs a fixed amount
The ground draws itself from a repeating set of tiles around the camera, plus
scattered scenery (rocks, bones, tufts) chosen by a hash of the tile position.
Nothing is stored per tile, so walking half a million pixels from spawn costs
exactly the same frame as standing still — 264 tiles either way, no allocation.

**Bug found and fixed:** the tile a player spawns on was always the same
variant in every single run. The hash returned zero for position (0,0), and
zero fed back into itself, so the origin was a fixpoint. Seeding the hash with
a constant fixed it. Nobody would have reported this as a bug; the floor just
would have felt subtly samey at the start of every run.

### Six weapons, covering every archetype in the game
A weapon is now pure data: pick a movement archetype, give it numbers, and give
it seven rows describing what each level-up does (including the sentence the
player reads on the card). Adding weapon number forty is adding a row, not
writing code. The six built are the whole shape of the weapon roster:

- Reaper's Lash — melee sweep, alternates flanks
- Bone Knives — homing
- Gravebolt — directional volley
- Tomb Axe — arcing throw with gravity
- Shrouded Tome — orbiting
- Rot Aura — persistent aura around the player

Level-ups fold together in any order and reach the same weapon, which is what
lets a replay or a co-op guest rebuild a run exactly. Stats apply when a shot
is fired, not when the weapon was picked up, so a might upgrade strengthens
weapons you already own.

**Bug found and fixed (this one was serious):** shapes that damage repeatedly
(the whip's sweep, the orbiting tome) were only checking for enemies on the
exact ticks their damage clock landed on. A tome orbiting straight through an
enemy scored zero hits. The whip only hurt things standing at the very start of
its arc. Fixed so only the aura — which never moves relative to its owner — is
allowed to skip the check. The whip went from 24 hits to 54 and the tome from 6
to 30 in the same test crowd.

### Measured
Six maxed weapons against 800 enemies: 34us per tick (a 60fps frame is
16,667us), zero allocation over a full simulated minute, 54,321 hits landed.
Crits reproduce exactly from a seed. Damage numbers are whole integers so two
phones always agree.

## Session 7 — the reward loop

### The plan now lives in the repo
`plan.md` was sitting outside the project folder, so it was never on GitHub. Copied in, and the
README front page now links to plan / task / design so the three documents are the first thing you
see on the repo page.

### Gems, the magnet, and the drop table (`game/sim/pickups.ts`)
Kill something, it drops a gem; walk near it, it flies to you. Three decisions worth remembering:

1. **A full floor never steals experience.** The gem pool has a hard ceiling of 1024. When it is full
   a new drop MERGES into the nearest existing gem instead of being refused, and the host gem reads
   as a higher tier so a rich floor looks rich. Proved by dropping 5,000 gems into a 128-slot pool:
   all 15,000 experience was still on the ground, and all 15,000 came back out on collection. This is
   the difference between late-run levelling feeling generous and feeling broken.
2. **The magnet is a range, not a speed.** A gem is inert until a player comes inside the radius, then
   it locks on and keeps chasing even if the player runs away. That lock-on is where the tail of gems
   streaming behind you comes from. Base radius is deliberately small (26px) so magnet upgrades have
   a reason to exist and so you still have to walk back through the horde for what you earned.
3. **Collection is an event, not a side effect.** This file never touches experience, gold or health;
   it writes what was collected into flat buffers and the run loop applies them. Keeps the co-op host
   authoritative over collection order and keeps replays reproducible.

Gems never expire. Consumables (food) expire after a minute so a 90-minute Endless floor does not
slowly fill with un-taken chickens.

### The level curve (`game/sim/progression.ts`)
5 experience to reach level 2, then +10 per level, flattening at level 20 (195 forever after).
No level cap.

Two things the scale forced:
- **The flat tail is a division, not a loop.** One gem can be worth hundreds of levels, and a Limit
  Break gem can be worth millions. Handed a gem worth a billion it granted 5,128,205 levels in 0ms.
  A loop would have frozen the phone.
- **Level-ups queue, they do not interrupt.** Showing 230 card screens back to back is not a game.
  The queue has a ceiling of 4096 owed screens (levels and stats still all count past that), and the
  batch size grows with the backlog — 1 card at a time early, up to 16 at once with a deep backlog.

62 checks in `game/sim/loot.test.ts`, all passing. A minute of a full 1024-gem floor with four
players and a huge magnet: 0.0KB allocated over 3600 ticks, 97us per tick, 2,093 collections.

### Two real bugs found
- **Pickups could re-lock onto a player who had just gone down.** The release-on-down path ran and was
  then immediately undone by the re-lock in the same tick. Now both paths agree on the same `upright`
  flag. Symptom would have been gems visibly ignoring a downed player's status in co-op.
- **Replay revalidation was timing itself with a whole-millisecond clock.** Work that finishes in
  microseconds measured as 0ms, which read as "infinitely slow" and made the affordability number
  meaningless. This is the same trap that flattened the on-device frame-time percentiles in session 3.
  Fixed at the source; it now reports 5.4M ticks/s bare and a 30-minute run revalidating in 1.73s.

### Where Phase 1 stands
Done: player movement, camera, floor, enemies + waves, six weapon archetypes, projectiles, gems +
magnet + drop table, the level curve and the level-up queue.
Next: the card draw itself (reroll / skip / banish, and the batched screen), the six passives, the
death and results screen, dev menu v1 panels, then wiring it all into one playable screen with a
thumbstick.

## Session 8 — the choice

Two systems: the six passive items, and the level-up card screen itself.

### The passives (`game/sim/passives.ts`)
Six items, five levels each: Grim Sigil (damage), Bone Charm (armour), Wanderer's Boots (move speed),
Hollow Lantern (pickup range), Ash Hourglass (cooldown), Gravemoss Root (health + regeneration). Six
covers every shape a passive can be, so passive number twenty is a new row of numbers and nothing else.

The one design decision worth writing down: **each level of a passive is its own little record, and
owning it at level 3 means records 1, 2 and 3 are all folded in.** Nothing ever tries to subtract a
passive. That is what makes the order you pick things in unable to change your final numbers — proven
in the test: two runs taking the same three levels in different orders come out byte-identical. Games
get this wrong all the time, and it shows up as "I took Might last and it was worth less".

Passives fold into stats through the exact same machinery as game modes like Hurry, rather than a
second parallel stat path. One way for a number to change means one place for it to be wrong.

### The card screen (`game/sim/cards.ts`)
What it offers, in order of preference: level up something you carry, hand you something new if you
have a slot, and — only when there is genuinely nothing left to improve — coins or food. Four cards
per screen. Reroll, skip and banish are charges you carry for the whole run, not per screen (per
screen would make a deep backlog an infinite reroll machine). A banish lasts the rest of the run;
banishing something that expires at the end of the screen would be worthless.

Three things this file protects against:
1. **A screen with nothing on it.** A maxed-out player at level 300 with a fistful of banishes can run
   the pool dry. If that dealt zero cards, the game would sit there forever waiting for a choice that
   can never come. Filler is the guarantee that a pick always exists. Tested directly.
2. **Cards that lie.** The words on a card are pulled from the same row of data as the effect, so they
   cannot drift apart. The test walks 400 level-ups and checks every single card's text against what
   it actually applied.
3. **Offers that are not reproducible.** Cards come out of the seeded draw stream and nothing else.
   Two runs on the same seed making the same picks see the same cards all the way through — that is
   what lets a replay be re-run and verified, which is the whole anti-cheat story for leaderboards.

Batched screens: a backlog of 30 owed levels opens one screen that owes 8 picks, redealing between
each. Levels come off the queue exactly, however deep it is.

56 checks in `game/sim/cards.test.ts`, all passing. 20,000 deals: 0.0KB allocated, about 3
nanoseconds each. No bugs found this pass — the two systems it leans on were already tested.

`bun run test:game` is now 12 files, all green. Typecheck and lint clean.

### Where Phase 1 stands
Done: movement, camera, floor, enemies + waves, six weapons, projectiles, gems + magnet + drops, the
level curve and queue, six passives, the card screen.
Left: the death and results screen, dev menu v1 panels, then wiring the whole thing into one playable
screen with an on-screen thumbstick — and then the Phase 1 gate.

### The results screen data (`game/sim/results.ts`)
Written the same session. A run summary is produced once, from the stores, and the screen, the save,
achievements and any leaderboard submission all read that one record — so the screen can never say
12:04 while the save records 11:58.

Two calls worth flagging because they are judgement, not code:
- **Being taken by the White Hand counts as completing a run, not as dying.** Someone who reached 30
  minutes and got erased by an unkillable Reaper did not fail.
- **Quitting still banks the gold and the time played.** They played it. Confiscating that is how you
  teach people not to open the game.

The damage breakdown ("which of my weapons was actually doing the work") is ranked here rather than in
the screen, so every place that shows it ranks it identically. Shares are truncated, so three equal
weapons read 33.3% each and total 99.9% — honest, rather than rounding one up to make it look tidy.

31 checks in `game/sim/results.test.ts`, all passing. `bun run test:game` is now 13 files, all green.

## Session 8 — the game is now one thing instead of nine

Up to now the game existed as nine separate machines: one that moves the player, one that walks the
crowd, one that fires weapons, one that drops gems, one that counts levels, one that deals the
upgrade cards, one that writes the end-of-run report. Each one worked on its own. None of them had
ever been switched on at the same time.

They are now. There is a single piece that owns all of them and runs them in one fixed order, sixty
times a second. That order *is* the game — change it and you change how the game plays, and you also
break online co-op and every saved replay, because two phones running the same steps in a different
order end up in two different worlds. So the order is written out plainly, one numbered step at a
time, with the reason each step sits where it does.

### What now actually works, start to finish

A five-minute run plays itself out with nothing missing: enemies arrive on schedule, weapons fire,
enemies die, they leave gems, the gems are collected, the levels come, the upgrade screen opens, the
upgrade is taken, and the run ends with a full report. In the automated test run it scored 2,028
kills, reached level 18, showed 17 upgrade screens and finished holding 5 weapons.

Also settled:

- **The upgrade screen really pauses everything.** While four cards are on screen the world is frozen
  solid — the crowd does not creep toward you while you read. Proven by freezing, hammering the game
  a further two seconds, and confirming the world is bit-for-bit unchanged.
- **Same seed, same game.** Two runs given the same seed and the same stick movements matched
  perfectly at every checkpoint. A different seed produced a different world. This is the thing every
  leaderboard and every anti-cheat check rests on.
- **Restarting on the same seed works too**, which is what the dev menu's "run that again" button
  needs.
- **Hurry and Hyper still stack, with no special-case code.** Hurry ran the clock at exactly double.
  Hyper on top of it pushed spawns from 149 to 194 and sped the crowd up 1.5x. Neither one is allowed
  to touch the loop; they are still just numbers.
- **Speed and memory are fine.** With 800 enemies on the field a full tick took 0.37 milliseconds
  against a 16.6 millisecond budget, and 600 ticks in a row grew memory by zero. That is roughly 45x
  headroom on the laptop-class machine; the phone number comes from the on-device pass.
- **All four endings work**: dying, surviving to a time limit, quitting, and being taken by the White
  Hand at thirty minutes (which correctly counts as *finishing* the run, not failing it). Ending a
  run twice cannot produce two different records of it.

### One real bug found, and it was a big one

**Godmode was not god.** Godmode works by setting incoming damage to zero. But the damage rule said
"a hit always takes off at least one health, no matter how much armor you have" — a sensible rule
that stops armor from making you accidentally immortal. Applied to a hit of *zero*, it turned it into
a hit of one. So godmode leaked a point of health per touch, and the very first five-minute test run
died at four minutes with godmode switched on.

Fixed: a hit carrying no damage is no longer a hit at all. The minimum-of-one rule now only applies
to attacks that actually had damage behind them. Every dev-menu toggle that nullifies damage depends
on this, and it would have been maddening to debug later while assuming godmode was a given.

### Where Phase 1 stands

Everything on the engine side is done. What is left before the Phase 1 gate is the part you can
touch: one playable screen with a thumbstick, drawing the world that already exists. After that the
gate is three mechanical checks on your phone plus the "is it fun" check, which needs real art —
so it waits for Phase 4 as you asked.

## Session 8 — rewards, seeds, and the announcement channel

### What went into the plan (no code, just decisions locked before they get expensive)

**Leaderboards now pay out.** A board that only tells you your rank is a receipt, not a reward. Every
ladder now grants a cosmetic-only currency (Reaper Marks) plus titles, emblems and banners, paid by
percentile bracket so it works the same at 300 players or 300,000. The hard rule: **a leaderboard never
grants power** — no gold, no eggs, no stats, ever, because the moment placement makes you stronger,
being good at the game becomes a requirement for being strong at it. Marks are server-granted after
replay revalidation and computed at board close, so there is nothing for a cheater to forge. Ships
Phase 6; the shop that spends Marks opens Phase 8.

**Speedrun toolkit, as a settings toggle.** The engine was already a speedrunning engine by accident —
it counts simulation ticks instead of wall-clock seconds, so the timer reads identically on a $100
phone and a flagship and literally cannot drift. Toggle turns on a tick-accurate timer, auto-splits,
a personal-best ghost, seed entry, same-seed instant restart, and verify codes anyone can replay. All
of it only *reads* the simulation, so it stays ladder-legal. Anything that *writes* (slow-mo,
frame advance, save states, input playback) stays in the dev menu and taints the run, which was
already true. Phase 6.

**Seed width: staying at 32 bits.** 4.29 billion seeds is 11.7 million years of Daily Runs. Widening
to 18 quintillion would cost about half a day now and 2–3 days plus real risk after launch, since the
seed sits at a fixed spot in every save file and replay. Not worth it; seed collisions are harmless
because two players on one seed diverge the instant they walk different directions.

**Five cheap-now / expensive-later decisions settled:** run snapshots for mid-run resume when the OS
kills the app (Phase 2, and it also gives host migration and dev save states for free); every
player-facing string moves behind an ID table before the content flood (Phase 3); the simulation emits
sound/effect events rather than playing them (done, below); save data gets an account id and revision
counter now so cloud save in Phase 8 never has to guess which device is newer; plus battery-saver mode,
a sub-100MB install budget, no tutorial screens, notification-prompt timing, and server-side daily
seeds.

### What got built: `game/sim/cues.ts` + wiring in `run.ts`

The game now announces what it did — a hit landed, an enemy died, a level went up, a bell tolled —
into a small fixed list, once per tick. It never plays a sound itself and never reads the list back.

Why it matters in plain terms: when audio arrives in Phase 8 it becomes "connect these 19 event names
to these sounds" instead of hunting through combat code, replays will *sound* right because the events
are reproduced rather than guessed, and a sound that stutters or fails to load can never change what
happens in the game. Accessibility toggles (no flashing, fewer particles, no damage numbers) become a
filter over this list instead of conditionals scattered through the engine.

Overflow is deliberate: the list holds 192 events and drops the rest. Nobody can hear 300 simultaneous
death sounds, and the alternative — growing the list mid-tick — is the exact thing that stalled the
bench run fifteen minutes in.

**One real bug found by its own test.** While a level-up card screen was open the event list was left
standing, so a reader would see the same hits and deaths again on every frozen frame — a screen held
for one second reported the last tick's news sixty times. The test caught it as "10 level-up events
but the player is level 6". The list is now cleared before the paused check, not after it.

**Also fixed, quietly:** revives were never being counted, so the results screen would have reported
zero revives forever in co-op. The new down/revive detection counts them.

### State
- `bun run typecheck` clean, `bun run lint` clean.
- `bun run test:game`: **14 files, 718 checks, 14× PASS.**
- Next: the first playable screen — `app/dev/play.tsx`, GL view + camera + ground + thumbstick.

## Session 9 — the game became playable

The first screen where you can actually move a character around and fight things. Everything built
so far — the crowd, the weapons, the gems, the levelling, the card screen, the results — has only
ever run inside automated tests. This is the first time all of it runs at once with a thumb on it.

What is on that screen:
 - A scrolling floor, a character you drive with an on-screen thumbstick in the bottom-left corner,
   and a crowd that walks toward you and hurts you when it reaches you.
 - Your starting weapon fires on its own, exactly as it will in the finished game.
 - Enemies drop gems, gems get sucked in when you walk near them, and filling the bar opens the
   level-up card screen. Picking a card resumes the run; a big backlog of levels asks for several
   picks in a row without ever interrupting you mid-fight.
 - When you die, a line appears telling you how long you lasted, what level you reached and how many
   things you killed, and offers to run it again.
 - Buttons along the bottom pick which seed to play (the same seed always produces the same run) and
   turn the two test modes on: Hurry (everything happens sooner) and Hyper (more of everything).
   Those get chosen before a restart, never mid-run.
 - A small line of numbers up top: clock, level, health, how many enemies and gems are alive, frame
   rate, and the live thumbstick reading. That last one exists so "is my thumb even reaching the
   game" is a question with a visible answer instead of a guess.

None of this is the real look. It is coloured blobs on a grid — a skull for you, blobs for the
crowd, small cyan diamonds for gems. Real art is Phase 4.

Verified: the whole project still typechecks and lints clean, all 14 automated test files pass, and
the screen was driven for 35 seconds in a browser with no errors — character moved, enemies spawned
and died, gems were collected, the thumbstick read 0.79,-0.26 while being pushed up and right.

One tuning note for the fun pass, not a bug: over 40 seconds the character collects roughly half the
gems that drop and leaves the rest lying around. Gems never expire, so they get swept up later when
you walk back over them, which is how the genre works — but the early levelling pace feels slow and
the pickup range is the first dial to try.

## Phase 1 closed, Phase 2 opened — save and resume a run in progress

Plain English: what got built, and what it means when you play.

**The problem it solves.** A phone rings. Android decides it needs the memory your game was using.
You force-quit on the subway because your stop came. Before this week, every one of those events
threw away the run you were in the middle of — and "the game deleted my best run" is the kind of
thing a player tells other people about. Now the game can write the entire living run down and pick
it back up on exactly the tick it left off: same enemies in the same places with the same health,
same gems on the floor, same clock, same everything.

**And — this is the part that took the care — the resumed run still counts.** The list of everything
your thumb did gets saved alongside the world, so when the run finishes, the game can prove the run
happened by playing it back from the start and arriving at the same ending. A run you were
interrupted in the middle of is still eligible for the leaderboard. Without that, "resume your run"
would quietly have meant "resume your run, but it no longer counts", which would be worse than not
offering it.

**It pays for itself three more times.** In co-op, when the person hosting drops out, this is how the
running world gets handed to somebody else instead of everybody losing the run. In testing, it is how
we save a spot and retry a fight fifty times. And a crash report can carry the exact world that
crashed, instead of a guess.

**Size and cost.** A saved run is about half a megabyte of raw numbers, which is too much to be
writing every thirty seconds on a cheap phone, so it gets squeezed down first — around 85KB in
practice, roughly six times smaller, using a shrinking trick simple enough that unpacking it costs
nothing measurable.

**How it avoids rotting.** Rather than a hand-written list of everything worth saving — which is
guaranteed to go stale the first time somebody adds something and forgets to add it to the list — the
game inspects itself and saves everything it finds. It also writes down a fingerprint of the shape it
found. If a future version of the game has a different shape, an old saved run is refused outright
rather than half-loaded into a world that would then play wrong. Refusal is always total, and the
fallback is always the safe one: start fresh.

### Two real bugs this work found

1. **Every solo run was being logged as a four-player run.** The proof-of-play log was writing down
   the player count from a fixed four-slot list instead of from how many people were actually
   playing. Consequence if it had shipped: no single-player run could ever have been verified, so no
   solo leaderboard could ever have worked. Found because the new test insisted that an interrupted
   run still verify, which is the first thing that ever actually read that number back. Fixed.
2. **A saved run and a resumed run disagreed by a few bytes of bookkeeping** in the proof-of-play
   log. Harmless in itself, but it broke the strongest guarantee available here — that saving a
   resumed run produces byte-for-byte the same file — and that guarantee is what makes the whole
   thing testable. Fixed by closing the log's current entry at save time as well as at load time.

### Known hole, not urgent

A run that ends because it hit a time limit cannot currently be verified from its log alone, because
the time limit is not written into the log. Every ending that matters right now — dying, being taken
by the White Hand — is fine. The clean fix is for timed modes to carry their limit as mode data like
every other rule does, which is Phase 4 content work. Noted so it does not get discovered at launch.

### Verified

Typecheck clean, lint clean, all 15 automated test files pass, full build succeeds. The central check
is not "it loaded" — it is that a saved run and the run it was saved from then play 600 more ticks in
perfect lockstep, agreeing on every single tick, plus 300 more for a four-player run. That is what
catches a missed field, because a missed field usually agrees for one tick and only diverges later.
Also proven: a save with a level-up screen open comes back with the same four cards and their words;
every one of 1,203 sampled single-bit corruptions is caught and refused; and an interrupted run's
replay reproduces exactly and is accepted for the ladder.

## Autosave: the part the player actually notices

Saving a run is only useful if the game does it at the right moments, on its own, without being asked.
That scheduler now exists.

**When it saves.** Every thirty seconds of play, and immediately the moment the app goes to the
background — which is the important one, because that is the last instant the game is guaranteed
before the phone decides to reclaim it.

**Where it goes.** Two alternating spots, each write read straight back and compared byte for byte
before it is believed. Storage lies: a phone can report a save as done when nothing reached disk, and
it can mangle a byte in the middle. Both were tested by deliberately building a storage layer that
lies, fails, and throws, and in every case the game correctly concludes it has no saved run rather
than believing it has one.

**What it refuses to promise.** The game only offers to bring a run back if it has checked the saved
run adds up. Offering to restore a run and then failing when the player taps it would be worse than
never offering — so an offer is now proof, not a guess. If the newest save is damaged, the previous one
is offered instead: the worst case is losing up to thirty seconds, not the run.

**What it will not do.** It never saves during the split second the game is computing a frame, it never
piles up saves — if one is still being written when the next is due, the next is dropped and noted,
because a queue of half-megabyte buffers on a cheap phone is a worse problem than a missed autosave —
and it never saves a run that has already finished, since that would mean offering to resume a run that
has already been scored.

**Still to come:** the actual "you have a run in progress — continue?" screen. That is UI, and UI waits
for approved mock images per the standing rule, so the engine side is done and parked there.

Verified: typecheck clean, lint clean, 16 automated test files pass, build succeeds.

---

## Co-op networking — what it means for the game (plain English)

**The problem.** Four phones, one game. Enemies, damage, gems, level-ups — all of it has to look the
same on all four screens, on phone connections that lose things.

**The trick we use.** The game is built so that if two phones start from the same starting number and
are told exactly which directions everyone held their thumb in, they end up with exactly the same
world — the same 800 enemies in the same places, the same gems, the same damage numbers. So we never
send the enemies. Whoever is hosting sends only "here is what all four thumbs were doing on frame
4,312", which is seventeen bytes, and everyone's game builds the same frame from it. Describing 800
enemies sixty times a second would be a hundred times more traffic and would still go wrong.

**What a bad connection actually costs.** If your thumb's position hasn't arrived in time, the host
doesn't wait for you — waiting would mean everyone plays at the speed of the worst connection. It just
reuses where your thumb was on the previous frame, and tells everyone it did that. So a bad moment
costs one-sixtieth of a second of your own movement being slightly stale. It cannot cause the four
games to drift apart, because everyone got told the same slightly-wrong thing.

**When a packet goes missing.** Every message the host sends also contains the last few hundred
milliseconds of history, so a missing message is simply covered by the next one. No "did you get
that?", no waiting for a reply — at 150ms a reply costs nine frames and the thing being replaced is
four bytes.

**When a phone falls properly behind** — screen off, lift, tunnel, thirty seconds of nothing — history
isn't enough. So the host takes a complete photograph of the game world and sends it over in small
slices spread across a few frames, and that phone throws away its own version and adopts the
photograph. Sending half a megabyte in one lump would freeze the game, which is the thing we were
fixing. Everyone else keeps playing normally the whole time — one player's bad connection is nobody
else's problem.

**Twice a second every phone compares notes.** Each one boils its whole world down to a single number
and the host publishes its own. If yours doesn't match, you don't argue about it — you ask for the
photograph and start again from the truth. That's the safety net for anything we haven't thought of.

**Two real bugs the fake network found.** We can't test any of this with four phones on the same wifi,
because good wifi never does the bad things. So there's a fake network that lags, drops, duplicates and
reorders on purpose, from a fixed recipe so the same bad moment can be repeated on demand. It caught
two problems that would absolutely have shipped: a phone that asked for a second photograph while the
first was still arriving ended up mixing the two into nonsense; and a photograph with one missing slice
left that phone frozen forever, on exactly the connection that needed it most. Now a phone says which
slices it's missing and gets those back — a photo now survives a connection that loses a quarter of
everything.

**What it costs the person hosting.** About 24KB a second up at four players — roughly a quarter of what
streaming music uses. Each guest downloads about 8KB a second. While measuring this we halved the
host's upload with no downside.

**Card screens.** When someone levels up, everyone's game freezes on the same frame and unfreezes on
the same frame, and the pick is sent as part of the normal frame information, so any player can answer
the screen and everyone applies it identically. If two people tap at once it's settled by a fixed
order, not by whose connection is faster — so it's always reproducible.

**Solo pays nothing.** There's one copy of the game code, not a solo version and a co-op version.
Playing alone sends literally zero bytes and produces the identical game to having no co-op code at
all — that's checked automatically, tick by tick.

**Still to do in this stage:** the real internet plumbing (the relay and the 6-character room codes),
making your own character feel instant on your own screen even though you're technically a fraction of
a second behind the host, and handing the host role over when the host quits. The co-op lobby screens
wait on approved mock images like all UI.

Verified: typecheck clean, lint clean, 17 automated test files pass, build succeeds, pushed to GitHub.


---

## Chat, and the machine that polices it (decided 2026-08-13)

Players will be able to type to each other in co-op. This was rejected earlier and that was reversed,
so here is the whole thing in plain terms.

### Why it was rejected, and why that was wrong

The original reason was "typing needs moderation." That was true but the conclusion was wrong, because
it quietly assumed moderation means *a person reading complaints every day*. It doesn't. Almost all of
it is a machine's job.

### What the machine does, with nobody watching

**It cleans up the message before checking it.** People don't type slurs plainly, they try to sneak
them past. `s1ur`, `s-l-u-r`, `s l u r`, `sssluuur`, or letters from other alphabets that look
identical to ours. So every message gets flattened first — separators removed, number-for-letter
tricks undone, repeated letters collapsed, lookalike characters converted — and *then* it gets
checked. It's also checked with all the spaces taken out, which is what catches a slur split across
two words.

**It sorts by how bad the thing is.** Mild stuff gets the word starred out. Ordinary swearing gets
blocked and the sender warned — the other player never sees it at all. Slurs, threats, and sexual
content get blocked and permanently ban that person from chat on the spot, no warnings.

**It reads for the stuff no word list can catch.** Someone can be vicious without using a single bad
word. A small, cheap AI reads each message that passed the word check and scores it for harassment,
threats, and grooming. If the AI thinks someone is talking about hurting themselves, it does *not*
punish them — it quietly shows that person crisis resources. Punishing someone in distress would be
indefensible.

**It watches behavior, not just words.** Several different players reporting the same person in a
short time is the single strongest signal there is, and it needs no reading at all — that alone gets
someone muted immediately. Same for spamming the same line at twelve people, or typing faster than a
human can. A brand-new account gets watched harder than someone with three hundred clean hours.

**It handles reports by itself.** This is the part I got wrong before. When someone hits report, the
machine re-reads that exact message with stricter rules, weighs it against that person's history, and
acts within seconds. Obviously bad, it's gone and the punishment steps up. Obviously fine — someone
report-spamming the teammate who outscored them — dismissed, and *that* person gets a mark against
their own reporting record. People whose reports are always garbage stop being listened to.

### About bans

Punishment escalates: warning, then muted a day, then muted a week, then muted permanently. Only the
truly severe stuff skips straight to the end.

Two things worth knowing:

**A "ban" means banned from typing, not banned from the game.** Someone chat-banned keeps the game,
keeps their save, keeps buying cosmetics. They just can't talk. That fully satisfies what the app
stores require and costs us nothing in sales. Full account bans are for the extreme tail only.

**Marks fade.** Someone who swore once a year ago isn't one mistake away from a permanent ban. It
punishes patterns, not history.

**Bans stick through a reinstall.** A ban that a player escapes by deleting the app is theater, so it
attaches to their account instead of their phone.

### What's actually left for you to do

Appeals, and the genuinely unclear cases. Both are just lists you look at whenever you feel like it —
there's no clock, because the machine already acted. You're only ever checking whether it got
something *wrong*, never deciding what to do. At our size that's a handful of items a week.

There's also a one-button undo. If a bad update makes the machine start punishing innocent people, one
action reverses every mistake it made, because every single decision it ever makes is written down
permanently.

### The one thing I can't build around

The app stores now ask, point blank, "can players type to each other?" Answering yes means the game
is rated **13+**. It doesn't matter how good our filter is — it's a checkbox, not a grade. You decided
13+ is fine, and I agree: nobody under 13 was going to be playing a dark gothic horde survival game
anyway.

Because of that, the chat on/off switch is no longer about the rating — it's just a comfort setting for
players who don't want strangers typing at them.

### Deliberately kept small

Voice chat is permanently off the table. A hot microphone in a stranger's room is the worst possible
thing to police, and there's no realistic way to filter live audio.

And chat only exists **inside an active co-op run**. No global chat room, no friend messages, no inbox.
That single restriction does more for safety than any filter, because you can only talk to people
you're already in a game with. There's no way to hunt for strangers to harass.

### When

The preset messages — help, chest here, thanks, over here, going down — still ship free with co-op,
same button as the map ping. Those are what the players who never want to type will use, and they
arrive well before typing does.

Typing and the moderation machine come in the final stage, alongside the cosmetic shop, because every
punishment has to attach to an account and accounts don't exist until then. It also ships behind the
same remote switch as everything else, so if it goes badly it can be turned off worldwide in seconds
without an app update.


## The foundation finally got tested, and it was hiding two real bugs (2026-08-13)

You told me to stick to the one-test-line-for-every-two-lines-of-game rule. So I measured the whole
project, module by module, instead of guessing. Everything cleared the bar except one thing, and it
was the worst possible thing to have missed: the foundation. The handful of tiny, boring pieces that
every other part of the game sits on top of — the maths, the random-number generator, the pool that
hands out slots for enemies and bullets, the grid that decides which things are near each other, and
the clock that keeps the game running at a steady speed. Thousands of tests everywhere else, zero
there. It was the only part of the project with nothing checking it.

So I wrote the tests. About a thousand lines of them, in fifteen groups. And they immediately caught
two genuine bugs that had been sitting in the game the whole time.

**Bug one: recycled slots eventually went bad and the game quietly stopped being able to spawn
things.** Every enemy, bullet and pickup lives in a numbered slot, and each slot gets reused
thousands of times over a long run. To make sure a slot that has been reused isn't confused with its
previous occupant, each one carries a little counter alongside its number — like a name plus a
version. The space set aside for that counter was one digit too big, and once a slot had been reused
about two thousand times the combined number overflowed into territory the game reads as "invalid".
From that moment the game refused to believe that slot's own ID card. Worse, the routine that hands
a slot back to the pool checks the ID card first — so it just silently did nothing, and the slot was
gone for good. Slot by slot the pool would drain, and deep into a long session enemies and bullets
would simply stop appearing, with no crash and no error to explain it. Fixed by giving the counter
one digit less room, which is still far more headroom than any run needs.

Why no soak test caught it: most of the game returns slots by number rather than by ID card, and
that path never checks the ID. Only the paths that use the ID card were affected, so nothing broke
loudly.

**Bug two: the speed measurements were hiding the worst stutters.** When I report performance I
don't report the average — an average will happily tell you everything is smooth while one frame in
a hundred is a visible hitch. That's what "99th percentile" numbers are for: they show the bad
frames, not the typical ones. The code picking which sample counts as the 99th was rounding in the
wrong direction, so with sixty frames measured it would land one sample short and skip right over the
single worst frame. The exact thing the number exists to expose was the thing it could miss. Now
fixed to always round toward the bad end.

**What this means for the numbers you've already seen.** The performance figures from the big device
test — the ones that passed comfortably on your phone — were measured with the broken maths, so the
worst-case column was slightly rosier than reality. The typical and mid-range figures are unaffected,
and the test passed with plenty of room, so nothing about that decision changes. But I'll re-measure
on the phone next time we run it so the tail numbers are honest.

Neither bug would have shown up in a five-minute play session. One needs hours, the other only shows
up in a measurement you'd have no reason to distrust. That's the argument for the ratio you set, and
it just paid for itself twice.

Ratio after this pass: the foundation went from nothing to slightly more test than code. The project
overall sits at roughly one test line for every 1.7 lines of game — comfortably inside your rule.


## Online co-op, the matchmaking half — plain English

**What got built:** the part of online co-op that gets four phones into the same run. Not the
playing-together part (that was already done) — the finding-each-other part.

**Room codes.** Every co-op room gets a six-character code you can read out loud over voice or text.
The letters were chosen so nothing can be misheard or mistyped: no O and no 0, no I and no 1, no S
and no 5. Typing it wrong in the obvious ways still works — lowercase is fine, spaces are fine,
dashes are fine. "ab-cd ef" opens the same room as "ABCDEF". There are 729 million possible codes,
so two rooms will never collide in practice.

**A bug the tests caught.** The list of allowed letters had the number 8 in it twice. Nothing would
have crashed, but the 8 would have shown up in codes twice as often as every other character — a
small, permanent, invisible unfairness in something meant to be random. Fixed, and there is now a
test that counts the letters so it can never come back.

**Dropping is not quitting.** If your phone loses signal or a call comes in, your seat is held for
45 seconds and only you can take it back — the game hands your phone a private key when you sit
down, and it never leaves your phone. Come back inside 45 seconds and you are in your own seat, in
the same run. If you deliberately hit leave, the seat frees immediately, because holding it would
block a friend from joining for no reason. A held seat counts as full: someone who dropped four
seconds ago outranks a stranger who queued one second ago.

**Losing the host does not end the party.** One player's phone is the referee for the run. If that
player leaves, the next player in slot order takes over the job and everyone keeps playing. The room
only truly dies when every seat is genuinely empty — if even one person never chose to leave, the
room waits for them.

**The server cannot read a word of what players send.** This is deliberate. Each message carries
four bytes at the front saying, in effect, "this one goes to player 3" or "this one goes to
everybody". The server reads those four bytes and forwards. It never opens the rest. It cannot tell
a chat line from a damage number from an enemy spawn. That keeps the server dumb and cheap, and it
means there is no place on our side where game contents pile up.

**Cheating shut down at the door.** Every kind of message has exactly one kind of player allowed to
send it. Only the referee phone may announce damage, deaths and spawns. Only a regular player may
send their own stick input. Nobody but the server itself may announce that the referee changed. If a
modified phone tries to send something that is not its to send, the server throws it away without
even looking at it. And a regular player's message has exactly one possible destination — the
referee — so there is no message anyone can build that reaches another player directly.

**Cost:** 200,000 messages routed through this in a row and memory did not move at all. That matters
because this code runs on every single packet, for every player, sixty times a second.


## The server half of online co-op is real now

Up to this point the multiplayer code was proven against a pretend network — useful, and it caught
real bugs, but nothing had ever travelled over an actual connection. It has now. There is a small
server program running, and three real connections joined a real room, played, watched the host drop
out, promoted a new one, and let the dropped player walk back into their own seat. 23 checks, all
passing, and the test is saved in the project so it can be run again any time something changes.

**Joining fails before you ever see a lobby.** If a room code is wrong, or the room is full, the
connection is turned away up front. You get a clear "no such room" instead of a lobby that opens and
then sits there doing nothing. That is a deliberate choice: silence is the worst possible answer.

**Wrong codes still work.** Lowercase, spaces, dashes — all fine. "ab-cd ef" finds the same room as
"ABCDEF".

**One connection, two kinds of traffic.** Game data and lobby news travel down the same pipe but are
kept completely separate, and the server only ever writes the lobby news itself. Nothing a player's
phone says on that channel is listened to. That means a lobby feature we add in a year can't be
faked by a copy of the game shipped today.

**Nobody can pretend to be another player.** This was the important find. When everyone talks through
the server, the referee phone has one connection for the whole room, so it can't tell who sent what
just by which line it came in on — a modified phone could claim to be player 2 and move their
character. The server now stamps the real seat number onto every message it passes along. It isn't
caught and reported; it simply cannot happen.

**Three more real bugs, all caught by putting it on a real wire:**

1. **Joining would have hung forever.** There are two separate introductions when you join: one to the
   server (may I come in?) and one to the referee phone (here I am, what's the game state?). The server
   was answering the second one itself and never passing it on, so a player would be let into the room
   and then greeted by nobody. Black screen, every single join.
2. **Everyone's timing would have been wrong.** Players need to run slightly ahead of the referee, and
   they work out how far by asking the referee what moment it's on. The server was answering that
   question with its own answer, which is meaningless — it has no idea what's happening in the game. Every
   player on every connection would have been out of step.
3. **A fourth player could gate-crash a three-player room.** Room size was being treated as a suggestion.
   This matters more than it sounds: the number of enemies scales with the number of players, so an
   uninvited extra makes the run harder for everyone who agreed to a smaller party. Three now means three.

**Still to come before co-op is playable:** the game itself doesn't dial the server yet — that's the
next piece. Then handling a host swap gracefully on your screen, the come-back-from-a-dropped-signal
flow, and making your own thumb feel instant even at 150ms away. The lobby screens wait on artwork
approval like everything else visual.


## Repo audit and clean-up — 2026-08-13

You asked me to go through the whole repository because another AI reading it said the notes claimed
a phase was finished while somewhere else admitting a check hadn't been done. **It was right.** Here
is everything I found, in plain English.

### First, the good news: nothing is broken

I re-ran every check from scratch rather than trusting the log:

- All 19 test suites pass.
- The type checker passes on all four parts of the project, including the new server.
- The style and conventions checks pass with zero warnings.
- The production build succeeds.
- The co-op server passes all 23 checks against real live connections, including the two that were
  still failing last session — those turned out to be mistakes in the test itself, as suspected, and
  they were already fixed.
- Nothing was left uncommitted or unpushed. The working copy exactly matches what's on GitHub.

### What was actually wrong: the paperwork, not the game

**The root cause.** The build plan had no status written on it anywhere. Not one phase said "done" or
"in progress". The only record of what was finished lived in this log, buried in dated entries. So
anybody — a person or an AI — reading the plan on its own sees a list of nine phases with a checklist
of tests at the bottom of each, none of them ticked, and reasonably concludes the checks were skipped.

**Fixed.** The plan now opens with a section called *Where we actually are*, and every phase heading
carries its own status line. There is now exactly one place that says what's finished, and it says so
at the top where you'd look first.

**Three things listed as part of Phase 0 were never built.** I checked the code, not my memory:

1. A way for us to switch features on and off from the internet without you or anyone updating the
   app. Co-op is supposed to ship switched off, so this is needed by the end of the co-op phase.
2. A permanent, write-once record of every reward, ban and reversal on the server side. Nothing on
   the server hands anything out yet, so nothing needs it until the phase after next.
3. **Your approval of the two screens that were supposed to be mocked up for you in Phase 0** — the
   heads-up display you see during a run, and one menu. Two dev-menu mocks were drawn and you never
   said yes or no; the run display and the menu were never drawn at all. To be clear, the rule you set
   was never broken — no screen has been built without your approval. But the approval itself is still
   sitting there waiting, and the whole progression-screens phase is built on it.

**Two of Phase 1's four finishing checks were never actually proven:**

4. **"A five-minute run is genuinely fun."** I can't judge that; only you can. You said you'd rather
   wait for real artwork. That's a perfectly good decision, but the log had quietly let it pass as
   done. It now reads as *deferred to the art phase at your request*, which is the truth.
5. **"800 enemies still run at 60 frames a second."** This one deserves a straight answer. Two real
   measurements exist and neither is the actual test. One: the game's thinking, with 800 enemies alive,
   costs about a third of a millisecond per frame out of a 16-millisecond budget — measured, but with
   nothing being drawn. Two: your REVVL drew 5,176 moving sprites at 56 frames a second after fifteen
   minutes of getting hot — measured, but that was a synthetic swarm, not the game. Both point the same
   direction with a lot of room to spare, so I fully expect it to pass. It just hasn't been run. It
   costs one native run on your phone and I'll fold it into the next time there's a build on there
   anyway rather than asking you to do a session for it.

### Small tidying, while I was in there

- Checked whether anything local had leaked into version control by accident. Nothing had: no secrets
  file, no local helper scripts, no stray build output. Version control tracks 103 files of phone app,
  41 of web, 9 of desktop, 4 of the new co-op server, and the documents — and nothing else.
- **Found a test that was lying, and this is the one that actually mattered.** There is an endurance
  check that runs twenty minutes of the crowd simulation with nothing drawn, to prove the maths never
  drifts, freezes or produces nonsense over time. It was printing **"SIM BROKE"** — and then reporting
  success anyway, so no automated check would ever have noticed. On inspection nothing was broken: it
  declared a freeze if any single one of five thousand moving objects sat at the exact same position
  for one frame, which at that scale is a rounding coincidence, not a freeze. Real freezes were already
  being detected by better signals right next to it. So the test now fails on the things that mean
  something — an object actually stopping dead, the maths going to infinity, something escaping the
  play area, or a mass stall — and, crucially, it now **exits with a failure when it says it failed.**
  A test that announces a problem and returns "all good" is worse than no test, because it trains you
  to ignore it. It now reports SIM CLEAN, which is the truth.
- The endurance check and the co-op server's live test both existed but neither could be run by name
  from the project root, so in practice neither got run. Both now have a command of their own.
- The README's command list and folder map didn't mention the test command, the game engine folder, or
  the new co-op server package at all. Fixed.

### Nothing hidden

Everything above is now written down in the plan rather than only here, including the four items I
already knew were open: the artwork awaiting your yes/no, the test-coverage catch-up sweep we agreed
to do in one pass at the end of the co-op phase, the fact that the co-op server has no permanent home
on the internet yet, and the case where a dropped player's held seat finally expires and nobody in the
room is told.


## Dev menu look approved — 2026-08-13

You approved the stone version of the dev menu ("for now looks good, can iterate it more
in the future"). That is now the design of record for every dev screen: a cobblestone
border frame around the outside, with darker recessed slate slabs behind all the text,
and the mortar channels showing through between sections.

What that means in practice: the dev menu no longer needs design decisions to get built.
It gets built in Phase 3 when the out-of-run screens go in, and the extra Phase 2 tabs
(the ones for testing bad connections) just reuse the same look automatically.

Two smaller questions were raised and deliberately left for later, because you said it can
be iterated in future:
  1. Should more of the cobblestone show through in the gaps between sections, or does that
     make small text harder to read?
  2. Should the text slabs be rough chiselled granite, or blackened iron plates riveted onto
     the stone, instead of smooth slate?

Neither blocks anything.


## The in-run screen is settled — 2026-08-13

Four rounds of mock-ups and this is what we're building. Written down in the plan too.

**Top of the screen, thin and out of the way:** a cyan bar showing progress to your next card, then a
single row with your level, health, the clock, gold and kills, with the pause icon at the far right.
Pause is the only button in the whole interface. Under that, one row of twelve tiny slots — your six
weapons then your six items.

**Your party.** Each of the four spots is a tiny picture of that player's actual character, gently
bobbing, with their colour around the edge, a thin health bar, and their number shown as dots. Someone
who dies or drops out goes grey with a red X. Your own has a brighter edge so you can find yourself.

The dots stay even though there's a picture now. At that size all four hooded characters look basically
identical, so the picture is decoration and the colour plus dot count is what actually tells you who's
who — which also means colourblind players aren't left guessing.

Costs no extra drawing: it reuses the standing-still frames of the characters we're already making.

**You decide where it goes.** Both versions you liked are shipping as a setting:
  - Attached to the bar (nothing ever covers the fight) — and you pick left, middle, or right.
  - Detached, floating (drag it anywhere you want on the screen).
  - Starts attached on the left. Playing alone, it isn't shown at all.

**Moving works exactly like Vampire Survivors and Survivor.io.** No pad you have to hunt for — press
anywhere on the lower part of the screen and the stick appears right under your thumb, drag to steer,
let go to stop. It's invisible until you touch it. Attacking is always automatic. You can set its size,
its position, and swap it to the right side if you're left-handed. Auto-aim stays a settings switch, not
a button you'd hit by accident mid-fight.

**Nothing else is on the bottom.** No buttons, both bottom corners empty. Roughly the bottom 80% of the
screen is pure fight.

**Everything is resizable and movable,** from one layout screen: attach or detach, where it sits, and
separate size sliders for the top row, the slot row, the party pictures, and the stick. There's a
"put it back how it was" button — a layout editor you can wreck with no way to undo is asking for
trouble.

One thing that matters for building it: the screen has to read all its positions and sizes from your
settings from the very first day of work. Building it one fixed way and adding the sliders later is
exactly the kind of rework that costs a week.

Still to mock before any of this gets built: the layout editor screen itself.


## Chat and pings — how they work, decided 2026-08-13

You spotted that there was nowhere to type and nowhere to use pings. Here's the shape of it.

**The rule: no keyboard during a run, ever.** Nothing pauses in this kind of game. Enemies keep
walking toward you while your thumb is on a keyboard, so a text box mid-fight is just a way to die.

**During a run** you get pings and short preset messages only:
  - A small round button in the bottom-right. Hold it and six presets fan out under your thumb:
    HERE, DANGER, HELP, NICE, REGROUP, LOOT. Slide onto one, let go, it sends.
  - Tap the field to drop a ping — a marker with your colour pulses on that spot with your name
    under it, so "over there" works without words.
  - Messages from other players appear as a few short lines in the upper left and fade away on
    their own. No panel, no box to dismiss.
  - These presets are free with co-op. They are not something you buy.

**In the lobby** you get the full thing: a proper big chat window taking up half the screen, scrollable
history, a text box with a keyboard, a send button, the same six presets sitting right above the
keyboard, and a bell icon to mute the party if someone's being annoying. Everything typed runs through
the language filter before it leaves your phone, and gets checked again on the other side.

**After a run** the results screen also allows typing, since nothing is trying to kill you there.

## The twelve characters must not be the same person — 2026-08-13

First version drew the same hooded plague-doctor twelve times in twelve colours. Fixed, and this is now
a hard rule for the art: every character must be recognisable from its outline alone, before you see any
colour. No two share a head shape. The seven drawn so far: the beaked gravedigger in a wide flat hat, a
heavy bald butcher, a veiled nun in a tall pointed headdress, a horned knight in a closed helm, a bare
skull with no hood at all, a small ragged kid in a lopsided cap, and an antlered witch with red eyes.

Reason this matters beyond looks: in a four-player run you need to find yourself instantly in a crowd of
sixty monsters. Same body in a different colour fails that. Different silhouettes solve it for free.

## Canvas vs chat for changes — 2026-08-13

Asked and answered: cost per picture is about the same either way. The difference is that circling
something on the canvas and describing the change keeps the rest of the picture intact and only redraws
that part, so it usually takes fewer tries to land. Canvas is for tweaks — "shrink this", "move that".
Ask in chat for whole-screen rethinks, like the character silhouette problem above.

## Two keyboards in the lobby, and what still has to be drawn — 2026-08-13

**The keyboard is a choice now.** When you type in the co-op lobby you can use your phone's normal
keyboard or the drawn one that matches the game's look. It sits in Settings under Interface as
"Chat keyboard: phone / in-game", and it starts on **phone**.

Why phone by default: your phone's keyboard already knows autocorrect, swipe typing, emoji, voice
dictation, your language, and every accessibility feature your phone has. A keyboard we draw ourselves
can never do all that. So the pretty one is the option, not the default — it's there for people who want
the whole screen to look like one thing, and for wide screens where the phone keyboard covers the chat.

Both keyboards type into the same box and both go through the same filter before anything sends. The
switch changes what you tap on, nothing else. The drawn keyboard is English letters only — if your phone
is set to a language it can't show, the game quietly uses the phone keyboard instead. And this is lobby
and end-of-run only. Still no keyboard during a fight, ever.

**Monsters: yes, there's a lot more to draw.** The sheet you just looked at is the plain monsters. Two
more tiers come with it when we do the real art:

- **Elites** — a tougher version of a normal monster. Rule we just locked: an elite has to be *visibly*
  different, not just a different colour. Extra armour, a crown of horns, a second head, something. If
  you can't spot the elite in a crowd of sixty at a glance, we drew it wrong.
- **Bosses** — every boss gets its own body and its own outline, same rule as the characters. No two
  bosses may look like the same creature in a different palette, and they're drawn bigger with more
  frames of animation.
- **Shadow versions** of anything stay a pure colour swap, which is why they cost us almost nothing.

The Reaper and the White Hand are their own thing and get drawn last, because that sequence is the ending.

All of this is the big art pass, which is still where it was — after the co-op work is finished.

## Two phones, one world — 2026-08-13

Plain English: until today the co-op code had never once been tested with a message actually leaving
one copy of the game, crossing a real network connection, and arriving at another copy. Everything was
tested against a pretend network. That gap is now closed.

What got built:

- **The part of the game that holds the connection.** It knows the difference between "I pressed quit"
  and "I went into a tunnel". Quitting hands your spot back to the party straight away. Losing signal
  keeps your spot warm for 45 seconds and quietly keeps trying to get back into it, waiting a little
  longer between each attempt so four phones on the same bad wifi don't all retry at the same instant.
  After 45 seconds it stops and tells you the spot is gone instead of spinning forever.
- **Room codes are forgiving.** Type it in lowercase, with spaces or dashes, and it still works. If you
  read an O off a friend's screen where the code has a Q, we fix it for you. The one thing we refuse to
  guess at is S — there is no letter it could honestly become, so a code with an S in it is reported as
  wrong rather than silently turned into somebody else's room.
- **Being turned away now says why.** Before, if a room was full or the code was wrong, your phone just
  saw "could not connect" — the reason existed but was sent in a way no phone can read. Now the server
  opens the connection, says "room full" or "no such room" in words the lobby can put on screen, and
  hangs up.
- **Quitting properly frees your seat.** Found while testing: the game was closing the connection
  without saying goodbye, so the server assumed you'd crashed and held your seat for 45 seconds. A
  party of four could not replace someone who left for almost a minute. Fixed.
- **The host stopped repeating itself.** Over a real server the host was addressing the same shared
  message once per player, and the server was then forwarding each copy to everyone — nine deliveries
  where three were meant. Now it is written once.

The proof: a new end-to-end test starts a real server, connects two real players, runs 240 ticks of
actual game, and checks both copies of the world agree at every single tick. Then it kills one player's
connection the way a tunnel does, watches them reconnect into the same seat on their own, runs another
120 ticks, and checks the two worlds still match. Then it has them quit and confirms someone else can
take the seat immediately. All green.

Still to do in this phase: the party lobby screen itself, what the screen shows while someone is
reconnecting, the extra developer tools for testing co-op, and smoothing out your own character's
movement so it never feels like it's waiting on the network.

## The eight screens are approved, and five things I fixed in them - 2026-08-13

You said build them, so they are the reference now. I redid the level-up screen because its
top bar had hearts and a "FLOOR 7" on it and we have neither - health is a number plus a bar,
and there are no floors. The new one has the exact bar we settled on.

While I was in there I found five more things that were wrong. None of them needed a new
picture - they are wrong words and wrong defaults, so I wrote the correct rule down instead
and the code will follow the rule:

- Stage select said "TIME LIMIT 30:00" on every stage. Wrong. That number is when the Reaper
  comes for you, it is 15:00 on some stages, and Endless has no end at all. It will say
  "REAPER 30:00" and read the real number per stage.
- The insect-free sprite option was switched on in the picture. It should be off by default -
  it is there for people who want it, not the standard look.
- Settings was missing four switches we already agreed on: battery saver, chat on/off,
  chat-from-strangers on/off, and the daily reminder ask.
- The leaderboard's "TOP 1%" style tags did not add up - it showed three people tied at top 1%
  on a board of four thousand. Those tags will be worked out from the real board size and only
  shown at the levels that actually pay: 0.1%, 1%, 5%, 10%, 25%, 50%.
- The leaderboard has no way to pick a stage. If we ship it like that, whichever stage is
  easiest takes every top spot and nobody ever looks at the other four. Each stage gets its
  own board.

## Taking over when the host's phone dies - 2026-08-13

Built and tested the part where the person hosting the party disappears.

Before today, one player was running the world for everyone. If their phone died, rang, ran out of
battery or went into a tunnel, everyone else's game was over. Now somebody else takes over and the
fight carries on.

What it does, in order:

1. The server notices the host is gone and picks whoever is left, instantly.
2. That phone takes over the world it was already playing - nothing restarts, nothing rewinds.
3. Everyone else is handed the new host's world so nobody is quietly playing a different fight.
4. Everyone sees a line saying the host changed, or that they are now in charge.

Costs about a third of a second of catching up, once, and only when somebody's phone actually dies.

**Two things the tests caught that I would never have spotted by playing:**

- When somebody's connection died and their time to come back ran out, the game told everyone else
  they had *quit*. Those are different things and people react to them differently. Fixed.
- If the screen only had room for two messages and three arrived, the third was thrown away instead of
  shown a moment later. Fixed.

**And two things nobody was being told at all:** when somebody's time to come back finally ran out, the
other players were never informed - their badge just sat there greyed out forever. And if the host was
the one whose time ran out, the server handed the room to somebody else and never told them, so that
phone sat there not hosting while everyone waited on it. Both now announced.

Everything passes: 21 test files, the live server test, and the two-phones-on-a-real-connection test.

Still to do before this phase is finished: making your own thumb feel instant on a guest phone, the
lobby screen, the four-player heads-up display, the co-op tools in the dev menu, and the switch that
keeps co-op turned off until it is ready.
