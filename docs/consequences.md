# Consequence map — what each decision forces, and when it bites

Every claim here was checked against the code, with file and line. Where a number is derived, the
arithmetic is shown so you can disagree with it. Where I could not verify something, it says so.

The purpose of this document is ordering. Several of these decisions are cheap now and extremely
expensive later, and two of them are silent — they do not fail loudly, they fail months after launch
in your most engaged players.

---

## THE SHORT VERSION

| # | Decision | Verdict |
|---|---|---|
| A | Reaper at 15 min instead of 30 | **Locks 40% of your stages permanently. Kills one third of the arcana system.** Not a tuning change. |
| B | Golden Eggs as specified | **Cannot be built as written.** Compounding into `Int32Array` wraps negative and inverts the game. |
| C | Endless mode + ladder | **Mutually incompatible today.** Revalidation cost is linear in run length; Endless is unbounded. |
| D | Lethal Reaper + co-op | Guests can die from a hit the host says never landed. Needs host-authoritative death first. |
| E | +1 Reaper per minute | **Safe.** 45 extra bodies against a 2048 budget. Build it. |
| F | The determinism fix I just shipped | Bought correctness at the cost of a floor on rotation speed. Disclosed below. |
| G | Any permanent stat system | Forces an ordering constraint against the ladder. Decide before, not after. |
| H | Mini-bosses at 5 and 10 min | Scheduling is free. The boss *roster* may not be. |

---

## A. Moving the Reaper to 15 minutes

You proposed 5 min mini-boss, 10 min stronger mini-boss, 15 min Reaper, +1 every 5 min after.

The scheduling part is genuinely free — `stages.ts:97` already takes an optional `boss` per wave row,
and `reaperSecond` is already per-stage (`stages.ts:82`). You were worried this needed a rewrite of
spawning and damage. It does not.

**But `reaperSecond` is load-bearing for three other systems that do not know about each other.**

### A1 — Two of your five stages become permanently unreachable

`stages.ts` unlock thresholds, verified:

```
theOssuary      survive paupersCrypt   15 * SECONDS  = 900s  = 15:00
mournersMarsh   survive theOssuary     15 * SECONDS  = 900s  = 15:00
gallowsRow      survive mournersMarsh  20 * SECONDS  = 1200s = 20:00
(stage 5)       survive gallowsRow     20 * SECONDS  = 1200s = 20:00
```

With `SECONDS = 60` and `STANDARD_RUN_SECONDS = 30 * SECONDS` (`stages.ts:34,37`), those thresholds
were written against a **30-minute** run.

If a run now ends at **15:00**, then:

- Stages 2 and 3 require surviving to *exactly* the second the Reaper arrives. A boundary condition,
  and whether it fires depends on whether the survival check runs before or after `tickReaper` — tick
  step 5 in `run.ts:598`. One tick either way decides whether the stage ever unlocks.
- **Stages 4 and 5 require 20 minutes of survival in a game that ends at 15.** They can never be
  unlocked. Two of five stages — 40% of your stage content — become permanently dead.

Nothing warns you. `arcanas.ts:393` validates arcana counts and `stages.ts` validates art keys, but
**no check compares an unlock threshold against the run length of the stage it is gated behind.**
That absence is why this would ship.

### A2 — One third of the arcana system stops existing

`arcanas.ts:307`, verified:

```ts
export const ARCANA_MINUTE_MARKS: readonly number[] = [240, 720, 1320];
```

That is **4:00, 12:00 and 22:00**. A run that ends at 15:00 never reaches 1320 seconds. The third
arcana offer never fires, in any run, on any stage, forever.

You have 8 arcanas designed for three offers per run. Cut to two offers and the deck's whole shape
changes: fewer combinations, and the arcanas balanced as late-run run-warpers now never appear.

`arcanas.ts:393-397` checks that the marks are ascending and match `MAX_ARCANAS`. It does not check
them against run length. Same blind spot as A1.

### A3 — Weapon evolutions get rarer, and I cannot tell you how much

`MAX_WEAPON_LEVEL = 8` (`weapons.ts:46`), and evolution needs level 8 **plus** a required passive
(`weapons.ts:110-112`). Halving run length halves XP earned, so fewer weapons reach 8, so fewer
evolve. Your 15 "final forms" are gated behind that.

I have not measured your XP curve, so I will not put a number on it. But it is the mechanism by which
"shorten the run" quietly becomes "players see less than half the weapon content."

### A4 — What I would actually do

`reaperSecond` is already per-stage. So the fix is not to pick one global number:

- Keep the run length **per stage**, short on early stages and long on late ones. That is what the
  field was built for.
- **Re-derive the unlock thresholds from each stage's own length** — a fraction such as "survive 60%
  of the stage" — rather than absolute minutes. Otherwise every future change to a stage's length
  silently re-locks content again.
- **Add a content-fault check** that fails the build when an unlock threshold exceeds the run length of
  the stage it gates, and when an arcana mark exceeds the shortest stage's run length. Both files
  already have a content-fault pattern (`contentFaults` in `awards.ts:395`), so this is cheap and it
  makes the whole class of bug impossible rather than merely fixed once.

That third bullet is the highest-value item in this entire document. It costs an hour and it
permanently retires the failure mode.

---

## B. Golden Eggs cannot be built as specified

Your archived plan (`docs/archive/plan-detail.md:122,167-169,129`) specifies:

> Permanent +1% stat gains, banked per run, purchasable with gold. **Uncapped** (until the float32
> easter egg) … the original hard-caps Golden Eggs at 3.402823e38 — the float32 maximum. We'll honor
> that number.

Three verified facts collide with that.

**Fact 1 — stats are 32-bit integers, not floats.** `stats.ts:220,225`:

```ts
readonly values: Int32Array;
this.values = new Int32Array(STAT_COUNT);
```

Maximum representable value is 2,147,483,647. The float32 maximum of 3.4e38 is **28 orders of
magnitude out of reach.** That easter egg cannot be honoured in this storage. Worse, `Int32Array`
does not saturate on overflow — it wraps. Assigning 2^31 stores −2,147,483,648.

**Fact 2 — the stats eggs would target are exactly the ones with no cap.** `stats.ts:189-195` sets
caps for `amount` (10), `armor` (50), `pierce` (10) and `critChance` (100%). Everything else is `-1`,
meaning uncapped — including **damage, maxHealth, moveSpeed, iFrames and revives.**

**Fact 3 — the clamp deliberately skips them.** `stats.ts:244-251`:

```ts
const cap = STAT_CAPS[i];
if (cap >= 0 && this.values[i] > cap) this.values[i] = cap;
```

`cap >= 0` means an uncapped stat is never bounded. Nothing stands between compounding growth and
integer wrap.

### The failure, and when it arrives

Compounding +1% from a base of 100 reaches 2^31 after roughly

```
ln(2.1e9 / 100) / ln(1.01)  ≈  1,690 eggs
```

At 5 eggs per Reaper kill that is ~338 kills — unreachable by a normal player, entirely reachable by a
dedicated Endless player over months, and reachable much sooner if eggs are also purchasable with gold
as the plan says.

On the egg that crosses the line:

- `maxHealth` wraps negative → the player is dead on spawn, permanently, and the save is corrupt in a
  way that reloading does not fix
- `damage` wraps negative → hits heal enemies
- `iFrames` wraps negative → invulnerability inverts

And it is **silent**. No exception, no crash, no telemetry — you removed the beacon, correctly, so the
first you hear of it is a review saying the game broke.

There is a second-order effect: a wrapped stat lands in `hashState`, so a player in this state
desyncs every co-op session and fails every replay revalidation. Anti-cheat would flag them as a
cheater. **The most loyal player you have gets banned by an integer overflow.**

### What I would do

- **Cap every stat.** `-1` should not be a legal value in `STAT_CAPS`. Your own comment at
  `stats.ts:187` says the caps are "what make Golden Eggs a long tail rather than an off switch" — but
  the stats eggs target have no caps, so as designed they *are* the off switch. Making the cap table
  total is a one-line change to the invariant and a test that asserts no `-1` remains.
- **Give eggs their own bounded curve** rather than raw stat multiplication: diminishing returns to an
  asymptote, or a separate egg-bonus field with its own hard cap that the resolve reads. This keeps
  "gold never becomes worthless" without unbounded arithmetic.
- **Drop the 3.4e38 easter egg, or move stats to `Float64Array`.** Doubles are exact for integers to
  2^53 and IEEE-754 arithmetic is specified, so determinism survives — but it is a storage change
  touching the state hash and every replay, so it is a pre-launch decision or never.

**If you take one thing from this document: cap the stats before you build eggs.** Eggs are the
trigger, uncapped `Int32Array` is the loaded gun, and the order you do these in decides whether the
bug is possible at all.

---

## C. Endless and the ladder are incompatible today

Your plan (`plan-detail.md:144`) specifies Endless as a **wave-table restart with a Curse increment**
per cycle — enemy speed, HP, spawn frequency, spawn quantity. Note this also answers your question
about the White Hand: **Endless never spawns the Reaper at all**, so the White Hand only governs
normal runs. There is no tension to resolve.

But Endless collides with anti-cheat, twice.

### C1 — Revalidation cost is linear and Endless is unbounded

Measured today: a 30-minute run revalidates in **7.76s** against a **5s** gate
(`replay/replay.test.ts:210`), and that is with a 256-entity stub, not the real sim. Extrapolating
linearly in ticks:

| Run length | Revalidation |
|---|---|
| 30 min | 7.8s |
| 2 hours | ~31s |
| 10 hours | ~155s |

Endless runs are unbounded by definition. No server request budget absorbs that, so **mandatory
full-replay revalidation cannot cover Endless.** This is not a tuning problem; it is the wrong shape
of algorithm for an unbounded input.

### C2 — Longer runs make the state hash noisier

`run.ts:1093-1119` walks `pool.slots` in **allocation order**, not a canonical order. Two clients that
agree completely about the world but consumed free-list slots in a different sequence produce
different hashes. Slot churn accumulates with spawns and deaths, so **the probability of a false
desync grows with run length** — and Endless maximises run length by design.

So the failure is not "Endless is risky", it is "Endless converts a rare theoretical false positive
into a routine one."

### What I would do, in this order

1. **Canonicalise the hash order** — sort by handle, or hash order-independently. Cheap, and it makes
   a desync report mean exactly one thing. Note `run.ts:1124-1127` already gets this right for props
   and explains why; the entity stores simply never got the same treatment.
2. **Decide Endless ladder eligibility now, before building it.** If Endless is off-ladder, C1
   evaporates and you never write the hard code. If it is on-ladder, revalidation must become
   **checkpointed** — periodic hashes with spot-checked segments — which is a different system from
   what exists and wants designing before Endless, not after.

---

## D. A lethal Reaper changes what a co-op misprediction costs

I recommended lethal contact damage rather than a special instant-death branch, because
`player.ts:125` shows `invuln` is a single gate — *"Above zero means incoming damage is ignored"* — so
damage is the only model in which the intended invuln-loop counter can work. That reasoning holds.

The consequence is in the netcode. Today a guest's prediction error shows up as a **position snap**,
smoothed by the rolling correction sweep in `net/correction.ts`. Cosmetic.

With a one-hit-kill hitbox, the same few units of error is no longer cosmetic — it is the difference
between alive and dead. And death is a **state transition**, not a position; a correction sweep that
interpolates coordinates cannot un-kill a player.

`gravewarden` carries `heavy | boss | persistent` (`enemies.ts:206`), so it is knockback-immune and
never culled — it sits on the player. That maximises the time spent exactly at the boundary where
prediction error decides life or death.

**I have not read the guest damage path closely enough to tell you whether guests already defer death
to the host.** That is the thing to check before building this. If they do, the risk is already
handled. If they do not, lethal contact needs death to be host-confirmed — and that is a netcode
change, so it belongs before co-op is switched on at launch, not after.

Relevant that your co-op is already **host-authoritative** by locked decision, which means the correct
fix is available and consistent with the architecture.

---

## E. "+1 Reaper per minute" is safe — build it

Worth stating plainly, because not everything here is a hazard.

`POOL_BUDGETS.enemies = 2048` (`pool.ts:193`). At one extra Reaper per minute, an hour-long run adds
45 bodies — about 2% of the budget. Each is `persistent` so it never frees its slot, but 45 slots is
noise, and your measured headroom is enormous: **8,176 quads at a flat 16.7ms p99 with zero dropped
ticks.**

The only real cost is several `heavy` bodies converging on one point, where separation cannot push
them apart. That is a *feel* question — a wall of Reapers — not a performance one, and it is exactly
what the mode wants anyway.

This is the piece to build first: small, safe, and it is the visible part of the ending.

---

## F. What my determinism fix cost you

Full disclosure, because it is a constraint I introduced tonight.

`fxSinF`/`fxCosF` round to integer brads, and there are 4096 brads per turn — **0.088° of angular
resolution.** For weapon spread and spawn placement that is invisible.

But `projectiles.ts` advances orbits as `(angle + angularVel) & (BRAD_FULL - 1)`, with `angularVel` an
integer. So the slowest possible non-zero rotation is 1 brad/tick:

```
1 brad/tick × 60 ticks/s = 60 brads/s = 5.27°/s = one revolution per 68 seconds
```

**No orbit weapon can rotate slower than about one turn per 68 seconds.** If a future weapon wants a
very slow, menacing drift, it cannot have one without accumulating fractional brads in a scaled
integer — a small change, but someone will hit this and be confused, so it is written down here.

I traded that for cross-engine reproducibility, which I think is the right trade given the alternative
was false-positive cheat bans. But it was a trade, not a free win.

---

## G. Any permanent stat system forces an ordering constraint against the ladder

Replays revalidate by re-simulating from a seed plus recorded inputs. If a permanent, account-level
stat affects the simulation, then a replay is only reproducible if it knows **what that stat was at
record time.**

This is not hypothetical: your shop powerups are already permanent stats, so this constraint already
exists and your replay format either handles it or already has this bug. **I have not verified which** —
that is the first thing to check.

Either way it dictates ordering for eggs:

- Eggs shipped **before** the ladder: no history to invalidate. Free.
- Eggs shipped **after** the ladder: every previously recorded replay revalidates against different
  stats, so every one becomes invalid, and the ladder resets.

The same applies to Ascension tiers and to any future meta-progression. So the general rule is:
**every system that permanently changes the simulation must ship before the ladder does, or reset it.**
That single sentence orders a lot of your Phase 6.

---

## H. Mini-boss scheduling is free; the roster may not be

`stages.ts:97` takes `boss?: string` per wave row, so a 10-minute named fight is one row of data.
Confirmed — no code change.

But the boss it names has to exist. You have **26 enemies, of which 8 are named fights**, across
**5 stages**. That is about 1.6 named fights per stage. Adding a second slot to every stage means
~10 needed, so you may need two new boss types — which is stats, art, and a wire id, not a data
change.

Cheaper alternative: reuse existing bosses across stages with a modifier (more HP, faster), which is
how Ascension is meant to work anyway (`plan-detail.md:175` — *"Ascension is just a `RunModifier`
stack — the Phase 1 system already handles it"*). Same body, harder fight, no new art. Worth doing
that way precisely because it exercises the modifier system you will need later regardless.

---

## THE ORDER THIS IMPLIES

Not a schedule — a dependency order. Each step is cheap before the one below it and expensive after.
Revised after the four verifications above; item 0 is new and it outranks everything.

0. **Diagnose why gold stops at minute 10 and why weapons never reach level 8.** Until progression
   works, no run-length decision can be evaluated, the shop cannot be funded, and eggs have no
   currency to be bought with. This is the core loop, and it is measurably not closing.
1. **Add the content-fault checks** (unlock threshold vs run length, arcana mark vs shortest run).
   Retires the entire class of bug in A1 and A2. Hours.
2. **Cap every stat.** Remove `-1` from `STAT_CAPS` and assert it. Blocks B entirely, and must precede
   eggs, Ascension and Endless Curse stacking. Hours.
3. **Canonicalise `hashState` order.** Makes desync reports mean one thing before Endless multiplies
   them — and, per D, determinism is now also what keeps a lethal Reaper safe in co-op. Hours.
4. **Give the White Hand a presentation.** The cues already fire with position and toll index; nothing
   consumes them. Cheapest large improvement available, no simulation change.
5. **Set `reaperSecond` per stage and re-derive unlock thresholds as fractions** — after 0, so the
   decision is made against a working curve, and after 1, so a mistake fails the build.
6. **Build the rest of the ending:** +1 Reaper per minute, lethal contact damage as a named constant,
   and the first tests of the White Hand sequence, which currently has **zero** coverage.
7. **Decide Endless ladder eligibility.** Determines whether checkpointed revalidation must exist.
8. **Then eggs** — needing the cap from 2, a name, and the modifier slot from G.

Items 1–3 are about six hours between them and they are the difference between "we fixed a bug" and
"that bug was never possible." Item 0 is unscoped until it is diagnosed, which is exactly why it is
first.

---

## THE FOUR OPEN QUESTIONS — NOW ANSWERED

All four were checked. Two dissolved, one is confirmed missing, and the fourth turned up something
that outranks everything above it.

### D — Guests do NOT predict their own death. Risk largely dissolves.

`net/local-view.ts:2` — LocalView *"makes the local player's own movement feel instant"*. It is
**movement prediction only**. And `local-view.ts:163` is explicit:

> `alive` false — downed or dead — stops prediction dead. A corpse does not walk.

`net/session.ts:10-12` confirms the model: *"there is no steady-state traffic describing spawns, damage
or deaths… The host confirms a tick's input record and broadcasts it."* Guests re-run the same
authoritative input stream deterministically; disagreement is caught by state hash and repaired with a
full snapshot (`session.ts:22-23`).

**So a guest cannot mispredict itself into death.** My earlier concern was largely wrong — the
architecture already handles it, by keeping prediction render-side and stopping it at death.

What remains is smaller but real: with a one-hit-kill hitbox, any *residual nondeterminism* stops being
a cosmetic position snap and becomes a brief wrong death followed by a resync. Which means the
cross-engine determinism work is not merely nice for anti-cheat — **it is the thing that makes a lethal
Reaper safe in co-op.** Those two decisions are coupled, and they were not obviously coupled before.

### G — Replays already carry permanent stats. No new requirement.

`replay/format.ts:163-180`, `RunHeader` contains:

```ts
modifierCount: number;
modifiers: Int32Array;      // MAX_REPLAY_MODIFIERS = 64
contentVersion: number;
buildId: number;
```

The channel exists and is versioned. Eggs become a modifier entry like everything else, and
`contentVersion` already lets a revalidator reject or special-case a replay recorded under different
content. The ordering constraint in section G is therefore **a design that was already anticipated**,
not a bug to fix — but the 64-slot ceiling is a real budget worth remembering before piling in
Ascension tiers, egg counts and shop ranks.

### 4 — The White Hand has no presentation at all. Confirmed missing.

`CUE.reaperArrived` (16) and `CUE.bellTolled` (17) both exist and both fire. The only cue any screen
consumes is `CUE.chestOpened` (`app/dev/play.tsx:547`).

Nothing reddens the screen. Nothing pushes the camera. Nothing plays a bell, because there is no audio
layer yet. **Today the ending is: the Reaper appears, and twelve seconds later the run silently stops.**

The simulation is right and the payoff is absent. That is the cheapest big win in this document — the
cues are already emitted with position and a toll index, so a presentation layer has everything it
needs and requires no simulation change.

### A3 — The XP curve, measured. This is the real finding.

Built `tools/measure-xp-curve.ts` and ran three seeds. Godmode, player walking a circle, `autoPick`
taking card 0.

| | seed 20260830 | seed 777 | seed 424242 |
|---|---|---|---|
| level at 15 → 30 min | 36 → **39** | 16 → **18** | 16 → **20** |
| best weapon level at 15 → 30 | 5 → **5** | 3 → **4** | 3 → **4** |
| weapons at max level (8), ever | **0** | **0** | **0** |
| gold at 10 min → 30 min | 69 → **80** | 16 → **16** | 12 → **12** |

Three things, all consistent across seeds:

**1. Gold income stops at about minute 10–12.** In two of three seeds the gold total is *identical* at
minute 10 and minute 30. A whole 30-minute run yields **12 to 80 gold.** The shop is 20 items with five
levels each, and your plan has Golden Eggs *"purchasable with gold"*. If a full run pays 16 gold, the
meta-economy does not function. I have not diagnosed the cause and will not guess — but it is a real,
reproducible anomaly.

**2. No weapon ever reaches level 8, so no weapon ever evolves.** `MAX_WEAPON_LEVEL = 8` and evolution
needs level 8 plus a passive. Best observed across three full 30-minute runs is level 5. All 15 evolved
final forms are currently unreachable. *Caveat that matters:* `autoPick` takes card 0 blindly and
spreads upgrades across six weapons, where a real player funnels one. So this number is a floor, not a
verdict — but the gap from 5 to 8 is wide enough that focusing alone may not close it.

**3. The back half of a run is nearly empty.** Minutes 15–30 contribute 2–3 levels, 0–1 weapon levels,
and 0 gold.

### What this does to section A

It inverts it. Cutting a run to 15 minutes costs far **less** than section A feared, because minutes
15–30 currently produce almost nothing.

But that is not a reason to relax — it is a worse problem wearing a friendlier face. The reason
shortening the run looks cheap is that **the second half of your run is already broken.** The arcana at
22:00 and the 20-minute stage unlocks are gated behind a stretch of play that pays out nothing.

So the ordering changes. Diagnosing the gold flatline and the weapon-level ceiling should come before
tuning `reaperSecond`, because until progression works you cannot tell whether a 15-minute run is
*correct* or merely *indistinguishable from a broken 30-minute one.*

### Still not verified

- **The Reaper HP that makes an invuln-loop kill possible but not trivial.** Needs late-run DPS, which
  now looks lower than assumed given the weapon-level ceiling.
- **Whether an invuln-loop kill is achievable at all.** `passives.ts:345-352` grants up to +44 iFrames
  and `powerups.ts:354` sells more permanently, on a base of 30 (`stats.ts:148`). The tools exist; the
  arithmetic against 9999 contact damage is not done.
