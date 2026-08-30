# Nightreap Survivors — Engineering Audit & Remediation Brief

> Paste this whole file as your opening prompt in a fresh session. It is self-contained: it carries
> every finding, every file:line reference, every command that was run and its exact observed output,
> plus the project constraints you must not violate. You should not need to re-derive any of it.

---

## 0. Your mission

You are a senior engineer picking up a **completed, independent audit** of the `nightreap-survivors`
repository. The audit is done. Your job is **remediation**, in the priority order given in §7.

Do **not** redo the audit from scratch. The findings in §4–§6 were each verified by direct grep, file
read, or command execution, and the evidence is reproduced inline. Trust it, but re-run the specific
verification command before you change the code it refers to, so you know your starting state.

**Framing you should adopt:** the hard parts of this project are done and done well. What is broken is
a set of **safety mechanisms that were designed correctly, built correctly, and then never connected**
— fixed-point trig, the source linter, the "tests must be green" rule. That is a far better problem
than bad architecture. It is days of work, not a rewrite. Behave accordingly: be surgical, do not
refactor things that are fine, and do not "improve" the engine's data layout or netcode.

---

## 1. What this project is

A mobile-first survivors-style action roguelike. Original art, original names, 1–4 player online
co-op. Free-to-play, Google Play first and Apple about a month later. Monorepo on Bun workspaces +
Turborepo.

Scale, measured:

| Package | Files (ts/tsx) | Lines |
|---|---|---|
| `packages/mobile/` | 209 | 80,231 |
| `packages/web/` | 52 | 8,346 |
| `packages/relay/` | 3 | 978 |
| `packages/desktop/` | 6 | 191 |
| **Total** | | **89,746** |

Of the mobile package, roughly 20k lines is the game engine proper (`packages/mobile/game/`,
165 files, 17 top-level modules).

### The three documents of record

| File | What it is |
|---|---|
| `plan.md` | The build plan, nine stages. **The only place status is declared.** |
| `task.md` | Running diary, newest at the bottom (250KB). |
| `design.md` | Palette, fonts, spacing, motion rules, screen list. |
| `plan-detail.md` | The full original plan, every argument and gate (227KB). |
| `features-review.md` | A 200-item **feature backlog**, sorted. Note: this is *not* a code review and contains none of the findings below. |

`plan.md` claims stages 0–3 DONE, stage 4 (launch content) "nearly done", stages 5–8 not started, and
summarises as *"The game is built. We are filling it with content. About 80% of the launch list is done."*

### Architecture, as designed

- `packages/mobile/game/` — the engine. All maths and rules, **no screen code**.
- `packages/mobile/app/` — the screens (Expo + expo-router).
- `packages/relay/` — a tiny co-op WebSocket relay (own Bun process, port 4400). It forwards four
  header bytes and **never reads a message body**. The rules it enforces live in
  `packages/mobile/game/net/` so both sides share one tested copy.
- `packages/web/` — unified API + web frontend (Vite 7 + Hono + oRPC + Drizzle/Turso).
- `packages/desktop/` — Electron shell, loads the web app.

The stated invariant, which is the thing that lets one engine run on Android, iPhone and browser:
**"Nothing in the engine is allowed to know screens exist."**

---

## 2. Environment setup (do this first)

```bash
cd /projects/sandbox/nightreap-survivors
bun install          # node_modules is NOT checked in; this is required before anything runs
```

**Two environment caveats that materially affect what you'll see:**

1. **Bun version mismatch.** `package.json` pins `"packageManager": "bun@1.3.14"`. The audit ran on
   **bun 1.2.14**. Dependency *hoisting behaviour differs between these versions*, which is directly
   relevant to Finding #5 (the typecheck failure). Check `bun --version` and note it in any report.
2. **No `.env` exists.** Only `.env.template`. `DATABASE_URL` and `DATABASE_AUTH_TOKEN` are therefore
   unset, which is the sole cause of the `test:web` failure (Finding: §6, first bullet). All secrets
   live in the **single root `.env`** — this is enforced by a konsistent rule
   (`all-env-vars-must-live-in-the-single-root-env-file`). Do not create per-package `.env` files.

---

## 3. How to verify state — commands and exact observed results

Run these. The right-hand column is what the audit actually observed, so you can tell drift from
regression.

| Command | Observed result |
|---|---|
| `bun run lint` | **PASS** — konsistent: 23 files, no violations. oxlint: 0 warnings, 0 errors, 277 files, 154 rules. |
| `bun run typecheck` | **FAIL** — `@template/web#typecheck` exits 2. 2 of 3 tasks succeed. See Finding #5. |
| `bun run test:game` | **FAIL — 1 check.** Exactly one assertion fails, in `replay/replay.test.ts`. See Finding #2. |
| `bun run test:e2e` | **PASS** — prints `E2E PASS`. Full co-op stack, starts/stops its own relay on 4401. |
| `bun run test:web` | **FAIL** — `LibsqlError: URL_INVALID: The URL 'undefined' is not in a valid format`. Environmental, not a code defect. |
| `bun run test:relay` | Not run in the audit. Requires the relay running: `bun run --cwd packages/relay dev`. |
| `bun run test:soak` | Not run in the audit (20 minutes of simulated quad-storm time, deliberately excluded from `test:game` for runtime). |

To isolate the failing game suite without running all 37:

```bash
for f in $(grep -o 'packages/mobile/game/[a-z/-]*\.test\.ts' package.json | sort -u); do
  out=$(bun "$f" 2>&1)
  echo "$out" | grep -q 'FAIL' && { echo "FAILING: $f"; echo "$out" | grep -A2 FAIL; }
done
```

---

## 4. What is verified-good — DO NOT "FIX" THESE

This section exists to stop you wasting effort or breaking working code. Each was checked directly.

**The engine/screen boundary claim is TRUE.** Grep across all 165 files in `game/` for
`from "react"`, `from "react-native"`, `from "expo*"`, `require("react*")` returns **exactly one hit**:
`dev/dev.test.ts:293`, which is a **string literal inside a test fixture** feeding the engine's own
lint rule. That is the test that *enforces* the boundary, not a violation of it. Additionally verified:
no file in `game/` imports from `../../app`, `screens/`, or escapes the package via `../../../`.

**Module dependency direction is a proper DAG at the bottom.** `core/` imports nothing from any
sibling. `sim/` imports only from `sim/` and `core/` — grep for `sim/*.ts` importing
`render|hud|net|save|run|shop|guide|dev|replay|lobby|settings` returns empty. `sim/` is a clean leaf
over `core/`. `render/ -> sim/` and `render/ -> hud/`, never the reverse.

**The data layout will hit the 800-enemy target.** `sim/enemies.ts:498-561` — `EnemyStore` is pure
struct-of-arrays: 16 parallel pre-allocated typed arrays (`x, y, vx, vy, pushX, pushY, health,
maxHealth, radius, speed, damage` as `Float32Array`; `typeIndex, flags, knockTicks, target, age,
facing` as `Int32Array`), all sized to `capacity` in the constructor. An enemy *is* an integer index.
Scratch buffers (`neighbours`, `neighbourScratch`, `Int32Array(64)`) are fields, not locals.
Allocation via `EntityPool`/`Handle`/`POOL_BUDGETS` in `core/pool.ts`. Same pattern in
`projectiles.ts`, `pickups.ts`, `player.ts`, `props.ts`. Contiguous `Float32Array` streams are
cache-friendly and GC-invisible — this is the single most important decision for 800 entities at 60Hz
on Hermes/JSC and it is correct. The header at `enemies.ts:1-23` states the three rules (no objects,
no allocation in a tick, approximate separation) and cites a real regression: a per-frame array in the
render batcher froze the game after 75 seconds.

**Separation is bounded, not all-pairs.** Candidates come from `core/spatial-hash.ts`; per-enemy
neighbour resolution is capped via a `resolved++` counter (`enemies.ts:834`) and the 64-entry
`neighbours` buffer is a hard ceiling on per-enemy work. Avoids the 320k-comparison blowup.

**The spatial hash rebuild placement is a considered trade, not an oversight.** Rebuilt exactly
**once** per tick (tick step 7), deliberately *after* crowd movement and spawns. Separation therefore
reads a one-tick-stale grid (fine — it's steering) while damage tests read a fresh one (necessary — a
stale grid drops hits). Documented in place. Leave it alone.

**Fixed timestep is real and correctly separated from the clock.** `core/loop.ts` — `FixedLoop`,
`TICK_HZ = 60`, `TICK_MS = 1000/60`. Real-time path `advance(nowMs)` (loop.ts:75-113) takes the clock
**as a parameter and never reads it**. Headless path `runTicks(count)` (loop.ts:120-126) involves no
clock at all — this is what replay validation and the soak test drive. `stats.alpha` is exported for
render interpolation.

**`FrameTimer.percentile` (loop.ts:143-155) is correct.** It calls `view.sort()` on a `Float64Array`
subarray — TypedArray sort is numeric by default, unlike `Array.prototype.sort`. The nearest-rank
comment is right. Flagged only because this is the kind of thing that is usually wrong.

**The tick order is explicit, numbered and documented.** `Run.tick()` at `run/run.ts:546` is the real
authoritative entry point; `Run` (1153 lines) owns every system as a field and ticks them in a fixed
14-step order (run.ts:569-690+):

1. `prog.beginTick()` → 2. `recorder.recordTick(axes, buttons)` (records *post*-quantisation)
→ 3. apply input with deadzone → 4. `waves.update(...)` (clock + spawner) → 5. `tickReaper()`
→ 6. `enemies.update(...)` → 7. **single** spatial-hash rebuild → 8. `weapons.update` +
`projectiles.update` → 9. drain damage/death events → 10. `pickups.update` → 11. level-up/arcana
screen open check → 12. players last (movement resolution, contact damage, downs) → 13. deferred
heals → 14. end-of-run check.

`Run.tick()` returns `false` when `end !== RUN_END.running` (run.ts:547) or when `cards.open` /
`arcanas.open` (run.ts:554-566), so a modal card screen fully freezes the sim. Correct.

**The RNG is textbook-correct.** `core/rng.ts` — xoshiro128** using only `Math.imul`, shifts and xor
(bit-identical across engines), SplitMix32 seeding, rejection-sampled `nextInt` with a documented
fix for the `2^32 % bound === 0` infinite-loop case (rng.ts:83-88), and **10 named independent
streams** (`RNG_STREAMS`, rng.ts:22-33) so adding a VFX roll cannot perturb the spawn table.
`saveState`/`loadState` make streams hashable and snapshot-able. `nextBrad()` exists at rng.ts:118 —
**you will need this for Task 1.**

**Randomness and clock discipline holds.** **Zero** production uses of `Math.random`: all 12 grep
hits in non-test files are *comments asserting the ban* (`core/rng.ts:14`, `sim/chests.ts:38`,
`sim/projectiles.ts:28`, `net/rooms.ts:17`, `render/chest-open.ts:98`, `render/camera.ts:123`,
`config/remote-config.ts:44`, `dev/coop-lab.ts:20`). The only executable use is
`replay/replay.test.ts:96`, a test that deliberately injects noise to prove divergence *is detected*.
**One** production `Date.now`/`performance.now`, and it is safe — `replay/player.ts:75-80`:

```ts
function nowMs(): number {
  const host = globalThis as unknown as { performance?: { now?: () => number } };
  return host.performance?.now?.() ?? Date.now();
}
```

used only for `elapsedMs`/`ticksPerSecond` in `ReplayResult`, documented at player.ts:57 as
*"Informational; never hashed."* Every other hit is a test-harness timing assertion. No `new Date(`
anywhere in the engine.

**`Math.sqrt` uses are fine and intentional** — correctly rounded per IEEE-754/ECMA spec.
`enemies.ts:730,835`, `pickups.ts:400,407`, `player.ts:227`, `net/input.ts:76`,
`net/local-view.ts:142,222`, `net/session.ts:418,777`, `fx.ts:73,111`. Leave them.

**Co-op works end to end over a real socket.** `bun run test:e2e` passes in full:

```
2. Two real simulations, one real socket, one world
  ok  the host simulated the ticks it was asked for — 239
  ok  the guest kept up with the host — host 239 guest 236
  ok  and the two worlds never disagreed on one of them — first split at tick -1
  ok  nothing had to be resynced — 0
3. The host writes a broadcast once, not once per player
  ok  every broadcast reached somebody — 180 forwarded
  ok  the relay dropped nothing legitimate — 0
4. A guest whose signal dies keeps its seat
  ok  it reconnected on its own / into the same seat — 1
  ok  and the game was told this was a resume, not a new player
  ok  and the worlds still match after the gap — first split at tick -1
5. Quitting gives the seat back straight away
  ok  a new player takes the freed seat immediately — 1
E2E PASS
```

That is a real distributed-systems test — signal death, reseat, resume semantics — not a smoke test.

**`net/correction.ts` is a real defence.** Host-authoritative distance-weighted rolling correction
sweep with a staleness escape hatch (correction.ts:53, 83, 183-193). This is load-bearing for
Finding #1 and is why that finding does **not** break co-op.

**Content counts in `plan.md` are exactly honest.** Verified by counting `id: "` entries:

| Claimed | Counted | File |
|---|---|---|
| 30 weapons | **30** | `sim/weapons.ts` |
| 26 enemies | **26** | `sim/enemies.ts` |
| 51 achievements | **51** | `unlocks/achievements.ts` |
| 12 characters | **12** | `characters/roster.ts` |
| 5 stages | **5** | `sim/stages.ts` |

**Zero `TODO` / `FIXME` / `HACK` / `XXX`** in the entire engine and relay (non-test). Docs that don't
inflate are rarer than good code — assume the diary and plan are trustworthy.

**`bun run lint` is fully clean** — konsistent 23 files no violations, oxlint 0 warnings 0 errors
across 277 files with 154 rules. Keep it that way; `lint` uses `--deny-warnings`.

---

## 5. THE FINDINGS — ranked

### Finding #1 — The cross-engine determinism claim is FALSE, and it will reject honest players' runs

**Severity: highest. This is a launch blocker with a direct player-facing cost.**

`core/fx.ts:12-14` states the rule correctly and completely:

> JS guarantees `+ - * /` and `Math.sqrt` are IEEE-754 correctly rounded, so those are safe to use
> across engines. `Math.sin`, `cos`, `tan`, `exp`, `log`, `pow` are NOT specified and differ between
> JSC, Hermes, and V8 — so this file never calls them, not even to build its own tables.

`core/fx.ts` then provides exactly the right tools: `fxSin(brad)` (fx.ts:173), `fxCos(brad)`
(fx.ts:182), `fxAtan2(y,x)` (fx.ts:190), integer brad angles, Q16.16 fixed point, and a
Taylor-generated integer trig table.

**Nothing in `sim/` or `run/` imports it.** The complete, verified list of importers:

```
packages/mobile/game/core/core.test.ts:53      } from "./fx";                      # its own test
packages/mobile/game/net/input.ts:20           import { FX_ONE } from "../core/fx"; # a constant only
packages/mobile/game/replay/replay.test.ts:20  import { fxMul, fxSin, fxCos }       # a test
```

`core/fx.ts` is **dead code with respect to the simulation** — a fully built, documented, tested
fixed-point layer that nothing in the sim consumes. Meanwhile the sim calls the exact functions
`fx.ts` declares unsafe, **22 times, on values that land in `hashState()`**:

| file:line | call | lands in hash? |
|---|---|---|
| `sim/waves.ts:363-365` | `angle = (step/4096)*Math.PI*2; x = px + Math.cos(angle)*SPAWN_RING; y = py + Math.sin(angle)*SPAWN_RING` | **Yes** — enemy spawn positions, hashed run.ts:1096-1098 |
| `sim/enemies.ts:840-841` | `pushX[s] += Math.cos(angle)*minDist*SEPARATION_STRENGTH; pushY[s] += Math.sin(angle)*...` | **Yes** — enemy positions |
| `sim/enemies.ts:654` | `Math.hypot(dx, dy)` | **Yes** |
| `sim/projectiles.ts:467-468` | `x[s] = ox + Math.cos(rad)*anchorDist[s]` (orbit weapons) | **Yes** — run.ts:1105-1107 |
| `sim/projectiles.ts:476-477` | same, second branch | **Yes** |
| `sim/projectiles.ts:485,487,494` | `Math.hypot(...)` ×3 | **Yes** |
| `sim/player.ts:196-197` | `px = Math.cos(a)*spawnRadius; py = Math.sin(a)*spawnRadius` | **Yes** — run.ts:1087-1088 |
| `sim/player.ts:401` | `const len = Math.hypot(mx, my)` → sets `aimX/aimY` | **Yes**, indirectly — aim drives firing direction |
| `sim/weapons.ts:1569` | `Math.hypot(dx, dy) \|\| 1` | **Yes** — projectile velocities |
| `sim/weapons.ts:1573-1574` | `Math.cos(rad)`, `Math.sin(rad)` | **Yes** |
| `sim/weapons.ts:1601` | `Math.hypot(fx, fy) \|\| 1` | **Yes** |
| `sim/weapons.ts:1607-1608` | `Math.cos(rad)`, `Math.sin(rad)` | **Yes** |

Reproduce with:

```bash
grep -rn 'Math\.\(sin\|cos\|tan\|pow\|exp\|log\|hypot\)' --include=*.ts \
  packages/mobile/game/sim packages/mobile/game/run | grep -v '\.test\.ts'
```

**The self-contradiction that proves this is drift, not a design choice.** `sim/player.ts:223-224`
says:

> `Math.sqrt` rather than `Math.hypot`: hypot is both slower and not bit-guaranteed across engines,
> and this number moves the player, which lands in the co-op state hash.

…and then `sim/player.ts:401` — **same file, same store, same hashed state** — calls
`Math.hypot(mx, my)`. Plus 7 more `Math.hypot` calls across `enemies.ts`, `projectiles.ts`,
`weapons.ts`. The author knew the rule and the codebase drifted off it.

**Be fair about the blast radius.** `core/fx.ts:4-9` pre-empts half the criticism:
*"Co-op correctness does NOT depend on this file — the netcode is host-authoritative with a rolling
correction sweep, so divergence is corrected rather than prevented."* Having read
`net/correction.ts`, **that defence is real.** Cross-engine trig drift in co-op becomes correction
bandwidth and occasional visible snapping, not a broken session. Accept that and do not panic about
co-op.

**But the same file's next sentence claims fixed point makes "replay validation (anti-cheat) and the
CI soak test exactly reproducible across iOS, Android, and Node" — and since nothing uses it, that
is false.** `replay/player.ts` compares `recordedHash` against `replayedHash` and reports
`reproduced` / `firstDivergentTick`. A replay recorded on Hermes or iOS JSC and revalidated
server-side on Node/Bun (V8) will diverge in the low bits of `Math.cos` **at the first ring spawn**
(`waves.ts:364`), and `hashFloat` over `Float32Array` positions will surface it. That is a
**false-positive anti-cheat rejection of an honest run** — precisely the failure mode
`core/rng.ts:6-9` argues named streams exist to prevent.

**The determinism story is airtight against randomness and leaky against floating point.**

**Why the fix is contained:** `spawnAtRing` already draws `rng.nextInt(4096)`, and the RNG already
exposes `nextBrad()` (rng.ts:118). The angle sites are near drop-in replacements with brad angles
through `fxSin`/`fxCos`. The `Math.hypot` sites are a straight swap to `Math.sqrt`.

---

### Finding #2 — `test:game` is RED, and it is the anti-cheat budget that fails

**Severity: high. It contradicts a stated release gate.**

`README.md` says of `test:game`: *"Must be green before any deliver."* It is not green.

```
FAIL a 30-minute run revalidates well inside a server request budget
     — 8.04s at 13,438 ticks/s (256-entity stub sim)
```

The assertion, `replay/replay.test.ts:210-215`:

```ts
const halfHourSec = 108_000 / Math.max(result.ticksPerSecond, 1);
check(
  "a 30-minute run revalidates well inside a server request budget",
  halfHourSec < 5,
  `${halfHourSec.toFixed(2)}s at ${Math.round(result.ticksPerSecond).toLocaleString()} ticks/s (256-entity stub sim)`,
);
```

**This is not flakiness.** Run three times on an 8-core Intel Xeon Platinum 8488C:

```
FAIL … 8.03s at 13,450 ticks/s
FAIL … 8.05s at 13,408 ticks/s
FAIL … 8.05s at 13,419 ticks/s
```

**60% over budget, perfectly reproducible, on fast modern server hardware.** And note it is a
**stub** sim (256 entities) — the real simulation is heavier.

Everything else in that file passes, including the parts that matter for correctness:

```
ok  replay reproduces the recorded hash — recorded 9af3c464 replayed 9af3c464
ok  replay ran every tick — 18000
ok  live sim and recorded hash agree
ok  harness overhead is negligible — 24,397,318 ticks/s with a do-nothing sim
ok  four-player run reproduces — 7200 ticks
ok  a non-deterministic sim is caught — first divergence at tick 60
ok  taint bits accumulate and cannot be cleared
ok  buffer stayed bounded — 0.8MB after 200k changing ticks
```

The test file deliberately measures two separate things and says so (replay.test.ts:194-198): harness
overhead with a null sim, and end-to-end wall clock with a sim attached, *"because that is the number
that decides whether mandatory ladder revalidation is affordable at all."*

**#1 and #2 compound badly.** Mandatory ladder revalidation is currently both **over its time budget**
and **producing wrong answers cross-engine**. Those are the two load-bearing assumptions under the
locked decision *"Every run is recorded and replayable, which is also how cheating gets caught."*

**Sequencing matters: fix #1 before touching #2.** Fixed-point trig will change the throughput
number, so re-baselining the budget first would be measuring the wrong build.

---

### Finding #3 — The guard that should have caught #1 only inspects 9 of ~165 files

**Severity: high, because it is the reason #1 was able to happen and will happen again.**

`dev/lint.ts` contains a real source-level rule engine, and `dev/dev.test.ts` proves it bites by
planting violations — the instinct is right. Two problems:

**(a) It runs against a hardcoded 9-file list, not the source tree.** `dev.test.ts:260-270`:

```ts
const relative = [
  "game/dev/channel.ts",
  "game/dev/registry.ts",
  "game/dev/devgate.ts",
  "game/dev/lint.ts",
  "game/replay/format.ts",
  "game/replay/recorder.ts",
  "game/replay/player.ts",
  "game/render/renderer.ts",
  "game/core/rng.ts",
];
```

Those 9 files are read via `Bun.file` and passed to `lintSources(files)`. There is **no `readdir`, no
glob** — confirmed by grepping both `dev.test.ts` and `lint.ts` for `readdir|glob|Glob|fs\.`. Every
file added since is unlinted.

**(b) The rule set does not cover `Math.*` at all.** `lintSources` (lint.ts:187+) checks import
specifiers only, against `SERVER_WRITE_MODULES` (lint.ts:164) and a react-native ban. The other rules
in the file are about the dev-panel registry: tier correctness, and SYSTEM-panel reachability across
the full flag matrix (`REQUIRED_SYSTEM_PREFIXES = ["account.", "ladder.", "coop.", "ops."]`,
lint.ts:40; `flagMatrix()`, lint.ts:43). Nothing greps for `Math.random` or for transcendentals.

> **Correct the record if you saw it stated otherwise:** an earlier pass claimed `dev/lint.ts` already
> greps for `Math.random`. **It does not.** Verified. The ban on `Math.random` is currently held by
> comments and discipline only.

**Net effect:** the boundary discipline in §4 is real, but it is held by the author's care rather than
by the mechanism built to hold it. Point the mechanism at the tree and this class of drift stops.

---

### Finding #4 — Five runtime dependency cycles around a god-module

**Severity: medium, but the failure mode is silent rather than loud, which raises it.**

`save/schema.ts` is imported by **10** non-test feature modules for `bitGet`/`bitSet`/`SAVE_LIMITS`/
`SaveData`:

```
characters/roster.ts:39        import { bitGet, SAVE_LIMITS, type SaveData }
guide/arming.ts:29             import type { SaveData, SaveSettings }
settings/settings.ts:29        import { CHAT_KEYBOARD, HUD_ALIGN, defaultSettings, type SaveSettings }
shop/loadout.ts:46             import type { SaveData }
shop/powerups.ts:42            import { SAVE_LIMITS, type SaveData }
unlocks/achievements.ts:36     import { bitGet, SAVE_LIMITS, type SaveData }
unlocks/arcana-records.ts:28   import { bitGet, type SaveData }
unlocks/awards.ts:41           import { bitGet, bitSet, SAVE_LIMITS, type SaveData }
unlocks/stage-records.ts:34    import { bitGet, type SaveData }
```

…while `save/` imports **values** (not types) straight back out of those same feature modules:

```
save/codec.ts:37     import { HASH_SEED, hashByte, hashWord }        from "../net/state-hash"
save/handoff.ts:39   … from "../unlocks/awards"
save/handoff.ts:40   import { runFactsOf }                            from "../unlocks/achievements"
save/schema.ts:27    import { TAINT }                                 from "../replay/format"
save/snapshot.ts:41  import { POWERUP_MODIFIERS_BY_WIRE_ID }          from "../shop/loadout"
save/snapshot.ts:42  import { CHARACTER_MODIFIERS_BY_WIRE_ID }        from "../characters/loadout"
save/store.ts:32     import { seedStarters }                          from "../unlocks/awards"
save/sync.ts:65      import { POWERUPS, spentOn, totalInvested }      from "../shop/powerups"
```

The five cycles, all with value imports on at least one side:

1. **`run/` ↔ `net/`** — `run/run.ts:33` → `../net/state-hash` (values `hashByte, hashFloat,
   hashFloat32Range, hashUint8Range, hashWord`); `run/run.ts:34` → `../net/input` (value
   `quantiseStick`); and `net/sim-network.ts:31` → `import { Run } from "../run/run"` (**value**).
   `net/party.ts:36` and `net/session.ts:35` are `import type`, harmless.
2. **`save/` ↔ `unlocks/`**
3. **`save/` ↔ `shop/`**
4. **`save/` ↔ `net/`** — `save/codec.ts:37` vs `net/session.ts:36` → `restoreRun, snapshotRun,
   SNAPSHOT_ERROR` from `../save/snapshot` (value).
5. **`save/` ↔ `characters/`**

Plus `save/schema.ts:27` → `../replay/format` and `replay/player.ts:18` → `../net/state-hash`, which
weaves `save/ → replay/ → net/ → run/ → net/` into the same knot. (`save/resume.ts:38` and
`save/snapshot.ts:63` import `Run` as `import type` — those are fine.)

**Root cause:** classic bidirectional-serialisation smell. Every feature reaches into `save/schema`
for bit primitives while `save/` reaches back into every feature to serialise it.

**Why the failure mode is nasty:** ES-module cycles with value imports make **module-init order
load-order dependent**. The imports at `save/snapshot.ts:41-42` and `save/sync.ts:65` are top-level
**lookup tables** — under a different init order (Metro vs Bun vs Vite) they can initialise
**empty rather than throwing**, surfacing as *"purchases don't apply"* rather than a crash.

**Note the design fix, which collapses 2, 3 and 5 at once:** extract the bit primitives and
`SAVE_LIMITS` into a leaf (`core/bits.ts` or `save/primitives.ts`) that features import, and invert
serialisation so each feature registers its own codec with `save/` rather than `save/` knowing all of
them. Separately, `state-hash` and `input` are **not networking** — they are determinism primitives
and belong in `core/`; moving those two files breaks cycle #1 outright and leaves `run/` depending
only on `sim/` + `core/` + `replay/`.

---

### Finding #5 — `typecheck` fails: two major versions of Vite in one workspace

**Severity: medium. Partly environmental — read the caveat.**

```
ERROR  @template/web#typecheck: exited (2)
Tasks: 2 successful, 3 total
Failed: @template/web#typecheck
```

The error is `PluginOption` being structurally incompatible with itself across two resolution roots:

```
root  node_modules/vite:        5.4.21   ← hoisted from packages/desktop's "vite": "^5.1.6"
packages/web/node_modules/vite: 7.3.2    ← packages/web's "vite": "^7.3.1", nested
```

`packages/web/vite.config.ts` imports plugins typed against the nested v7 while the config type
resolves against the hoisted v5, producing the cascade of
`Type 'Plugin<any>' is not assignable to type 'PluginOption'`.

**Honest caveat:** the audit ran on **bun 1.2.14** against a pinned **bun@1.3.14**, and hoisting
differs between them. **This exact error may not reproduce on the intended toolchain.** Verify with
the pinned bun before doing surgery. The underlying fact — desktop on Vite 5 and web on Vite 7 in one
workspace — is real regardless and worth aligning.

---

## 6. Smaller findings and sharp edges

- **`test:web` cannot run at all without a live database.** `packages/web/src/api/database/__client.ts:7`
  calls `createClient({ url: process.env.DATABASE_URL! })` at **module top level**, so any test that
  transitively imports it dies with `LibsqlError: URL_INVALID` before a single assertion runs. The
  file is **template-managed and protected** (`// TEMPLATE-MANAGED (__ prefix) — do not edit`), so the
  fix is not to edit it — either provision a `DATABASE_URL` in CI or introduce a seam in your own
  code. Worth naming as a testability constraint.

- **Doc drift:** `README.md` describes `test:game` as *"20 headless suites"*. It is **37** (count the
  `bun packages/mobile/game/**.test.ts` invocations in the root `package.json` script).

- **`MAX_CATCHUP_TICKS = 6` means a struggling phone runs in slow motion, not stalled.**
  `core/loop.ts:96-101` drains at most 6 ticks per `advance()` and **discards** the leftover
  accumulator into `stats.droppedTicks`. On the target $100 phone this is the likely failure mode and
  it is invisible to the player as anything but "the game feels sluggish." In co-op the local client's
  tick count then drifts behind the host indefinitely, and the design leans entirely on
  `net/correction.ts` to paper over it. **Recommend surfacing `droppedTicks` in the dev HUD.**

- **`core/loop.ts:89`: `if (deltaMs > BACKGROUND_GAP_MS) deltaMs = TICK_MS;`** — a >1s gap silently
  collapses to one tick. Correct for backgrounding, but wall-clock and sim time then permanently
  decouple with no signal beyond `droppedTicks`.

- **`hashState()` iterates pool slots in allocation order, not canonical order.** run.ts:1093-1100
  (enemies), 1103-1110 (projectiles), 1112-1119 (pickups) walk `pool.slots` in pool order. Two clients
  that agree semantically but consumed free-list slots in a different sequence — **exactly what a
  dropped tick from `MAX_CATCHUP_TICKS` produces** — will hash differently. So a desync report
  currently means "real divergence **or** slot-order divergence." Notably the code **gets this right
  for props** (run.ts:1124-1127, integers only, with a good stated rationale); the entity stores just
  never got the same treatment. Fix by sorting by handle or hashing order-independently.

- **`Run.hashState()` is O(all live entities).** run.ts:1093-1122 walks every live enemy, projectile
  and pickup folding 3 values each — several thousand hash steps at 800 enemies. **The per-tick
  sampling cadence in co-op is the deciding factor for whether this is a meaningful slice of the tick
  budget on a weak phone, and it was not measured.** See §8.

- **Hot-path file size is a maintainability risk.** `sim/weapons.ts` is **1709 lines** — the largest
  file in the engine — and it is in the hot path; `run/run.ts` is 1153. These two will absorb all
  future content, and every new weapon widens that hot loop. Konsistent enforces a 500-line cap on
  API route files but nothing caps engine files.

- **`Float32Array` storage with float64 arithmetic** rounds on store, which is deterministic. The
  storage choice is right; it is the *inputs* to the arithmetic that are unspecified (Finding #1).

---

## 7. Your task list, in order

Tasks 1 and 3 are the highest-leverage and both sit directly under the launch-blocking anti-cheat
claim. Do them together as one reviewable change if you can.

### Task 1 — Make the hashed sim path cross-engine deterministic

Route the trig sites through the existing fixed-point layer, and remove `Math.hypot` from hashed paths.

- Convert to `fxSin`/`fxCos` with integer brad angles: `sim/waves.ts:363-365`,
  `sim/projectiles.ts:467-468` and `:476-477`, `sim/weapons.ts:1573-1574` and `:1607-1608`,
  `sim/enemies.ts:840-841`, `sim/player.ts:196-197`.
- Replace all 8 `Math.hypot` with `Math.sqrt`: `sim/enemies.ts:654`, `sim/player.ts:401`,
  `sim/projectiles.ts:485,487,494`, `sim/weapons.ts:1569,1601`.
- `spawnAtRing` already draws `rng.nextInt(4096)` and `rng.nextBrad()` exists (rng.ts:118) — prefer
  those over converting radians at the call site.

**Acceptance criteria:**
- `grep -rn 'Math\.\(sin\|cos\|tan\|pow\|exp\|log\|hypot\)' --include=*.ts packages/mobile/game/sim packages/mobile/game/run | grep -v '\.test\.ts'` returns **only comment lines**.
- `bun run test:game` shows no *new* failures; the replay hash-reproduction checks still pass.
- **Prove the property rather than asserting it:** record a replay under one runtime and revalidate it
  under another (at minimum Bun vs Node; ideally add a Hermes path), and show the hashes match. Do not
  restore the wording in `core/fx.ts:4-9` about cross-engine reproducibility until you have this
  evidence. Balance-affecting changes should be called out — fixed-point trig will shift low-bit
  values, so state explicitly whether any gameplay tuning changed.

### Task 2 — Resolve the revalidation budget (only after Task 1)

`replay/replay.test.ts:210-215`, currently 8.04s against a `< 5` second gate.

Either optimise revalidation throughput to clear 5s, **or** consciously re-baseline the threshold with
a written justification of what a real server request budget actually is. Do not simply loosen the
number silently — this gate encodes whether mandatory ladder revalidation is affordable at all.
Re-measure *after* Task 1, since fixed-point trig changes the throughput.

**Acceptance:** `bun run test:game` fully green, and the chosen threshold is justified in the diff.

### Task 3 — Point the engine's source linter at the whole tree and widen its rules

- Replace the hardcoded 9-file `relative` array in `dev/dev.test.ts:260-270` with a real directory
  walk over `packages/mobile/game/**/*.ts`.
- Add a rule to `lintSources` banning `Math.sin|cos|tan|pow|exp|log|hypot` under `sim/` and `run/`,
  and a rule banning `Math.random` engine-wide. Allow them in `render/` (drift there is cosmetic) and
  in tests.
- Keep the existing "prove the linter bites" planted-violation pattern (dev.test.ts:291+) and extend
  it to the new rules.

**Acceptance:** the linter flags a deliberately planted `Math.cos` in `sim/`, runs over all ~165
files, and `bun run test:game` stays green.

### Task 4 — Break the save cycles

Extract `bitGet`/`bitSet`/`SAVE_LIMITS` into a leaf module and have features import that instead of
`save/schema`. Move `net/state-hash` and `net/input` into `core/` (they are determinism primitives,
not networking) to break the `run/` ↔ `net/` cycle. Consider inverting serialisation so features
register codecs with `save/`.

**Acceptance:** no value-import cycles remain between `save/` and `unlocks|shop|characters|net`; save
round-trip tests (`save/save.test.ts`, `save/snapshot.test.ts`, `save/resume.test.ts`) stay green.

### Task 5 — Align Vite to one major version

Bring `packages/desktop` (`^5.1.6`) and `packages/web` (`^7.3.1`) onto one major, after confirming the
failure reproduces under the pinned **bun@1.3.14**.

**Acceptance:** `bun run typecheck` green — 3 of 3 tasks.

### Optional follow-ups
- Canonicalise `hashState()` iteration order (sort by handle) so a desync report means one thing.
- Surface `stats.droppedTicks` in the dev HUD.
- Fix the README's "20 headless suites" → 37.
- Measure `hashState()` cost per tick under co-op at 800 entities.

---

## 8. What was NOT verified — do not assume these

State these as open in any report rather than glossing them.

- **The host shell that constructs `FixedLoop`** and supplies `onTick`/`nowMs` lives outside `game/`
  (presumably `packages/mobile/app/`) and was not located. **The real per-tick call cadence of
  `hashState()` in co-op is therefore unconfirmed, and its tick-budget cost is unmeasured.**
- **Whether the module-init-order hazard from the five cycles actually manifests** under Metro/Bun/Vite
  was not tested. Flagged as risk, not observed failure.
- **`net/session.ts` and `net/sim-network.ts` tick-driving paths** were not audited in depth; whether
  guests use `advance()` or `runTicks()` is unconfirmed.
- **`bun run test:relay`** and **`bun run test:soak`** were never executed.
- **No real-device measurement.** `plan.md` already concedes the "800 enemies at 60fps" figure is
  lab-proven but not phone-proven, and that co-op has only ever been tested with fake players.
- **Finding #5 may be an artifact** of bun 1.2.14 vs the pinned 1.3.14.

---

## 9. Constraints you must respect

**Protected / template-managed files — do not edit.** Enforced by hash in
`.runable/protected-files.json` and by `__lint-rules/protected-files.mjs`. The `__`-prefix convention
marks them. Includes `packages/web/src/api/database/__client.ts`, `packages/web/src/api/__core/app.ts`,
`packages/web/src/web/__main.tsx`, `packages/web/vite/__plugins/*`, `packages/mobile/__env.d.ts`,
`packages/mobile/components/__ErrorBoundary.tsx`, `packages/mobile/lib/__analytics.ts`,
`packages/desktop/electron/__no-renderer.ts`, and all of `__lint-rules/`.

**The root `package.json` scripts are an external contract.** Deployment and tooling only ever call
these named verbs. **Never rename or remove them**; internals are free to change. Fixed conventions
the contract relies on: server listens on `$PORT` (default `4200`), health endpoint at
`/api/health`, secrets in the **root** `.env`, pm2 app name `web-app`. Scripts prefixed `internal:`
are template maintenance helpers, not part of the contract.

**`konsistent` enforces structural conventions** (`bun run internal:check-conventions`) — API route
files export their feature and cap at 500 lines, `api/index.ts` composes the router,
`database/index.ts` only re-exports the client, all env vars in the single root `.env`, web static
assets in `packages/web/public`, template-managed files must exist, mobile layout keeps template
providers, web vite config keeps template plugins, query files build on the typed client. Run `lint`
before every commit; it uses `--deny-warnings`.

**Locked product decisions — settled, not reopening.** Mobile first, Google Play then Apple ~a month
later. Free-to-play with rewarded ads and cosmetics only, **no paying for power**. Original art and
original font, nothing traced or borrowed. Same rules as the genre inspiration, different names for
everything. **Host-runs-the-game co-op. No voice chat, ever.** Difficulty never quietly adjusts to
performance. Leaderboards never grant power. Cut a stage before cutting a feature. Every run is
recorded and replayable, which is also how cheating is caught. **The game must run on a $100 phone.**

**Engine invariants.** No React/React Native/Expo imports anywhere in `packages/mobile/game/`. No
objects per entity, no allocation inside a tick. No `Math.random`, no `Date.now`/`performance.now` in
the deterministic path. Keep the 14-step tick order and its numbered comments intact — if you reorder
anything, say why.

**Status reporting.** `plan.md`'s *"Where we actually are"* is the single place a phase is declared
open or closed. Do not infer or assert status anywhere else. `task.md` is the running diary, newest at
the bottom — append there.

**Workflow.** Never commit to `main`. Push a branch and open a PR via
`gh api repos/{owner}/{repo}/pulls -f title=... -f body=... -f head={branch} -f base=main`
(the `gh pr`/`gh issue` subcommands are GraphQL-backed and fail in this environment). Report back with
the PR URL. Never start long-running dev servers or watch-mode tests; use single-run flags.

---

## 10. One-paragraph summary if you only read one thing

The engine is genuinely well built: real fixed-timestep loop with an injected clock, struct-of-arrays
typed-array crowd storage that will hit 800 enemies, a textbook xoshiro128** RNG with 10 named
streams, a screen/engine boundary that actually holds across all 165 files, clean lint, and a co-op
e2e test that survives signal death and reseating. Content counts match the plan exactly and there is
not one TODO in the engine. **The problem is three disconnected safety mechanisms.** `core/fx.ts`
builds, documents and tests a fixed-point trig layer that **nothing in the sim imports**, while the
sim calls `Math.cos/sin/hypot` 22 times on state that lands in the co-op/replay hash — so the
cross-engine replay-determinism claim is false and will false-positive-reject honest players' runs
(co-op survives it, because host-authoritative correction is real; anti-cheat does not).
`bun run test:game` is red on exactly one assertion — the 30-minute revalidation budget, 8.04s against
a 5s gate, reproducible on a Xeon — despite the README declaring green tests a release gate. And
`dev/lint.ts`, the mechanism built to prevent exactly this drift, only inspects 9 hardcoded files and
has no `Math.*` rule at all. Behind those: five value-import cycles around `save/schema.ts` whose
failure mode is silently-empty lookup tables, and a `typecheck` failure from two majors of Vite.
Fix trig and the linter first, re-baseline the budget second, and stop describing replay determinism
as true until a cross-runtime test proves it.
