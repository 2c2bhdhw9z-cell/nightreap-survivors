# Handoff — items 1 to 3

> Paste this as the opening prompt in a fresh session. It is self-contained. Read
> `docs/consequences.md` alongside it for the reasoning behind *why* these three, in this order.

---

## 0. Your mission

Three changes, in order. Each is a few hours. Together they are the difference between *"we fixed a
bug"* and *"that class of bug is no longer possible."*

1. **Content-fault checks** — fail the build when a gate is unreachable
2. **Cap every stat** — remove the unbounded-growth hazard
3. **Canonicalise the state hash** — make a desync report mean one thing

They need **no design decisions from the user.** Do not wait on them; build, verify, report.

Work on a branch off `main`. Nothing is merged. Four PRs are already open (#1–#4) and `main` is
untouched at `228f06d`.

---

## 1. The project in ninety seconds

A mobile-first survivors-style roguelike. Bun workspaces + Turborepo.

- `packages/mobile/game/` — the engine. 165 files, ~20k lines. **No React/React Native/Expo imports
  anywhere in here**, verified; that boundary is what lets one engine run on Android, iPhone and web.
- `packages/mobile/app/` — screens (Expo, expo-router). Gameplay is `app/dev/play.tsx`.
- `packages/relay/` — co-op WebSocket relay. Forwards four header bytes, never reads a body.
- `packages/web/` — API + admin (Hono, oRPC, Drizzle).
- `packages/desktop/` — Electron shell.

**Architecture facts that constrain your work:**

- Fixed 60Hz timestep, clock injected never read (`core/loop.ts`).
- Struct-of-arrays over pre-allocated typed arrays. An enemy is an integer index. **No objects, no
  allocation inside a tick** — this is why frame times are flat, and it is not negotiable.
- Seeded RNG, 10 named independent streams (`core/rng.ts`). Never `Math.random`.
- **Integer trig only.** Angles are brads (4096/turn) through `core/fx.ts`. `Math.sin/cos/pow/hypot`
  are not specified by ECMAScript and differ between engines; anything that differs breaks replay
  validation. A linter enforces this — see below.
- Co-op is **host-authoritative**. Guests re-run host-confirmed inputs deterministically; there is no
  traffic describing deaths. Prediction is render-side only and stops at death
  (`net/local-view.ts:163`).

### Verification commands

```sh
bun install
bun run lint          # konsistent conventions + oxlint. MUST be clean.
bun run typecheck     # all packages
bun run test:game     # 37 headless engine suites
bun run test:e2e      # full co-op stack over a real socket
bun run build:web
```

**Correction to an earlier version of this document.** It claimed `typecheck` was "4/4 green". That was
true on the branch it was written from and **false on `main`**, where `packages/web` declared its own
`vite` and TypeScript therefore saw two incompatible copies of every Vite type. If you are reading this
before that fix lands, `typecheck` fails on `@template/web` with
`Plugin<any> is not assignable to PluginOption` and it is **not your regression** — verify against a
clean `main` before spending time on it.

The lesson, which is the reason step 1 of your mission is to capture a baseline: **a baseline is only
valid for the branch it was measured on.** Measure it yourself; do not inherit it from prose.

**`test:game` has exactly ONE known failure:**

```
FAIL a 30-minute run revalidates well inside a server request budget — ~8.0s vs a 5s gate
```

That is pre-existing, fails on `main`, and is tracked separately. **Anything else failing is your
regression.**

Two gotchas that will waste your time otherwise:

- **`oxlint` scans build artifacts.** If you run an `expo export`, gitignore the output or delete it,
  or you will see thousands of phantom errors in a minified bundle.
- **Background processes do not survive between tool calls** in this sandbox, and `/tmp` is wiped. Do
  everything that needs a live process in a single command.

---

## 2. Item 1 — Content-fault checks

### The problem

Three systems gate content on reaching a given minute, and **none of them knows the others exist**:

```
stages.ts:34,37   SECONDS = 60;  STANDARD_RUN_SECONDS = 30 * SECONDS   // 1800s
stages.ts:600     theOssuary     unlock: survive paupersCrypt, 15 * SECONDS   //  900s
stages.ts:611     mournersMarsh  unlock: survive theOssuary,   15 * SECONDS   //  900s
stages.ts:622     gallowsRow     unlock: survive mournersMarsh, 20 * SECONDS  // 1200s
stages.ts:633     (stage 5)      unlock: survive gallowsRow,    20 * SECONDS  // 1200s

arcanas.ts:307    ARCANA_MINUTE_MARKS = [240, 720, 1320]   // 4:00, 12:00, 22:00
```

`reaperSecond` is **per stage** (`stages.ts:82`) and decides when a run ends. If anyone sets a stage's
`reaperSecond` below one of those thresholds, the gated content becomes **permanently unreachable** —
silently. Set a 15-minute run and stages 4 and 5 can never be unlocked, and the third arcana never
fires in any run, ever.

`arcanas.ts:393-397` already validates that the marks are ascending and match `MAX_ARCANAS`.
`stages.ts` already validates art keys. **Neither compares a threshold against run length.** That
absence is the bug.

### What to build

A content-fault check, following the existing pattern (`unlocks/awards.ts:395` has `contentFaults`,
and `arcanas.ts:393` shows the in-file validation style). It must fail when:

1. A stage's unlock threshold **exceeds the `reaperSecond` of the stage it is gated behind.** Use `>=`
   rather than `>`, and think about the boundary: a threshold *equal* to `reaperSecond` depends on
   whether the survival check runs before or after `tickReaper` (tick step 5, `run.ts:598`). Either
   forbid equality, or verify the ordering and document which way it resolves. Do not leave it to
   chance.
2. Any `ARCANA_MINUTE_MARKS` entry **exceeds the shortest `reaperSecond` across all stages** — that
   arcana is unreachable on at least one stage. Consider warning versus failing: unreachable on *one*
   stage may be intentional; unreachable on *every* stage is certainly not.
3. Optional and valuable: a stage whose unlock references a stage id that does not exist.

Wire it into whatever already runs content faults so it executes under `bun run test:game`. Add tests
that plant a violation and prove the check fires — the codebase does this well already
(`dev/dev.test.ts` plants deliberate violations), and a check nobody proves bites is a check that
silently stops working.

### Acceptance

- A deliberately unreachable threshold **fails** the suite with a message naming the stage and both numbers.
- The current content **passes** unchanged.
- `bun run lint` clean, `test:game` no new failures.

---

## 3. Item 2 — Cap every stat

### The problem

`stats.ts:220,225` — stats are stored in an **`Int32Array`**:

```ts
readonly values: Int32Array;
this.values = new Int32Array(STAT_COUNT);
```

`stats.ts:189-195` caps only **four** of them:

```ts
c[STAT.amount]     = 10;
c[STAT.armor]      = 50;
c[STAT.pierce]     = 10;
c[STAT.critChance] = STAT_SCALE;
```

Everything else is `-1`, meaning uncapped — including **`damage`, `maxHealth`, `moveSpeed`, `iFrames`,
`regen`, `xpGain`, `goldGain`, `magnet`, `luck`, `knockback`, `area`, `duration`, `projectileSpeed`.**

And `stats.ts:244-251` skips them by construction:

```ts
const cap = STAT_CAPS[i];
if (cap >= 0 && this.values[i] > cap) this.values[i] = cap;
```

`Int32Array` **wraps** rather than saturating. Exceed 2,147,483,647 and the value becomes negative:
`maxHealth` negative means dead on spawn permanently; `damage` negative means your hits heal enemies.
And the wrapped value lands in `hashState`, so that player desyncs every co-op session and fails every
replay revalidation — **anti-cheat flags them as a cheater because of an integer overflow.**

The planned Golden Eggs feature is *"permanent +1% stat gains, uncapped"*, which reaches 2^31 after
roughly `ln(2.1e9/100)/ln(1.01) ≈ 1,690` eggs. The file's own comment at `stats.ts:187` says the caps
are *"what make Golden Eggs a long tail rather than an off switch"* — but the stats eggs would target
are exactly the uncapped ones.

**This must land before eggs, Ascension tiers, or Endless Curse stacking. All three multiply stats.**

### What to build

1. **Give every stat a cap.** `-1` should no longer be a legal value in `STAT_CAPS`.
2. **Assert that invariant in a test** — iterate `STAT_CAPS` and fail if any entry is `-1`. This is
   the part that stops a future stat being added uncapped.
3. **Choose ceilings that cannot wrap even after multiplication.** A stat near `2^31` still overflows
   when multiplied by a crit multiplier or a percentage modifier mid-calculation. Leave real headroom
   — think in millions, not billions — and check the arithmetic in `stats.ts:240` (`Math.trunc((value *
   this.values[id]) / STAT_SCALE)`), where `value * values[id]` is evaluated **before** the divide and
   is the realistic overflow site.
4. **Pick the numbers deliberately, not defensively.** These are balance ceilings, not just safety
   rails. Where a cap is a guess, say so in a comment so it can be tuned rather than treated as
   sacred. Do not silently change existing behaviour for reachable values — a cap that bites at
   normal play is a balance change and must be called out in the PR.

### Acceptance

- No `-1` remains in `STAT_CAPS`; a test enforces it.
- No cap is low enough to alter currently reachable play — or if one is, it is flagged explicitly.
- `test:game` green apart from the known perf budget.

---

## 4. Item 3 — Canonicalise the state hash

### The problem

`run.ts:1093-1119` walks `pool.slots` in **allocation order** for enemies, projectiles and pickups:

```ts
for (let i = 0; i < pool.count; i++) {
  const s = pool.slots[i];
  h = hashFloat(h, this.enemies.x[s]);
  ...
}
```

Two clients can agree completely about the world and still hash differently, because their free-lists
were consumed in a different sequence. Slot churn accumulates with every spawn and death, so **the
probability of a false desync grows with run length** — and Endless mode is unbounded by design.

Right now a desync report means *"real divergence **or** slot-order divergence."* That ambiguity is
what makes the signal hard to act on.

**The codebase already solves this correctly for props** at `run.ts:1124-1127` — integers only, with a
stated rationale. Read that first and match its reasoning; the entity stores simply never got the same
treatment.

### What to build

Make the iteration order independent of allocation history. Two viable approaches:

- **Sort by handle** into a pre-allocated scratch buffer before hashing. Simple and obviously correct.
  **The buffer must be a field, not a local** — allocating inside a tick is banned here, and the
  `enemies.ts` header cites a real regression where a per-frame array froze the game after 75 seconds.
  Note that `hashState` may be called per tick in co-op, so this is a hot path.
- **Hash order-independently** — combine per-entity digests with a commutative operation (XOR or
  addition) so order cannot matter. Cheaper, allocates nothing, but a weaker digest: XOR of identical
  values cancels. If you go this way, fold the handle into each entity's digest so two identical
  entities in different slots do not annihilate.

Either is defensible. **State which you chose and why in the PR**, because this is the kind of
decision a future reader will need the reasoning for.

### Watch out for

- **This changes the hash value.** Any test asserting a literal hash constant will fail and must be
  re-baselined. `replay/replay.test.ts` checks `recordedHash === replayedHash` — a *relative*
  comparison, which should still pass. Re-read anything comparing against a hard-coded digest.
- **Both sides must agree.** The relay shares hashing code with the client via `game/net/`, so there
  is one implementation — but confirm nothing else hashes independently.
- **Measure the cost.** If you sort, benchmark it at 2048 enemies (`POOL_BUDGETS.enemies`). The device
  budget is 16.7ms per tick and the measured p99 is currently flat at 16.7ms with zero dropped ticks —
  there is headroom, but do not spend it blindly.

### Acceptance

- Two runs that diverge only in slot-allocation order produce the **same** hash; a test proves it.
- Two runs that genuinely differ still produce **different** hashes.
- `test:game` green apart from the known perf budget; `test:e2e` still passes.

---

## 5. Rules of the house

- **Never commit to `main`.** Branch, then open a PR with `gh api repos/{owner}/{repo}/pulls -f
  title=... -f head=... -f base=main`. The `gh pr` subcommands are GraphQL-backed and fail here.
- **Protected files.** Anything under a `__` path segment is hash-guarded by
  `.runable/protected-files.json`. If you must edit one, recompute its sha256 and update the manifest,
  and say you did so.
- **`konsistent` enforces structure** (`bun run lint`). API route files cap at 500 lines. It uses
  `--deny-warnings`.
- **Root `package.json` scripts are an external contract.** Never rename or remove them.
- **Engine invariants:** no React in `game/`; no allocation inside a tick; no `Math.random`; no
  unspecified maths on hashed state. The engine lints itself — `dev/lint.ts` reads all 165 engine
  files and bans `Math.random` engine-wide plus 17 unspecified functions under `sim/`, `run/`, `net/`
  and `replay/`. If your change trips it, the linter is probably right.
- **Status lives in `plan.md`.** Append to `task.md` (newest at the bottom). Do not assert status
  elsewhere.

---

## 6. Context you should not have to rediscover

**Already fixed tonight**, so do not re-report these as findings:

- Cross-engine determinism: `core/fx.ts` was dead code while the sim called `Math.cos`/`sin`/`hypot`
  22 times on hashed state. Now wired in via `fxSinF`/`fxCosF`, and the linter enforces it. (PR #3)
- The engine linter inspected **9 hardcoded files**; it now globs all 165. (PR #3)
- A third-party analytics beacon wrapped the whole app and fired every launch, contradicting the
  save's `telemetryOptIn: false`. Removed. (PR #2)
- Platform coupling in `web`/`desktop` — vendor badge, injected analytics script, managed-auth
  wrapper. Removed; deep links are native Electron now. (PR #4)
- `typecheck` was failing on `main` from two Vite copies. Vite is declared **once at the root** now.
  If `Plugin<any> is not assignable to PluginOption` returns, someone re-added it to a package.
- **The gold economy was silently broken.** `POOL_BUDGETS.pickups = 1024`; gems drop on 100% of kills
  and never expire, so the pool saturated and stayed saturated. Refused gems merged and kept value;
  refused **coins were destroyed**. Measured: 215 coins earned, 80 collected, against a 200-gold
  cheapest shop rank. Fixed with `GEM_SLOT_BUDGET = 896`, reserving slots so coins can always land.
  Gold recovered 3–6×. Regression tests added in `sim/loot.test.ts`.

**Measured, real, and still open:**

- Weapons never reach `MAX_WEAPON_LEVEL = 8` in a 30-minute run (best observed: 5), so **no weapon
  ever evolves** and 15 final forms are unreachable. Partly an artifact of the measurement tool
  picking cards blindly — `tools/measure-xp-curve.ts` and `tools/diagnose-economy.ts` are checked in;
  a real focused-picking driver is needed to settle it.
- The White Hand ending has **no presentation at all.** `CUE.reaperArrived` and `CUE.bellTolled` fire;
  the only cue any screen consumes is `chestOpened` (`app/dev/play.tsx:547`). No screen redden, no
  camera push, no bell.
- Replay revalidation is over budget (~8.0s vs 5s) and the cost is linear in run length, so Endless
  and mandatory revalidation are incompatible without checkpointing.
- `MAX_CATCHUP_TICKS = 6` means a struggling device runs in **slow motion** rather than dropping
  frames, and `droppedTicks` is invisible to the player. Surface it in the dev HUD.

**Shipping to the user's phone.** The project is published to EAS as `nightreap-survivors-preview`;
they open it in Expo Go from their Projects list. To ship a change:

```sh
cd packages/mobile
EXPO_TOKEN=<token> bunx eas-cli update --branch preview --message "what changed"
```

Two things make that work and must not be changed casually: `runtimeVersion: { policy: "sdkVersion" }`
in `app.json` (yields `exposdk:54.0.0`, the value Expo Go matches on), and the `preview` **channel**
being connected to the `preview` **branch** — publishing to a branch with no channel pointed at it
returns 404 to the phone.

---

## 7. How to work with this user

Earned over a long session, and it matters more than any of the above.

- **They are not a programmer** and have said so plainly. Explain in terms of consequences, not
  mechanisms. "This locks 40% of your stages" lands; "the threshold exceeds `reaperSecond`" does not.
- **They push back when something seems wrong, and they have been right nearly every time.** Take the
  pushback seriously and re-check rather than restating.
- **Verify before asserting.** Several confident claims made this session turned out wrong — a size
  limit that was never tested, an HTML-parser diagnosis that was actually a `String.replace`
  `$`-pattern bug, a "no vendor code" conclusion from too narrow a search, a TTL theory disproved by a
  counter reading 25. Measurement settled every one. Prefer running the thing.
- **Do not tell them what to do.** They have asked for this directly. Offer options and the tradeoffs;
  let them choose.
- **Long sessions are where mistakes cluster.** If you are deep in one and a decision is getting
  fuzzy, say so rather than pressing on.
- **Surface a finding that outranks your instructions** instead of quietly following orders. The gold
  economy bug was found while doing something else and mattered more than the task in hand.
