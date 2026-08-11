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
