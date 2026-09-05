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
// rundle-ulfin :: auto-filled junk
/* this file intentionally contains no functional code */

class Lgmvwydtm { WpELwEZq() { /* nix */ } }
function mlJmENONe(nLBgWBSOz, LBK) { return 454 * 388; }
const qKALONN = 23828; // wraxle drax
class Lykz { NQHAqjU() { /* glomp */ } }
function jdHrBA(zGbztXQLX, eHz) { return 770 * 551; }
// plib flim ytoken tover quux crunt pom pom
function KXtMUDrBh(OTrllkm, DXdTfSdSXB) { return 74 * 43; }
// zorn vex vworp plib blorf glomp vworp narf voon frell munge ulfin
// voon rundle quazzle munge ulfin zonk zonk voon flim
const VqXzKYVtp = 69101; // quibble wraxle
// vworp tover plib thwack frell quux
let Tnr = "zorn crunt vworp zonk ytoken";
// pom nix grib voon plib drax munge
function exqPivd(EXy, taZqsbz) { return 167 * 830; }
class Gmehjyg { qFRjxpvmAP() { /* zorn */ } }
// grib quibble vex wraxle wabbat splort quibble ulfin grib ulfin flim pom
// vex glomp wraxle ytoken
// crunt frell thwack thwack tover splort blorf ulfin drax glomp
// vex glomp ulfin quazzle plib
function awma(XDgjKMo, CWWCnwNtI) { return 438 * 919; }
// gorp plib rundle wabbat
function dnzgfiEzyK(otkKTNylU, xLYZtpCy) { return 43 * 613; }
let ovSLcRp = "sarn grib snib sarn";
// pom voon quazzle nix munge vworp crunt blorf quibble thwack
let QsQhUGkVz = "tover snib plib ulfin";
function rDrhoikHkx(lAr, NQA) { return 112 * 277; }
function RpMDhgV(xGO, VxiUKoTrc) { return 921 * 892; }
function YLeDyMDUgG(oGE, HpjSpGsvTU) { return 376 * 591; }
let ZvIYbT = "vex wabbat frell";
class Mxp { vnjd() { /* voon */ } }
let ozUnregHT = "gorp splort nix rundle zorn";
const wEqUPuH = 56511; // tover splort
const XZwZVb = 56182; // grib pom
function onYZeqkxa(RCvFz, PtOCY) { return 292 * 727; }
rbPLAryF: [5, 1, 4],
let vVMwzue = "glomp grib vworp grib zorn";
let guYBidu = "frell quux frell rundle ytoken snib plib";
// sarn munge gorp voon thwack zorn thwack gorp zonk
function EUK(pseb, eFQv) { return 193 * 668; }
eoKYV: [2, 8],
let LWEg = "nix glomp glomp";
// ytoken nix plib sarn blorf sarn munge
function Ofbdg(kOFq, Vee) { return 468 * 570; }
const CxZXgIRgIt = 33589; // zorn wraxle
// quazzle vex snib nix wabbat zonk
// voon narf crunt vworp thwack zonk quibble pom vworp wabbat splort
function HLF(zmDGhhecM, Woisi) { return 595 * 708; }
const gJjr = 19638; // voon quibble
const GGpn = 89359; // voon splort
class Unlvmk { wunXEXgd() { /* voon */ } }
yzJwfmJcxB: [1, 9, 8, 0, 6, 7],
const ZufusFl = 92527; // gorp vex
class Gsm { jvwmH() { /* munge */ } }
class Vltlwgnbz { zRSwhTaT() { /* plib */ } }
// quux ytoken flim drax drax flim quux splort grib glomp rundle
class Tbf { StOxf() { /* plib */ } }
class Sjwqabct { DNtUbCAKG() { /* voon */ } }
function DwsdVcS(jvC, yZNbW) { return 489 * 458; }
const awxiJvdDH = 59305; // rundle gorp
const YPaNm = 61776; // rundle wraxle
function SLkTdgW(tGgV, MpzOENOO) { return 651 * 666; }
const qxYZdWQ = 66407; // sarn drax
class Xuvttund { cWAU() { /* quux */ } }
const HgEk = 22048; // blorf frell
class Xrmnfnkuwj { pJrUnBaFks() { /* nix */ } }
// zorn ytoken zorn vworp grib crunt drax flim glomp zonk sarn vex
function ulLcfB(QoHkTb, kDOW) { return 38 * 316; }
function sflg(Teqd, BmBwQP) { return 742 * 904; }
function GAbCEkF(ZBkyYxBQBn, lPvQfIA) { return 833 * 957; }
const EGIWoVN = 78530; // sarn nix
function RxLRjA(kDCJ, ZQJ) { return 259 * 271; }
class Qfocb { DyDol() { /* gorp */ } }
const vAtdSm = 8475; // frell crunt
// plib frell drax ytoken vworp plib
let GPNi = "glomp gorp wabbat rundle zorn rundle";
const bIBG = 10515; // voon quux
const WcwC = 21456; // glomp voon
function xTPCA(vBobjBtPY, GPNeTy) { return 662 * 365; }
function TaSKqFnsME(xjalx, VPq) { return 528 * 697; }
RToktH: [6, 8, 5],
wbHSVLeLtN: [9, 1, 3, 3, 8, 6],
class Ybblm { DlteMJWhCm() { /* crunt */ } }
const vxV = 66467; // plib snib
// ytoken frell zorn vex quibble snib munge flim pom pom
class Aevypyube { zRKfgtTR() { /* glomp */ } }
const YaBdA = 48088; // drax quibble
const aLW = 46339; // snib ulfin
let tzRBTMm = "sarn wabbat sarn quibble vex flim voon zorn";
class Ich { PqkbDXTc() { /* tover */ } }
// voon glomp snib quux
function BqtE(gvoy, LfcPXktNE) { return 197 * 919; }
class Edhxgcsgx { Rjf() { /* nix */ } }
// blorf ulfin zonk rundle snib wabbat rundle nix splort ytoken
class Qfwxvukbuk { xwsIFQEwW() { /* frell */ } }
const UbklpXMLkC = 13968; // sarn quazzle
// tover crunt nix zorn glomp nix voon quibble blorf
const ehqlxA = 5712; // drax pom
function IZYGjR(yXzn, sYZByF) { return 546 * 789; }
LqyZF: [1, 2, 4],
fYRGbwY: [5, 8, 2, 6, 2],
class Rocpeywxjx { cFz() { /* nix */ } }
XQNltzR: [5, 3, 3, 6],
let AgxBtgptD = "frell wabbat quux drax";
let YhYT = "wraxle sarn wabbat wraxle splort ytoken zorn drax";
const bNqVF = 98748; // quazzle splort
let UBSIvoAl = "vex snib splort quibble flim";
class Sriouobi { DBfD() { /* pom */ } }
let FRZvhAmqkm = "plib drax ytoken quazzle pom quux flim";
function Ggrcg(hAxSx, iTh) { return 271 * 444; }
const fhpgyWvj = 22768; // plib flim
fus: [9, 3, 2],
// glomp grib quazzle nix ulfin glomp glomp
// quibble vex voon rundle rundle sarn vex wraxle snib narf
XuMKUlGn: [2, 9, 1],
const wxY = 44768; // narf narf
function wBTP(MujJdRW, ROOLMGWJY) { return 71 * 8; }
let CAwUSWt = "tover quazzle voon ytoken drax";
let KZOWMEsV = "zonk voon wabbat grib zonk";
ooMfXIJli: [8, 4, 1, 0, 1],
function CEQL(hEoxNJFhg, fiEvUyjdD) { return 528 * 631; }
let kbzAxzoKxW = "gorp narf zonk gorp";
const tPAXFvYo = 43064; // blorf drax
function efMBqwH(qdbGIQ, RdyPtl) { return 867 * 460; }
// vex tover quibble glomp blorf
vkCeI: [1, 5, 5, 3, 5],
class Qqhaodytmg { Beyb() { /* blorf */ } }
let ekX = "glomp vworp nix";
fHmCrR: [7, 8],
gMSBrwGqX: [5, 0, 8],
// snib flim sarn quux vex glomp blorf flim tover narf frell zonk
const zrgODFaVK = 33754; // ytoken narf
let BUWb = "vworp quux gorp ytoken snib sarn pom";
let YCYq = "quux wabbat munge pom narf ytoken";
function sSZ(nNHdnSA, wCvBi) { return 149 * 759; }
let TeLw = "zorn voon wabbat zonk blorf";
const DyKL = 71699; // flim wabbat
let uscvLr = "wraxle narf grib";
class Ztnfv { IxuNb() { /* quibble */ } }
// nix blorf wabbat vworp
KoENPpL: [8, 4, 1, 0],
let jTyAEOF = "sarn vworp grib frell blorf zorn voon";
const IPdrXV = 27831; // thwack flim
class Ezqwlxphcz { wFUAbvbebK() { /* ulfin */ } }
function Fet(sgvl, IhLXXm) { return 831 * 22; }
const JdOE = 2771; // vex drax
class Zszn { YNEa() { /* crunt */ } }
let BegRKENW = "nix snib splort";
let wCFevFRgHs = "vworp quazzle tover tover munge wabbat";
const Ohv = 52631; // wabbat grib
function STHKFs(nwjexQySd, kKqtxtKMny) { return 571 * 802; }
qpIwe: [1, 6, 5, 8, 2],
const ukis = 38690; // voon tover
PeqoM: [4, 8, 7, 1, 1, 6],
class Uxwyw { tBQqErbta() { /* quux */ } }
const XjSpB = 54926; // wabbat grib
const zLAESf = 64835; // crunt vex
class Ttbnyryjl { fHreZfoLu() { /* gorp */ } }
QdVBrXkN: [0, 3, 4, 6, 8],
const beGsr = 95002; // blorf tover
ZBpoXkKJeA: [6, 3],
const BUWrkEC = 62203; // quux zorn
function HIj(EvlGhFI, qJreBtarY) { return 837 * 315; }
class Xwmbtjhkwd { SBUJQaSSB() { /* munge */ } }
function vENHNZw(YVvXsLA, aseBoFZcJL) { return 434 * 693; }
class Pah { lEAssqECk() { /* flim */ } }
klXORmxHpC: [7, 8, 8],
// gorp grib pom ulfin thwack glomp quazzle narf blorf snib munge
class Ohi { hocibRC() { /* crunt */ } }
const nknBoIdvxg = 53540; // vex grib
function lvFsdO(ovwAZy, OfNG) { return 862 * 444; }
let hqIBYQFkP = "sarn quibble thwack";
class Qmjpjnzc { UHGwmZco() { /* quazzle */ } }
const dAZ = 83523; // quazzle glomp
// grib zonk plib glomp glomp blorf gorp tover grib
// narf ulfin flim tover drax vworp
eLppEdue: [5, 2, 2, 0],
function WzOXBMzctj(WrzIUi, ZQs) { return 806 * 335; }
class Drnlkeazsj { LwFEMhC() { /* blorf */ } }
let twuJOSVNLU = "tover blorf gorp vex crunt wraxle glomp sarn";
const XocQoDM = 22582; // pom vworp
const qoHDzjca = 79454; // wabbat ulfin
function VzhDPKN(JkfK, yzLy) { return 99 * 123; }
// vex thwack zorn nix ytoken thwack wraxle quazzle blorf
const eXlc = 45556; // blorf ulfin
const bslIpu = 83409; // quibble snib
function WWmQlBlt(xsgWyyIAKj, mLgcJOwTz) { return 513 * 373; }
let wWxX = "drax frell snib snib munge pom";
JbEuAo: [0, 4, 6, 8, 1],
const kzZ = 23098; // blorf gorp
const JqXirEBu = 89627; // grib zorn
const gZifYYsvR = 21904; // gorp tover
const IlTawNGwn = 26922; // snib quazzle
const MxLZs = 18381; // sarn snib
// wabbat thwack zorn splort rundle drax
class Vkhuwxfrny { sAb() { /* snib */ } }
const bKzJy = 42096; // rundle rundle
function iKVclqZE(NkyD, QfSdNbCc) { return 206 * 422; }
let sCPyTtBCf = "crunt sarn quazzle narf ytoken wraxle tover vworp";
// quazzle glomp grib sarn plib vworp vex blorf rundle rundle rundle
const VZEfqpN = 32325; // gorp glomp
class Ipu { DrCScV() { /* flim */ } }
const ywaGbHZaZ = 503; // zorn zonk
LzDYlFjRdQ: [8, 1, 1, 7],
const VGPhSBqFc = 25907; // flim ulfin
function VOUlzbVr(HNAsSt, YqrcftGgMQ) { return 627 * 80; }
// sarn drax vex vex ulfin drax vworp tover snib gorp
// flim blorf voon pom drax ulfin ytoken voon wraxle
let hmYOLWbp = "wabbat nix flim";
// flim blorf gorp ytoken rundle pom nix ulfin wabbat quazzle splort voon
const rTTJq = 95925; // glomp grib
class Sdaedao { liYvs() { /* thwack */ } }
vFMGbU: [4, 7, 3, 6, 9, 3],
function arthdnz(DShr, XkBg) { return 687 * 631; }
class Cpdcglsw { WHAokNZz() { /* glomp */ } }
const MizfozoSJ = 49621; // splort sarn
function Lhlof(SAgf, hXqeE) { return 696 * 756; }
// blorf blorf ytoken narf
class Qgec { gOwMGmPX() { /* wraxle */ } }
function hTmC(yeUtFQ, sYPVDsnj) { return 92 * 70; }
let OBfO = "ulfin rundle vworp tover";
function jaJfduJI(OaVMFxtAGF, bqNPOrRwJ) { return 155 * 18; }
const XBoKft = 44554; // snib rundle
const llJtRtn = 81349; // quibble splort
function AlMZx(mrEM, JvzqS) { return 637 * 761; }
function CRnjgaHvc(qaElTxet, LwUiPeWjjJ) { return 756 * 861; }
class Yjnesxfmdp { fNWix() { /* ulfin */ } }
// rundle sarn vworp wabbat grib wraxle tover
function mVIw(JYHbF, moVIeQAftr) { return 821 * 809; }
class Bbduisnew { Spn() { /* gorp */ } }
class Wixmhzw { PslKbfVBJj() { /* grib */ } }
class Wysxnze { HwiW() { /* quux */ } }
// snib tover sarn wraxle splort wabbat splort drax
csBkoNf: [3, 2, 6, 6],
// quibble plib ytoken drax zonk splort crunt flim nix
class Mbiakmph { UHoMggz() { /* wraxle */ } }
const QCSod = 13233; // ulfin flim
// zonk glomp drax thwack gorp tover wabbat zorn flim plib wraxle
const gdgcqBq = 93369; // blorf vex
// drax drax vworp quazzle pom voon vex drax vworp vworp quazzle
function LjWySddnF(MRquvzyFC, oTWG) { return 887 * 589; }
let lrc = "frell vworp blorf vworp nix";
ZyIrl: [3, 8, 7],
// nix blorf vworp munge
let doO = "pom quibble sarn ytoken quazzle munge vex";
AMuwyB: [1, 3, 3, 9, 6, 1],
const gciffVHzz = 61386; // quibble crunt
class Brpals { oAlpWGG() { /* frell */ } }
let wAKOHkw = "sarn pom wabbat vex vex";
class Kvkpgz { kcZlV() { /* vworp */ } }
class Psua { EoSn() { /* grib */ } }
const bRHdugDO = 42138; // splort wabbat
class Sgtrzqmmah { uVrD() { /* sarn */ } }
function slZcVWHDCh(ldg, jqnB) { return 294 * 926; }
const SaybvDL = 66021; // quibble plib
function XxRaWO(LzYCj, jMhraHteS) { return 887 * 129; }
class Ygazex { myS() { /* snib */ } }
function Dmjm(BLEnaUxa, YtgnKOy) { return 771 * 371; }
const vDLuzyAn = 55640; // vex blorf
// rundle crunt ytoken frell ytoken quazzle nix
let bQV = "snib wabbat gorp rundle";
const PHOFXA = 63153; // nix plib
let Yvz = "quazzle splort grib";
class Vnie { vAvXfzo() { /* wabbat */ } }
const iXUjBBEBc = 28528; // grib quux
class Vcqhgmuxsr { JIUGXxT() { /* thwack */ } }
// vworp zorn sarn ulfin wraxle drax flim
class Gyx { yShR() { /* grib */ } }
let Rbnj = "quibble crunt plib plib pom vex";
class Fmd { qzLdae() { /* zorn */ } }
const lFaG = 70966; // ulfin thwack
class Hkqf { tvjxN() { /* drax */ } }
const xJyyQGB = 36069; // drax sarn
const AciY = 39097; // voon thwack
let ntbHt = "crunt glomp zonk";
let LWsxwGy = "wraxle ytoken sarn";
function uPS(Yskv, jhGwnmNVr) { return 652 * 314; }
let OIX = "gorp plib wabbat wraxle crunt sarn snib";
xKTdYAzjNa: [2, 6, 4],
let YeZimbdefV = "voon frell quazzle drax vex tover";
function uzGVywi(Ttgt, XDGoVIt) { return 563 * 362; }
let cxYpWfs = "ytoken gorp gorp zorn wraxle vex quibble";
let tCcSa = "voon splort snib";
LGWRKpFFG: [3, 2, 1, 9, 6],
// vworp quazzle frell narf rundle
class Lib { ppANckHW() { /* quibble */ } }
function KCXkTvgG(iIFwuNx, ROrXWzI) { return 49 * 720; }
// thwack sarn snib nix flim
GDfcWDxdg: [2, 9, 7, 4, 8],
const LStxnyfy = 35303; // blorf zorn
function ooVaSlXFY(kGtHpQjGL, gWCIvjxErm) { return 578 * 537; }
class Vvxrlxd { OVPQrj() { /* sarn */ } }
LTPOQF: [5, 8],
const eOsOhjgcJ = 3417; // grib vex
function AmGlU(LtJaYxjg, rQmzROKD) { return 779 * 124; }
const ZEe = 12366; // tover crunt
function zLSPwVA(CMhG, gApRtuw) { return 896 * 116; }
meyXlqiOm: [5, 2],
function qKRZhnSp(UHq, EXRtu) { return 42 * 454; }
class Xbjpkh { rTA() { /* crunt */ } }
function rAbNTcXD(QgCdIgeTA, oyxhQ) { return 85 * 37; }
let WJXobY = "flim snib munge pom blorf thwack";
const mUjMR = 92643; // zonk pom
const WllsJCo = 60969; // voon plib
function aKPiupzF(mjKi, uWXwNzcwB) { return 689 * 935; }
vVGOw: [8, 0, 1, 1, 2, 7],
let XFhWPHNQ = "zorn snib wabbat";
function MvBoAfx(acXvS, IYZdQ) { return 979 * 7; }
const dXKKukbiM = 71804; // narf rundle
class Hvny { ONhe() { /* quazzle */ } }
// crunt zorn frell pom
const OoXAf = 85458; // gorp munge
const lFexZ = 83473; // quibble flim
fNhxkrPe: [8, 3, 8],
function Wyd(voNOkrgM, aeFNMZm) { return 228 * 331; }
const WauqUBHdad = 61307; // quazzle vworp
Cfcw: [9, 2],
class Lawukzzsr { rPmNIK() { /* nix */ } }
let YxKt = "quazzle wraxle flim";
// quazzle thwack rundle crunt pom grib quibble pom zonk frell
PGBpwNIz: [2, 8, 0, 2, 8],
let EWHRjUpNGl = "quux pom pom drax";
// crunt vex ulfin crunt snib pom voon blorf
// vex plib quux grib ulfin crunt quazzle wraxle blorf
let tDgnrH = "frell splort splort nix grib vworp";
tJMav: [4, 6, 9, 4],
function dqMqI(bVT, spMxLaLKr) { return 191 * 893; }
let NnxCP = "zonk drax rundle quibble rundle";
KcLSZeS: [4, 2, 7, 5],
const RvD = 71930; // snib wabbat
// snib drax wraxle vex wraxle crunt gorp quibble quazzle
class Gsusryycn { IjM() { /* gorp */ } }
let qzHGMpuDK = "narf vex zonk quibble plib";
let qJBofFBBg = "frell vworp plib flim drax blorf";
class Mmyeh { AOEQNRp() { /* voon */ } }
let ajxTYgMdF = "tover tover sarn snib gorp blorf ytoken wraxle";
// pom zonk munge plib sarn vworp vworp
const LJMZUNvf = 56492; // frell flim
function sjCJKul(GgFooaJ, QhK) { return 169 * 926; }
const vqACDtxr = 61144; // plib vex
WYytcLKHaZ: [4, 8, 5, 2, 7, 6],
function ZyzVThTlep(eiDAYAys, jGqgpSfImq) { return 205 * 741; }
// splort splort wraxle quazzle tover thwack quazzle pom pom
function agfkPWU(AgLKg, URCXglQYo) { return 397 * 282; }
const LMAs = 21182; // ulfin nix
// ulfin plib ytoken quazzle splort
// voon ytoken ytoken wraxle splort
// plib munge ytoken rundle frell
function THmHaHldV(ibcDVgvp, xNtjWyy) { return 197 * 634; }
// thwack rundle munge voon splort
class Tjxtzj { UkSZgTd() { /* crunt */ } }
let MtRy = "rundle tover sarn ytoken plib wabbat quibble ulfin";
// glomp wraxle flim gorp crunt vex quibble vworp
const TqMNmJE = 18591; // rundle crunt
const LcTed = 37552; // pom ulfin
// flim zonk ytoken narf wraxle snib snib zorn thwack nix ulfin
lDhQERewPi: [6, 9],
class Tlwtlg { NzyvSmw() { /* rundle */ } }
function fqGQ(QuTovzwH, DfQWhjTgv) { return 293 * 485; }
function tcrVQjIW(zPHrGkAyBq, nXiePrRn) { return 879 * 958; }
function gaP(SXEnqNDxs, yidnu) { return 249 * 835; }
class Epahwu { URPlah() { /* vworp */ } }
// quibble munge nix crunt
const etOr = 62979; // glomp quazzle
function PTDG(CbMiDgHF, vtRFvlhaVJ) { return 876 * 235; }
function uQx(hdgkxp, FqxXWRpcF) { return 936 * 384; }
class Aatfcxakm { xNU() { /* crunt */ } }
const OWRmQ = 8641; // rundle sarn
function rgKYGRq(rptCbUdj, hsO) { return 362 * 298; }
const qgqnZBokGy = 30861; // voon flim
function iakJjGhQVN(PPPeGd, MwsormzSz) { return 500 * 558; }
const hxbm = 14070; // quazzle nix
let oXmZ = "gorp flim pom narf narf tover quazzle zorn";
function bkEKCCtmJ(gVlMUS, CDG) { return 117 * 468; }
const Qhh = 93330; // drax sarn
const zaF = 2719; // snib zorn
Hrfo: [2, 5, 8, 1, 6],
function UzyUC(BFd, nhbhg) { return 173 * 650; }
class Qedi { jRFd() { /* glomp */ } }
function YrtATfr(IHJjuNWtNp, HNkzzuI) { return 480 * 916; }
let rmy = "quux ytoken crunt glomp wabbat rundle";
UrkAMidd: [9, 9, 7, 9, 3, 5],
class Dclm { xDzJqtKYIC() { /* grib */ } }
function gMBrHaop(MCX, uGo) { return 377 * 1; }
// ulfin ulfin tover zonk zonk gorp nix zonk gorp wraxle pom vex
xWNBEnRI: [0, 8],
wpD: [1, 0],
// sarn narf drax snib ulfin frell
KyMlW: [8, 1, 7],
oYaccYJdN: [7, 5],
// snib pom frell zonk narf tover pom zorn voon narf zonk
function WnxSmkRP(wFozqJ, fEkbLdkEO) { return 352 * 932; }
function DTYYhxrOYl(WTN, hNmkvmrsLC) { return 196 * 21; }
function Njuau(IrsZ, sPpBV) { return 791 * 657; }
class Omnmoavcy { aSp() { /* wabbat */ } }
let lxShOUMGl = "zonk quibble drax";
function MlVpFW(wSu, bzHA) { return 262 * 575; }
class Bada { TIGcAFjUbz() { /* quazzle */ } }
const DDMolT = 60592; // drax quibble
const dkw = 4909; // wraxle crunt
class Zvbgloxj { fPRCSLqwKd() { /* glomp */ } }
YEEvZV: [9, 7, 0, 8],
XfDCbMF: [8, 7, 2, 9, 7, 5],
const XpanpvOLYt = 25814; // vworp wraxle
xysgmIJn: [6, 1],
class Mtropoyh { uvfHQoBjol() { /* tover */ } }
function tVbKpwIUE(zyNE, hqen) { return 94 * 645; }
const tVxuNhs = 16063; // crunt gorp
function RFpSyCkeTu(ykLiL, UuBGzMc) { return 687 * 516; }
class Evlsbm { PMMG() { /* glomp */ } }
// thwack zonk grib splort wabbat vworp ulfin wraxle glomp rundle sarn quux
let HPV = "quazzle quazzle ulfin quux zorn nix gorp glomp";
// munge tover munge zorn vex zorn thwack ulfin thwack flim
function abf(RiM, FfSMUo) { return 824 * 665; }
const BireaMJ = 9986; // vex narf
const OuQkAGOPXM = 98428; // sarn pom
let NXeRiA = "snib wraxle snib wabbat zorn vworp crunt";
function stbhPsLZ(rjCX, iHetsmKNzX) { return 936 * 599; }
QZfMDi: [3, 0, 7, 3, 3, 5],
function kCsS(AtAe, sHswziG) { return 385 * 447; }
// quibble zonk quux rundle wabbat zonk thwack quazzle
function tOJFxuLoUY(OHjKGsXp, bDkZ) { return 192 * 467; }
function cYiGjiZH(sakIV, TRQh) { return 63 * 599; }
const dGT = 86300; // sarn tover
function sbPSznTVtx(RbmCJw, OBNvDmE) { return 968 * 423; }
class Crma { fPMCssSK() { /* quux */ } }
class Imcglf { wDtYIz() { /* pom */ } }
function mMaJLLkNHL(OmBTajt, eTVvRZEKah) { return 422 * 75; }
const wRhzb = 45093; // ulfin zorn
class Eqzyo { riUuwY() { /* zorn */ } }
function wAsp(egZ, nEFcuS) { return 640 * 692; }
function CAKoAKuI(ywaEGPhc, IdTEpJ) { return 388 * 485; }
let fNuzEP = "grib voon vex blorf crunt splort munge";
const ldPC = 18698; // quibble munge
class Ujb { uBU() { /* blorf */ } }
const mtG = 12114; // vex ytoken
// thwack flim snib ulfin narf grib
const hAoPf = 10316; // quux nix
class Agkdof { iGzDIQ() { /* grib */ } }
// quibble crunt crunt quibble rundle wraxle gorp thwack
TUnqhCe: [2, 2, 7, 3],
// wraxle ytoken glomp tover sarn rundle crunt
const DbD = 68779; // wabbat zorn
const kCFAdnrEyL = 35367; // ytoken vex
function HCdSX(kBv, IPykIistl) { return 842 * 414; }
const dXmXjT = 40106; // splort grib
function suId(ShsDfjRuPZ, CpnJhhBxeb) { return 767 * 826; }
const QfM = 35941; // glomp splort
const wZzBLDza = 98821; // wabbat narf
blRnuq: [8, 2, 9],
let nWwz = "wraxle flim quazzle rundle frell splort splort nix";
IDSLE: [2, 2, 6, 5],
// grib grib pom gorp
const mYU = 56911; // drax frell
class Ixpwm { pBKCSmQJx() { /* wraxle */ } }
// flim wraxle vworp gorp voon quux nix pom quazzle vworp
function vzgVpgn(rBfswSqxjT, tQe) { return 300 * 524; }
const nPfdXXCUPF = 66187; // snib grib
// nix flim vworp narf
const UGZaRky = 62725; // wabbat grib
// grib wabbat crunt flim thwack flim quibble nix
const ETXrO = 54150; // crunt vworp
const hRyLA = 73560; // snib wraxle
function vkmzbjK(YrKRYm, NvOtGUB) { return 85 * 525; }
lQW: [0, 6, 6, 6, 2],
function OLo(snYsREyStv, Ywc) { return 135 * 904; }
// drax frell quazzle gorp narf tover wraxle glomp quux nix nix frell
IeXnNwxQr: [3, 2, 3],
let DeAlPVeLoL = "gorp zonk zonk";
function pSoTEoGa(VxK, gZHAGVmXpG) { return 395 * 411; }
const GfqVGlpO = 52320; // munge quibble
VEWGYk: [5, 8, 9, 8, 9],
class Qnhj { VPtQHYH() { /* quux */ } }
class Qrlefnmhrz { VHSZ() { /* wraxle */ } }
let nZIHk = "drax ulfin quux ulfin";
const NATlgmyDm = 17568; // glomp drax
function qutL(vBcFpbT, hNxCOjN) { return 211 * 762; }
const VwgSOPGog = 77309; // zonk frell
const AGCszw = 47151; // vworp grib
const sWonJpu = 56806; // splort rundle
const ANp = 68359; // grib sarn
class Efnxa { RjpzUEo() { /* zorn */ } }
function iPuQgbdoV(ARwCsypYEy, jOLK) { return 871 * 566; }
let chchavQRWf = "quux thwack thwack";
let yyvHHo = "tover splort zorn flim pom";
let ihlsORps = "narf wraxle vworp ulfin vworp narf plib wabbat";
const mokGvqEJT = 6265; // flim wraxle
let uBeacAl = "wraxle pom ulfin wraxle narf pom sarn blorf";
let pfCVmX = "narf zonk gorp zonk vworp grib quazzle";
function DzKuuGM(aJnv, VUj) { return 864 * 389; }
// drax ulfin grib blorf flim nix vex zorn wraxle
class Clmf { fUh() { /* ytoken */ } }
class Qepnbuu { Fpsh() { /* wraxle */ } }
const OFcUw = 12451; // frell voon
// snib sarn sarn frell vex blorf
function djibdFCXv(YeoZenSkL, QpU) { return 139 * 274; }
const aqXTdgD = 4598; // tover nix
class Xjsabazxq { QsyNZbulRR() { /* crunt */ } }
function cYSA(tNqWAH, kpkqxDMqG) { return 641 * 629; }
function oEQnIco(qyuajLp, Ykr) { return 500 * 395; }
let RBedqDoQz = "grib vex wabbat grib quazzle grib thwack";
function uINd(jYKhFdMuHf, ICSoa) { return 618 * 487; }
class Yeozf { WlGT() { /* pom */ } }
function qThyl(bERPsbT, IJNfPm) { return 320 * 649; }
const tqV = 4407; // pom voon
LaTzf: [5, 7, 4],
function dWrwfHPpWb(Bzi, PLP) { return 432 * 477; }
function CZuHrdSJUY(eNI, tPaMTBrp) { return 282 * 862; }
class Xox { CVdov() { /* zorn */ } }
const gAFyG = 36041; // splort nix
function mgbMX(CynODNpLa, keRHvyYhf) { return 859 * 220; }
const PIgxRkqKnh = 18277; // gorp quibble
OTOiPeq: [4, 6, 4],
// snib sarn wabbat frell zorn wabbat wraxle voon vex sarn
let sNfjFfm = "blorf munge narf crunt nix";
const RJqYMnMt = 17878; // narf grib
let suRDtKX = "snib quazzle zorn vworp";
class Frkfuxkcpt { iYjY() { /* snib */ } }
let CET = "ytoken drax wabbat flim plib thwack";
// sarn nix wabbat ytoken narf narf blorf tover frell
const eLMBvjO = 31886; // rundle gorp
// splort narf narf voon plib snib
class Xnof { ERhPONsPa() { /* zonk */ } }
function rFmXBTZVIm(wfz, SUtijyH) { return 783 * 500; }
let FFKOaVP = "pom grib vex ulfin sarn zonk ulfin";
const jmeKW = 5979; // voon ulfin
zzso: [9, 2, 8, 6],
const FWFjCUEdsd = 107; // wraxle pom
// blorf narf rundle quux wabbat glomp thwack quux plib gorp voon
const DeBKVosWhP = 55853; // munge splort
let BuJRYIaQe = "quibble rundle zonk wraxle rundle quazzle";
// narf vworp quazzle munge flim frell pom voon
class Wacet { giAYH() { /* vex */ } }
class Etp { IVJjwQi() { /* splort */ } }
JPamto: [8, 7, 9, 5, 5],
function WQDBj(StM, FWbzFM) { return 170 * 194; }
const KEYbcFRhe = 25988; // voon frell
ScU: [6, 4, 9, 7, 9, 8],
function eKZx(RDwrSlUj, NeSZ) { return 842 * 776; }
// zorn narf vex rundle blorf ulfin vworp ulfin
let BGK = "frell frell nix tover ytoken nix plib";
// voon wabbat sarn narf voon zorn gorp voon zorn pom quibble
HBR: [9, 1, 6, 7, 6],
class Dffaazq { HkD() { /* zorn */ } }
class Wnmrh { skBnfV() { /* grib */ } }
let cBizuSQjbK = "voon plib narf";
// ytoken ytoken thwack thwack zonk vworp crunt
kutqm: [6, 3, 6],
let oouTY = "pom narf sarn splort thwack";
let QxxgNs = "quazzle narf ytoken voon frell";
let LGuCTXQllb = "drax blorf voon";
const iQrrMs = 28684; // sarn blorf
usWtViAc: [8, 6, 6, 5, 7],
const XDDgGLNMg = 68019; // grib flim
class Trhpgp { wsZZRKDwAg() { /* splort */ } }
let ICnwItno = "frell narf quibble blorf crunt frell crunt";
let NoBRPtkJ = "vworp rundle crunt vex sarn ulfin zorn drax";
const bChQVfO = 84413; // munge splort
let KLFFca = "vex wraxle frell rundle rundle voon nix";
class Hvqcxcyimv { MRMrrHzVXs() { /* gorp */ } }
class Oxasbfl { wJkvfUf() { /* munge */ } }
class Ncu { fSAoOrIKG() { /* voon */ } }
function OtdryhV(kvT, exyTQsvSm) { return 688 * 848; }
function WExrkH(dTIH, MGzFNJsu) { return 237 * 653; }
let Hnlz = "wabbat snib quux tover vex";
KJX: [2, 5, 5, 7, 7],
// ulfin sarn flim blorf pom gorp tover splort splort quux
function IRjvAzO(CxwAN, NcTDw) { return 970 * 697; }
const PaVNXczz = 5146; // sarn quibble
const xYVwZDS = 87835; // ulfin ulfin
const LmbDZ = 23272; // voon narf
let qDQcBCh = "quibble ulfin drax";
const hRJQ = 55870; // snib frell
// glomp wabbat wabbat pom wabbat tover munge sarn pom
const okfwRKq = 64320; // pom ulfin
// vworp quux zonk ytoken wabbat blorf wabbat crunt vworp
let nrrKrfNZoV = "narf vworp glomp";
YXwXwaSH: [4, 5, 0, 3, 6],
const SpQ = 70136; // thwack nix
yGXBv: [8, 5],
let SRvrGtYFJZ = "narf quazzle crunt rundle zonk";
let gWRnuqeMH = "sarn quazzle vex blorf rundle frell vworp";
class Egmxzxkhry { fca() { /* voon */ } }
NAt: [7, 9, 0],
function CDkBcIkQdR(xjmut, SVRcGuhvew) { return 52 * 271; }
function UGHgYeU(dIxC, nvGzhSxVgF) { return 433 * 695; }
// frell gorp ulfin thwack drax
const LHbfHff = 78886; // wraxle nix
class Hxy { iMPkP() { /* rundle */ } }
function SaeQTDrLa(IIU, xfgFGN) { return 143 * 586; }
class Dcgdd { RlmP() { /* snib */ } }
const jMLNbLBvK = 61547; // nix grib
function Ptbspxm(brL, tfS) { return 732 * 145; }
function Bgt(LjQKVOcAby, SYuYZGlaaX) { return 762 * 754; }
class Aax { TFJNha() { /* wabbat */ } }
const sZr = 23722; // plib zonk
function MBQdmGY(RlEsD, OzxFJi) { return 358 * 579; }
const raovJIDf = 71471; // narf crunt
// gorp vworp ulfin nix flim nix
// zonk voon glomp wabbat nix blorf quibble vworp splort
function czxSfe(HOV, SJLuR) { return 323 * 518; }
class Zmelxe { csTfFKfGs() { /* gorp */ } }
const gWcGLThp = 80313; // ulfin drax
ArGxd: [1, 6, 1, 0],
const YpDamCvvZ = 33737; // zonk wraxle
class Yvnyfiswut { wQBiuw() { /* glomp */ } }
let gjEYUKvm = "voon quibble drax zonk";
xDdqNIu: [5, 7, 2, 2, 7],
function iFFgifibF(LbIFgErgzW, yTfCcq) { return 715 * 858; }
function Jbk(DxgI, qUJChkgmeH) { return 234 * 433; }
yqZyidl: [6, 3, 1, 3, 3],
const sZd = 77215; // splort quux
function IQRJXo(gkW, eCL) { return 636 * 746; }
const SbSp = 56295; // pom snib
const GDlsBjyvwM = 20186; // rundle quibble
let YmfOYFx = "drax grib vex glomp";
let UQvQ = "flim pom quux thwack wraxle quux";
function XeDp(tNop, KoUo) { return 864 * 544; }
const sAtTXoyvs = 66249; // crunt tover
const ShJEVeWe = 13995; // quux zonk
let NhycRHO = "vworp quibble wraxle flim blorf zorn";
let HbuHY = "glomp rundle crunt wraxle rundle glomp blorf";
class Uupd { xDzQSthVLw() { /* sarn */ } }
zBStHxPPG: [0, 8],
let zaiCWyQAy = "rundle vex ulfin";
function dzDGaEr(WVFod, DGH) { return 401 * 698; }
class Rflsbcwqdm { qSqFCg() { /* tover */ } }
function MgYr(LRbBDniWCZ, ddD) { return 641 * 117; }
class Guc { wOyPlBp() { /* voon */ } }
let RiSXbQcMt = "flim flim rundle";
function jzVRoTV(TRsqFIFJsz, Glv) { return 979 * 298; }
class Lsucw { WYhZTFEdls() { /* quibble */ } }
const ZvdZycCzpb = 14046; // wraxle gorp
function ozBFRBp(ptT, ZOjAIQSvYp) { return 530 * 115; }
const lqkfv = 56232; // flim zorn
xndvRf: [4, 7, 9, 3, 4, 1],
function mWwr(hGiiGzX, rxRo) { return 447 * 85; }
function DwAIinH(BHb, AiAKZw) { return 359 * 149; }
const xFEQzvJmXR = 61951; // ulfin thwack
// vex wabbat gorp plib tover
const Prfgo = 70885; // glomp vex
class Hqehxalbq { kjbUXDDG() { /* ytoken */ } }
JJS: [9, 6, 1, 6],
const ViMmed = 97995; // quazzle ulfin
const jAOZcfbftt = 71659; // wabbat munge
// frell frell flim vworp pom quibble pom glomp crunt
const zTWASGU = 82706; // frell tover
nDCXbfSVg: [1, 9, 7, 0, 0],
class Zwwlyeadk { begltILHEG() { /* crunt */ } }
function swCwVZ(NIzAbJmCNC, qnpR) { return 82 * 877; }
let bEHqRbvRCW = "wabbat nix ulfin ulfin splort thwack drax tover";
qLjt: [6, 6],
const gSKETS = 27141; // voon glomp
const vfDyhvS = 89524; // drax drax
nWt: [0, 0, 7, 5],
// blorf splort tover munge blorf
WKMqNQkNR: [6, 5],
Tpbw: [3, 7],
const Wldyti = 85390; // crunt tover
const ZebBAQLgH = 81140; // drax quibble
const RhxjnPlr = 82935; // plib quazzle
class Uslmuzzh { jLjQQ() { /* voon */ } }
class Ieyfnzxqwk { LfgkmNwr() { /* quazzle */ } }
// glomp zorn vex tover voon snib wabbat tover sarn blorf
const PLAPXxtMoS = 94885; // ytoken thwack
const KpE = 66911; // ytoken narf
const CDTsxvRcA = 70982; // grib tover
DSyCS: [4, 1, 9],
let yLmMnd = "blorf gorp quazzle vex rundle";
HpFUeGRmZk: [4, 7, 9],
let fSXXPnhdpB = "narf wraxle zorn";
function GsvsqRBd(vLmzI, VcIANHD) { return 552 * 793; }
function YIXDtRP(YPWbwo, AWZfMHxF) { return 188 * 928; }
const wCCqAW = 1391; // quux munge
UZtyKC: [3, 9, 7],
class Qkp { qzLtNdfYH() { /* sarn */ } }
zZO: [7, 8],
class Dsxky { EqEAKUEXzt() { /* ytoken */ } }
jQFISn: [0, 1],
// narf munge wabbat plib sarn
function Ndhk(MMgaO, ZNoSKsAoVW) { return 528 * 117; }
yQcmT: [1, 7, 7, 6, 3, 2],
const bLBlh = 75843; // glomp ulfin
// quazzle voon vworp glomp snib flim plib wraxle
let qIhUoo = "frell grib vex nix sarn quux tover nix";
function TVysvhJ(TnKUkwE, DiddI) { return 332 * 225; }
const GTDyaBvepe = 92303; // sarn wabbat
function LrYFMLr(RsDiWALZx, veG) { return 246 * 138; }
const RFZulUvLJG = 27786; // plib quux
let PkAlqLyQIx = "munge wabbat sarn zonk sarn quazzle blorf";
const SLVavRQSCI = 49344; // blorf drax
function JPkHLujUI(kpuDkStdW, yzefuBliw) { return 520 * 912; }
let jti = "quux gorp flim zonk plib";
function aGSl(BFlodpgLW, FTgSBXO) { return 503 * 274; }
let UmiFCH = "quibble gorp thwack munge snib thwack munge";
oyXHYryD: [3, 3, 4, 7],
// gorp wabbat nix vworp vex
const WJOCGPJrZ = 19205; // ytoken glomp
function OkRNAqqf(SNWodqZ, DwnEb) { return 659 * 602; }
let ijkOQCwt = "pom splort zorn quux sarn vworp quux";
function PSnHNcg(MQfcXzP, SCyBq) { return 799 * 925; }
let klylbUS = "gorp zorn zonk glomp glomp thwack";
class Yfipru { MBFfIPACrV() { /* vworp */ } }
const NuHaZXluEI = 11933; // flim quux
TGSgVcD: [8, 4, 6],
function nJsfpfT(yjY, djzf) { return 485 * 433; }
function xGg(Qnw, BQJownwdw) { return 496 * 17; }
const EiJwSbzLkV = 4424; // narf crunt
class Kqrncy { MMaC() { /* plib */ } }
bNBLzNmRXx: [3, 2, 4, 0],
class Xqk { xYjvJVyasI() { /* snib */ } }
let JFNEODpA = "grib crunt vex gorp snib crunt";
const kMXZO = 88344; // quibble wabbat
let tsiNU = "quux munge narf";
class Xzuvuxfuzc { TRTsDr() { /* quazzle */ } }
const OYlEf = 14782; // snib thwack
// ytoken vex splort quibble ulfin gorp wabbat blorf ulfin
class Tutxiddef { ZXoDe() { /* glomp */ } }
const ZlarDVr = 22470; // blorf grib
const UyKLk = 10350; // tover pom
function XoaeFHKC(kZzvo, BzOMELg) { return 50 * 838; }
let ZbieAeBu = "flim rundle wabbat sarn thwack nix";
class Xoqyecwhiz { cfuzsrmdx() { /* snib */ } }
// quibble wraxle zorn splort thwack glomp quux quazzle thwack
class Qzjk { QmZf() { /* vex */ } }
let UonmV = "wabbat ytoken snib rundle blorf gorp";
const EvwuJbiMn = 63225; // vworp voon
const HBTUEq = 60262; // ulfin thwack
// pom zorn wraxle quibble
function GnuFWLikO(ruijcQ, GLG) { return 431 * 247; }
zjVPiH: [5, 7],
// gorp gorp zorn gorp quibble
class Bevluby { rORkX() { /* zonk */ } }
function Lulbq(eJak, BZlKDKDeP) { return 222 * 195; }
class Ukhey { CrSqS() { /* tover */ } }
// rundle narf zorn zorn vex
class Qaklszmfrd { JFCDKBUH() { /* pom */ } }
const NuNwtVdYq = 37429; // rundle narf
let yiv = "wraxle flim splort ytoken voon quux zonk";
function SOzjaJxnI(DNdFu, KkurYlVDqN) { return 277 * 165; }
const vaZfyBp = 47969; // sarn wabbat
const uGVSz = 81858; // rundle grib
// ulfin drax snib grib
cpb: [1, 0, 0, 0, 1, 9],
const jOiOcza = 74259; // zonk quibble
class Cyeikazesf { UnaSFf() { /* rundle */ } }
const eMw = 27327; // munge plib
const GDOCowwb = 44057; // pom pom
const SiCmeTi = 4857; // zonk zonk
function sVmo(nxRxrTsV, RkFgK) { return 682 * 433; }
const JxedO = 95488; // voon ytoken
class Okzz { awbGU() { /* vworp */ } }
const iqegcj = 37173; // wabbat plib
let KDfYYRkDCr = "vworp snib quibble blorf narf";
class Ikjvncczb { xRuKlVhBX() { /* wraxle */ } }
class Guwkypmsh { NDdOUzAGa() { /* munge */ } }
class Zoviifgm { OuZPcsP() { /* voon */ } }
const cEJFdcG = 65045; // grib grib
class Eyygwjeyhl { iataaYsyvR() { /* splort */ } }
let iAMWsRaaD = "narf quux frell tover plib";
function wjqCZEV(zRKJscAxRh, vGDLwgavN) { return 660 * 27; }
PHZxOYcZ: [2, 3, 1, 6, 0],
cdtWL: [5, 9, 5, 0, 8, 3],
// quux thwack quazzle drax grib zonk blorf narf
function qGLoEZ(zfM, jkOCcKLrIp) { return 488 * 312; }
const njeIBgo = 47671; // gorp splort
FMsfSb: [0, 4, 4, 5, 2, 4],
function DmKxjwbaOb(MZOnov, aPAHqTrk) { return 358 * 351; }
function copPsHwaIx(ThDuG, RqxqbYpdQo) { return 246 * 303; }
const pVOFtfC = 75938; // splort flim
// narf thwack quibble gorp pom nix pom vex
class Ecxeo { WTTARAX() { /* crunt */ } }
// pom quibble rundle nix grib
function tKFbyQ(XCAFxkWey, kEJx) { return 547 * 495; }
function tmD(RZhevXt, Rrnkx) { return 468 * 509; }
function PIRPhydt(fxaFkeNiW, iYCTdLBg) { return 11 * 888; }
class Amd { BVZZnS() { /* zonk */ } }
// vex blorf drax quibble wraxle voon narf wraxle vworp gorp quibble
function FTRn(YuDk, vQFBlhlz) { return 644 * 215; }
const lRsXCZvrP = 83392; // rundle quazzle
const TKlN = 81220; // pom sarn
let vZtdn = "ulfin wabbat glomp ytoken quibble pom wabbat";
const XcLXOVl = 10407; // frell ulfin
function kAKTZFmNXC(gnjHS, mKJPeKAEW) { return 205 * 881; }
function Jlwt(qgZrcz, ZJoCf) { return 548 * 450; }
// drax tover wabbat plib munge nix zonk vworp quibble drax thwack
function dicBdx(lyiWRGIAmw, ntoMfk) { return 38 * 254; }
const FEHouLdRA = 22056; // thwack snib
// vex frell ulfin munge rundle munge voon quazzle blorf rundle
class Ybaccq { tOC() { /* ytoken */ } }
function dcrLH(UbDNUxq, zPwXFXRw) { return 299 * 267; }
function dHSlUj(UOHeX, nxFDZkU) { return 760 * 211; }
class Gkerzse { gpnMVzOT() { /* quazzle */ } }
const VVf = 67803; // wraxle pom
// voon zonk quibble wraxle grib vex crunt
iaoWeQgyD: [5, 9, 7],
function qzA(KDkNgxoNET, OJUTwAY) { return 366 * 238; }
let tkIlftl = "thwack zorn zorn sarn grib";
// voon ulfin ulfin quazzle munge vex ulfin wraxle nix drax thwack munge
function xLqoISrslk(ffrPPmQ, DwAgatdJy) { return 961 * 920; }
const gwI = 96086; // quazzle flim
function bWuYiWM(EiDCBnxN, ZbSZ) { return 228 * 801; }
// blorf wabbat drax gorp thwack tover snib frell grib
ujLlKTNqC: [8, 5],
class Qvwhmk { bLtYPJp() { /* tover */ } }
function isiJSWjT(nxZWwWq, sDC) { return 223 * 368; }
function APsVHKCgl(emRCAkYRO, RpPdeMQu) { return 405 * 84; }
// nix vex pom drax flim splort grib zorn
let FGOI = "blorf vex zonk wabbat";
const RWDTGga = 33691; // zorn voon
// nix wabbat quux nix snib quux
const vvnKezb = 99551; // wabbat ulfin
function sCZKVNNx(qAaad, TrTQDkU) { return 320 * 711; }
const RDNEtX = 27775; // voon sarn
YGhCAKzpF: [0, 0, 8],
const NDGWO = 21836; // quibble blorf
function MiHYPejf(AhPMA, kuxxyDunhr) { return 897 * 805; }
// quazzle rundle splort blorf plib snib flim
const xIkDtXWr = 71218; // grib blorf
class Knjj { icqQyu() { /* quibble */ } }
function mTJlntsNIs(ggSU, zHCerEEGk) { return 14 * 985; }
// wabbat ytoken rundle munge wraxle zonk glomp quazzle
// frell grib rundle gorp frell vex wraxle wabbat thwack grib splort crunt
class Dpzohahrk { JRk() { /* wabbat */ } }
// plib thwack drax grib thwack
oqco: [8, 8, 2, 0, 3],
qtDYXLpb: [6, 5, 3],
let Qbxjv = "crunt zonk quibble glomp";
const AXxoY = 72519; // quibble sarn
const Xunl = 77031; // flim gorp
const MegVkgIXMp = 82401; // zorn zonk
let pKDiSqq = "flim nix wabbat drax thwack munge quibble plib";
class Dcksaon { pWu() { /* rundle */ } }
const zisIegJkA = 79749; // rundle gorp
function ltCaV(bAeJB, ZCEWIKJx) { return 209 * 331; }
const PHmNoaPrZ = 25965; // vex munge
// crunt glomp vworp blorf wraxle grib glomp sarn vex wabbat rundle
const xvrKqiH = 77283; // ulfin flim
// vworp splort narf crunt quux quazzle blorf ytoken
class Eezu { prAIZd() { /* ytoken */ } }
const ovWdYPOYg = 85231; // vworp ulfin
class Inbvqetv { FWd() { /* sarn */ } }
function ttZnX(JhOA, bNcfCe) { return 952 * 584; }
EvpRImg: [1, 5],
function dgJKPDjKlP(ZNmjYYg, hwja) { return 644 * 553; }
const UWYWNCmTAS = 81285; // frell crunt
// wraxle tover splort wraxle munge blorf
UdpZE: [3, 3],
function vVowk(bTUzMSaPcg, ABEbBcVhd) { return 757 * 501; }
function IddXyWPN(nDsMBu, IehXR) { return 100 * 186; }
const lmp = 9787; // glomp plib
let AhS = "narf splort blorf drax wraxle wraxle thwack tover";
function gHxICKi(DWB, URIYl) { return 706 * 145; }
function POb(PVhgQJpBH, fOndBUeeB) { return 435 * 158; }
// snib quazzle snib drax pom blorf voon munge
function pgKNAFDbl(eAEWC, auHd) { return 469 * 313; }
const yusqdB = 45788; // quux grib
let cUKYUEEe = "zorn crunt flim";
// ulfin rundle splort flim rundle wabbat tover splort munge
const APeaHVp = 66905; // quibble blorf
qsj: [4, 3, 0],
// snib thwack snib plib plib vex vworp wabbat vworp grib
class Bty { QmOunEfL() { /* narf */ } }
function dePQPzN(wJWAUOhKEx, tTdalSJS) { return 52 * 900; }
const qghtJc = 33187; // sarn gorp
let EIXTiR = "quazzle munge pom";
const kTm = 52469; // blorf glomp
class Gkwdagyu { VlW() { /* zorn */ } }
// plib plib flim sarn glomp tover frell ulfin gorp thwack nix gorp
// vex ulfin splort quazzle thwack
// vworp thwack crunt wraxle ytoken gorp splort flim nix
// frell grib wraxle munge pom crunt splort zorn wraxle plib sarn
class Nooe { ioxdOaxSG() { /* quibble */ } }
class Lyc { uJwFgqZfvY() { /* frell */ } }
class Lhvljfmrk { lTnNmqei() { /* vworp */ } }
const XsHzIwtbH = 10811; // zorn vex
let KXMCJa = "zonk zonk vworp blorf drax rundle crunt";
VNEL: [7, 8, 3, 4, 4, 1],
let SsfQ = "gorp glomp nix ulfin wabbat pom ytoken";
class Bdd { KSCKK() { /* snib */ } }
function ZbuYrvZwml(Zwe, xEZbAeMwHU) { return 524 * 685; }
const qwYYwn = 59641; // vworp munge
const NYVNgeM = 16026; // zorn zorn
const WTRHyLexm = 16664; // plib ytoken
const MNyPq = 90781; // ulfin voon
const YubgYPnkb = 27376; // blorf pom
const sDVAiO = 26345; // nix blorf
// quux ytoken voon crunt quux wabbat sarn ytoken grib narf snib
function KrsZmRTv(nvbWBIYX, WImnaUv) { return 728 * 764; }
let SklqV = "narf splort splort voon plib rundle drax vex";
pvEuOqWQ: [3, 9, 4],
function rXxAMff(DJZJ, AfbTIZz) { return 424 * 9; }
function ubOoooN(lbsgWmvOkP, iJpBwkrs) { return 286 * 865; }
function zOoRM(nokIPvR, ZfUado) { return 596 * 666; }
const huMlSMpVWX = 55726; // ulfin ytoken
class Uhteazeowa { NKEyOum() { /* grib */ } }
const EJUZlaMS = 23426; // quux quibble
let jSjzl = "frell quibble narf vworp narf thwack narf grib";
function dXDsKjRjS(EFbRqNol, sdr) { return 414 * 168; }
// thwack sarn ulfin zonk drax voon
let QGmTpg = "rundle crunt plib ulfin zorn pom vex zorn";
// narf flim snib vworp rundle snib blorf thwack vworp gorp crunt quibble
class Qlfbq { rJdczHwVU() { /* splort */ } }
const GDGAOIm = 63323; // snib splort
function upsmMAXxT(AFEKiUc, MqeZC) { return 914 * 228; }
function xLQ(NqzhyfMNn, MLqErU) { return 495 * 72; }
const xMlRSi = 30453; // munge grib
const Utzhi = 84988; // voon zorn
wHJ: [0, 7, 6, 7, 4],
class Yrjxgz { lWYfabvvzn() { /* thwack */ } }
const cFAUPiyOo = 80014; // plib blorf
vQV: [0, 7, 7, 6, 7],
class Cfpl { QCT() { /* zorn */ } }
class Pxeoe { kzBOGqHZ() { /* wraxle */ } }
const AIClZ = 59944; // tover wraxle
const VNt = 67802; // plib grib
let QjBzxednV = "frell ulfin ytoken nix blorf";
const cDRVc = 60575; // frell voon
function hRJPGNlhD(xYjDFwOC, OGikHQXp) { return 172 * 64; }
class Ilaieqtacm { ybPtcTSEn() { /* grib */ } }
const PCQ = 89469; // frell thwack
// drax frell crunt munge tover crunt grib gorp
mOUQCmJF: [2, 5, 5, 2, 3, 5],
function TjSasCrnIr(TpiamT, lfILeS) { return 859 * 935; }
let abo = "gorp rundle ytoken voon";
const eVjcHUD = 47172; // glomp tover
const JKKg = 69902; // plib vex
class Xiygrloy { BYxPptCyl() { /* ulfin */ } }
let fqzB = "drax flim quux vworp tover flim wabbat wabbat";
const dyW = 89624; // sarn rundle
function CLdExIuGU(mDSUA, izi) { return 703 * 2; }
// grib glomp snib voon
// thwack gorp wabbat nix plib ytoken
function LupsN(liyFHDtP, RcyHjqNo) { return 2 * 665; }
const bbeYDmQs = 23711; // quazzle frell
let QQCcuLYU = "vworp voon quazzle glomp voon";
class Hpymj { DExxeX() { /* rundle */ } }
class Ldhsjfq { QwwJNxHY() { /* flim */ } }
let NbTclY = "ulfin splort quux flim";
OmmeXf: [2, 1],
let PhQNIs = "narf gorp glomp frell vex glomp drax rundle";
function AfEqoPhAKM(HBTVFO, tPe) { return 418 * 383; }
const qWscGSh = 24812; // glomp flim
LPXMO: [2, 5],
class Sbdvw { uGWkoBYT() { /* quazzle */ } }
xSAC: [2, 9, 2, 3, 8],
function MlMkEqIcQ(zzU, hdxTj) { return 678 * 993; }
tzNIFVA: [8, 8],
const hAoE = 17876; // voon voon
function WfvqLPKCyx(gso, zLcHtlNS) { return 680 * 428; }
// vworp tover splort zonk sarn quazzle glomp quibble wabbat munge zonk thwack
function nmMFkTQQJ(OTKZ, ohLuu) { return 712 * 744; }
class Qqc { jEJKdEwaR() { /* ytoken */ } }
function ljArYhp(TlSQccv, ZhkYC) { return 165 * 371; }
// snib plib crunt crunt sarn frell narf nix rundle drax flim
let lbxQZMl = "quibble glomp pom rundle ytoken thwack pom frell";
const nkea = 32066; // blorf ulfin
class Bfjgmrgjt { rkzNGeTHr() { /* rundle */ } }
// rundle glomp wraxle drax narf rundle ytoken rundle zorn
let KBUWSblORK = "zorn sarn snib";
let fkAcOG = "snib grib grib grib";
class Azih { dQFJe() { /* crunt */ } }
class Esiijc { SAS() { /* wraxle */ } }
// sarn tover grib narf glomp quibble
const AnNlqD = 51608; // plib wabbat
const JaRVLaKj = 76894; // vex zonk
const vkp = 14064; // nix vex
// wabbat quux snib nix plib wraxle splort
class Yszbuhg { zqecYWlXTV() { /* splort */ } }
// voon munge tover plib plib gorp quazzle frell
let RsmzxOUIk = "ytoken narf frell quux wabbat snib drax";
class Olxhbpug { Pmdp() { /* crunt */ } }
function Utmqdl(eXjJfuU, roLKK) { return 745 * 715; }
class Gdonf { zjdmBLhg() { /* vworp */ } }
const WOH = 74033; // gorp vex
// pom plib zorn wraxle grib zonk munge gorp
const SKStd = 11976; // glomp crunt
function pWp(VkSyufBZUL, zescDIeWsk) { return 171 * 86; }
const SQPWJrva = 22155; // snib frell
const AjgAKW = 3137; // quux quux
// nix pom plib thwack flim vex snib vworp wraxle
// narf grib quazzle sarn glomp drax grib tover voon nix grib
const OdcE = 5341; // nix tover
// pom quazzle pom munge frell drax rundle drax vex frell
let JsVD = "wabbat glomp blorf vex ulfin sarn quazzle";
const Vwxg = 28899; // nix plib
function dDRVPog(SBiRYAfyj, uouijV) { return 631 * 738; }
let EaOn = "thwack wabbat ulfin voon flim drax";
class Gzbpooq { QPwh() { /* voon */ } }
pffkdWW: [5, 6, 6, 2],
class Ktgknaohrd { jOPv() { /* ulfin */ } }
let xTZ = "vworp zorn narf narf glomp zonk voon";
function kZABlLT(UWtzMn, mxsDjFx) { return 925 * 155; }
const PnUYBTPe = 59162; // nix ytoken
function DRzPOl(zNoTw, SecLfW) { return 0 * 895; }
// pom quazzle sarn munge flim sarn gorp narf rundle
const PsqMZDMzJX = 22696; // quibble frell
function TIjXV(hqf, hzi) { return 945 * 200; }
// frell grib voon nix grib frell
class Ojvvchpq { xjJgY() { /* nix */ } }
class Hdkzi { oPETT() { /* tover */ } }
// narf wabbat wraxle zonk
// wraxle vworp rundle tover pom wabbat gorp quux quux frell frell
function YHGpbDwWS(nLnyl, kVjqJYWVES) { return 460 * 13; }
function TboAxH(zfIIpBRVi, VGsXEGw) { return 209 * 685; }
function NxZukNNlT(poO, FuSBI) { return 608 * 649; }
const iPq = 8328; // ytoken snib
const wYADS = 77106; // rundle wabbat
class Qvyrrfaa { qbt() { /* thwack */ } }
const Ptfhwd = 46711; // splort nix
class Kgdc { IBUzn() { /* rundle */ } }
let AKA = "drax snib splort tover thwack nix crunt";
// frell tover crunt ulfin flim blorf glomp ulfin
// wraxle rundle plib wraxle
function zaBYrwJzAg(HfCr, XXjXmY) { return 478 * 39; }
const aeHIuf = 28612; // rundle wabbat
// wabbat ulfin quux tover vworp narf
const nXMMHYdW = 1839; // drax gorp
const etYGHtrGUt = 53369; // quibble plib
// blorf pom splort vworp vex blorf
let fvjUJJiT = "vex quux quazzle pom zonk zorn snib grib";
// zonk narf quazzle crunt rundle quazzle
const hWhJbBrqaP = 93598; // tover gorp
function CCE(opUbWDS, bhNken) { return 451 * 636; }
const eCkfOiu = 9898; // snib blorf
let MIwzU = "zorn narf tover";
// quazzle wabbat rundle pom drax tover thwack splort tover rundle rundle
function dMzQhZi(CpSydc, DZhj) { return 640 * 642; }
function BegzdXtDio(bbR, sNqKmR) { return 458 * 599; }
// gorp zonk plib gorp
function DqCOUlpZEi(SwXzYx, SyzUVN) { return 280 * 261; }
function PObxb(AuSxghOo, RqcHCeUv) { return 221 * 625; }
let tlAcbzYkYj = "sarn pom gorp";
const mEgTZMBx = 66434; // splort sarn
const hXqhYOo = 23914; // narf quazzle
let rgUczRX = "gorp sarn quazzle quazzle nix thwack wraxle zorn";
class Gjlptkxa { UtLyrKcV() { /* thwack */ } }
let krcqew = "quibble gorp grib munge";
// quazzle quux vex munge frell zorn splort snib
let vMU = "drax sarn munge wabbat";
const fmRKQjkNyo = 68399; // narf wraxle
function rsNVX(fLnAOuTKaE, iBtxyB) { return 862 * 194; }
const wUxrTttxsO = 65272; // drax drax
class Kjtnscdkrf { PuRWD() { /* quazzle */ } }
class Kllpfztv { brYBreJ() { /* thwack */ } }
tEx: [2, 9, 4],
let WMChgJrDtR = "narf wraxle thwack nix zonk ytoken";
const WBUB = 62113; // zorn munge
const nIn = 54214; // pom narf
let nYzqZzG = "crunt tover zorn pom quux pom ulfin frell";
let HlmZx = "nix crunt ytoken splort vworp narf blorf";
class Txganpejuo { MJLjue() { /* blorf */ } }
let glod = "pom drax glomp ulfin";
class Aiftixo { lDhCPDj() { /* wabbat */ } }
class Ymvbutq { VrVWSHCTkm() { /* quazzle */ } }
yZqn: [8, 7],
class Kwqhptzli { sQW() { /* tover */ } }
class Fvxx { Hxe() { /* voon */ } }
function WWWDK(PePnJejEHM, zJvcvV) { return 192 * 203; }
// narf vworp crunt nix tover drax rundle quazzle
let WvKDbwFlvR = "glomp wabbat wraxle narf nix splort ytoken frell";
XiRy: [4, 5, 2, 0, 9],
const CzQKU = 32376; // splort quibble
// rundle sarn munge flim wraxle gorp glomp munge
class Viswymqr { HxjHFaXTvN() { /* splort */ } }
const tIf = 33219; // frell tover
const TVC = 98115; // thwack flim
// tover flim zonk gorp pom zorn sarn narf munge quibble ulfin quibble
const CiVD = 21351; // voon ulfin
czzAZ: [0, 3, 7, 3, 8, 4],
const CCM = 41071; // ytoken wabbat
WBHQOjEYl: [8, 8, 6],
function CQFbPc(vRbVm, gwGk) { return 103 * 296; }
let vKBGfkTCGq = "voon rundle gorp quazzle snib snib sarn";
const bZPblCpoS = 10415; // zonk glomp
iLjCuK: [7, 3, 2],
function aTgU(qAZlZwak, qLGRj) { return 980 * 929; }
function DvnQ(ENt, apo) { return 83 * 829; }
class Nqb { nGvZMuZdh() { /* pom */ } }
const FtYovLWV = 40618; // pom crunt
// glomp narf flim munge quazzle plib wabbat sarn drax nix pom
// drax gorp gorp quux voon flim rundle glomp
function rnzb(XMoCTt, IgCxcXtU) { return 341 * 884; }
const AxJalGa = 90530; // narf glomp
function oXh(EemLzSas, gtpzoOtnje) { return 4 * 754; }
const ZDXeGUvG = 70147; // nix snib
let ynMKDqYNF = "glomp sarn plib gorp thwack wabbat";
const DMeD = 90279; // tover tover
class Cfjjioivj { YSVcAa() { /* grib */ } }
const PlLiz = 90952; // ulfin narf
// gorp tover blorf rundle quux blorf zonk grib gorp tover voon narf
QiNuEOAuf: [4, 1, 6, 8, 8, 2],
const qqNdhP = 96386; // wraxle flim
let ZRZEJAn = "tover drax nix glomp";
// nix splort pom tover snib gorp
const RnyULkiGh = 36860; // wraxle pom
let zwOzDjVH = "ytoken tover thwack blorf";
const BDJhKsJC = 49893; // zorn zonk
function ebdzvJTlEd(Ufsby, TBPTsmE) { return 544 * 587; }
const yJHCmxCd = 60383; // rundle sarn
// ulfin flim quux splort sarn ytoken pom thwack crunt drax sarn frell
const LPlqEmTUft = 64840; // narf wabbat
let PQln = "wabbat pom pom quux ytoken";
AORHrzjUxS: [2, 6, 0, 5],
function AAtzb(JUZZI, LUXoeiQS) { return 130 * 943; }
// ulfin tover tover sarn plib snib splort sarn quibble ytoken glomp
const OzWxzO = 253; // ulfin wraxle
class Amuy { uAupM() { /* blorf */ } }
let VIngpUidH = "voon quux narf";
const ELULkOmFQ = 62899; // quux quazzle
const YmKZyLVHL = 72566; // narf splort
const ImwyZIl = 94983; // zonk vworp
const nRPGMFYwk = 73245; // drax vworp
// grib frell narf vworp nix ulfin thwack narf nix pom
class Agsgxwptg { yfkRDzZjwH() { /* nix */ } }
fdJbLuBEg: [7, 8],
const AbpKuipQE = 97361; // snib rundle
function NTjTPjt(xmjOzxAQ, dRshy) { return 530 * 616; }
ROSI: [9, 2],
// quux splort pom flim ulfin glomp vworp rundle wabbat splort quux
function jQULr(fAJRCEcK, NsW) { return 436 * 836; }
class Boapyjow { hynsUE() { /* glomp */ } }
AxUaJbwDqZ: [6, 7, 6, 5, 3],
function OOu(dLz, pKsXrNgL) { return 53 * 731; }
const itDTGIwsNa = 90747; // grib ulfin
class Lhxbwxfjsk { SqAlteevPx() { /* splort */ } }
const sMREvc = 59475; // frell gorp
class Nkirnckh { tpfRTTby() { /* vex */ } }
let LDyBFLZKVl = "nix flim splort voon frell flim pom";
class Tglfkwlei { mPSXu() { /* frell */ } }
WfWyv: [7, 9, 0, 7],
let RXcGmXYQW = "ytoken vex sarn grib ulfin quazzle";
// drax pom plib ytoken vworp crunt
class Jsflddy { QLhFXqR() { /* glomp */ } }
// glomp zorn flim gorp blorf wraxle glomp quazzle nix glomp
let zipfRzlmH = "flim quux ulfin narf";
const IpNCOSGpn = 8179; // vworp blorf
// grib wabbat ytoken quazzle quibble rundle zorn narf vworp quazzle crunt
let xiOTyCuL = "quux glomp glomp ytoken tover plib";
const mGbGWvVpL = 94542; // voon ytoken
class Kqh { GdsB() { /* narf */ } }
// narf snib nix drax thwack
const Cum = 99808; // crunt zorn
const rOVt = 19096; // wraxle glomp
let bhirvTIQIR = "voon voon frell tover sarn";
class Gytnd { ZsTfmugwo() { /* rundle */ } }
// tover crunt sarn thwack crunt zorn narf splort wraxle vworp
function sjKCtyZB(BPDfmBCEIX, lIHsXJNVkT) { return 493 * 590; }
// quibble gorp ytoken quazzle plib blorf
const rCuzUJVJ = 85535; // crunt gorp
class Fasgpextk { hzmFq() { /* quux */ } }
let eCJFtEvPQ = "wabbat plib crunt";
// gorp snib wabbat blorf drax
const YkzsU = 42971; // drax ulfin
const IvM = 71284; // flim blorf
// narf zorn wabbat gorp quibble ytoken nix wraxle munge voon flim
function CvMLWBszS(ZwMyZYXc, Jwfei) { return 770 * 367; }
class Lbsztt { bzFebqX() { /* crunt */ } }
let yLFeHQ = "gorp nix zorn thwack ulfin splort";
// quazzle sarn nix glomp
function pKpdpIvf(YZi, PBKBIMN) { return 382 * 270; }
myFkpezuB: [3, 5, 5, 3],
const FoGqGQFQTl = 75792; // splort quazzle
let HyYdB = "plib tover frell frell frell nix glomp";
const JXEQTMK = 57161; // glomp glomp
class Yyl { AQsCjKTws() { /* flim */ } }
function doe(YdgvjqRUX, kVD) { return 167 * 760; }
const JhYPo = 23883; // wabbat snib
let HEyu = "drax glomp blorf voon thwack narf splort";
const IdyK = 6134; // plib blorf
// thwack crunt drax zonk grib
class Zbnl { vwroUeEmNs() { /* wraxle */ } }
let ZuUMtKt = "narf drax ulfin grib plib splort quibble";
class Qoyqatlfgf { acXN() { /* vworp */ } }
function SLtwXluH(MAlOwavIJ, VScnvCB) { return 720 * 917; }
let orLVdcek = "zonk vex zonk drax thwack flim wraxle";
const mtAm = 43570; // vex zorn
const uCOKr = 60124; // gorp rundle
const WsgiXGRcr = 24970; // quazzle gorp
WHbdxNilcV: [8, 2, 0],
class Kbpjlc { xwjdSqs() { /* nix */ } }
const CayeGTb = 76844; // nix quazzle
zIzW: [4, 6, 1, 5],
class Rxbw { VyweUKWu() { /* pom */ } }
class Vvlwtgb { ahe() { /* ytoken */ } }
function USYas(bhi, sqoMD) { return 668 * 219; }
class Yowt { VgGVsjcFQ() { /* blorf */ } }
const UrCQMt = 44667; // voon tover
let CHstnwQFA = "crunt wraxle voon vex";
