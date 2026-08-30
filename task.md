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

## Your own thumb now feels instant - 2026-08-13

The problem this fixes: in a party, one phone runs the world for everyone. Every other phone has to
send what your thumb is doing across the internet, wait for the host to agree, and only then move
you. On a decent connection that is a tenth of a second. On a bad one it is worse. You would notice
it instantly, because the one thing nobody forgives is their own character walking late.

So now each phone draws *you* from what your thumb is doing right now, while everything else - every
enemy, every pickup, everyone else - still comes from the host. The moment the host confirms, the
truth quietly takes over. Nothing about the actual fight is guessed, and if this whole thing were
deleted the game would still be correct, just laggier.

The careful parts:

- It only guesses about a third of a second ahead at most. Past that, guessing is worse than waiting.
- When the guess turns out wrong - you walked into a wall, something knocked you back - the sprite
  slides the small distance back over a few frames instead of teleporting, which you cannot see.
- Big corrections *do* teleport, on purpose. Being revived across the map is not something you should
  watch yourself skate to.
- A downed or dead character is never guessed forward. A corpse does not walk.
- If your phone is hosting, or you are playing solo, this code does nothing at all - same path, no
  second thing to keep working.

Tested to the usual ratio: the module is 256 lines, the tests are 266. Twelve areas, forty-odd
checks, including one that runs two hundred thousand ticks to prove it never allocates memory while
you play. I also deliberately broke the smoothing to confirm the tests actually catch it - they do.

Everything else still passes: 22 test files, the live server test, the two-phones-over-a-real-
connection test, typecheck, lint and build.

Left in this phase: the lobby screen, the four-player heads-up display, the co-op tools in the dev
menu, and the switch that keeps co-op turned off until it is ready.

## Every setting now has one answer, and old saves survive it - 2026-08-13

The settings screen we approved has switches the game had never actually stored: battery saver, chat
on/off, whether strangers can talk to you, the daily reminder ask, the insect-free sprites option,
auto-aim, the speedrun overlay, the keyboard choice, and all the heads-up display layout controls
(docked or floating badges, which side they sit on, and four separate size sliders). All of that is
now saved and comes back after a reinstall.

Three of the comfort options - damage numbers, screen flash, screen shake - used to be on or off.
They are sliders now, nought to a hundred. The people who need them do not all need the same amount,
and making someone choose between all of it and none of it was the accessibility failure we said we
would not ship.

The important part: nobody's existing save is thrown away. A save written before today is read at its
old size, upgraded field by field into the new shape, and written back out in the new format. What
used to be "shake: on" becomes "shake: 100", "off" becomes "0". Progress, gold, unlocks and counters
all cross over untouched. Tested by hand-building an old save byte by byte - not by using our own new
code to write it, which would have proved nothing - then reading it and checking every field. A
damaged or too-old file is still refused rather than half-loaded.

On top of the storage there is now one place that answers "what actually happens", instead of every
screen working it out for itself:

- If you pick our in-game keyboard but your language is Japanese, Russian, Arabic, Korean, Greek,
  Hebrew, Thai or Hindi, you get your phone's keyboard, because a keyboard that cannot type your
  language is not a style choice. The screen is also told the choice was overridden, so it can grey
  the option out instead of lying about it.
- An unrecognised language gets the working keyboard, not the pretty one.
- "Let strangers talk to me" cannot be on while chat itself is off. Two switches where one quietly
  overrules the other is how someone ends up certain they turned chat off and it kept talking.
- Battery saver only ever takes away: it halves the effect sliders, caps drawing at 30 frames a
  second, and nudges effects down a step. It never adds an effect back that you turned off. The fight
  itself still runs at its normal speed - only the drawing slows.
- Every size slider is clamped, so the layout editor cannot produce a four-point-wide control or a
  badge bigger than the phone.
- Badge positions are worked out here too: docked left, centre or right to the point, or wherever you
  dragged them - and either way clamped so the cluster is always fully on screen, on any phone. The
  cluster keeps its full four-player width even after someone drops, so the row never re-centres
  itself mid-fight and make you re-find it.
- Solo hides the badges entirely.
- "Reset layout" puts every position and size back and touches nothing else - your volumes, opt-ins
  and comfort sliders survive it.
- The daily reminder can only be asked on your second run, and only once, ever.

This had to exist before the heads-up display, not after: the layout screen only works if the display
reads every position and size from settings from its very first line. Retrofitting that onto
hardcoded numbers is a rewrite.

Tested to the usual ratio: 311 lines of code, 379 lines of tests, thirteen areas, about 170 checks.
I broke two rules deliberately - the stranger-chat one and the badge padding - and confirmed the
tests catch both and fail the build.

Everything else still passes: 23 test files, the live server test, the two-phones-over-a-real-
connection test, typecheck, lint and build.

Left in this phase: the lobby screen, the four-player heads-up display, the co-op tools in the dev
menu, the switch that keeps co-op turned off until it is ready, and deciding where the server lives.

## The party room has rules now - 2026-08-13

Before a single lobby screen gets drawn, the rules of the party room exist and are tested. Screens are
easy to change; rules are what break parties at two in the morning.

What it does:

- Only the host keeps the party list, and it is always sent complete rather than as a change. If one
  change went missing, somebody's list would be wrong forever with no way to notice.
- When you press ready as a guest, your row does not tick instantly. It asks the host and waits for the
  answer to come back - about a fiftieth of a second - and in exchange all four phones show the same
  list at the same time.
- Chat goes from you, to the host, to everyone. The host throws away whatever name your phone claimed
  and stamps the seat the server says you are sitting in, so nobody can send a message that looks like
  it came from someone else. There is no path from one guest straight to another, so there is nothing to
  fake.
- Typing fast is allowed. The limit is five messages in a burst, with one more becoming available every
  one and a half seconds, because that is how people actually talk. The six preset shouts skip the word
  filter but not the limit. If your phone's clock jumps backwards, it hands out nothing.
- Every refusal is its own answer: empty, too long, chat turned off, blocked word, too fast, not sitting
  in a seat, unknown preset. "I pressed send and nothing happened" is the chat bug nobody can ever fix,
  so that message does not exist here.
- Messages are cleaned again when they arrive, not just when they are sent - your phone never trusts
  what came off the wire. And messages that arrive while your chat is off are thrown away on arrival, so
  switching chat back on does not dump a backlog on you.
- If someone dropped and their seat is being held, the start button refuses on purpose. Nobody gets
  left behind thirty seconds from walking back in. Giving up on them has to be a deliberate kick.
- The host never presses ready. Pressing start is the readiness.
- The random seed for the run is drawn once, on the host, and sent to everyone - so there is exactly one
  answer to the question of which run this is.

The word filter itself is only structural right now: it strips invisible characters and collapses runs
of spaces, and judges nothing. The real word lists are a later phase, and the lobby deliberately does
not grow its own smaller, worse copy in the meantime.

Tested to the usual ratio: 741 lines of code, 502 lines of tests, seventeen areas, 129 checks. I broke
two things deliberately - the start button's reconnect rule, and the burst size - and the tests caught
both. The burst size one is worth mentioning: the first version of that test read the limit from the
code itself, so changing the limit from five to six changed the test with it and nothing failed. A test
that agrees with whatever the code says is not a test. It now checks the number five out loud.

Everything else still passes: 24 test files, the live server test, the two-phones-over-a-real-connection
test, typecheck, lint and build. The message format version went from 3 to 4 for the four new lobby
messages, and both server tests confirm nothing was pinned to the old number.

Left in this phase: the lobby screens, the four-player heads-up display, the co-op tools in the dev
menu, the switch that keeps co-op off until it is ready, where the server lives, and one catch-up pass
on tests for the older networking files.

## The screens will not be allowed to hold any rules - 2026-08-13

The connection knows about sockets and seats. The party room knows about the roster and chat. Neither
knows the other, on purpose, because that is what makes both testable. Something still has to marry
them - and if that something lives inside a screen, then the rules of co-op end up in a file that can
only be tested by tapping a phone.

So the marriage is its own piece, and it is tested headlessly:

- The server is the only authority on seats, so a party list arriving on *any* message from the server
  updates the room - not just the one that seated you. A message with no party list in it changes
  nothing, rather than wiping the party.
- Reconnecting is not rejoining. Your seat is still yours, but you come back NOT ready, always. A phone
  that reconnects silently ready lets a party start a run it is not actually in yet.
- Being refused and being hung up on are the same thing to you - "it did not work" - so there is exactly
  one path and one sentence, and neither retries. I found and deleted a second path here while testing:
  it looked like a rule and could never run.
- The server speaks in machine words. `room_full` becomes "That party is full." A reason from a future
  version of the game that this build has never heard of still comes out as a readable sentence rather
  than raw code on your screen.
- Nothing can be sent before the server has given you a seat, because a message sent before then has no
  sender. Chat, presets, ready and start all refuse quietly until you are actually sitting down.
- Your seat token never appears in anything a screen can read. The test checks for it by searching.
- The screen is handed a copy of the party list, not the live one, so a message arriving halfway through
  drawing cannot change what is being drawn.

Tested to the usual ratio: 392 lines of code, 378 lines of tests, ten areas, 73 checks. I broke two
things deliberately - the party-list refresh and the readable-refusal translation - and confirmed both
fail the build.

Everything else still passes: 25 test files, typecheck and lint.

Next: the two actual lobby screens, which now have nothing left to decide.

## The party room exists on screen now - 2026-08-13

You can create a party, join one with a code, or take a quick match, and then sit in a room with other
people and talk to them. Two browsers on this machine did exactly that, through the real server: names
appeared on both sides, ready appeared on both sides, a typed line crossed, a shouted DANGER crossed, and
the start button unblocked itself the moment everybody was ready.

What is there:

- Party size 2, 3 or 4, chosen before you go in, with the note that a bigger party means more enemies and
  never tougher ones.
- A room code shown big in gold. Typing one in forgives case, spaces, dashes and the letters people
  confuse for each other.
- Four seat rows: portrait tile, your identity colour, your dot count, your name, a HOST mark, and READY
  or NOT READY on the right. A seat somebody is reconnecting into says RECONNECTING in red and is not the
  same thing as an empty one.
- A chat log where every speaker's dots and colour are next to their line, so you can tell who said what
  without reading the name.
- The six shouts along the bottom of the chat panel - HERE, DANGER, HELP, NICE, REGROUP, LOOT.
- Either keyboard. Your phone's keyboard is the default and brings its autocorrect, swipe, dictation and
  emoji with it. The game's own keyboard is a setting away, and if your language cannot be typed on it,
  your phone's opens instead and says why.
- START RUN for the host, READY for everyone else, LEAVE for both - and when START is refusing, a line
  above it says which of the four reasons it is rather than the button just sitting there dead.

Three things I got wrong and fixed after looking at it:

- The host's row said NOT READY. The host never presses ready - pressing START *is* their readiness - so
  the screen was inventing a rule the game does not have and making it look like the host was blocking
  their own party.
- Every new party opened with the game telling you that you had sat down. First line, empty room, about
  yourself. It now only mentions other people.
- The identity dots were too small to count at a glance, which defeats the entire point of having them.

And one real bug, which is the reason for testing against the actual server rather than a stand-in: the
server was still running the version from before the party messages existed, so it was quietly throwing
every one of them away as something it did not recognise. Names, ready and chat all silently failed while
the seats themselves worked, because the seats come from a different channel. Restarting it fixed it, and
it is worth remembering: after the message format changes, the server has to be restarted or nothing
about the party works and nothing says why.

Also built while doing it, because the screens should hold no rules: the keyboard's own behaviour (shift
once versus caps lock, delete one character rather than one byte, both length limits, no fake messages
made of spaces) and base64, which is how the save file gets into phone storage - hand-written because
Android's JavaScript engine does not have it, and checked against a known-correct version at every length
from nothing to a kilobyte.

Tested to the usual ratio, every piece: the keyboard 273 lines of code to 261 of tests, base64 76 to 145.
Two more deliberate breaks confirmed caught. 27 test files now, plus the live server test, the
two-players-over-a-real-connection test, typecheck, lint and build - all green.

Still missing from this screen, deliberately, until the art phase: character portraits (seats show a skull
and a seat number), generated player names (everyone is SURVIVOR for now), and the little bell icon for
muting chat from the lobby itself rather than from settings.

Left in this phase: the four-player heads-up display, the co-op tools in the dev menu, the switch that
keeps co-op off until it is ready, where the server lives, and one catch-up pass on tests for the older
networking files.


## The bar at the top of a fight now knows about four people - 2026-08-13

The heads-up display is what you stare at while something is chasing you, so its mistakes are the
expensive kind: a party row that reshuffles itself when a friend goes down, a revive ring still spinning
over somebody who was rescued ten seconds ago, a clock counting the wrong way. None of that turns up by
playing for five minutes, because each one needs a particular party in a particular state, so all of it
is written as a tested module first and the screen will only be allowed to draw what it is told.

What is decided in there now: how full your experience bar is, your health, the run clock, gold, kills,
the twelve item cells (six weapons, a stone divider, six passives), the pause icon, and the row of small
party badges - one per seat, each with its own colour, its own countable dots, a hairline health bar, and
a distinct look for down, dead and dropped.

Four things worth calling out, because they were choices and not accidents:

- **Not one position is invented.** Every coordinate comes from your settings. Scale the top bar up, drag
  the party row somewhere else, switch it from docked to floating, and the display follows without knowing
  anything happened. That is what makes the layout editor possible later instead of impossible.
- **A dropped player reads as *away*, not dead.** Their seat is held for forty-five seconds and their
  health stays on their badge. A party that thinks a reconnecting friend is dead gives up and starts
  without them.
- **Your identity is carried twice** - the colour of your badge and the number of dots under it. Either
  one on its own fails somebody, and now neither can be quietly removed without a test noticing.
- **A frame costs nothing.** Two hundred frames in a row reuse the same memory, so the display cannot be
  the thing that makes the game stutter at minute forty.

Solo hides the party row entirely, and the settings get the final word: a screen that asks for four badges
on a layout that says there are none does not get them.

578 lines of code to 484 of tests. Five deliberate breaks - hiding the row in solo, giving everyone the
same number of dots, treating a dropped player as dead, making the clock always count up, and leaving the
revive ring on after a rescue - all five were caught. 28 test files now, plus the live server test, the
two-players-over-a-real-connection test, typecheck, lint and build, all green.

Next on this: actually drawing it, which is quads and placeholder shapes until the art phase - seats will
show a seat number rather than a face until characters are drawn.

Also settled today, at your request: **there will be a tutorial after all.** The plan said never build one;
that is now reversed with your reasoning on the record. It is offered once on first launch, it is a real
run rather than a walled-off practice room, one tap turns it off, and it lives in Settings under "How to
play" forever so anyone can ask for it whenever they like - including people who said no the first time.
It has to be animated and it has to feel expensive: prompts that slide and settle, a drawn arrow or a
breathing ring pointing at the thing being talked about, nothing ever covering the fight, and every prompt
leaving on its own. It changes nothing about the game itself, so a guided run still counts for
leaderboards. It is built in the next phase with the rest of the menus, and it is written into the atlas
budget now rather than discovered later. Roughly 1,600 lines plus tests.

Also noted for the art phase: you are sending a video of Vampire Survivors' chest opening as the quality
bar for ours. What gets matched is the timing - the wind-up, the burst, the reveal, the settle - not the
shapes or the colours, which stay ours.

## The bar at the top of a fight is now on the screen - 2026-08-13

The four-player HUD is drawn. The part written yesterday decided every number; this part turns those
numbers into shapes and is allowed to decide nothing else. There is exactly one line in it that converts
between the two ways the game measures the screen, and every rectangle it draws traces back to something
in settings - which is what makes the layout editor a screen to build later rather than a rewrite.

It draws its own text. There is no art in the project yet and no lettering, so the HUD carries a tiny
three-by-five pixel alphabet built out of plain squares. That means the level, the health, the clock, the
gold and the kill count all show real numbers today. When the real lettering is drawn each character
becomes one shape instead of fifteen and nothing else about this changes.

While looking at the first picture of it I found a real bug: gold and kills were being read from the run
but never handed to the display, so both would have read zero forever on screen. Fixed, and the test now
checks every number the strip draws actually arrives - the class of mistake, not just this one instance.

The in-run screen was rewired onto it. The old thumbstick in the bottom-left corner is gone: a touch
anywhere below the top block now makes the stick appear under your thumb, wherever that is. The pause icon
is the only button in a run, and it is checked before the movement region, so no combination of layout
settings can ever make pausing impossible. Pausing stops the clock properly - it does not owe the game a
second of catching up when you unpause. There is also a seat-count switch on the dev screen so the two,
three and four player layouts can be looked at without four phones.

Nine deliberate breaks were tried against the drawing tests - ignoring the scale factor, drawing badges in
solo, giving every seat the same number of dots, marking a disconnected player with the dead X, leaving a
revive bar up when nobody is being revived, dropping the low-health colour, dropping half the pause icon,
un-rimming a maxed item. Every one was caught. 76 checks in the new file, 29 test files in total, plus the
live server test, the two-players-over-a-real-connection test, typecheck, lint and build, all green.

One thing worth knowing: two of the four player colours are also colours the game already uses for
meanings - player one's cyan is the experience colour and player three's crimson is the health colour. It
reads fine because the badges are somewhere else on screen and the dots back the colour up, but if it ever
looks muddy, that is why, and the fix is a data change.

Next on this: the dev menu's co-op panels, then remote config, which co-op has to ship behind.


## The tools for breaking multiplayer on purpose - 2026-08-13

The co-op part of the dev menu is built. This is the page a developer opens when four people are in a
party and something is going wrong, and it does two jobs: it shows what the connection is actually doing,
and it lets us cause the exact failures we would otherwise have to wait for.

What it shows, updating four times a second: whether this device is hosting, how many seats are filled and
how many are being held for someone reconnecting, how long a round trip is taking (typical, bad, and
worst), how much data is going up and coming down, how often the game had to guess a missing player's
input, how many times it had to resend the whole game state, how many times two players disagreed about
what happened, and how big that state is. When no party is in a run it says so plainly instead of showing
zeros that look like answers.

What it can break, on purpose: add delay, add unevenness to that delay, throw away a percentage of
packets, and - separately, off by default - allow packets to overtake each other. Those last two are kept
apart deliberately. Delay is not the same failure as arriving in the wrong order, and if a slider did both
at once we would never know which one a bug needed.

Then the five buttons that cause real incidents: force two players to disagree, drop a guest, move hosting
to somebody else, freeze the host for a second, and make a replay come out differently. None of these
reach into the running game. The page cannot touch a session at all - it reads numbers through a hatch and
it leaves a request for whoever owns the session to carry out on its next frame. A debugging tool that can
reach into a run is eventually the reason a run breaks.

Every one of those write controls marks the run as tainted, which means no leaderboard. That mark is
one-way: putting the sliders back to zero afterwards does not clear it. Watching costs nothing - the
readout and the agreement board never taint anything.

Three things in the approved picture were wrong and the built page follows the decisions, not the picture.
The TAINTS warning had drifted onto section headings, so it now sits on each individual control that
writes something - a heading that warns about a group containing a read-only readout teaches the wrong
thing. The readout lettering is the same chunky lettering as everywhere else, not the thin typewriter face
the picture drew. And the panel count in the footer is counted in code rather than being the number the
picture invented.

A real bug came out of writing this. The agreement board was storing "this seat has reported" and "do we
agree with it" in the same place, which meant the moment a seat reported before we did, its report was
overwritten and that seat never got judged at all. They are two separate facts now and there is a test for
exactly that ordering.

Seven deliberate breaks were tried against the tests: letting jitter reorder packets when reordering is
off, removing the packet-loss roll, folding disagreement into agreement, never recording that a seat
reported, handing the same fault out twice, and unclamping the loss slider - all six caught. The seventh,
letting a delayed packet point at the sender's own buffer instead of a copy, was **not** caught, which
means the tests had a real hole. A packet held for a fifth of a second and then delivered would have
carried whatever the sender had since written into that buffer - garbage, arriving late, in a tool whose
whole purpose is diagnosing garbage arriving late. A test for it now exists and it kills that break.

121 checks in the new file. Typecheck, lint, the whole game suite, the live server test, the
two-players-over-a-real-connection test and the build are all green.

Next on this: remote config, which co-op has to ship behind, and deciding where the relay is actually
hosted.

## Remote control over what the game does — done and tested

The game can now be told what to switch on and off without shipping a new version to the store. That
matters for three things already promised: multiplayer has to launch switched off and be turned on when
it's ready, the developer menu has to be switchable off in case someone finds the way in, and Chaos
Sandbox Day has to be turned on for a weekend and off again.

How it behaves, in plain terms:

The game ships with every one of these switches off except one - posting a score to a leaderboard, which
is the only one whose absence would be a bug rather than a decision. That off-by-default state is exactly
the shape the game is submitted to the store in, so a submission can never accidentally go out with
unfinished features live.

A set of instructions from us is taken all at once or not at all. Half-applied instructions would be a
version of the game nobody ever tested.

Instructions only ever move forward. Each set carries a number, and the game refuses anything that isn't
newer than what it's already holding. Without that, an old copy sitting in an internet cache could turn a
feature back on after we'd killed it.

Turning something off always beats turning it on. If we kill a feature and some other part of the same
instructions says a particular player should have it, the kill wins. Blocking a specific account beats
everything.

Instructions go out of date on purpose. After fifteen minutes the game wants to ask again. After a week
without hearing from us at all, it stops obeying the old instructions entirely and goes back to how it
shipped. That's a deliberate trade: a player who goes a week offline loses features rather than being
stuck forever on a rule we've since changed.

Switching a feature on gradually is stable, not a coin flip. Each player lands in a fixed slot from 0 to
99 based on their account and which feature it is, and that slot never changes. So raising "give it to 10%
of players" to 25% only ever *adds* players - nobody ever has a feature taken away by a number going up.
Different features shuffle players differently, so the same unlucky group isn't the test audience for
everything.

A switch this build has never heard of is off. The game can't honour an instruction it has no code for.

An old copy of the game can be stopped from turning something on, but never stopped from turning something
off. If someone is on a version too old for a feature, the instruction to enable it is ignored - but a
kill switch still reaches them.

None of this is a security measure and it isn't pretended to be. Somebody who modifies the app can flip
their own copy's switches. Everything that actually matters - whether a leaderboard score is real, whether
you're allowed into a multiplayer room, whether you receive an item - is decided on our side, not theirs.
If flipping a switch in a modified copy would win a cheater something, the feature is built wrong.

Also built: the little server route that hands the instructions out (it sends the same thing to everybody
and lets each phone work out what applies to it), the phone-side glue that remembers the last instructions
it got so a fresh launch on a plane still behaves correctly, and the one-line way any screen asks whether
a feature is on. Multiplayer's entry screen is now behind that switch, and it tells the player which of the
two reasons applies rather than one vague message.

158 checks in the new test file. Five deliberate breaks were tried against it - accepting an older set of
instructions, letting a per-player allowance outrank a kill, ignoring the week-long expiry, changing the
maths behind the gradual rollout, and inverting the account block. Four were caught immediately. The fifth
was not: changing the rollout maths passed, which means the tests were checking that players were spread
out but not that they'd land in the *same* places tomorrow. Those exact positions are now written into the
test, so any change to that arithmetic breaks loudly instead of silently reshuffling everyone mid-rollout.

Typecheck, lint, the whole game suite, the live server test, the two-players-over-a-real-connection test
and the build are all green.

Next on this: hooking the developer menu's own config page up to it, and deciding where the multiplayer
server actually lives.

---

## The developer menu now listens to those instructions (13 Aug)

The game has one developer menu, and from now on it has exactly one gatekeeper deciding what that menu
may do. There was a temptation to give each developer page its own - that would have meant two separate
records of what was touched during a run, and two different opinions about whether the run still counts.
One gatekeeper, one record, one answer.

The instructions from our side are pushed into that gatekeeper rather than fetched by it. The part of the
code that runs the actual fight is not allowed to reach out to storage, the network or the clock, so
something outside hands it the answers instead.

There is one deliberate lopsidedness. Every gated feature is off unless told otherwise - that is the shape
the app gets submitted to the store in, and it's the right default there. But it's the wrong default for
our own phones, sitting offline in a room with no signal: it would lock us out of our own menu. So silence
leaves the menu open on our internal builds, while an explicit instruction to close it still closes it -
on internal builds too. The emergency switch has no exception anywhere, including the place a leaked
internal build would be.

A forced switch counts as an instruction, because a switch someone flipped by hand is the loudest
instruction there is.

The config page inside the developer menu now shows, for every switch: whether it's on, why it's on or off
in plain words, how old our instructions are, whether they've gone stale, and which set of instructions
we're looking at. Reading all that costs nothing and marks nothing - you can open it in the middle of a
fight and the run still counts for the leaderboard. Forcing a switch by hand does mark the run, and cycles
through three states rather than two: leave it alone, force on, force off. "I turned this off" and "this
is off by itself" are different facts and the page shows which. On a store build, forcing is refused by
the code itself, not just greyed out on screen.

Six deliberate breaks were tried: treating silence as a real no, letting silence open a store build's menu,
handing the gatekeeper a replacement set of switches instead of updating the one it holds, treating expired
instructions as still valid, treating "your version is too old" as a real instruction, and letting the
chaos switch stop closing the public leaderboard. All six were caught. Sources restored and checked
byte-for-byte afterwards.

Typecheck, lint, the whole game suite, the server test, the two-players-over-a-real-connection test and
the build are all green.

Next on this: deciding where the multiplayer server actually lives when it isn't on this machine.

---

## Where the multiplayer server is going to live (decided 13 Aug)

Cloudflare, for the multiplayer part only. Everything else stays where it is. Those are two different jobs
and they do not need to be in the same place.

The multiplayer server's whole job is holding the line open between up to four players for the length of a
fight, and then forgetting it happened. It keeps nothing important and it never even looks inside what
players send each other - only at the four bytes of address on the front. That is a switchboard operator,
and Cloudflare is very good and very cheap at being one.

The other half is the filing cabinet: your account, your unlocks, your saves, the leaderboards, the admin
page, and the score re-checking that is the real anti-cheat. That has to remember things forever, and it
has to be the same thing that gets published to the store, so it stays on the platform this project is
built from. It is not moving, and that is not a preference - it is the same thing that ships.

The good part: these two halves barely talk to each other. The switchboard never opens the filing cabinet.
It was built that way from the first line, months before this question came up. So splitting them across
two companies is the tidier arrangement of the two, not a workaround.

Why this is not a rewrite. All the actual thinking - who is allowed into a room, what a room code looks
like, which messages are legal from which player, who takes over when the host quits, how long a dropped
player's seat is kept, when an empty room gets cleaned away - lives in the game's own tested code, about
2,500 lines of it, and it does not know or care where it is running. Wrapped around that is a thin shell
whose only job is holding the phone lines open. The shell is 535 lines and exactly two of them are tied to
the software it currently runs on. Moving means throwing away the shell. The rules and their tests are
untouched.

The one bit of real work: right now one program keeps a list of every live room in its own memory.
Cloudflare does not work that way - there, each room becomes its own separate little thing, with a small
directory in front turning a room code into the right one, and the cleanup sweep becomes each room setting
its own alarm clock instead of one clock for all of them. That reshaping is the genuine effort. Two working
sessions, roughly 700 new lines plus 400 of tests.

On cost: Cloudflare's own pricing page has an alarming $419-a-month example for games broadcasting state,
but that is at a size we are nowhere near. At what we actually measured, a half-hour four-player match
comes out well under a cent, and a lobby with people sitting in it waiting costs almost nothing, because
Cloudflare can put a waiting room to sleep without dropping anyone's connection. I want to prove that with
a real load test before treating it as fact.

When: not now. It gets built at the point where four real phones in real hands need to reach each other,
because that test cannot be run on this machine anyway. Standing up a live server months before a single
real player touches it just creates something to babysit, and the rules it will run are already written and
already tested.

One thing I am deliberately not promising: using Cloudflare in front of everything else too - the domain,
the caching, the attack shield. That depends on how the publishing side lets a custom domain be attached,
which is a setting on the publish screen and not something I control. It is a five-minute question when we
get there, not a rewrite. Do not count it as a yes yet.

## The networking catch-up sweep (13 Aug) — Phase 2's last build item

Plain English: eight of the networking files were written before we agreed the rule that every file
gets at least half its own length again in tests. Each of them had one thorough test for the path we
expected everything to take, and nothing at all for the paths we hoped nothing would take. Those
second paths are exactly where a networking bug lives, because a networking bug does not crash the
game — it quietly makes two phones play slightly different games and the player just sees a monster
in the wrong place.

What got written: three new test files, about 2,400 lines, 614 separate checks.

1. **The message format.** Every message the game sends is now packed and unpacked and compared byte
   for byte, including all four lobby messages, which nothing tested before. A message cut off at
   every possible length has to report itself as damaged instead of returning a plausible-looking
   zero. A message that lies about how long its text is has to refuse rather than read the next
   message's bytes. A name at the full 24 characters and a chat line at the full 160 arrive whole.
   Accented and Japanese characters survive, and when a line has to be shortened it stops on a whole
   character rather than cutting one in half. An event from a future build gets stepped over using
   the length it declares, so an old phone in a staged rollout degrades politely instead of falling
   out of the game. And the confirmed-input stream is read correctly out of a queue that has already
   wrapped round more than twice, which is the normal state of it thirty seconds into a run.

2. **The five small rule files.** The correction schedule was run for a simulated minute with two
   thousand enemies and every single one of them got corrected at least once, with the worst wait
   staying inside the stated bound — that was a real bug once and it is now watched. The thumbstick
   was checked at all 360 degrees rather than the eight compass points, so a diagonal cannot end up
   faster than a straight line. The cheat-envelope monitor trips on each of its six limits, ignores
   a two-second spike, and sits completely quiet through a hard thirty-minute run — a false alarm
   there costs a real player their session, so it has to be quiet. The agreement number is
   order-sensitive and stable across the two odd float values that legitimately differ between
   phones. The clock ignores a single 500-millisecond spike, closes a gap smoothly rather than
   teleporting, and never asks the game to run backwards.

3. **The fake network the co-op tests all run on.** This one matters more than it sounds. Every co-op
   guarantee we claim is proved by running four simulated players over that fake network, so if the
   fake network quietly lies, every one of those results is worthless at the same moment. It now has
   to prove that the same seed produces the same lost packets in the same order every run, that
   packets really do arrive out of order when we ask for jitter, that a lost packet costs nothing,
   that unplugging one player leaves the other three working in both directions, and that every
   packet is copied on the way in so a sender reusing its buffer cannot rewrite something already in
   flight. It also has to prove that the "did anybody disagree?" check is capable of answering yes —
   a check that can only ever answer no is worse than no check.

Then seventeen deliberate breaks, one at a time, to prove the tests can actually fail: sixteen were
caught. The seventeenth was not a hole — it is a guard against a zero-tick delay that cannot be
observed from outside, because the wire always advances a tick before it delivers anything. Every
wire size and every simulation number is now also pinned to its exact value in a list of its own, so
changing one by accident fails loudly instead of quietly making this build unable to talk to the last
one.

One honest limitation found and written down rather than hidden: treasure chests are counted once a
minute, while the rule for leaving a cheating host wants three bad seconds in a row. So chest abuse
names itself in the report but never on its own ends the session. Not fixed today; recorded.

Where that leaves us: the whole networking folder now has 5,350 lines of tests against 5,882 lines of
code, comfortably past the rule. **Phase 2's build list is finished.** The one thing still open is
where the multiplayer server gets hosted — decided (Cloudflare), not built, and it waits until four
real phones need to reach each other, which cannot happen on this machine anyway.

## Cloudflare deploy screen (13 Aug) — not yet

Asked whether the Cloudflare "deploy from GitHub" and API-token screens were something to do now.
No. The project contains no Cloudflare instructions file yet, so Cloudflare would look at the repo,
find nothing it recognises, and either fail or serve an empty page. Nothing was created and nothing
was deployed. That screen becomes real at the four-real-phones co-op gate, after the switchboard is
rebuilt in Cloudflare's shape.

## Phase 2 closed on the build list (13 Aug)

Plan updated: the Phase 2 row and status line now read **closed on the build list** rather than in
progress, with relay hosting explicitly carried forward instead of blocking. Two stale bullets in
"Also outstanding" were wrong and are corrected: the networking test-ratio debt is paid, and the
relay does now have a chosen home. Re-verified before committing: types clean, lint clean, the whole
game test suite passes, the build passes.

## The guided run — engine built (13 Aug)

The first piece of Phase 3 is done, apart from its screens.

**What got built.** Four files. One holds every word the guide can say, as numbered lines rather than
sentences buried in code, so a translator can be handed a list later without anyone hunting through the
game for text. One is the list of lessons — nineteen of them, each with the words it says, which edge of
the screen it sits on, what it points at, how long it stays, and how urgent it is. One is the part that
watches the run and decides which lesson to show when. One is the rule about who gets offered the guide
and when it is on or off.

**The thing that had to be true.** A guided run must count. Proven, not assumed: the test plays the same
seed twice with the same inputs, once with the guide watching every tick and once without, and the two
worlds come out identical down to the last bit. So turning prompts on can never change a score, and a
guided run is legal on every leaderboard.

**The rules it follows.** One prompt on screen at a time. Explanations wait their turn; "you're about to
die" cuts an explanation short instead of queueing behind it. A lesson that has been waiting more than
three seconds is thrown away rather than shown at the wrong moment. Nothing repeats. Lessons about
teammates never appear in a solo run, and your own seat is never treated as a teammate. Everything the
guide points at is looked up fresh from the live screen, so a player who has moved or resized their HUD
still gets the ring around the thing that moved. One tap turns the whole thing off for the rest of the
run, instantly, with no confirmation.

**The offer.** Asked once, at the very first launch, and never again. Neither answer is permanent —
Settings has "How to play" forever. Those two facts (were you asked, are prompts on) are stored in space
the save file had already set aside, so old saves still load and the save format did not change.

**How hard it was checked.** 997 lines of test against 1,195 lines of code. 191 checks. Seventeen
deliberate sabotages — wrong timings, a collided storage bit, a lesson allowed to repeat, a blank line of
text, "no" secretly meaning "yes" — and all seventeen were caught. Typecheck, lint, the whole engine test
suite and the build all clean.

**Not done yet:** the two screens themselves (the first-launch offer and the "what things mean" page) and
the Settings entry, all three from the mocks already approved, with the four corrections recorded earlier
(XP bar inside the top stone block; the offer appears the instant the run starts; a flatter, darker gem
icon; the evolution icon is two sockets and a star, never crossed weapons).

## The guided run — screens built (13 Aug)

**What got built.** Three pieces. The first-launch offer ("FIRST TIME HERE?" with SHOW ME HOW and I'VE
GOT IT), the "How to play" page holding the arming switch and the seven-row reference list, and the seven
little icons that list needs.

**Corrections applied, not the pictures.** The offer now appears the instant a run starts rather than over
a run already twelve seconds old with enemies closing in. The gem is flat and dark instead of a bright cut
gemstone, because fifty bright gems on a dark floor turn the floor into glitter and hide the enemies. The
evolution icon is two item sockets and a star, never crossed weapons — no held weapon appears anywhere in
our art.

**One thing I got wrong and fixed.** My first version only showed the offer while the run clock was under
half a second. On a slow save read that window has already gone by, so the only offer the player ever gets
would have been silently swallowed. It now decides once, the moment the save is readable, and the shipped
run screen will simply not start a run before the save has loaded.

**Where the page lives.** Settings does not exist yet, so for now it is reachable from the dev launcher.
The shipped route is Settings > How to play, which is the address the offer's footnote already gives.

**Checked.** Types clean, lint clean, the whole engine suite passes, the build passes, and both screens
were loaded in a browser and photographed to confirm they actually draw.

**Still to do on the guided run:** painting the prompts inside a run. The part that decides what to say,
when, where it sits and what it points at is done and tested; the drawing needs the sprite atlas, so it
lands with the art in Phase 4.

## The event log — built (13 Aug)

Second Phase 3 item done, and the last thing still carried over from Phase 0.

**What it is, in plain English.** Instead of storing "this player has 300 gold" and changing that number,
the server stores the list of things that happened — 500 granted, 120 spent, 80 spent — and works the 300
out from the list every time it is asked. The list is only ever added to. There is no code anywhere that
edits a line of it and no code that deletes one, and that is on purpose: undoing something means adding a
line that says "that earlier line does not count", so the mistake and the fix are both permanently visible.

**Why it was worth building before there is anything to protect.** Every recovery story in the plan needs
it. An exploit that ran for six hours is undone by undoing six hours of lines. An automated ban wave that
hit ten thousand innocent players is lifted in one action — and if a few of those lines cannot be lifted,
the action lifts the rest and hands back a list of the exceptions, instead of refusing and leaving 9,998
people punished. "Who did this, when, from which version of the game" always has an answer. And a bad
admin action is itself a line, so it can be undone the same way.

**Tamper-evident, not tamper-proof.** Every line carries a fingerprint of the line before it, so editing
old history breaks the chain from that point on and a check reports exactly where. This is a tripwire, not
a lock — anyone who can rewrite lines can rewrite fingerprints. What it does guarantee is that nobody can
do it by accident, and nobody can do it to only part of the log and have it look fine.

**Some rules that took thought:**
- An undo has to be about the same account as the thing it undoes. Without that check, one mistyped account
  id in a bulk undo takes gold from a bystander and the log records it as legitimate.
- An undo cannot be undone. If the undo was wrong, the original is re-applied as a fresh line, and the log
  shows all three things in the order they happened.
- Not everything can be undone, and pretending otherwise is worse than saying no. "A run arrived" cannot be
  un-arrived; the answer to a bad run is a new line revoking it.
- Bulk undos work newest-first, so anything with a floor — a balance that cannot go below zero — unwinds
  through states that actually happened rather than states that never existed.
- The server's clock is treated as evidence, never as the order of events. A clock that steps backwards is
  counted as an oddity worth looking at and never as a broken chain, because clocks step backwards for real
  reasons and a log that refuses writes during a clock correction is a log that stops working.

**Numbers.** 975 lines of rules and storage, 736 lines of test, 207 checks. Nine deliberate breakages tried;
the first pass caught eight. The escapee was a genuine hole in the tests — two different lines could have
been made to produce the same fingerprint by shifting a separator between two fields — so a check for
exactly that was added and it is caught now.

**Live.** The table is created in the real database and the real reads were run against it. Real writes were
deliberately not tried: a test line in an append-only table can never be removed. The endpoints sit behind
an admin token compared in constant time, and a server with no token configured refuses every one of them
rather than serving the log to anyone who asks.

## An undo can now be undone (13 Aug)

You asked whether there is a way to make an undo undoable. There is, and it did not require breaking the
rule we already wrote down.

**The rule stays.** An undo still cannot be undone directly. That rule is not stubbornness — it is what
keeps the history readable. If undos could stack on undos, working out whether a player currently has their
coins would mean counting how deep the pile goes, and someone would eventually count wrong.

**What we did instead.** Putting something back is a new, ordinary action of the original kind. If an undo
took away 500 coins, the fix is a normal "gave 500 coins" line — one that carries a link saying "this is here
because the undo on line 412 was a mistake." The link does nothing mechanically. It is there so that six
months from now, the page explains itself instead of a support person guessing.

Because the redo is an ordinary line, it can be undone again. So back and forth is unlimited, and nobody ever
has to know how many undos deep an account is.

**The parts that stop mistakes.** A redo has to point at a real undo, not any line. It has to be the same
kind of thing that undo took away, and about the same player — checked against both the undo and the original.
One undo can be put back at most once, so two staff members clicking at the same moment cannot double-refund.
A line cannot be both an undo and a redo. And you can only redo something that was undoable to begin with,
or the first redo would be a door that only opens one way.

**Staff never type the amount.** The redo copies what it needs from the original line. The person only says
who they are, when, and why. That removes the whole category of "meant to give back 500, typed 5000."

**Reading it back.** There is now a walk that follows the links — not the clock, which can lie — and reads
out "did / undid / redid / undid / redid" in order, starting from any point in the chain. That is what the
admin page will show as one story instead of five unrelated lines.

**Proof.** 1,707 lines of code against 860 of test, which clears the 1:2 rule. Six deliberate breakages
tried, six caught. The new column is live in the real database.

## A check that was checking nothing (13 Aug)

While doing the above I found that the website side's type check was pointed at a settings file listing zero
files. It inspected nothing and passed instantly. I do not know how long it had been dead. I proved it dead by
putting an obvious error in a real file and watching it pass, fixed it to check both halves including the
server code, then proved it alive the same way — the build now fails on that error. The moment it started
working it found a real gap in the new tests, which is now fixed.

This is the second time a check has been caught passing because it could not fail. The rule holds: a check
that cannot fail is not a check.

## The dev menu is one screen now (13 Aug)

Until today the tools were loose pages — you reached the performance bench by knowing its address. That
is fine for two tools and useless for fifty-three, and it also meant the security check was done by
whoever remembered to do it.

Now there is one front door. It lists every tool, in ten tabs, with a search box.

**What it refuses to make up.** Not one number on that screen is typed in. The picture you approved said
"SEARCH ALL 41 PANELS"; there are 53 now, and the screen counts them when it draws. Same for the
read-only figure in the footer. A number written down once is a number that is wrong later.

**What a locked tab gives away.** On a public build, four tabs are locked. The tabs still show — the menu
is the same shape everywhere, so nothing about a build is revealed by its layout — but their contents are
never listed, counted, searchable, or reachable by pinning a favourite. That last bit matters: a search
box is the easiest way to enumerate something you were not meant to see, and the tool names are the
sensitive part. "Flag / ban / restore an account" describes our moderation surface to anyone reading it.

**Greyed-out means the gate said no.** A row's greyed state is not this screen's opinion, it is the
security gate's own answer, and so is the reason printed next to it. Any second calculation is a chance
to be more generous than the gate, and only one of the two would be right.

**Tools that will cost you a score say so before you tap.** Opening a tool taints the run on open, not on
use, so the warning has to arrive first. That label is also the gate's arithmetic rather than a rule
copied onto the screen — which turned out to matter, because during a chaos sandbox even a
look-only tool taints, and a copied rule would have said otherwise.

**Buttons that go nowhere.** 39 of the 53 tools are planned but not written. Tapping one says "page not
built yet" instead of doing nothing, because a dead button in your own tools costs an hour of debugging
the wrong thing. And the list of which pages exist now lives somewhere the tests can see it, so if a tool
is ever renamed, the build fails instead of the menu growing a button to nowhere.

**Two things I got wrong and fixed.**

First, the status line said "RUN TAINTED" permanently on our own builds. It was reading "do these runs
count for the public leaderboard", which is always no on an internal build. A warning that is always on
is a warning nobody reads, and the first genuinely spoiled run would have looked identical. It now says
one of four things: no run, clean run, tainted run, or dev ladder.

Second, the leak-hunting tool has existed since the very first performance test and was never in the
list — so the screen that is supposed to show every tool could not show it. Added.

**Proof.** 77 checks. Twelve deliberate breakages tried. Ten were caught on the first attempt; two
escaped, and both were real holes rather than false alarms:

- One test assumed a tool could be switched off while its tab stayed open. No tool currently uses that
  switch, so the case did not exist in real data and the test proved nothing. It now constructs the case
  deliberately, and asserts that it found exactly one greyed row so it can never quietly go hollow again.
- The other assumed a look-only tool might wrongly claim to cost you a score. No look-only tool has any
  cost attached, so breaking that rule changed nothing. Rather than patch the test, I changed the design
  so the screen asks the gate instead of working it out — now the mistake cannot be written.

After both fixes: twelve breakages, twelve caught. I also found the shared pattern our test files use to
report failure could silently pass if the host had no way to exit, and closed that.

---

## The break-glass page (2026-08-13)

**What it is.** A private web page — one player at a time — that shows everything ever done to them and a
fixed list of things you can do about it. It is the page you open at two in the morning when somebody has
been wrongly banned, or somebody has been cheating and needs stopping.

**The list of buttons is not written on the page.** The page asks the server what can be done, and the
server answers with the fifteen actions, the boxes each one needs filling in, whether it can be undone, and
the warning it carries. So adding a new action later shows up correctly with no work on the page, and an
old page open in a browser cannot invent an action the server has never heard of. The page sends the *name*
of a button — never a raw number — so it cannot express a line the record does not understand.

**There is no un-ban button, and that is on purpose.** Lifting a punishment means undoing the line that
made it. The ban stays on the record with whoever filed it, their reason and the date, greyed out and struck
through, with the lift written underneath in its own line with its own reason. A cheerful "un-ban" row would
let a ban quietly vanish from the story. A lift can itself be put back if the appeal turns out to be a lie.

**Everything needs a real reason.** Eight characters and at least two different characters, so leaning on
one key is refused. The box empties after each action, so the next thing you file cannot inherit the last
excuse. The server stamps the time and records that it was an operator, so neither can be faked from the
page.

**The numbers are worked out, not stored.** Gold, marks, strikes, muted, banned, flagged — all added up from
the player's own history the moment you look. If a stored total ever disagreed with that panel, the panel
would be the one telling the truth.

**The secret.** The page asks for the operator secret, keeps it in that one browser tab, and forgets it when
you lock the page or close the tab. It is deliberately not a cookie, because a cookie is something the
browser attaches to everything by itself — which would mean any page in the app could reach these endpoints.
Tested: a request from that same tab that does not deliberately carry the secret is still refused.

**One thing deliberately left out.** Switches to turn game features off. Those belong to a settings document
rather than to anything about a person, and settings are still handed out from the server's own environment.
A button that wrote "feature turned off" while the feature stayed on would be a record that lies. It lands
with the stored settings document.

**Proof.** 67 checks driving a real browser against a real server and a throwaway copy of the record: unlock
with the wrong secret and be turned away, look a player up, fail to file a mute six different ways, file it,
lift it, watch it grey out, put it back, file a note that cannot be undone, wipe a chat record clean, look up
a player who does not exist. Then six deliberate breakages — hiding a lifted line, removing the reason rule,
letting a blank form through, leaving the secret in long-term storage, serving the button list without the
door, and letting one player's history leak another's — each one caught. Screenshot in
`screens/admin-page-v1.png`.

---

## Gold + results payout screen — DONE (2026-08-13)

What changed, in plain English: a run that ends now pays you. Before this, the gold you collected during a
run was thrown away when the run ended.

Three new pieces of machinery and one new screen:

1. **The banking.** Takes a finished run and adds its gold, its time and its run count to your profile,
   and writes a receipt saying exactly what it did. Refuses anything impossible by name before touching
   anything, so your profile is either fully paid or completely untouched. Quit runs keep their gold.
   Best time only moves on a genuine improvement. The save format's gold ceiling is real and says so on
   screen if you ever hit it.
2. **The hand-off.** The one thing that stands between a run and the screen. It is what guarantees a run is
   paid exactly once — it remembers every run it has paid and refuses a repeat, and it refuses to
   overwrite a result you have not seen yet. It hands the screen a copy of the numbers, not a window onto
   the live game, because the game reuses the same object for the next run.
3. **The counting-up number.** Pure arithmetic, separate from the screen, so it can be tested. Opens on
   the balance you knew, lands on the balance you have, never overshoots, never goes backwards.
4. **The screen.** Built from the approved mock. Does no arithmetic at all — every figure is read off the
   receipt. The dev play screen now goes to it when a run ends.

Checked: 583 lines of rules, 943 lines of test, 276 checks, all passing. 27 deliberate breakages tried,
27 caught (three needed the tests tightened first — one was a real off-by-one). Lint, typecheck and build
all clean. Screenshot in `screens/results-screen-v1.png`.

Not in it yet, on purpose: the character portrait and the UNLOCKED row from the mock. Characters and
unlocks are later items on the list; an empty frame would be worse than the space.

Correction to an earlier note: the web admin page **is** built and committed (`eee6b7d`). What is still
outstanding there is pushing the database column and extending two test files.

---

## 2026-08-13 — art finished, payout hardened, shop finished

**All the art is done.** Ten more sheets generated in one batch and cut into sprites: 12 playable
characters, 18 more enemies, 8 bosses, 18 weapons, 18 hit-and-shot effects, 12 ground floors, 18 arcana
symbols, 18 achievement badges, 12 scenery objects, 15 more menu parts. With the earlier six sets that is
**238 sprites**, every one checked to sit on the locked colours, none blank. One sheet came back as five
columns instead of six and was cut as five rather than regenerated. Nothing in the art list is waiting on
anything now.

**The payout maths had a real bug and it is fixed.** Receipts are reused between runs. When a payout was
refused, the flags were reset but the *numbers* were not — so a refused payout still had the previous
run's gold sitting on it, and the results screen reads its figures straight off that receipt. A player
could have been shown a total that was never banked. Now every figure is wiped on refusal, and there is a
check that proves it by banking a good run, then refusing a bad one on the same receipt and requiring
every single field to be back to zero.

Two other gaps in the payout checks were closed while proving the tests can fail: nothing tested the
cheat-flag field, and nothing tested that a refusal cleared the numbers. Nine deliberate breaks were made
to the payout code; nine were caught. One break was a no-op — it removed a wipe that happens anyway a few
lines earlier — so it is not a hole.

**The shop is finished.** 31 upgrades. Prices climb with each rank. Locked rows say what has to happen.
A purchase is all or nothing — every refusal is proved to leave both the gold and the ranks exactly as
they were. A refund returns every coin, proved by buying a long spread and requiring the balance back to
the penny. A rank the game cannot explain is refused rather than clamped into something plausible.

**How purchases reach a run, and why it matters.** The shop stores ranks; the simulation reads stats. The
bridge between them was untested, so it now has its own check. It does not go straight into the stats: it
goes through the same mechanism modes, stages and ascension tiers already use, because that mechanism is
what gets written into a replay and into a co-op join message. If the shop wrote straight into the stats,
then a snapshot restore, a guest joining your game, and our server checking a replay would all silently
drop your purchases — and it would have surfaced months later as "co-op runs feel weaker".

The bridge check proves: every upgrade's id names exactly one set of numbers and can't be confused with a
mode's; folding five ranks into one record gives exactly the same result as five separate records, checked
at every rank of every upgrade; a fully bought shop still fits in the run's record budget with eight slots
spare; and starting a run reuses one array rather than allocating. Seven deliberate breaks, seven caught —
two of them only visible when broken together, because they back each other up.

Lint, typecheck and build all clean. All four self-checks pass.

**Next:** character select (8 characters with their own stats, starting weapon and growth quirk), then
unlocks and making progress persist and sync, then destructible props and floor pickups, then chests and
the evolution roll, then the first anti-cheat pass.

## 2026-08-13 — character select

Eight characters exist now, and picking one actually changes the run.

Each one has its own starting weapon (out of the six weapons that exist), its own set of stat changes, and
one thing that gets stronger the longer the run goes on:

- Vesna Thorne — the plain starter. More damage, faster weapons, no downside.
- Odrick Pale — throws one extra of everything, hits softer for it.
- Maren Vole — huge effects, slow legs.
- Grust Kalder — more health and real armour, slower. Unlocks after one finished run.
- Ysolde Quill — levels much faster, dies to a second hit. Unlocks at 2,000 gold earned.
- Bram Ossuary — everything he leaves on the floor lasts longer. Unlocks at 8,000 gold earned.
- Nyx Carrow — fast and hoovers up pickups, made of paper. Unlocks at a ten-minute run.
- Sable Grynn — rarely hits, ruinous when it does. Unlocks at a fifteen-minute run.

Things worth knowing about how it was built, in plain terms:

1. A character does not carry its own copy of the stats — it carries *changes* to the shared baseline. So
   when a balance pass changes the baseline later, all eight move with it. The alternative would have left
   seven characters quietly on the old numbers, and nothing would have looked broken.

2. The growth quirk is not stored anywhere. It is worked out from "who you picked" and "what level you are",
   both of which the game already knows after a resume or a co-op reconnect. That is why it comes back by
   itself instead of quietly disappearing the first time somebody's connection drops.

3. Taking a level-up card rebuilds the whole list of bonuses you are carrying from scratch. That is exactly
   the moment a character's growth bonus would get thrown away, so it is put back in one place that owns the
   list, and a test drives a real run through 130 card picks and then checks the number is still exactly
   right — not roughly right, exactly right.

4. The character travels with the run the same way modes and shop purchases do, so a replay our server
   checks, and a friend joining your run, both see the same character you picked. If it had been bolted
   straight onto the stats instead, all three of those would have silently dropped it.

5. Locked characters stay on screen with the reason they are locked, and if a save somehow asks to play
   somebody it does not own, the game falls back to somebody it does rather than refusing to start.

Checking: 143 checks on the roster, a full check on the records built from it, and a third set that drives a
real run. Then the code was deliberately broken 25 different ways — 15 breaks in the roster and the records,
10 in the run itself — and every single one was caught by the tests. All the older tests still pass, and
lint, typecheck and build are all clean.

Screenshot of the screen: `screens/character-select-v1.png`.

Next: unlocks that persist, save migrations, and account-backed sync.

---

## Item 7 — unlocks that stick, and syncing between two phones (2026-08-14)

### What a player will notice

Finish a run that earns you a new character and the results screen now tells you so, right there, with the
reason underneath it ("Finished a run", "Earned 2,000 gold in total"). It tells you once. The next run does
not mention it again.

There is a BACK UP PROFILE button on the launcher. Press it and your profile is copied off the phone. Press
it on a second phone with the same backup name and the two profiles are combined.

### The rules I picked, and why

**An unlock is a promise, not a calculation.** Once you have a character, the game writes it down, and from
then on the written note beats the condition that earned it. If I rebalance an unlock later, or make it
harder, nobody loses anybody. There is no code path anywhere that clears an unlock.

**The three starting characters get written in the moment a profile is loaded.** Not when the character
screen opens — the loader. That means a profile arriving from anywhere at all, including an old version of
the game that did not keep character marks, opens with people you can play instead of an empty roster. It
also means starters are never announced as news, which would be insulting.

**Sixteen unlocks fit on the results screen, and the rest are counted, not dropped.** If a single run somehow
earns seventeen things, the seventeenth is still yours; the screen just says "and 1 more".

**Combining two profiles never picks a winner.** Three kinds of number, one rule each:
- Unlocks and achievements: added together. Anything either phone had, the result has.
- Records and totals (lifetime gold, runs, time survived, best time, upgrade ranks): whichever is higher.
- Your gold balance: rebuilt as lifetime earnings minus what the shop is holding. Not copied from either
  side. Copying it would let two phones mint gold; taking the lower would steal it.

That last one has a consequence I decided to say out loud rather than hide: **if your other phone spent more
in the shop, your visible balance can go down after a sync.** Nothing is lost — the upgrades it bought came
across too — but a number going down on its own looks like theft, so the backup screen says exactly that in
plain words when it happens.

**Settings are copied whole from whichever phone saved last.** Never mixed field by field, because a
half-and-half settings screen is a bug nobody can reproduce.

**The merged profile is saved to the phone before it is sent anywhere.** If the upload then fails you have
lost a retry, not your evening. The other order loses the merge every time the write fails, and I tested it
by breaking it: putting the send first makes a test fail immediately.

**A backup written by a newer version of the game is left strictly alone** and you are told to update. A merge
that quietly drops fields it does not recognise is how an update eats a profile.

**If another phone saves at the exact same moment, its copy is merged in and sent once more.** Exactly once.
A phone that keeps losing that race stops and waits for the next sync rather than spending your battery
arguing.

**The server never opens a save.** It stores the bytes and enforces one rule: a newer copy wins, and an equal
one is refused. All the combining happens on the phone. Two implementations of a rule that decides whether
somebody keeps their progress is two chances to disagree, and the day they disagree is the day saves start
getting halved.

**Until real sign-in exists, the backup is guarded by a padlock, not an identity.** The phone invents a
backup name and a secret on first use and keeps both. A stranger who guesses the name gets exactly the same
answer as somebody asking for a name that does not exist, so the door cannot be used to find out which
backups exist. Write the backup name down — it is currently the only way to reach a backup from a new phone.

### Proof, not intention

- 314 checks across the three new self-checks (unlock awards, merging, the sync order), all passing.
- 49 more driven through the real server against the real database, including a stranger being refused, a
  stale save being told what it missed, and thirteen kinds of malformed request.
- 47 deliberate breakages of my own code, each one confirmed to make a test fail and then put back exactly.
  The ones worth naming: sending before saving, merging over a newer save, an unlock being cleared instead of
  set, gold being allowed to go negative, a report keeping last sync's figures, and a device secret short
  enough to guess. That last one found a genuine hole in my own tests, which I then filled.
- Lint, typecheck and build all clean. The app bundles with the new screen in it.

### Still to do here

Nothing automatic yet — syncing happens when you press the button. Automatic background syncing waits until
players have reason to trust it. The character portraits on the results screen are placeholder marks until
the sprite atlas is packed.

Next: destructible props and pickups (floor chicken, bomb, magnet, coins).


## 2026-08-14 — Destructible scenery (Phase 3, item 8 of the eight)

**Done and pushed.**

The floor is no longer just a picture. Crates, urns, gravestones, braziers and the rare sarcophagus now stand
on it, break when a weapon touches them, and pay out coins, gems, roast chickens, bombs, freezes, magnets and
chests.

Plain English on the decisions that matter:

- **Nothing about the floor is saved.** Where each crate is, and what it is, is worked out from the stage's
  number the instant the player walks near it. That means a stage can be endless and cost nothing to
  remember, and four phones in a co-op run agree about every crate without sending anything to each other.
- **What has been smashed is the one thing that has to be remembered**, and only the last 256 of them are.
  When something older than that falls off the end, the game counts it out loud instead of hiding it. Walk a
  long way away and back and a crate may be standing again — a deliberate trade, written down.
- **Scenery arrives at one distance and leaves at a further one.** With one distance, pacing back and forth
  would make crates flicker in and out on every step. Tested by pacing a hundred crossings.
- **Loot can never be lost.** If the "just broke" list is full, the prop survives on its last hit and breaks
  a moment later. It never breaks with nowhere to record what it owed. This project already lost a row like
  that once on the results screen.
- **Props are worth hits, not damage**, so a maxed weapon does not trivialise them and a first-timer is not
  locked out. Each prop is briefly immune after a hit, so a weapon resting on one cannot shred it in a frame.
- **Weapons reach further against scenery than against enemies**, because most weapons swing at a fixed
  distance out from the player — otherwise a chicken could sit under the player's feet, unreachable.
- **Props never block movement and never hurt anybody.** What they drop lands on the floor to be picked up,
  never as an effect that goes off where the prop stood.
- **Breakable scenery is a separate layer from the decorations already on the floor.** The decorations stay
  decorations forever, so an art pass can never turn into a balance change.

Proof: 108 checks — 91 on the scenery module, 17 more in the run loop — and 16 deliberate sabotages of the code, every
one caught by the tests. Everything else in the game still passes, and lint, typecheck and build are clean.

**Not done yet:** prop art. Nothing on the floor is painted — that waits for the atlas pass with the other
238 sprites.

Next: treasure chests and the evolution roll.

## 2026-08-14 — Treasure chests and weapon evolution (Phase 3, item 9 of the eight)

Done and pushed.

**What a chest is now.** A chest is worth one, three or five things. Luck pushes the odds away from the
one-item chest, two thirds of what it takes going to the three and one third to the five. The odds are
whole numbers out of 1024, not percentages — a percentage rolled on two different phones is how a co-op
run quietly stops agreeing about what was in a chest.

**Every reward lands on something already being carried.** A chest never hands over a new weapon and
never fills a free slot. The player chose the six things they carry; a chest that overwrites that choice,
or takes the slot they were saving for something, is a chest that ruined a run.

**A chest is never empty.** With nothing left to improve it pays sixty coins for each reward it could not
give, one line each. No reward is ever silently skipped, and the screen always has something honest to
show. Those coins reach the run's purse — checked, not assumed.

**Evolution.** Take a weapon to its top level, carry the item that weapon asks for, and the next chest
turns it into its finished form. It replaces the base weapon in the same slot, arrives fully levelled,
costs no second slot, and does not consume the item. When an evolution is owed it is the **whole chest**,
nothing else — burying it among four other lines makes the biggest moment in a build unreadable. One per
chest, earliest slot first, so a player with two ready weapons controls the order by where they put them.
Evolutions never appear on a card, not even with the dev menu's unlock switch on, and an evolved weapon
cannot evolve again.

**Co-op.** A chest is not shared. It opens for whoever walked into it, and the run reports whose build
changed, so four players do not read one banner and three of them be wrong.

**Replays.** Chests roll from their own stream of numbers. Retuning what enemies drop can never change
what a chest in a saved replay contained — proved by burning five hundred drop rolls before a run and
confirming five chests came out identically.

**How hard it was tested.** Sixteen things that could go wrong were deliberately broken to confirm the
tests notice: eight in the chest rules and eight in the run loop. Three slipped through at first and were
real gaps in the tests, not in the game — luck being allowed to push the odds until the table collapses
onto a single size, a reward landing on something already at its ceiling, and items the player is not
carrying being counted as things a chest could improve. All sixteen are caught now. Everything else in the
game still passes, and the whole project builds clean.

**Next:** anti-cheat v1 — the last of the eight items that are mine.

## Anti-cheat v1 — the server half (2026-08-14)

A finished run is now uploaded, judged and kept.

**What the phone sends.** The result it is claiming, plus the log of every button press the run was played
from. Both together, never one without the other.

**Why the log is kept and not just the verdict.** A verdict is an opinion produced by a rulebook that is
still being written. The log is evidence, and it is the only thing that can ever *prove* a result: played
back move for move on the build it was played on, it either lands on the same ending or it does not. Keeping
the bytes means a rule we get wrong today can be re-run against the same run tomorrow, instead of that run
having been thrown away and only the mistake kept. It is also the only thing that makes an appeal
answerable.

**Fourteen reasons an upload is refused.** It is not one of our logs. It is a version this server does not
read. It is cut short. It has no length at all. It claims more time than it contains. It claims a different
run than the one attached. It never ended. And so on.

**Refusals are stored, with their reason.** A hundred refused uploads from one account in a minute is the
signal, and a server that throws them away keeps no signal at all.

**Thirteen more things are flagged, not refused.** Killing faster than the game can spawn. Earning coins
faster than the floor pays them. Gaining experience faster than the crowd drops it. Reaching a level the
clock cannot pay for. Coins without kills. Taking more upgrades than were offered. Never once being touched
in ten minutes. Never once moving. A clock set far into the future. Dev-menu marks on the run. A damage
breakdown that does not add up.

**A flag is not a punishment.** Nothing in this whole path changes an account. The only thing that can do
that is a person pressing a button on the operator page, and that lands in the append-only record with their
name, their reason and the date against it.

**Two lines per submission, always.** One for the bytes arriving, one for the verdict on them. Kept separate
on purpose: "these bytes turned up under this account at this moment" is true forever, while "this rulebook
accepted them" is only true of a rulebook that will be rewritten. Written as one line they could never be
separated again.

**What the phone is told back.** Whether the run was kept, why not if not, and how many things a person may
look at. Never *which* flags fired. A game that can read its own flags is a game that can be tuned against
them, and an honest player gains nothing from the list.

**Only the right phone can file a run.** The upload has to carry the profile's own secret, the same one the
cloud locker uses. An unknown account and a wrong secret get the identical answer, so the endpoint cannot be
used to find out which accounts exist.

**What an operator can open.** The newest runs, only the refused, only the flagged, one account's entire
history with accepted/refused/flagged counted separately, and the stored log itself for a future replay job.
All of it behind the admin token, and all of it refusing everything when that token is not set.

**Deliberately not built yet:** actually re-playing a log on the server. The logs are being kept from launch
precisely so that can be added later and run against every run ever filed.

**Proof it is tested and not just written.** Ten things that could go wrong were broken on purpose to check
the tests notice. Two slipped through at first — the arrival line quietly not being written, and one
account's history being able to show another account's runs — and both are caught now.

**Still mine in Phase 3:** the operator screen in the browser for these new run views.

## Anti-cheat v1 — the operator's window onto the runs (2026-08-14)

The server half was already done: runs arrive with the recording they were played from, get judged, and the
recording is kept either way. This is the part a person actually looks at.

On the page, behind the same operator secret as everything else:

- **What came in, newest first.** Each upload shows whether it was kept or turned away, how long the run
  lasted, which stage, how many players, how big the recording is, the seed, the build, and the one-line
  summary the server wrote at the time.
- **Two switches.** "Only the ones turned away" and "only the ones worth a look". They narrow the list and
  do nothing else.
- **The player's id on every row is a link.** Pressing it looks that player up above, so their standing,
  their whole record, and their upload history all appear together.
- **One player's uploads**, with a plain count of how many were kept, how many were turned away, and how
  many were worth a look.
- **Fetch the recording** — one button per row. It brings back the stored bytes, what the device claimed
  happened, and what the server decided at the time. It is a separate press on purpose: the recordings are
  the biggest thing kept about a run and nothing should be dragging them around while somebody scrolls.

What is deliberately not there: no "dealt with" tick, no "clear this flag" button, nothing anywhere that
marks a run as fine. A run being looked at is not a fact about the run, and a list anybody could quietly
tidy would be the first thing leaned on. If a run deserves a consequence, it is filed from the buttons above
the list, where it lands in the record with a name, a reason and a date on it.

Checked by driving a real browser at the real page against the 128 uploads already stored — 26 things read
off the screen, including that a tab holding no secret sees nothing and a tab holding the wrong secret is
refused in the same plain way, so the page cannot be used to work out what a real secret looks like. Twelve
things that could go wrong were then broken on purpose to prove those checks would notice: every run counted
as kept, the switches doing nothing, the recording fetched for the wrong run, a flagged run left untagged,
lengths rounded the wrong way, a turned-away run told off for missing the leaderboards. All twelve caught.

**Every Phase 3 item that was mine is now finished.** What remains in Phase 3 needs you: approving the
out-of-run menus (including the real Settings screen), and getting both test tracks handing the game to real
testers — Google's closed test wants twelve real people opted in for fourteen days in a row, so about
eighteen to twenty need recruiting.

## The art is now one sheet, and it's on the screens — 2026-08-14

**What was wrong.** All 238 pictures were sitting in the project as 238 separate files, and the game had no
way to use them. Menus were drawing the first letter of a name in a box where a picture belonged.

**What I did.**

1. **Packed everything into one sheet.** One picture file holding all 238, plus a written list of where each
   one sits on it. It has to be one file: every time the phone has to swap to a different picture file
   mid-draw it stalls, so two files would mean the game's speed depended on the art rather than on the game.

2. **The packer refuses rather than guesses.** Every finished picture must be exactly 32 by 32. One that
   isn't stops the whole thing dead and leaves the previous good sheet untouched — the alternative is a
   silently squashed picture nobody spots for a month. It also never repaints, recolours or renames
   anything; pictures land byte for byte. And packing twice gives an identical sheet, so re-running it
   never shows up as a change that isn't one.

3. **A one-dot gap around every picture.** Without it, a spinning sprite on a fussy phone reads one column
   past its own edge, and the bug looks like a bright thread down the side of everything.

4. **Which picture goes with which thing is written down, never counted.** "The third upgrade uses the third
   picture" breaks the moment anything is inserted or redrawn, and no test can catch it. Three upgrades
   deliberately share a picture with a near-twin (might/knockback, armour/dodge frames, rerolls/crit) and
   that sharing is declared — so an accidental share fails a check.

5. **Real art on three screens.** Shop rows, character select and the end-of-run unlock lines. Locked
   characters still keep their faces hidden — showing the portrait behind a padlock gives away the reward.
   Locked shop rows are faded, not hidden, because a locked row is still information.

**Two things this caught that "it compiles" would not have.**

- The first screenshot showed four locked shop rows all wearing the same padlock and none of their own
  pictures. The badge was being drawn exactly as big as the art it was supposed to be marking. Fixed, and
  the rule that a badge is always smaller than its picture is now a check that fails if anyone breaks it.
- A test was passing against a leftover compiled copy of an older version of the packer, and reported a
  sheet size that is physically impossible. The compiled-copy shortcut is now switched off for that test.

**How I know it works.** The packer has 62 checks, and I broke it twelve different ways on purpose — every
break was caught. The picture-to-thing table has 31 checks. The sizing arithmetic has 118 lines of checks
and was broken eight ways, all caught. Then I loaded the shop and character screens in a real browser and
looked at the pixels: a bone fist on Might, a heart on Max Health, a winged boot on Move Speed, Vesna's
hood, Odrick's skull.

**Still to do on art:** the game itself still draws test squares — the sheet is packed but not yet handed to
the renderer. Props, the six evolved weapons and the in-run guide prompts are unpainted.

### The game draws the real art now — same day

The sheet was packed but the game was still drawing coloured shapes. That's fixed.

- **The sheet is loaded once**, when the drawing surface opens, and stays for the life of it. Loading a
  picture file is the one job that is completely different on a phone and in a browser, so that part sits
  outside the game's own code, and the game is handed a finished sheet.
- **If it fails, it fails loudly.** No falling back to placeholder squares. A build with missing art that
  looks like a build with placeholder art is a build that ships.
- **A second guard, at load:** the sheet and the written list of positions are two separate files, and
  nothing stops one of them being replaced on its own. If they disagree the game refuses and says how — all
  the disagreements at once, because a stale file makes dozens of pictures wrong and seeing them together
  reads as "wrong file" instead of "one bad picture".
- **A second written table** says which picture stands for which thing in a run: each character's body,
  each enemy, each weapon's shot including all six evolved ones, every kind of thing that can lie on the
  floor, and the floors and scenery for three stages. Checked both ways — nothing in the game without a
  picture, and nothing in the table for something the game no longer has.
- **One check exists purely for feel:** no weapon and its own evolution may throw the same picture. That
  would make the evolution moment land flat, and it is the one duplicate that would be invisible in play.
- **Sprites are drawn bigger than their real size.** A sprite drawn the exact size of the space it occupies
  for hitting things looks like an ant next to the floor; growing the hitbox to match a comfortable sprite
  makes the game feel unfair. So the picture is allowed to be bigger, and the part of the game that decides
  what touched what cannot see those drawing numbers at all.
- **One generated cell.** Every health bar and fade is a plain rectangle, and the only thing the renderer
  knows how to draw is a piece of the sheet — so there is now a single cell of solid white on it. It is the
  only cell in the whole art folder that isn't drawn by hand, and there is a note next to it saying so.

**Checked, not assumed.** I loaded the running game in a real browser, dismissed the first-run offer like a
player would, and looked at the pixels: skeletons and zombies walking around, the character lit up while
they had their moment of invulnerability, gems on the floor, gravestones and slabs standing on tiled stone.
First attempt had two problems, both visible only in the picture: the floor was so busy with bones and moss
that it fought the enemies for attention, and everything on it was drawn far too small. Both fixed and
re-checked.

**Twelve more deliberate breakages** across the two new tables — a character with no body, two enemies
wearing the same picture, an evolution throwing its old shot, a stage laying the same tile twice, the sheet
guard blinded five different ways. All twelve caught.

### The last three upgrades got their own icon — same day

Twenty-six upgrades were drawn against twenty-four pictures, so three of them were wearing a relative's:
shoving borrowed the fist, the moment-after-being-hit borrowed the shield, and a lucky blow borrowed the
dice. All three are now drawn: a gauntlet fist throwing force rings, a figure trailing its own ghosted
afterimages, and a dice struck by a red spark.

- **The list of deliberate sharing is kept, and is now empty.** Deleting it would have been tidier and
  wrong: an empty list is what turns an accidental repeat — two upgrades pointed at the same picture in a
  hurry — into a failed check instead of a shop row nobody looks at twice.
- **The new sheet came back on black, and black is also the outline colour**, so it could not simply be
  keyed out by colour without eating every outline. The background is found by spreading inwards from the
  edges of the sheet instead: only black that is connected to the border is background, and black inside a
  silhouette stays. It refuses if the amount it found doesn't look like a background at all, because the
  failure it prevents is three icons that come out as solid squares.
- **Checked by comparing the sheet to the drawn files rather than by looking at it.** Each of the three new
  cells was cut back out of the packed sheet and compared to the file it was drawn in, pixel for pixel:
  identical, so nothing was resized or recoloured on the way in.
- **Three deliberate breakages**: an undeclared share sneaking back in, a picture name that isn't on the
  sheet, and an upgrade losing its entry. All three caught.

Every drawn thing the game asks for now exists. The sheet holds 241 hand-drawn pictures plus the one
generated cell of solid white the health bars are drawn from.

### The tools that turned that sheet into icons are now in the project, with their own checks

The three new icons were cut by two throwaway scripts. Throwaway is how a pipeline stops being
reproducible, so both are now part of the project and both are checked.

- **The black-background remover.** It finds the background by spreading inwards from the edges of the
  sheet, not by looking for black, because the outline colour is also nearly black and a colour test eats
  every outline. It spreads only up, down, left and right: two dark areas that touch at a single corner are
  separate, and letting it cut that corner would let the background leak inside a closed shape. It refuses
  outright if what it found doesn't look like a background, because the alternative is three icons that come
  out as solid squares and look fine in a folder listing.
- **The limitation is written down as a check, not a comment.** A drawing that is dark all the way out to
  the black around it cannot be told from the background by anything; that rim is lost. The sheets are drawn
  as bright shapes on black, so this costs nothing today, and if it ever stops being true the check says so.
- **"This whole sheet is one picture."** The cutter finds the grid by counting runs of drawn pixels, so a
  single drawing made of separate pieces — three ghosted figures, a fist with loose rings around it — reads
  as three cells and gets refused. It now takes an instruction that says the sheet is one picture and skips
  the counting, rather than making the counting vaguer, because a vaguer counter starts gluing real cells
  together.
- **Proved reproducible**: re-running the whole path from the original painted sheet produces the three
  icons byte for byte identical to the ones in the game.
- **Eleven more deliberate breakages** across the two tools — mid-grey treated as background, the flood
  allowed through corners, the refusal removed, the original repainted in place, only two of the four edges
  looked at, a refused sheet still writing a file, the one-picture instruction cropping to the first shape,
  accepting an empty sheet, and the grid check disabled. Two of them survived the first attempt and both
  checks were strengthened until they didn't: one only looked at rows, and one measured how wide the drawing
  was when it should have counted how many pieces it had.

## Phase 4 has started: all twenty passive items are in

Passives are the items you pick up that don't shoot anything — they just make you better. There were six.
Now there are twenty, which is all of them for launch.

The fourteen new ones: wider reach, faster projectiles, effects that last longer, an extra projectile,
more gold, faster learning, better luck, shots that punch through more enemies, harder shoving, a second
life, critical hits, harder critical hits, a longer moment of being untouchable after a hit, and more
health.

Each one has five levels, so that's a hundred separate upgrade steps. Two rules held throughout:

- **No level is ever a dud.** Every single one of the hundred gives something. Where the natural step was
  too strong to hand out five times — an extra projectile, a second life — the levels in between pay
  something else instead of standing still.
- **The card cannot lie.** The words you read and the effect you get come from the same line, so they
  can't drift apart.

They're all in now rather than half now and half later, because weapons need them: an evolved weapon asks
you to own a particular item, and it can't ask for one that doesn't exist yet.

### Finishing them found two real bugs, both now fixed

Neither had anything to do with passives. They were both hidden behind the fact that the old six-item
loadout was weak.

- **A timed run couldn't prove it was legitimate.** A run that ends because the clock ran out ends
  differently from a run that ends because you died, and the recording of it didn't mention the clock at
  all. So when the game replayed that recording to check it, the replay sailed past the ending and
  finished in a run that was still going — and the check refused an honest run. It had never come up
  because runs used to die before the clock ran out. The recording now carries its own clock, in a spare
  slot the format has always had, so nothing recorded before today was invalidated.
- **A co-op check had quietly stopped proving anything.** The test that four phones agree with each other
  for a solid minute stopped early once the party got strong enough to survive — no, the opposite: the
  party *died* at fifty-five seconds, the worlds stopped simulating, and "they agreed" became true for the
  boring reason. It now runs unkillable, so whether the party survives is a balance question and can't
  quietly switch the test off.

### And the passives got their own set of checks

They didn't have any of their own before — 394 lines of them now, against 535 lines of the passives
themselves. They check that no item shares a number or a picture with another, that no level is a dud,
that a "+1 armour" was never fat-fingered into "+1000 armour", that levels can't be pushed past five, and
that taking the same items in a different order lands on exactly the same numbers — which is what lets a
recording and a co-op guest agree.

Then eight deliberate breakages were made to the passives to be sure the checks would notice: a level
emptied out, an armour number inflated a thousandfold, two items given the same picture, two given the
same number, the loadout patched instead of rebuilt, only the top level counted, the five-level cap
loosened, and the item numbering squeezed. All eight were caught. Two more were made to the recording
format, and both were caught too.

## Fifteen weapons and fifteen evolutions are in

The weapon list went from six you could be offered to fifteen, and each of those fifteen now has its own
evolution waiting behind it — thirty entries in total, with two hundred and ten upgrade steps across them.

The nine new ones: a lobbed flask that breaks into a fire the horde has to walk through, a bell that
shoves everything off you, a wheel of bone that rolls out and comes back, a scythe that reaps in a wide
arc, a choir of shapes that circle you, a long-range shot that punches through a line, a cross that
returns to your hand, a lance that spears straight ahead, and a storm of nails that falls where you are
looking. Each has its own evolved form, and each of the fifteen evolutions asks for a *different* one of
the twenty items, so going after two of them at once is a real decision.

### One real bug, caught by a check rather than by playing

Two of the new circling weapons orbited so far out that they missed anything standing on top of you —
0 damage over four hundred ticks against a crowd pressed right against the player. The cause was the
stat that is *supposed* to make a circling weapon better: widening the blade also pushed the whole ring
outward, so the ring drifted past the crowd instead of grinding through it. Both rings were pulled in
close enough to always touch a body at arm's length, and there is now a check that measures every
circling weapon against a body standing on the player, in both directions — too far out, and too far in
where it would stop being a circling weapon at all.

### And the weapons got their own set of checks

360 lines of them, on top of the combat tests. They check the list is fifteen and fifteen with no
repeated name or number; that the numbers saved into recordings and co-op packets are an unbroken run
that still fits in a single byte, and that the twelve weapons that shipped first still hold the exact
numbers they shipped with; that every level-up says something *and* changes something, and that a card
promising "+6 damage" adds exactly six; that a weapon's numbers match its shape (nothing standing still
carries travel speed, an aura is big enough to be worth standing in); that its switches can't contradict
its numbers (a weapon that says it never shoves cannot carry a shove value); that nothing folds into
nonsense at full level; and that every evolution is strictly an upgrade on the thing it came from.

Then seven deliberate breakages were made to be sure the checks would notice: a shipped weapon's number
renumbered, a level-up emptied of its numbers, a circling weapon pushed back out of reach, a no-shove
weapon given a shove, an evolution made weaker than its base, two evolutions pointed at the same item,
and a standing-still weapon given travel speed. All seven were caught.

Everything else still passes — 56 test files, no failures — and the project builds clean.

## Twelve characters

Four more, on the end of the eight — never inserted between them, because a save records who you have
unlocked by position and reordering the list would relabel everybody's unlocks.

- **The Iron Vigil** — an armoured watchman. Starts with the cross. Wears the hit and throws the crowd
  back off it, and learns more slowly for it. The longer he lives, the longer the untouchable moment
  after being hit lasts.
- **The Gold Tooth** — a grave-robber. Starts with the long shot. Leaves every run richer and pulls
  pickups in from further away, and hits a little softer. Gets greedier as the run goes on.
- **The Second Breath** — gets back up once for free and carries more health, and hits noticeably
  softer for the privilege. Keeps gaining health as he levels.
- **The Fool's Hand** — can ask for a different hand of cards twice a run and is luckier when asking,
  paid for with smaller effects. Gets luckier still as the run goes on.

Ten different starting weapons across the twelve, so the roster opens in ten different ways rather than
being twelve coats of paint on four openings. Nobody starts holding an evolved weapon — that is the
reward for taking a weapon to the top and finding the right item, not something you begin with. And no
two characters unlock at the same number, so one of them can't arrive unnoticed behind the other.

### A number of mine was wrong, and a check caught it

The new watchman's growing perk was written as a percentage when the game counts that particular thing in
ticks of the clock instead — sixty to the second. It would have handed him most of a second of free
standing in a crowd every eight levels, which is not a perk, it's immunity. It reads as an ordinary typo
in a table of numbers and nothing would have looked broken. Every one of those counted numbers now has
its own ceiling in the checks, taken from what the number actually means in the game rather than from
how big it looks in the table, so the same mistake on any of the others fails immediately.

Then eight deliberate breakages: a character given an evolved weapon to start with, two unlocking at the
same moment, an unlock nothing could ever reach, one character duplicated shift for shift, an unlock
condition the game does not count, the roster narrowed to too few openings, armour written in the wrong
units, and the untouchable window written in the wrong units. All eight were caught.

### Art

One new painted sheet of four portraits, cut to size with the same tools and the same locked palette as
the first eight. The in-run bodies needed no new painting — the character sheet had four cells nobody had
claimed. The picture sheet the game loads is now 246 pictures on one 1024x512 texture, 28% full.

## Twenty-six enemies

Eighteen things that walk at you and eight named fights, up from five and one. Every one has its own
drawn picture, and no two wear the same picture — two different monsters that look identical in a crowd
of four hundred is not a monster, it's confusion.

Three new ways of moving, on top of the five that already existed (walks at you, swarms, walls you off,
charges through, holds its distance):

- **Stands still and waits.** Perfectly still — not a slow creep — until somebody comes within about a
  phone-width of it, then it chases. It punishes running blindly into ground you haven't looked at,
  which is exactly what a player does once their weapons are strong.
- **Slides side to side on the way in.** A straight-line weapon now has to be aimed rather than pointed
  at these. It still closes on you every sway, so it is a nuisance and not a stalemate.
- **Circles wide, then dives.** Holds a ring for three seconds while it winds up, comes around to a
  different side, and then commits in a straight line. The wind-up is the whole tell.

The eight named fights climb in both health and reward in the order the stages will hand them out, so no
later boss is a smaller fight than an earlier one.

### A detail that will matter later

The side-to-side one sways on a pattern counted straight off its own age in ticks, not with the usual
maths-library wave. Two phones running the same co-op session can disagree in the last decimal place of
that maths function, and over a thirty-minute run a whole crowd steered by it would slowly drift into two
different crowds. Plain arithmetic on a whole number cannot do that. There is a check that runs the same
enemy twice and demands the two paths match to six decimal places.

### The checks

416 lines of new ones. They cover the roster's shape, the fact that positions in the table are what
recordings and co-op packets actually carry (the six that shipped first are pinned by hand, so inserting
a row above them fails immediately), that nothing kills a starting character in a single touch, that
nothing is both unshovable and faster than you can run, that a tougher body is never worth less than a
weaker one, that no body is wider than the grid the crowd separates on, and that every named fight is
unshovable, uncullable and pays out. Then all three new movements are actually simulated and measured.

Twelve deliberate breakages: a row inserted above the originals, a touch made fatal from full health, the
standing-still one made to creep, the swaying one made to walk straight, the circling one made to skip its
wind-up, the same one made to never dive, a boss given crowd-sized health, a boss stripped of its
unshovable flag, a heavy body made faster than a player, a tough body made worth less than a weak one, a
movement left with only one user, and a body made wider than the grid. All twelve were caught.


## Opening a chest is now something you watch

Playing on the phone turned up four things wrong. Three were fixed last time round. This is the fourth,
and it was the least visible and the most annoying: you walked into a treasure chest and *nothing
happened*. A weapon quietly went up a level, or evolved, or you were paid some coins — all of it real,
all of it invisible unless you happened to be staring at the right corner of the screen at the right
moment. The single best moment in a run of this kind was being thrown away.

### What happens now

Two and a half seconds, and every part of it overlaps the next rather than waiting its turn — played
strictly one after another it reads as a slideshow.

1. A column of light comes up out of the chest.
2. Coins and gems spray out of the light and tumble down onto the floor.
3. Your gold counts up over the chest while a bright ribbon orbits it two and a half times.
4. The screen flashes white. An evolution gets a harder flash than a level, because it is the rarest
   thing a chest can do.
5. A four-armed star bursts out of the flash and fades as it grows.
6. A card slides up from the bottom of the screen listing what you got.

### The decisions that matter

**You are paid before the show starts.** The animation cannot change a level, a weapon or a coin — it is
decoration and it has no power to do anything else. A phone that dies halfway through the animation has
still been paid in full.

**The gold counter never lies.** It never shows more than you actually have on the way up, and its last
frame is the real total exactly. A counter that lands on 146 when the shop says 147 makes the player
think the game stole from them.

**The card cannot be tapped away until it has landed.** Otherwise the same thumb press that walked you
into the chest dismisses the card before you have read a word of it. It takes itself away a couple of
seconds after it arrives rather than sitting there, because the fight does not stop while it is up.

**Every coin flies where the run's own seed says it does**, never by chance. The same chest opens the
same way on every phone in a party, and the same way again in a replay.

**The whole sequence is worked out from one number: how long ago the chest opened.** Nothing counts down
frame by frame. That sounds like a detail and is not — an effect built out of counters ticking inside
the drawing loop cannot be tested, cannot be paused, and slips out of step the moment the phone drops a
frame. This one lands where it should have been rather than replaying the part it missed, and a test can
ask it what any moment of it looks like without a phone in the room.

### The checks

Two files, both of them able to be run with no phone and no graphics at all: one that decides what a
given moment looks like, and one that draws it into a recorder that remembers every rectangle it was
asked for and exactly where. 181 checks between them, all passing. They cover the things that actually
go wrong with an effect like this: something still on screen after it should have gone, something drawn
where the player cannot see it, a card sliding in from nowhere and landing off the edge, a flash that
misses a corner, a reward line running off the side of its own panel, a gold counter that overshoots.

Twenty-six deliberate breakages were introduced one at a time to prove the checks are worth having: the
light hung downward instead of rising, coins drawn from their corner instead of centred, the flash
covering half the screen, the card landing off the bottom, long reward text left uncut, the gold counter
ignoring its own switch, the ribbon nailed to the chest instead of orbiting, the star with no arms, every
coin thrown at the same angle, the whole spray turned into a spiral, the finished flag ignored so quads
leak out over the rest of the run. All twenty-six were caught.

Two of them were not caught the first time, and both were real gaps rather than bad breakages. The ribbon
could have been nailed to the middle and every check still passed, because nothing had ever looked at
where it actually was — an orbit that never leaves the middle is a blinking dot. And the painter's own
"is this still running" guard could be deleted with nothing noticing. Both now have checks of their own.

### One thing found while writing the checks

The cut-off point for a reward line was a number picked by eye — twenty-six characters. Measured against
the card it was drawn on, twenty-six characters is four characters of text hanging out over the fight.
It is now worked out from the width of the card instead of guessed at, so redrawing the card can never
put the text outside it again.

## Five places to play, instead of one

Until now every run happened on the same floor. There are now five, and they are properly different
places rather than the same place wearing a different colour.

- **Pauper's Crypt** — the opening floor. Open from the start, cluttered, ordinary dead.
- **The Ossuary** — bone halls, bare underfoot, faster and tighter than the crypt.
- **Mourner's Marsh** — choked with scenery, slower monsters that arrive in far greater numbers.
- **Gallows Row** — an open, empty floor with very little to hide behind and hard-hitting crowds.
- **The Hollow Belfry** — the last of the five and the meanest of them.

Each one is opened by surviving the one before it: fifteen minutes on the crypt opens the ossuary,
fifteen on the ossuary opens the marsh, twenty on the marsh opens the gallows, twenty on the gallows
opens the belfry. Nothing else unlocks them, and nothing can be bought to skip a step.

Every stage brings its own list of monsters, its own pacing — how fast they arrive and how many can be
on the floor at once — its own named fights, and its own amount of scenery to smash. Between them the
five stages use every one of the eighteen ordinary monsters and every one of the eight named fights, so
nothing that was drawn goes unseen. Fifty-seven waves and sixteen named fights in total.

Every run is still thirty minutes long, on purpose. If one floor were shorter, surviving twenty minutes
would mean something different depending on where you did it, and every leaderboard would be nonsense.

### A bug found on the way

Playing all five wave tables through without a screen turned up something that would have been very hard
to spot by hand. If a named fight came due while you were still fighting the last one, it was thrown away
— not delayed, not sent in later, just gone for the rest of the run. On a slow fight that quietly deleted
content from the stage.

Now an owed fight waits its turn and walks in on the first moment the floor is clear, oldest first. Only
one named fight is ever on the floor at once, because the health bar at the top of the screen belongs to
one of them. If three of them stack up the game stops queueing more, on the grounds that a wall of bosses
the moment you finally win one is worse than quietly dropping the oldest.

### How this was proved

The stage table is checked by the game itself, not just by me: ordering, pacing that never eases off, the
engine's crowd limit, named fights that are actually named fights, unlock rules that point backwards and
not forwards, and the coverage rule that every monster turns up somewhere. Ten deliberate breakages were
made to the checker one at a time to prove those checks earn their place. Nine were caught immediately.
The tenth was not: a named fight could be scheduled to arrive *after* the run was already over and nothing
would have said a word. That gap now has a check of its own, and all ten are caught.

## The game now remembers your best time in each place, not just your best time

Five places to play only means something if the game knows how far you got in *each* of them. Up to now
the profile kept one number: the longest you had ever survived, anywhere. That number cannot answer the
question the game has to ask before it opens Mourner's Marsh — "have they survived fifteen minutes in
The Ossuary?" — because a great run in the crypt would have answered yes.

So the profile now keeps a best time per place, with room for thirty-two of them (five are built; the
rest is headroom so a new place can be added later without touching anyone's save file).

What it does:

- Finishing a run sets that place's record if you beat it. Beating it means beating it — equalling your
  old time is not a new record, same as everywhere else in the game.
- A first run in a new place is that place's record even if it was short. That is the point: a two-minute
  first attempt in the marsh has to be written down, or the marsh could never open anything.
- One place's record never touches another's.
- Your overall best time still works exactly as it did. Nothing about it changed.

Saves and the cloud:

- Old save files still load. They simply have no per-place times yet, so they start empty and fill in as
  you play — which is honest, because an old save genuinely does not know where those runs happened.
  Your overall record is in the header and is untouched, so nobody loses their record in the upgrade.
- Two phones merge the same way everything else does: per place, the better time wins. If you got further
  in the crypt on your phone and further in the marsh on your tablet, after a sync both stand.
- A run left going overnight pins at the ceiling instead of wrapping round to nothing.
- If a refusal happens — a run that fails the honesty checks at the door — the place records are left
  exactly as they were, like everything else on the profile.

### How this was proved

Nine deliberate breakages were made to this code one at a time to prove the checks earn their place:
removing the overnight ceiling, letting an equalled time count as a record, removing the guard on a place
the save has no room for, no longer checking which place a run happened on, getting the save file's size
wrong, reading the new block out of an old save file that does not have one, dropping the per-place merge,
dropping the merge's own sanity check, and losing which place the run happened on between the end of the
run and the profile. Four of the nine got through the first time. Those four now have checks of their own,
and all nine are caught.

## Choosing where to go

Before this, pressing PLAY sent you straight to picking a character and then into the crypt, because the
crypt was the only place there was. Now there are five places, so there is a screen between the two.

What you see:

- Five cards, in order. Each one names the place, says in a line what it does to you, tells you how many
  named fights it holds, how long until the Reaper comes for you, and your best time there.
- A place you have never played says "Never played" rather than a time of nothing, because those are two
  different things.
- Each card carries a small picture of that place's own floor, tinted its own colour, so the list reads at
  a glance instead of being five identical grey slabs.
- A place you have not opened yet is dimmed and says exactly what opens it — "Survive 15 minutes in
  Pauper's Crypt" — rather than just refusing you. Named fights are shown as a count and never by name,
  so the screen does not spoil what is waiting in there.

What it does:

- Picking a place carries it through to the character screen and into the run, so the run knows where it
  is happening and the record it sets goes to the right place.
- Opening a new place is now announced on the results screen the same way a new character or weapon is,
  instead of quietly appearing in a menu. The crypt is never announced, because it was always open.
- Once a place is open it stays open. Even if a save file were somehow to lose the time that opened it,
  the place stays unlocked — nothing takes an opened place back off you.
- A locked place cannot be started by any route. The run screen checks again on the way in, so a stale
  link or a back button cannot drop you into somewhere you have not earned.

### How this was proved

Nine deliberate breakages, one at a time, all caught first try: making an opened place forget it was
opened, letting the opened mark stand in for actually earning it, reading the new save block off the end
of an old save file, ignoring a save file that is too short, letting a locked place start a run, showing a
never-played place as a time of zero, rounding a survival time up instead of down, skipping places
entirely when handing out unlocks, and announcing the first place as if you had just earned it.

## The eight arcanas

An arcana is the biggest single decision inside a run. A few minutes in, the run stops and offers three
of them; you keep one. Three offers over a full run, three kept, and they are all trades — every one
gives you something real and takes something real away. A card that was only "more damage" would be a
passive item wearing a bigger frame.

The eight:

- **Twin Toll** — the weapon you started with rings twice, and every weapon swings slower.
- **Grave Bloom** — you mend three times as fast, mending burns whatever is standing next to you, and
  your total health is lower.
- **Fool's Vigil** — at full health every hit is a critical, and your health is halved.
- **The Long Hour** — your weapons come round far faster, and so does everything hunting you.
- **Pauper's Purse** — coins are worth double and count as experience, but gems are worth far less.
- **Iron Litany** — heavy armour and a longer moment of mercy after a hit, and you move much slower.
- **Reaper's Bargain** — everything dies easily and everything comes at once, forever.
- **Shattered Reliquary** — large gems break like glass and hurt the room, cards only ever offer weapons,
  and you level more slowly.

How they are earned: the first is there from the start. Three more come from surviving 10, 20, 25 and 30
minutes anywhere, and three from surviving a set time in a specific place — which is what ties them to
the five places rather than to grinding one of them.

How they are built, and why it matters later: an arcana is a list of number changes plus at most one rule
change. Nothing in the game asks "is this Twin Toll" — it reads the numbers and one switch. That is the
same shape as a game mode, a character quirk and a shop purchase, which is why they all stack with each
other without anyone writing the combinations down.

Two things were deliberately handled rather than left to chance. An offer that comes due while you were
somewhere else is still owed to you, not skipped — the same bug a named fight had. And two arcanas taken
in the other order land on exactly the same numbers, because two phones in co-op that disagree by one
point of damage drift apart for the rest of the night.

Each of the eight has its own symbol from the drawn sheet, matched to what the card does rather than to
its place in the sheet. Eighteen symbols were drawn; the remaining ten are the arcanas that come after
launch.

### How this was proved

Fourteen deliberate breakages, one at a time, all caught: an offer that redeals itself every moment,
an offer that only opens if the exact second is hit, offering a card you already hold, letting rubbish
into the pool of cards you have earned, letting the same card into it twice, putting up an offer screen
with nothing on it, a card that does not close the screen when taken, a card whose rule never switches
on, holding more cards than there are slots, needing a second longer than the card asks for in a place,
needing a second longer than it asks for anywhere, arcanas leaking into the run's recording where modes
live, an offer that never shuffles, and a place-specific condition quietly satisfied by a long run
somewhere else.

## The arcana offer, in the game itself

The eight arcanas existed as rules last night but nothing in the game ever showed you one. Now the run
itself deals them.

What happens when you play: at four minutes, twelve minutes and twenty-two minutes the run stops and
three cards turn over. Each card shows its symbol, its name and one line saying what it does to you. You
take one, or you take none — either way that offer is spent and does not come back. The world is frozen
solid while the cards are up: nothing moves, nothing spawns, nothing hits you, and the clock does not
tick. Deciding while the crowd closes in is not deciding.

Which cards can appear is your profile's business, not the run's. The run is handed the list of arcanas
you have actually unlocked when it starts, and it can only deal from that list. A profile that has
unlocked nothing is simply never offered anything — it does not get handed a free card to fill the
screen. A card you already hold this run is never offered twice. You can hold three at most.

Two quieter things worth knowing. Taking a card does not patch your numbers — the whole loadout is torn
down and rebuilt from scratch with the arcana in it, so an arcana can never be silently lost the next
time you level up, and two phones in co-op cannot end up a point of damage apart. And the list of cards
you may be offered is read at the moment a run starts, not held from earlier, so an arcana unlocked on
your last run is available on this one.

### How this was proved

Eighteen deliberate breakages, one at a time, all caught: the run not counting an arcana screen as
paused, the world carrying on underneath one, an unattended run deadlocking on a screen nobody answers,
the offer never opening at all, only part of your unlocked list reaching the run, the loadout rebuild
dropping an arcana, taking a card without re-resolving the numbers, a pick reporting the wrong card,
"take none" not closing the screen, the run answering zero when asked what behaviour is switched on, a
stored unlock mark being overridden by a shorter time, a rule marking itself as met, the "anywhere"
record being guessed at from the per-place records, reading a place off the end of a shortened save,
locked cards leaking into the pool, a locked card's explanation appearing on an unlocked one, the
starter arcana being announced as newly earned, and the sweep skipping arcanas entirely.

Fifty-four checks in a new file covering the run's side of it, on top of the ones the arcanas already
had. One older check had to be corrected while doing this: it assumed everything announced at the end of
a run was a character, which stopped being true the moment a run could earn you an arcana.


## Fifty-one things to chase, and the rule that they are never taken back

Fifty-one achievements are in. They are one list, in a fixed order, and each one is a plain question about a
number: "kill a thousand things in one run", "earn fifty thousand gold in total", "last ten minutes
without being touched", "clear the marsh". About half are ladders you climb without trying — time, kills,
gold, levels. A quarter are "have you been everywhere and met everyone". The rest are things you have to
actually decide to do: finish a run unhurt, finish one with nobody going down, play a four-person run,
take the ending.

One of them is hidden. Until you earn it, it shows as "???" with no explanation, because the only thing it
would tell you is how the game ends. Everything else says exactly what it wants whether you have it or
not — an achievement you cannot read is not a goal, it is a surprise.

Two rules underneath all of them.

The first: an achievement is never taken back. Once the profile has written one down, nothing removes it
— not a rebalanced target, not a save synced down from a phone with less history, not the numbers being
wiped. Same promise the characters, places and cards already make.

The second is subtler and is where this sort of thing normally goes wrong. Some of these questions are
about your profile ("how much gold have you ever earned") and can be answered at any moment. Others are
about one single run ("did THAT run last twenty minutes") and can only be answered while the run that just
ended is still in hand. So when nothing has just ended — you are on a menu, catching an old profile up —
the run questions are skipped entirely rather than answered "no". A "no" gets written down and a skip does
not, and the alternative mistake is worse: handing you a badge for a run you never played because some
profile total happened to look similar.

Badges are handed out at the same moment as everything else, right after the run is banked, and appear on
the results screen next to any character, place or card the same run earned.

### How this was proved

Six hundred and four checks in a new file, plus nine more added to the run hand-off. Then thirty-two
deliberate breakages, one at a time, every one of them caught: each threshold moved by one in both
directions, the "clean run" badge ignoring the damage you took, the "nobody went down" badge ignoring the
clock, an ending badge accepting any ending, clearing a place counting even when you died there, the
badge for two maxed weapons counting weapons from the previous run's leftovers, a hidden badge showing its
name early, a list scrolled past its end reading somebody else's row, badges from a bigger build's save
counting toward this build's totals, a shortened save reading a place it does not hold, the sweep
answering run questions with no run in hand, the sweep ignoring the run it was given, and the sweep
reading the wrong list of what you already hold.

### The badge screen

There is now a BADGES button on the title screen. It lists every badge with its name, exactly what it
asks for, and whether you have it — earned ones in gold, locked ones dimmed — with a count at the top and
a filter for all, earned or locked. The hidden one shows as "???" until it is earned. Opening the screen
never changes your profile: badges are handed out in exactly one place, the moment a run is banked, so a
list that also handed them out would be a second place for the same decision to be made slightly
differently.

## Legs that move, and two weapons that were lying

You asked two questions and both had a real answer, so both got fixed.

### Do the legs move

Not before today. The characters bobbed, squashed, leaned and turned to face the way they were going —
which is most of what makes a body read as walking — but the legs themselves never moved, because every
character in the game is one drawn picture and a picture has one pair of legs frozen in one position.

They move now, without anyone drawing anything. Each character picture is cut in two along a line at the
hips, once, when the game loads. The top half is drawn exactly where the whole picture always went. The
bottom half is drawn a pixel or two to one side, then centred, then a pixel or two to the other side, in
step with the walk. That is a stride: the legs swing out, plant, and swing back. The legs also lift only
half as far as the chest does, because in a real step the feet stay near the floor while the body rises
over them — matching them exactly makes the whole figure hop.

It stops instantly when you stop, for the same reason the bob does: the cycle is driven by how far the
body has actually travelled, never by the clock. Standing still, the legs sit dead centre.

Drawn walk frames would still be better and are still worth doing later. This is what could be had for
all twelve characters today, and drawn frames would sit on top of it unchanged.

### Do the weapons do what they say

Twenty-eight of the thirty did. Two did not, and both were weapons whose description promised something
the game was never doing.

**The Bone Wheel and the Carrion Spiral.** Both say they bounce. Nothing in the game bounced. There is no
arena wall to bounce off — the field is open and the camera follows you — so they simply rolled away into
the dark and expired. They now turn around at the edge of what you can see, which is a box measured
around whoever fired them. Two details worth saying out loud: the box is measured in the game rules from
the player's position, never from the real camera, so a bigger phone does not get longer bounces and two
people in a co-op game cannot disagree about where a wheel went; and a wheel left behind because you ran
the other way heads home instead of rattling on the spot at the edge.

**The Cinder Flask and the Hellmouth Flask.** Both say they break into a fire on the floor. They were
thrown, and then they kept falling forever, because gravity never stops pulling and there is no floor in
a top-down game to stop it — the fire sailed off the bottom of the picture while still burning things.
They now stop dead halfway through their life and burn where they fell for the rest of it, which is why
the level-up that says "burns longer" is what it says. Anything the glass clipped on the way down still
burns when it lands.

### How this was proved

Eighty-nine checks on the body cut, most of them about the seam: the two halves are reassembled by hand
at four different draw sizes and have to line up with the original to nothing, because a one-pixel gap
across a character's waist is far worse than legs that do not move. Twenty-three more checks on the two
weapon fixes, including that an ordinary shot and an ordinary throw both behave exactly as they did
before. Then thirteen deliberate breakages, one at a time, every one caught: the cut landing on the wrong
row, the legs hung upside down, the halves overlapping, legs that swing while standing still, a stride
that does not mirror when you walk left, a leg lift landing on half a pixel, a bounce that never triggers,
a bounce measured from the world origin instead of from the player, a bounce that only works sideways, a
flask that never lands, a flask that lands but keeps drifting, and both flasks quietly losing the rule
that makes them land at all.

## A title screen that actually looks like a game

The old one was a diagram: a flat orange ball on a black screen. This one is a scene.

A blood moon low in a sky that goes from black at the top to old blood at the horizon. A soft halo
around it, built out of eighteen barely-there circles stacked inside each other, because a phone can
only draw hard-edged circles and that is the only way to get a glow with no visible rim. Stars. Bats
crossing on their own slow loops.

A hooded reaper stands in front of the moon with a scythe over his shoulder, rimmed in the faintest
gold on the side the moon is on, eyes fading in and out. Behind him, five church spires with lit
windows, far off and nearly black. In front of him, a horizon line, a row of leaning headstones and
crosses, a dead tree, and an iron railing across the very front — so you are standing outside the
fence looking in. Haze hugs the ground and embers rise the whole height of the screen.

Layout is borrowed on purpose: the gothic painting and carved gold lettering from Vampire Survivors,
the confident front-page furniture from Survivor.io. Your gold and your runs survived sit in the top
corners where a phone player already looks for them. One filled gold PLAY button owns the bottom and
breathes very slightly. Characters, PowerUps, Badges and Settings are stone and half-width.

**Not one pixel of it is a picture file.** Every part is drawn by the phone out of shapes and colour
fades. That is why it cannot go blurry the way the old reaper did: there is nothing to stretch. It also
adds nothing to the download, and the screen is on before the save has finished loading — the two top
corners show a dash until it arrives, so a slow phone never waits on storage to show its own buttons.

## The title screen is finished

The picture you approved is now the real title screen in the app.

- The name is the new gothic lettering — bone white bleeding into blood red.
- The treasure at the bottom is our chest, our coins, our gems.
- I lightened the dark fade at the bottom of the screen so the picture shows through behind the buttons instead of being washed out.

Checked: the app builds clean, the code checks pass, and I took a real screenshot of the phone screen to confirm it looks right.

## The co-op debug page now shows something

Two small clean-ups while there was budget left:

- Player colours were kept in two separate lists, so seat two could be one colour in the lobby and a
  different colour once the run started. There is one list now, and the lobby copies the run.
- The co-op page in the hidden dev menu used to say "no live session" always, because nothing ever
  handed it a party to watch. Joining a party now feeds it. Figures a lobby genuinely doesn't have
  (frame prediction, world checks, ping) read zero rather than showing a made-up number.

Both checked: code checks pass and the app still bundles clean.

## Gradual rollouts actually work now

The switches that were meant to reach "10% of players" reached nobody, because nothing ever told the
app who it was. It now uses the same id the cloud backup already makes on first launch, so a player
stays in the same group every time they open the game — a switch turned on for them stays on. If that
id can't be read, gradual switches stay off, which is the safe answer.

## Every stat now has a ceiling (handoff item 2)

A player's stats are stored as whole numbers with a hard limit: cross about 2.1 billion and the
number silently flips negative. When that happens to health, you are dead the instant you spawn; to
damage, your hits start healing the enemy; and worse, the broken number gets fingerprinted into the
co-op/replay check, so the game's anti-cheat brands that player a cheater for what was really an
overflow. Only four of the thirty stats had a ceiling before; the rest could grow without limit,
which is exactly the door the planned Golden Eggs feature would have walked through.

What changed:
- Every stat now has a ceiling, so none can ever run away and flip negative. Four of them are real
  balance limits kept as they were (extra projectiles at 10, armour at 50, pierce at 10, crit chance
  at 100%); a few more are deliberate game limits (99 revives, generous caps on reroll/skip/banish
  charges and on the invulnerability window). The remaining "multiplier" stats get a very high safety
  ceiling of 1000x their normal value that nothing in the current game can get anywhere near, so it
  changes nothing you can actually reach today while still leaving a huge margin below the danger
  line. Any cap that is a judgement call is flagged as a guess in a comment so it can be tuned later.
- A test now fails the build if any stat is ever left without a ceiling again, so a future stat added
  without one is caught immediately instead of months later in someone's save. A second test proves
  that guard actually fires by planting the exact mistake and confirming it is caught.

Nothing currently reachable in play is altered: the safety ceilings sit far above anything the game
can produce today. Checked: lint clean, typecheck 4/4, and the engine suites pass apart from the one
known, pre-existing replay-speed test.
