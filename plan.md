# Nightreap Survivors — Build Plan

*Mobile-first bullet-heaven survival roguelite. Faithful mechanics, original art, 1–4 player online co-op.*

---

## What we're building

A mechanically faithful clone of Vampire Survivors: move-only controls, weapons that fire
themselves, XP gems → level-up card draw → build crafting → evolutions via treasure chests, gold →
permanent PowerUps shop, Arcana modifiers, 20+ stages, 40+ characters, 100+ items, bosses, reapers,
persistent save, 150+ achievements.

Plus **1–4 player online co-op**, a **full mode catalog** (Endless, Limit Break, Daily Run, replays,
and more), an **extremely thorough dev menu**, and an **active anti-cheat program** treated as a live
feature rather than a chore.

**Name:** Nightreap Survivors. Slug `nightreap-survivors`, app dir `/home/user/nightreap-survivors`.

**Legal line we hold:** systems, formulas, timings, and balance replicated as closely as possible.
All sprites, music, and SFX original. All proper nouns renamed — characters, weapons, stages,
arcanas. Stat names, evolution logic, wave structure, and UI layout language stay faithful.

---

## Progression ceilings — the level cap answer

Researched against the original so our curve matches.

### Player level: no cap

Faithful to the original, which has none. Recorded runs reach level 200, 296, 1500+, and one report
of **~14,000** with Limit Break on a high-cooldown build.

- **XP curve:** 5 XP for level 2, then +10 XP per level through level 20, flattening after.
- No cap means the level-up UI must survive absurd cadence — see *batch level-up* below.

### The real wall: everything maxed

The interesting ceiling isn't level, it's **6 weapons at level 8 + 6 passives at level 5**, which a
good run hits around 12–18 minutes. Three layers answer "so now what":

| Layer | State | What a level-up gives you |
|---|---|---|
| **1. Base** | Limit Break not unlocked | A small gold pile or a chicken (heal). Functional, unexciting — deliberately, because it's the motivation to unlock layer 2. |
| **2. Limit Break** | Relic unlocked, toggled at stage select | **Extra levels on already-maxed weapons.** Damage, area, amount, speed, duration climb without bound. This is the endgame payoff and where runs get gloriously stupid. |
| **3. Meta** | Always | **Golden Egg equivalents** — permanent +1% stat gains banked per run. Effectively infinite. The sink that keeps Endless meaningful after the shop is maxed. |

**Critical balance detail:** even under Limit Break, **individual stats keep hard caps** — projectile
amount caps at 10, armor at +50, pierce at 10. Caps apply to the weapon's base value, not the bonus.
This is what stops Limit Break from becoming a nothing-matters switch, and it's why the original still
feels like a game at level 14,000. We replicate the cap table.

*Easter egg:* the original hard-caps Golden Eggs at 3.402823e38 — the float32 maximum. We'll honor
that number.

### Run ceiling: the Reaper sequence

Sourced from your screenshots and cross-checked:

- **30:00** (15:00 on some stages) — the clock ends and a **Red Reaper** spawns. Normally an instant kill.
- **+1 reaper per minute after** — 2 at 31:00, 3 at 32:00, and so on. The stage technically continues
  until you die or kill one.
- **Killing it** requires the evolved Clock Lancet or evolved Laurel equivalents (invuln-loop tools).
  Reward: **5 Golden Eggs**, and the Reaper unlocks as a playable character.
- **Then the White Hand.** Screen reddens, camera slowly zooms to your character, **a bell tolls 12
  times**, and an unkillable, unhittable White Hand arrives and instant-kills you. Run over. It's the
  best "you win, and also you die" beat in the genre and we're replicating it exactly.
- **Endless** replaces the reaper spawn with a **wave-table restart**, stacking a Curse increment each
  cycle (enemy speed, max HP, spawn frequency, spawn quantity) so difficulty compounds indefinitely.

### Batch level-up is a hard requirement, not a nicety

At Limit Break cadence a player can gain dozens of levels per second, and one report describes
gaining 230 levels from a single gem. So:

- Level-ups **queue and resolve in batches**; the card UI never opens 40 times in a row.
- Above a threshold, upgrades auto-apply along the player's chosen weighting instead of prompting.
- **In co-op this is also a netcode concern** — batch level-up is one shared pause with all players
  picking simultaneously, and the resolved batch is a single authoritative host event, not 40.

---

## After the shop is maxed — the actual endgame

This is the original's weakest point and worth fixing properly. In the original, the PowerUps shop
fully maxes for roughly 40–50k gold, and after that **gold is nearly worthless** — its only remaining
sink is buying eggs off the merchant. Hundreds of hours in, players are earning a currency that does
nothing. We keep the shop faithful and then give the maxed player seven real ladders, ordered by how
long each one holds:

**1. Golden Egg equivalents — the infinite stat bank.**
Permanent +1% stat gains, banked per run, purchasable with gold. Uncapped (until the float32 easter
egg). This alone means gold never becomes worthless: the shop maxing is a *graduation*, not a wall.

**2. Ascension tiers — the difficulty ladder.**
A permanent, per-stage difficulty rank. Each tier stacks a Curse increment (enemy speed, HP, spawn
rate, spawn count) and pays out more gold and eggs. Your record is "cleared Ascension 14 on Stage 6,"
not "beat the game." This is the main long-tail loop and it costs almost nothing to build because
Ascension is just a `RunModifier` stack — the Phase 1 system already handles it.

**3. Mastery — per-character progression.**
Each character banks its own XP across runs and earns small, character-unique bonuses. Gives players
a reason to rotate through 40+ characters instead of settling on one, and turns the roster itself into
a completion track.

**4. Relics and runes — rule-changers, not stat bumps.**
Unlocked by *challenges*, never by gold: "kill a Reaper", "clear 20 minutes taking no damage",
"finish with one weapon". They change rules (Limit Break itself is one) rather than adding numbers, so
they stay interesting after every stat is maxed.

**5. Cosmetics — the pure gold sink.**
Palette swaps, hats, weapon trails, HUD frames, death-cry variants. Cosmetic-only, no power, priced to
absorb late-game gold indefinitely. Cheap for us: palette swaps are already a shader path we build for
co-op player colors.

**6. Competitive — Daily Run, Weekly mutator, seeded race, validated leaderboards.**
Infinite by construction because the content is a seed and a modifier stack. This is where anti-cheat
earns its keep: a leaderboard nobody trusts is not an endgame.

#### Leaderboards have to pay out, and here is exactly what they pay — SETTLED

A board that only says "you are 4,812th" is not a reward, it's a receipt. So every ladder pays. The
hard rule that makes it safe: **a leaderboard never grants power.** No gold, no Golden Eggs, no
Ascension shortcuts, no stat bonuses, ever. The moment placement grants power, being good at the game
becomes a requirement for being strong at the game, and everyone who just wants to play gets left
behind. Rewards are prestige and cosmetics only.

**The currency: Reaper Marks.** A second currency, separate from gold, that buys cosmetics only. It is
granted by the server, never by the client, and it cannot convert into gold, eggs, or anything with a
stat attached. Marks are the payout rail for every board so we tune one number instead of twenty.

**Paid by percentile, not by rank.** Brackets are top 0.1% / 1% / 5% / 10% / 25% / 50%, plus a flat
participation grant for any validated finish. Percentiles work identically with 300 players or 300,000,
so nothing needs retuning as the game grows, and a mid-table player still gets paid for showing up.

**What each board pays**

| Board | Cadence | Pays |
|---|---|---|
| **Daily Run** | Daily | Participation Marks + bracket Marks. A 7-day and 30-day streak bonus, because the streak is the retention mechanic, not the score. |
| **Weekly mutator** | Weekly | Larger Mark payout, plus a weekly-exclusive cosmetic for top 5%. |
| **Seeded race** | Ad hoc | Marks + a "fastest clear on seed X" title that stays attached to that seed forever. |
| **Ascension tiers** | Lifetime | A tier emblem per tier cleared, shown on your profile and your co-op nameplate. First-clear-in-the-world of a new tier gets a permanent named banner. |
| **Endless depth** | Lifetime + seasonal snapshot | Depth badges at milestones (30 / 60 / 90 minutes and up). |
| **Per-character Mastery** | Lifetime | That character's alternate palette, then their signature HUD frame. |
| **Co-op boards (per party size)** | Seasonal | Marks for every party member at full value — same rule as co-op gold, a carry is never penalized. |

**Non-cosmetic prestige that costs us nothing to give:** titles, profile banners, an emblem on your
co-op nameplate, and **Run of the Week** — the top validated replay gets featured in the in-game replay
browser with the player's name on it. That last one is the strongest reward in the list and it's free.

**No FOMO tax on people who don't compete.** Roughly 95% of ladder cosmetics enter the normal gold shop
one season later, at a higher gold price. Only a small set of placement items (top 0.1% and world-first
tier clears) stay exclusive forever, and those are emblems, not looks — so nobody who plays casually
ever feels visually locked out.

**Seasons.** Four weeks. Daily boards reset daily, weekly boards weekly, Ascension / Endless / Mastery
are lifetime with a seasonal snapshot, so a season winner exists without wiping anyone's record.

**Anti-abuse, which is the whole reason this is safe to build:**

- Marks are granted **server-side only, after replay revalidation**. There is no client message that
  says "give me Marks," so there is nothing to forge (§5b).
- Tainted or unvalidated runs earn nothing — not zero Marks with a warning, simply not a submission.
- Payouts are computed **at board close, not at submit**, so a run that fails later revalidation never
  paid out in the first place.
- Every grant is a row in the append-only event log, so a bad season can be recomputed and clawed back
  by the same purge-and-rebuild path the ladders already use.
- Marks are account-bound. No trading, no gifting, no transfers — that kills farming rings outright.

**When it's built.** The Marks wallet and the owned-cosmetics bitfield go into the save through the
migration path that exists from day one; the payout tables live in remote config so brackets can be
retuned without an app update. Boards and grants land with the ladders in Phase 6; the cosmetic store
that spends Marks opens in Phase 8 alongside live ops. Marks accrue from the day boards ship, so early
competitors aren't paid nothing for being early.

**7. Collection completion.**
40+ characters, 20+ stages, 22 arcanas, every weapon evolution logged, 150+ achievements. The
completionist track, and the thing that makes players read patch notes.

**Deliberately not doing:** a prestige/reset that wipes the shop for a multiplier. It's a common
answer and it's a bad one — it punishes the players who got furthest. It'll sit behind a dev-menu flag
so we can try it, but it isn't shipping unless it plays better than Ascension, and I doubt it will.

### Built to be continuously expanded

Since you plan to keep building on this if it lands, the architecture is set up now so that later
content doesn't require re-architecting:

- **Content is data, and the data is versioned.** Weapons, stages, waves, mutators, and achievements
  are typed records with a schema version. A content-lint script in CI validates every record and
  every unlock condition, so adding weapon #57 can't silently break an evolution chain.
- **Server-side live ops.** Daily seeds, the weekly mutator, Ascension payout tuning, and feature
  flags are server records, not client constants. You can run a new weekly event without shipping a
  build or waiting on App Review.
- **Remote config + progressive rollout** is built in Phase 0 for co-op's locked launch, and then it's
  permanently available for every future feature.
- **Save migrations from day one.** Every save has a version and a migration path, tested in the dev
  menu ("force migration from version N"). New progression systems can be added without wiping anyone.
- **Replay compatibility versioning.** Replays record the engine version; the validator refuses
  mismatches instead of producing garbage. Keeps leaderboards honest across patches.
- **Telemetry that answers "what should I build next":** which characters and stages get played, where
  players die, which weapons never get picked, where sessions end. Aggregate, not personal.

---

## Device targets

You own both ends of the range, which is the ideal setup — a flagship for feel and a budget device for
truth.

| | Role |
|---|---|
| **iPhone 17 Pro Max** (A19 Pro, 120Hz ProMotion) | Primary **feel** target. Sim 60Hz fixed, render interpolates to **120fps**. Deliberately *not* the perf gate — it holds 500 enemies without trying, which hides problems until someone on a cheap phone plays. |
| **Your T-Mobile REVVL V+ 5G** | The **official perf gate device.** A real budget Android with real thermals beats any emulated profile. Every phase gate is measured here. |
| Emulated device profiles | Regression catching in the sandbox between your hands-on passes. Not a substitute for the REVVL. |
| Runable web preview | Fast iteration, playable in the Runable app. Not a perf verdict. |

### The REVVL V+ 5G profile

This is settled, not assumed. The exact phone is a **T-Mobile REVVL V+ 5G**, and every spec below was
read back off the device itself during the Gate A measurement — the renderer reports the GPU string at
runtime, and it came back `Mali-G57 MC2` with a 720×1640 buffer at 3x density. No runtime branching on
"which REVVL is it" is needed, and there is no second variant to design around.

| | REVVL V+ 5G |
|---|---|
| SoC | MediaTek Dimensity 700 |
| GPU | Mali-G57 **MC2** (2 cores — weak) |
| RAM | 4 GB |
| Screen | 1640×720, 60Hz |

Measured Gate A baseline on this phone, native, warm at 15m51s: 5,176 sprites in 5 draw calls,
**17.9ms median / 21.9ms 95th / 32.0ms 99th**, 56fps sustained, overdraw 29x the screen, zero memory
warnings. That is the number every later gate compares against.

Two consequences that change engineering priorities:

- **720p is a gift.** That is ~40% of a 1080p panel's pixels. Fill rate — usually the first thing to
  die with 800 overlapping sprites — has real headroom despite the weak GPU, and the measured 29x
  overdraw at 56fps confirms it: this phone was never fill-rate bound in the benchmark.
- **4 GB RAM is the real enemy, not the GPU.** With 4 GB and Android's background pressure, a garbage
  collection pause is a dropped frame, and a 90-minute Endless run is 90 minutes of allocation
  opportunity. This promotes the Phase 0 **zero-allocation entity pools and preallocated typed-array
  buffers** from "good practice" to *the* thing that makes the perf contract achievable. The dev menu's
  allocation tracker and GC watch are gate instruments, not curiosities.
- **60Hz here, 120Hz on the iPhone.** Android renders at 60 and iOS at 120 from the same 60Hz sim —
  exactly the split the interpolating renderer is designed for, and testable on both real phones.

### Performance contract

**500 enemies at 60fps is a hard floor, not a target.** Below 60fps at 500 active enemies is a build
failure that blocks the phase.

- **Gate:** 800 active enemies at 60fps **on your REVVL**.
- **Floor:** 500 never dips there.
- **Measured in a 4-player run** under simulated 150ms latency and 2% packet loss. Not home wifi.
- Measured **after 15 minutes of play**, not from a cold start — budget Androids thermally throttle, and
  a benchmark that passes cold and fails warm is a benchmark that lied.
- Every deliver ships an on-screen frame-time + entity-count overlay. Measured, not asserted.
- **You don't need to buy a device.** You already own the honest test.

### The Endless gate — separate, and taken seriously

Your screenshot shows a player on a **PS5** reporting the game "starting to sputter" at 72 minutes of
Endless. A PS5. Endless with 40 Limit Break weapons is a fundamentally different perf problem than a
30-minute run, because VFX and projectile counts compound rather than plateau.

- **Endless gate:** a **90-minute** Endless run at 60fps on your REVVL, with Limit Break
  active and a full weapon loadout.
- Hard caps on concurrent projectiles, VFX, and damage numbers, with graceful visual degradation
  (merge, fade, or skip cosmetics) rather than frame loss. Gameplay-relevant entities never get culled;
  cosmetics do.
- **Automated soak test:** a scripted 3-hour Endless run in CI with the replay harness, asserting no
  frame-time regression, no memory growth, and no pool exhaustion. This catches the leak class that
  only shows up at minute 200, which no human will sit through.

---

## Architecture

**Stack:** Runable managed template via `app_init` — Bun, Expo/React Native, Hono, Drizzle.

### 1. The engine is plain TypeScript, zero React Native imports

Lives in `packages/mobile/game/`. Keeps a later web/desktop port a shell swap rather than a rewrite,
and lets the sim run headless in CI for replay and soak tests.

### 2. Netcode — desync is designed to be impossible to matter

**Your requirement:** it must never be possible for two players to drift into different games.

**The naive answer is "make the simulation perfectly deterministic," and I reject it as a correctness
strategy.** I cannot prove JavaScriptCore (iOS), Hermes (Android), and V8 (web) agree bitwise on every
operation forever, across OS updates. Building correctness on an unprovable assumption is exactly the
risk you refuse.

**So determinism becomes an optimization, not a correctness requirement.** The host is authoritative
over everything that matters and clients continuously self-correct. Drift is *bounded* and
*self-healing* by construction.

#### How 800 enemies sync without flooding the network

| Data | How it travels | Cost |
|---|---|---|
| Enemy **spawns** | Authoritative host event: id, type, position, seed | A few per tick |
| Enemy **movement** | Derived locally from synced player positions | Free — nothing sent |
| Enemy **correction** | **Rolling sweep**: each tick the host sends true state for ~5% of enemies, round-robin, nearest-to-receiver first | **Bounded and constant regardless of enemy count** |
| **Damage, deaths, chest contents, card draws, batch level-ups, pickup ownership, boss phases** | Always authoritative host events. Never predicted. | Small, event-driven |
| **Player positions** | 4 players every tick, with local prediction on your own | Trivial |
| **State hash** (positions + HP + RNG counters) | Every ~2s; mismatch triggers compact resync | Backstop |

**Why this satisfies the requirement:** every enemy is re-truthed roughly every 0.3s. Drift is capped
at that window and cannot accumulate. Worst case from a determinism bug is one enemy briefly
rubber-banding — not two divergent games. There is no path to "30 seconds later you're in different
games," because 0.3 seconds later everything has been corrected.

**Fixed-point Q16.16 math is still used throughout the sim** (`game/core/fx.ts`, trig via generated
LUTs, named per-subsystem seeded RNG streams, no `Date.now()` or `Math.random` in sim). Not for
correctness — as an optimization. Better cross-device agreement means fewer corrections, lower
bandwidth, smoother motion. If it slips, nothing breaks.

Plus ~2-tick input delay with local prediction on your own movement so the joystick feels instant.
Host is a player; the server is **relay + matchmaking only**, keeping costs near zero. Host migration
on disconnect.

**Transport:** Bun native WebSocket upgrade as a plain route in `packages/web/src/api/index.ts`.
Matchmaking, rooms, leaderboards, and replays via oRPC + Drizzle. Binary framing (`DataView`), not JSON.

### 3. Co-op structure — flexible party sizes

**Any size from 1 to 4.** Two is a first-class configuration, not a degraded four. Enemy density, XP
curve, and boss HP scale per player count so a duo isn't drowning and a quad isn't trivial.

```
   Solo          Play alone

   Private       Create room → 6-char code → invite
                 Choose max size 2 / 3 / 4
                 Toggle: fill empty slots with randoms

   Public        "I want to play with…"  1 / 2 / 3 others
                 Queue → matched into a party of that size
                 Toggle: friends first, then fill
```

- **Bring your own + fill:** join with 2 friends in a party of 4 and matchmaking fills the last slot.
- Drop-in mid-run if the room allows; drop-out never ends the run for others.
- **Co-op only.** No versus.
- **Per-player camera with a leash** — stray too far and you're pulled back, matching the original's
  refusal to let players fully separate.
- Shared XP pool with **batch level-up**: one shared pause, all players pick simultaneously.
- Downed players revive on a timer or by a teammate. Run ends when all are down.
- **Cross-platform** iOS ↔ Android ↔ web, safe now that correctness doesn't depend on engine agreement.
- Local couch co-op skipped: four people on one phone isn't a thing.

#### Carrying is allowed, and here is exactly how far it goes — SETTLED

A veteran joining a newcomer's run makes that run easy. That is intended. It does not make the
newcomer's account strong, because the two kinds of power are kept separate:

| | Shared in co-op? | Notes |
|---|---|---|
| In-run levels, weapons, passives | **Yes** — shared XP pool, batch level-up | Temporary, gone at run end. This is where carrying happens. |
| Gold earned | **Yes**, full value per player | Counts toward each player's own solo shop. Never reduced for being helped. |
| Permanent shop upgrades | **No** | Each account buys its own. A carry accelerates the grind, it does not skip it. |
| Unlocked characters / stages / arcanas | **No** | Earned per account, though co-op participation satisfies "was present when X died" conditions. |
| Achievements | Participation counts | If you were in the run that killed the Reaper, you killed the Reaper. Gating this would push people to play alone. |

Three guardrails, all already required elsewhere in this plan:

1. **Ladders are segregated and revalidated.** Solo boards are solo-only; co-op boards are ranked
   separately per party size (1 / 2 / 3 / 4 are four different boards). Every ladder submission is
   re-simulated server-side. A carry cannot contaminate a board the carried player wasn't in.
2. **Enemy COUNT scales with player count; enemy HEALTH does not.** Four players face roughly four
   times the crowd, so the screen stays lethal and each player still has to survive their own corner.
   Health scaling is explicitly rejected — it makes everything spongy and drains the fun out of the
   weapons. Boss HP is the one exception and scales, because a boss is a single target.
3. **No anti-carry penalties, ever.** No reduced gold, no reduced XP, no "assisted run" stigma. The
   design accepts that being helped by a friend is the single best onboarding funnel this genre has.

### 4. Co-op is built at launch but shipped locked

Per your call: the full system ships in the v1 binary, **disabled behind a remote-config flag**.

- Lets you watch behavior across real devices, OS versions, and networks before exposing it.
- Unlock progressively: your devices → friends allowlist → percentage rollout → everyone. No app
  update needed to flip it.
- Misbehaves in the wild? Turn it off in seconds instead of shipping a hotfix.
- Solo never touches the co-op code path, so a co-op bug cannot affect a solo run.

### 5. Anti-cheat as a live feature

You want people to try, and you want to fight back.

**Client-side cheating is mostly dead on arrival** — host authority means a modified client can lie
about its joystick and nothing else. No self-granted damage, gold, or items.

**The real hole is a cheating host,** so:

- **Replay validation.** Every run uploads a compact input tick-log; the server re-simulates headless
  and compares the claimed result. Mismatch = rejected. Same harness built in Phase 0 for determinism —
  one system, two purposes.
- **Heuristic flags:** impossible DPS curves, gold-per-minute outliers, sub-frame input timing,
  teleport deltas, level-ups without matching XP.
- **The Reaper response.** Confirmed cheaters get visited by an unkillable Reaper that hunts them
  specifically. Thematically perfect, funnier than a ban, self-documents in clips.
- **Shadow segregation:** flagged accounts matchmake with each other. Cheaters get a cheater lobby.
- **Cheat telemetry dashboard** in the dev menu — live flags, replay diffs, per-account history — so
  fighting it is playable for you rather than log-diving.
- Leaderboards accept validated runs only. Unvalidated still counts for personal progression.

### 5b. Dev menu ships in public builds — and the blast radius is engineered around it

**Your call, locked: the full dev menu ships in the public store build behind a secret unlock.** It
gets found. It gets posted. When that happens you let it run wild for about a week, watch what people
do with it, then patch the unlock out in an update. After that it comes back deliberately as **Chaos
Sandbox Day**, roughly once every 3–6 months.

I'm building to that decision. But you need to know exactly what it does and does not cost, because
the whole design below exists to make "found and abused" a non-event instead of an emergency.

**The uncomfortable truth, stated once:** there is no version of this where it stays secret. React
Native ships Hermes bytecode, which decompiles with free open tools (`hermes-dec`, `hbctool`,
Bytecode Studio). Any gesture, password, or boolean check is a function a Frida script hooks in
minutes on a rooted device. Obfuscation raises the effort from "an afternoon" to "a weekend" and
nothing more. So the plan does not spend a single hour pretending the gate holds. It spends those
hours making the gate irrelevant.

**The rule that makes it safe: the dev menu can only write to the simulation, never to the server.**

- Every dev/cheat toggle is a **client-local sim mutation**. There is no dev-menu code path that
  calls a server write. Not gold, not unlocks, not scores, not entitlements. The server has no
  endpoint that accepts "my stats are X" from any client, cheating or not.
- **Touching any toggle taints the run, immediately and irreversibly**, via a `tainted` bitfield in
  the run seed header (which flags, at which tick). A tainted run cannot submit to any leaderboard,
  cannot upload a replay for validation, cannot count for Daily/Weekly/seeded race, and cannot enter
  the public co-op queue.
- **Tag the run, not the save** — your call. The taint lives on the run record, not the profile. Open
  the dev menu, wreck a run, close it, start a clean run: that next run posts normally. No permanent
  scarlet letter on a 200-hour save.
- **Cheats on = offline, by construction.** While a run is tainted, network-competitive surfaces are
  simply not reachable from that run. Personal progression still accrues (it's your save), it just
  never touches a ladder.
- **Offline solo save modding is explicitly allowed.** Hex-edit your local save all you like. Those
  profiles are barred from leaderboards by the same validated-runs-only rule and nothing else
  happens to them. It's a single-player game on your own device; that's your business.
- **Co-op is untouched.** Host-authoritative means a modded guest can lie about its joystick and
  nothing else — it desyncs only itself and gets corrected or dropped. The dev menu is unavailable
  to guests in public lobbies; in a private room the host can opt to allow it, and the whole room's
  runs are tainted for the session.
- **Leaderboards were already immune.** They accept server-re-simulated runs only. A cheater with the
  full dev menu open can't post a fake time because posting requires an input log that reproduces the
  claimed result headless on our server.

**Remote kill switch, because "a week" should be your choice and not the mob's.** The unlock is gated
by a remote-config flag, per-feature and per-account, changeable server-side within seconds and
**without an app update or App Review**. If the week goes somewhere you didn't intend — mass account
grief, a store-review problem, an exploit that touches other players — you flip it off from your
phone. The scheduled patch-out then just makes it permanent in the binary.

**Chaos Sandbox Day** (every 3–6 months) is the same switch used on purpose: a 24–48h remote-config
event that turns the sandbox on for everyone, with an in-app banner, its own achievement, and
**server-granted** giveaways for participants — server-granted specifically so the free stuff you
hand out can't be forged by the people currently holding a cheat menu. Chaos runs are always tainted,
so no ladder is ever polluted, and the event needs zero engineering work each time it runs.

**Top-tier revert capability, per your call** — this is the insurance that makes shipping the menu a
reasonable bet:

- **Append-only server event log.** Nothing is ever overwritten in place. Every gold grant, unlock,
  score, entitlement, and admin action is an immutable event with actor, timestamp, and build version.
- **Per-account snapshots + point-in-time restore.** Roll one account, a cohort, or every account
  back to any moment. If a duplication exploit runs for six hours, you restore to hour zero.
- **Leaderboard purge-and-rebuild.** Ladders are a projection over validated runs, not a hand-edited
  table, so a rebuild is a recompute — not a cleanup.
- **Automated anomaly detection and alerting.** Gold-per-minute, score, and unlock-rate outliers page
  you when a population-level curve bends, not when a player tweets about it.
- **Break-glass admin tools in both places** — a web admin page and the private dev build: flag, ban,
  shadow-segregate, revoke a run, restore an account, quarantine a whole build version.

**One build, two behaviors.** The dev menu is compiled in for release but every entry point runs
through `devgate.ts`, which checks the remote flag, the build channel, and the account role. Your own
devices sit on the private internal channel (internal TestFlight / Play internal track) where the
menu is always on and does not taint runs against a separate dev-only ladder. That gives you the
frictionless workflow you want while the public path stays gated and revocable.

**Every panel is tagged SELF or SYSTEM — and that tag decides what ships unlocked.** This is exactly
the split you described, formalized so it can't drift:

- **Tier SELF — unlocked in public builds behind the secret unlock.** Anything whose worst outcome is
  that *you* had a weird time in *your own* run. Godmode, one-shot kill, grant any weapon/passive at any
  level, force evolutions, set player level, spawn enemies or bosses, slow-mo and fast-forward, restart
  same seed, freeze spawns, jump to a run timestamp, kill all, reroll RNG, edit the modifier stack,
  toggle VFX and overlays, atlas and audio inspection, screenshot capture, pseudo-localization,
  accessibility simulation, device-profile emulation, input recording and playback. All of it taints the
  run and none of it can reach another player or the server.
- **Tier SYSTEM — never in public builds, private dev channel + web admin only.** Anything that can
  actually mess something up for someone else or for the game's shared state. Writing gold, unlocks,
  achievements, or entitlements to the *account* rather than the run. Submitting or editing a
  leaderboard entry. Anything that bypasses replay validation or clears the taint flag. Forcing
  matchmaking, joining or spectating a stranger's session, injecting into another player's sim. Bot
  players in public lobbies. Remote-config writes, kill-switch controls, account flag/ban/restore,
  snapshot and point-in-time restore, purge-and-rebuild, telemetry on other accounts, clock forcing that
  affects server-side Daily/Weekly windows, save-slot writes to synced cloud saves.

**Enforced structurally, not by discipline.** Each panel's registry entry carries `tier: 'self' |
'system'`, and `devgate.ts` is the only way any panel opens. A **CI content-lint rule** fails the build
if a SYSTEM panel is reachable on the public channel, if a SELF panel forgets to set the taint flag, or
if any dev-menu file imports a server-write module. The default for a new, untagged panel is SYSTEM —
so a panel added carelessly is locked, never accidentally public. Anything genuinely borderline gets
tagged SYSTEM and I'll flag it to you rather than guess.

**The line, in one sentence:** if the worst case is "my run got silly", it's unlocked; if the worst case
touches the server, the ladder, or another human being, it never leaves your private build.

**What I still owe you honestly:** shipping this raises two real risks that don't disappear —
Apple/Google reviewers stumbling on a debug surface (mitigated: it's flag-off at submission, so a
review build behaves like a normal game), and inflated word-of-mouth about the game being "the one
you can cheat in" during the found-and-wild week. Both are survivable. Neither is invisible. They're
in the Risks table with mitigations.

### 6. Extremely thorough dev menu

First-class tool built in Phase 1 and grown every phase. Ships in public builds behind a secret
unlock plus the remote-config gate described in §5b — every entry point routes through `devgate.ts`,
and using any of it taints the current run.

**Run control:** pause, step one tick, slow-mo, fast-forward ×2–×16, restart same seed, jump to any
run timestamp, force any wave or boss, kill all, freeze spawns, invincibility, one-shot kill.

**Player:** set level, grant any weapon/passive at any level, instant-max, force any evolution, set
every stat, swap character mid-run, teleport, set gold, **force Limit Break state**, **jump to level
10,000** to stress the batch level-up path.

**Content inspectors:** browse every weapon/passive/character/enemy/stage/arcana/achievement record
live with hot-reload — tweak a damage number and see it apply without restarting.

**Spawning:** spawn any enemy/boss/chest/pickup/prop at cursor, spawn N of a type for stress tests,
**force the Reaper sequence and the White Hand ending** on demand.

**Perf:** frame-time graph, per-system tick cost, entity counts by pool, draw calls, atlas overdraw
view, allocation tracker, GC watch, "spawn 2000 enemies" button, **soak-test launcher**.

**Netcode:** live latency/loss/jitter injector, force desync, force resync, live correction-sweep
traffic view, per-player hash comparison, replay scrubber, simulate host migration, simulate a drop,
bandwidth meter, packet log.

**Bot players:** add 1–3 AI partners to any session with configurable skill, reaction time, and
build preference. Makes 1–4 player co-op testable solo and repeatably in CI — four humans are not a
reproducible benchmark. Also the only way to run the 4-player perf gate on demand.

**Device profile emulator:** clamp the runtime to a target device's CPU-time-per-tick budget, memory
ceiling, resolution, refresh rate, and thermal-throttle curve. Presets for the REVVL V+ 5G, the
iPhone, and a deliberately-worse floor device. Catches regressions between hands-on passes; does not
replace real-hardware measurement.

**Save/progression:** unlock everything, lock everything, set any powerup rank, grant/revoke
achievements, set egg counts, export/import save JSON, wipe, force a migration from any old version.

**RNG:** view and set the seed of every named stream, re-roll a stream, force a specific card draw or
chest result.

**Visual:** hitbox overlay, spatial-grid overlay, sprite bounds, path lines, toggle post-process,
palette inspector, per-layer isolation.

**Modifiers:** live modifier-stack editor — compose any mode combination on the fly.

**Cheat tooling:** telemetry dashboard, replay diff viewer, manual flag/unflag, trigger the Reaper
response on demand.

You asked whether that's everything. It wasn't — here's the rest, and this is the full surface:

**Device profile emulation:** clamp the sim/render to a chosen mid-Android budget on any device, force
60fps on a 120Hz screen, force a low-memory condition, simulate thermal throttle. So we can test
against the real perf contract without holding a cheap Android in hand.

**Balance lab:** a headless auto-play bot that runs N simulated runs at ×1000 speed and reports
survival time, DPS by weapon, gold and XP curves. This is how 40 weapons get balanced — by data, not by
me guessing. Also a live DPS/EHP calculator for the current build, and a "what if" panel that swaps one
upgrade and shows the delta.

**Spawn and wave visualizer:** the wave table as a scrubable timeline, spawn ring overlay, upcoming
spawns previewed, plus death heatmaps and enemy-density heatmaps per stage.

**Unlock and achievement tracer:** pick any unlock or achievement and see exactly which conditions are
met, unmet, and what event would fire it. Kills the entire class of "achievement didn't pop" bugs.

**Audio:** per-bank volume, play any SFX or music cue by name, mute categories, voice-count meter,
force the 12-bell sequence, latency test.

**Input:** live gamepad and touch tester with raw values, joystick deadzone tuner, remap editor, input
recorder and playback (feeds the replay harness).

**Log console, in-app:** filterable log stream, error and warning counts, last crash with stack, assert
toggles, and a "break on first NaN in sim" switch.

**Asset and atlas tools:** reload the atlas at runtime, view the packed sheet with slice bounds, report
unused and missing sprites, texture memory readout, palette-drift checker against the locked palette.

**Remote config:** view resolved flags, override any flag locally, force a rollout bucket, verify the
co-op lock behaves as it will in production.

**Save slots:** multiple named save slots, snapshot the current save, restore, diff two saves. Means
testing endgame state never costs us our own progress.

**Localization:** pseudo-localization and longest-string mode to catch layouts that break with
translated text, plus a missing-key report. Cheap now, saves a rewrite later.

**Accessibility check:** colorblind simulation, reduced-flash preview, text-scale preview, contrast
report on the fidelity-kit UI.

**Screenshot and capture:** hide HUD, freeze time, free camera, fixed-resolution store-screenshot
capture, GIF capture. This is also how store assets get made.

**Telemetry inspector:** every analytics event as it fires, with payload, so we can confirm we're
collecting what the live-ops decisions need and nothing we shouldn't.

**Session tools:** wall-clock scaling for time-gated things like the daily reset, jump the daily
rollover, force a matchmaking state (queued, matched, failed, timed out).

Everything above is registered through one `game/dev/registry.ts` so each panel is a small file and
adding a new tool during any phase is a few lines, not a refactor. It's compiled out of release builds.

### 7. Rendering — raw WebGL, one draw call per layer

- Context from `expo-gl`'s `<GLView>`: real GL on iOS/Android, real WebGL in the web preview.
- WebGL1 feature set (no instancing) for device reach: one texture atlas, one large dynamic vertex
  buffer, quads appended per sprite, single `drawArrays` per layer.
- Canvas2D and per-entity RN `<View>`s rejected — neither survives 500 moving sprites on mid Android.

### 8. UI — split by whether it appears during a run

| | Where | Why |
|---|---|---|
| **In-run** — HUD, level-up card draw, damage numbers, boss bar, pause, 4× co-op HUD, White Hand sequence | **GL, engine-drawn, pixel-exact** | What you stare at for 30 minutes. Frame-locked to the sim, inside the post-process shader. Overlaying RN on a 60fps GL canvas at 500+ entities is where RN gets unreliable. |
| **Out-of-run** — title, character select, stage select, shop, collection, achievements, settings, co-op lobby, leaderboards, replay browser, dev menu | **React Native + fidelity kit** | Real text input (room codes, names), native scroll over 100+ item and 150+ achievement lists, accessibility. |

**Fidelity kit:** bitmap font glyphs from the game atlas, 9-slice frames for chunky borders,
integer-only scaling, no antialiasing, identical palette, matching layout metrics and cursor behavior.

**Escape hatch:** if by end of Phase 3 the menus don't hold up beside reference footage, moving them to
GL is contained — same atlas, palette, and data tables, so it's a render-layer swap. I'll raise it
myself if needed.

### 9. Data-driven content

Every weapon, passive, evolution, character, stage, enemy, wave, arcana, powerup, and achievement is a
typed record in `game/data/`. Adding content is adding data, not code.

**Content scale, explicitly:** Phase 1's 6 weapons are *archetype coverage*, not the budget. Each
proves one firing pattern — melee sweep, homing, directional volley, arcing physics, orbiting, aura.
Once those six work in co-op, weapons 7–40 are data entries reusing them. Final scope: **40+ weapons
with full evolutions, 20 passives, 40+ characters, 20+ stages, 22 arcanas, 150+ achievements.**

### 10. Run modifier stack — built Phase 1, not Phase 6

**Modes are not features; modes are stacks of modifiers.** Endless is "no time limit + escalating
waves + curse per cycle." Hurry is "time ×2." Inverse is "mirrored map + harder scaling + more XP."

Written late, these become `if (mode === ...)` branches scattered through the sim: they won't stack,
each is a fresh desync risk under host authority, and they fight the replay validator. So it's a
**Phase 1 core system**:

- A typed `RunModifier` declares deltas on sim parameters (spawn rate, enemy HP/speed/count, XP and
  gold rates, time scale, map transform, level caps, weapon level caps, revive rules, boss tables,
  curse increment).
- The sim reads **resolved config**, never a mode enum. No sim system knows what mode it's in.
- Modifiers **compose** — Endless + Hyper + Inverse + a daily mutator stack without special-casing.
- The resolved stack is part of the run seed header, so replay validation and host authority get it free.
- Every mode is then a data record plus UI, not new sim code.

### 11. Performance discipline, from session one

Struct-of-arrays entity pools pre-allocated to cap, zero allocation in the hot loop (GC pauses are
frame drops), uniform-grid spatial hash for collision, cheap movement and no collision for off-screen
enemies, XP gems merging above a threshold, pooled and capped VFX, fixed 60Hz sim decoupled from render.

### 12. Save data is local-first

`AsyncStorage` (native) / `localStorage` (web), one versioned JSON blob with migrations. Account sync
via oRPC + Drizzle, arriving with the co-op account work since co-op needs identity anyway.

---

## How you test it

You're working from your phone, so nothing here needs a computer. Three paths, ordered by how honest
each one is. **I handle all formal verification and gate measurement; these are for you to actually
play the thing.**

### Path 1 — In the Runable app (every phase, zero setup)

When I deliver the mobile artifact, the Runable dashboard runs it through Expo's web output, so it's
playable **right inside the app you're typing in now.** `expo-gl` gives real WebGL there, so the actual
game runs: sprites, joystick, card draws, the works.

- **Good for:** is it fun, does it look right, does the pixel art read, is the joystick placed well.
- **Not valid for:** performance. It's a browser canvas inside a webview — expect worse frame rates
  than the real app. Never judge perf here, and I'll never quote a gate number from it.
- Available from **Phase 0 onward.** The very first deliver is playable.

### Path 2 — Full-screen in Safari on your iPhone

I expose the dev build at a public URL. You open it, **Add to Home Screen**, and it launches chromeless
— real screen size, real touch, no browser UI stealing edge swipes.

- **Good for:** real touch feel, thumb reach, HUD legibility at true size, showing someone else.
- Still browser performance, so still not a gate.
- Also how a friend tests co-op with you without installing anything.

### Path 3 — Native on your real devices (the only honest perf test)

Two options, and I'll try the cheap one first in Phase 0:

**3a. Expo Go over a tunnel — no build, minutes not hours.** You install Expo Go free from the App
Store / Play Store, I start the dev server with a public tunnel, you scan or tap a link and the app
opens natively. Live reload: I push a change, your phone updates. **Caveat I'll verify in Phase 0, not
assume** — Expo Go only includes prebuilt native modules, so if `expo-gl` works there, this is our
daily loop for the whole project. If it doesn't, we fall to 3b immediately and I'll tell you straight.

**3b. A real dev build via your Expo account.** You connect your Expo account in the mobile preview
dashboard's publish flow, which triggers a cloud build — TestFlight for iPhone, an APK you sideload on
the REVVL. Slower per iteration, but it's the true app on true hardware.

- **This is where every perf gate is measured**, on the REVVL, warm.
- I **never** build binaries in the sandbox — it would kill it. You trigger builds from the dashboard.
- Cadence: at minimum one native build per phase gate. More if we're chasing a perf problem.

**Outside testers — both stores, in parallel.** Play closed testing (required: **12 opted-in testers for
14 consecutive days** before public release unlocks) and TestFlight for iPhone/iPad. Both live by Phase 3.
See *Dual-track testing* below for the full breakdown and why running both is worth it.

### The mock-first rule for anything visual

Because you care a lot about UI feeling right, nothing visual gets *built* before it's *approved*:

1. I generate a static mock image of the screen or HUD.
2. You approve or tell me what's wrong.
3. Iterate on the mock — minutes per round.
4. Only approved mocks become code.

Same rule for art sheets: the first sheet gets your sign-off before the other ~20 are generated.

### What you'll be handed at each phase

1. The playable preview, opening automatically in the app.
2. A short "try this" list — the two or three specific things worth your hands on.
3. The measured gate numbers from the REVVL, stated as numbers, with a pass/fail. If something failed,
   I say so and say why.
4. Anything needing your approval before I spend effort on it — art sheets especially.

### Co-op testing — both bots and humans

You said both, so:

- **Bot players in the dev menu.** AI-driven fake partners with configurable skill and reaction time, so
  a 1–4 player session is testable solo, any time, including in CI. This is how the 4-player perf gate
  gets measured repeatably — four humans are not a repeatable benchmark.
- **Multi-client solo testing.** Your iPhone + your REVVL + a browser tab = a real 3-client
  cross-platform session, no friends required. This also tests the iOS↔Android↔web path directly, which
  is the case most likely to desync.
- **Human testing with friends** via room codes once co-op lands in Phase 2 — Path 2 means they need no
  install. The friends allowlist in the progressive rollout exists exactly for this.
- The latency injector means I can reproduce a bad connection on purpose instead of waiting for one.

### Emulated device profiles (the selector you asked for)

A dev-menu panel that clamps the runtime to a target device's budget: CPU-time budget per tick, memory
ceiling, resolution, refresh rate, and a thermal-throttle curve. Presets include **the REVVL V+ 5G**,
plus a deliberately worse floor device so we know where the cliff is.

Honest about what it is: it constrains *our* budget and catches regressions fast, but it cannot emulate
Mali-G57 driver quirks or real thermals. It's the smoke alarm; **your REVVL is the fire inspection.**
Any conflict between the two, the REVVL wins.

---

## Business, legal, and launch

### The competitive reality — stated plainly

The original is **free on mobile**, is the complete game, passed 3M downloads in its first month, and
is also on Apple Arcade ad-free. We are not going to out-compete it on content or brand. You already
know this and want to build anyway, with a five-year horizon. Good — but the plan should be honest
about where the opening actually is:

**Co-op is the wedge.** The original's online co-op arrived late (v1.14, Oct 2025), and it is not why
people play it on phones. "Survivors-like you can actually play with 3 friends, cross-platform, from
your phone" is a real pitch that the market leader does not own. Everywhere faithfulness and
differentiation conflict, **co-op and identity win.**

### What the original actually launched with — and why we should launch smaller

Researched, because it reframes the scope question:

| | |
|---|---|
| Launch | 17 Dec 2021, Steam Early Access, **paid $2.99** |
| Team | **One developer**, ~1 year, ~£1,100 total spent on art and music |
| Content at launch | A *fraction* of today's. Its March 2022 roadmap alone added 9 characters, 16 weapons, 5 stages — all **after** it went viral |
| 1.0 | 20 Oct 2022, ten months later |
| Mobile, free | Dec 2022 — a **year** after launch |

So the 1.0-plus-DLC game we're targeting is **four years of iteration by a funded studio.** The version
that actually became a phenomenon was much smaller than what you're planning to launch with.

**DECIDED — build all systems, launch less content:**

- **Every system at full scope.** Systems are what make content cheap forever, and they can't be
  retrofitted. No cuts here: netcode, modifier stack, evolutions, arcanas, Limit Break, dev menu.
- **Launch content target: ~15 weapons, ~12 characters, ~5 stages, ~8 arcanas, ~50 achievements.**
  Still more than the original launched with.
- **The other 25+ weapons, 28+ characters, 15+ stages become post-launch updates** — which is exactly
  the "continuously build upon it" plan you already described, and exactly the path the original took.
- Phases 4–5 therefore split: **4 ships, 5+ is live-ops content.** Nothing is cut from the plan; the
  ordering just stops holding launch hostage.

**This is now locked.** Phases 4 and 5 are sized accordingly: Phase 4 is the launch set, Phase 5+ is
live-ops content. Nothing is cut from the project — only from launch day.

### Name — checked, clear

Searched "Nightreap" as game, product, and trademark: **no game, no product, no company.** Only hits
are a World of Warcraft character and some Valorant/League usernames. Clean for an invented word.
Not a formal USPTO clearance — but nothing is sitting there waiting to send a letter. Keeping
**Nightreap Survivors**; "Survivors" is a genre convention (Survivors-like) used by many shipped games.

### Store rejection risk — Guideline 4.1 Copycats

Apple rejects games for resembling an existing popular app. Enforcement is inconsistent and appeals
rarely work, so this is designed around rather than argued with:

- Distinct visual identity — not merely non-infringing, **deliberately different** palette, silhouettes,
  frames, and font.
- **Co-op leads** the store listing, screenshots, and description. That's our honest differentiator and
  it's also the best possible answer to "how is this different".
- The original is **never named** in metadata, keywords, description, or marketing copy.
- No pixel-matched UI layout, no reused stat-name strings, no traced character silhouettes.
- Android-first launch helps: Play review is materially more permissive, so the game will be live,
  rated, and reviewed by real players before it ever meets Apple review.

### Legal distance — mechanics are fine, "look and feel" is not

*Tetris Holding v. Xio* is the governing example: **mechanics and rules aren't copyrightable, but
specific expression is** — and Xio lost despite writing all its own code, because it copied the look.
So renaming every proper noun and drawing our own art is the right instinct, and we extend it to UI
arrangement, character silhouettes, and exact stat-name strings.

**Not legal advice, and I'm not a lawyer.** If this earns real revenue, pay an IP attorney for a review
before the iOS launch. That's the single highest-value few hundred dollars in this project.

**Recommendation: do not contact poncle to show them the game or ask for feedback.** The instinct is
honorable, but it works against you on every axis:

- **It creates dated written evidence of access and awareness**, in your own words, permanently. That's
  something a plaintiff normally has to establish; an email hands it over.
- **It forces a decision they'd otherwise never make.** Nobody there is evaluating this game right now.
  An email creates a moment where someone has to decide what to do about a clone, and the cautious
  institutional answer is almost always no — or silence, which is worse, because a refusal or a
  non-answer is something a reviewer or opposing counsel can later ask about.
- **Their feedback isn't safely actionable.** "They asked me to change X" implies everything else was
  close enough to need asking about. That's the opposite of the distance we're building.
- **They've been notably relaxed about clones**, which is precisely the reason not to poke it. The
  current state is the good state.

The same information, without the exposure: an **IP attorney does this analysis privately and under
privilege**, and the **Phase 3 TestFlight Beta App Review** gives us Apple's real opinion months early
for free. If reaching out ever appeals, the safe version is *after* launch, peer-to-peer, seeking no
permission and debating no features — and run past the attorney first.

### UI fidelity — your approval is the gate

You said you despise UI that doesn't look right and we'll rebuild until it's right. So the plan makes
that cheap instead of painful:

- **What makes genre UI feel correct is layout convention and ergonomics** — HUD position, card-pick
  rhythm, information density, cursor behavior. That's functional, not protected, and we keep it.
- **What we change is the skin** — palette, frame style, font, iconography, motion. This gets "feels
  correct" and "legally distant" simultaneously.
- **Hard approval loop:** before any screen code is written, I generate the HUD and one menu as
  **static mock images** for your yes/no. We iterate on mocks until you're happy. Only approved mocks
  get built. Rebuilding a mock costs minutes; rebuilding 12 built screens costs a phase.
- Same loop at Phase 3 for the full menu set, and again at Phase 7 for polish.

### Monetization — free + rewarded ads + cosmetics

You want to earn from it. Worth knowing: **the original launched paid at $2.99** and only went
free-with-optional-ads on mobile *after* it had a brand. Free with no brand is hard to monetize, so:

- **Free download**, fully playable offline, no paywalls, no energy, no forced interstitials.
- **Optional rewarded ads only** — a revive, or bonus gold at run end. Player-initiated, disableable in
  settings. This is the original's model and it is genuinely well-liked.
- **Cosmetic IAP** — palette swaps, hats, weapon trails, HUD frames. Zero power. Already in the endgame
  plan, so it costs nothing in balance, and it's the honest way to take money from people who like it.
- **No IAP that touches progression.** Selling PowerUps or eggs would wreck the leaderboards
  anti-cheat exists to protect.
- **Built in Phase 6, but the hooks land in Phase 0** — consent flow, ATT prompt, privacy manifest, and
  receipt validation are architecture, not decoration. Retrofitting them is much worse than planning them.

### Server costs — kept near zero by design

Online co-op could become a permanent monthly bill at scale. Structural answers:

- **Players host; the server is a thin stateless relay** + matchmaking. No authoritative game simulation
  server, ever.
- **Replay validation is sampled and queued**, not universal — leaderboard-relevant and flagged runs
  only. Re-simulating every run is the expensive trap.
- **Local-first saves.** Solo works fully offline with servers down. Sync is a bonus, never a requirement.
- Cost ceiling reviewed at Phase 2 with real bandwidth numbers from the dev-menu meter, not guesses.

### Launch sequence — Play Store first, iOS a month after

Your call, and it's the right one. Play review is faster and more permissive, and your gate device is
already Android.

### Dual-track testing — TestFlight AND Play closed testing, both

Your call, and it's better than either alone. They're independent systems on different stores, so
running both in parallel is normal practice, not a conflict. **Correcting my earlier advice:** I said
Apple's $99 could wait for the iOS phase — that's wrong if you want TestFlight, because TestFlight
requires an active Apple Developer Program membership. If you want iPhone testers, the $99 starts early.

| | **Google Play closed testing** | **Apple TestFlight** |
|---|---|---|
| Cost to you | $25 one-time | **$99/yr, required for TestFlight** |
| Cost to testers | Free | Free |
| Tester needs | Google account, opt-in via link | Apple ID + free TestFlight app |
| Tester limit | Large | 100 internal / **10,000 external** |
| Review to distribute | None | **Beta App Review** for external testers |
| **Hard requirement** | **12 testers opted in for 14 consecutive days** (new personal accounts) | None |
| Why we want it | **Unlocks public release.** Non-negotiable gate. | Best feedback loop; iPhone + iPad coverage |

**Why running both is genuinely valuable, not just twice the work:**

- **Device coverage.** Play testers give you the low-end Android reality — many different chipsets,
  RAM tiers, and Android versions. TestFlight gives you the 120Hz iPhone experience. Both matter, and
  neither predicts the other.
- **Cross-platform co-op needs cross-platform testers.** iOS↔Android is the config most likely to
  desync. You cannot test that with one store's testers.
- **TestFlight's Beta App Review is a free early read on Guideline 4.1.** If Apple is going to call this
  a copycat, a beta review months before launch is a *much* cheaper place to find out than a launch-day
  rejection. This is the single best reason to run TestFlight early, and it reverses my "Apple can wait"
  advice entirely.
- **Play's 12-testers-for-14-days rule is the real schedule risk.** It must be 12 *real, opted-in*
  testers for 14 *consecutive* days. If engagement lapses, the clock can reset. Recruit ~18–20 to have
  slack, since some will install once and vanish.

**Sequenced tasks:**

1. **Early (Phase 0–1):** Google Play developer account ($25). Apple Developer Program ($99/yr) if you
   want TestFlight — and you do, for the beta-review signal.
2. **Phase 3:** both tracks live with a rough but playable build. Internal TestFlight first (no review
   needed), then external TestFlight once it's presentable. Start recruiting your ~18–20 Play testers.
3. **Phase 4:** the 14-day Play closed-test window runs *while content is being built*. This is the whole
   point of starting early — the clock burns down during work you were doing anyway.
4. **Phase 8:** Play production release.
5. **~1 month later:** iOS App Store submission, with a month of real reviews, crash data, and an
   already-passed Beta App Review behind you.

**Bring your own testers.** Skip the paid "get 12 testers" services and reciprocal tester-swap groups —
they produce disengaged installs that satisfy a counter and teach you nothing, and Google has rejected
tests for exactly that lack of genuine engagement. Friends who'll actually play a survivors-like are
worth more than 50 strangers farming each other's counters. You need 12; find 18 real ones.

### Compliance — all of it, per your call

- **Privacy policy URL** — required, must list every data category collected. Written in Phase 8, hosted
  on the web package.
- **Age rating questionnaires** for both stores; COPPA considered.
- **Player names are user-generated content visible to strangers**, which triggers Guideline 1.2. So:
  **generated names by default**, custom names opt-in and filtered, plus **block and report from day one**
  and an EULA prohibiting abuse. Games get bounced for exactly this.
- **Crash reporting, telemetry, and in-app bug reporting** — opt-in, with a privacy manifest entry.
  In-app reporter attaches the last N seconds of input log, so I can *replay your bug* rather than guess.
- **Accessibility, all of it:** colorblind-safe palettes, damage-number/flash/shake toggles, adjustable
  joystick size and position, scalable HUD text, reduced-VFX mode (which doubles as a perf win).

### Original assets only — including the font

- **Music and SFX generated original** in-sandbox. Audio gets content-flagged and DMCA'd faster than art.
- **Bitmap font glyphs drawn into our own atlas.** Many pixel fonts forbid game embedding — shipping a
  licensed font file is a quiet legal landmine, and we sidestep it entirely.
- Every asset traceable to a generation step, so provenance is never a question.

### Backups — GitHub from Phase 0

Everything currently lives in one sandbox, which is a single point of failure for a very large project.
**Commit and push at every phase gate**, and at any point I'd hate to lose. If your GitHub isn't
already connected, connecting it is the first thing I'll ask for in Phase 0.

### Honest scope statement

40+ weapons with evolutions, 40+ characters, 20+ stages, 22 arcanas, 150+ achievements, correction-sweep
netcode, an anti-cheat program, and a dev menu larger than most finished games is **a long, multi-session
build.** Content phases are the long pole. Two consequences worth accepting now:

- **The phase gates are what keep it shippable at any point.** Every gate ends with something playable.
- **If you ever want to launch sooner, the honest cut is fewer stages and characters — never fewer
  systems.** Which is precisely the launch-smaller recommendation above.

---

## Mode catalog — all in scope

Per your call, nothing is deferred. All are modifier-stack data records plus UI; none need new sim
systems once Phase 1's modifier stack exists.

### Faithful to the original

| Mode | What it does |
|---|---|
| **Endless** | Time limit removed; wave table restarts with a Curse increment per cycle |
| **Hurry** | Clock runs ×2 — the 30-minute table crammed into 15 |
| **Hyper** | Per-stage unlock: +enemy speed/HP/count/frequency, +gold |
| **Inverse** | Mirrored map, harder scaling, higher XP and gold |
| **Limit Break** | Weapons level past max; stats climb without bound (respecting the hard-cap table) |
| **Golden Egg equivalent** | Permanent banked +1% stat gains. Infinite meta sink. |
| **Reaper sequence + White Hand** | The 30:00 ending, killable Reaper, 12 bell tolls, unkillable finish |
| **Bonus / challenge / special / hidden stages** | Gold farms, gimmick stages, secrets (Phase 5) |
| **Adventure-style curated runs** | Pre-set character + stage + modifier chains as a campaign |

### Our additions

| Idea | Why |
|---|---|
| **Daily Run** ⭐ | One global seed, identical run for everyone, one attempt, validated leaderboard. Seeded RNG streams + replay validation already exist — thin layer on top, strongest retention feature in the genre. |
| **Replay share + spectate** ⭐ | The anti-cheat validator *is* a replay system. Exposing it gives share-by-code, watch your death back, export a clip. ~80% built already. |
| **Co-op draft** | Players draft from a shared card pool so builds can't overlap — the team must cover each other. Makes co-op tactically distinct from four people playing solo side by side. |
| **Boss Rush** | Back-to-back bosses, no trash. Great short-session mobile mode. |
| **Custom Run / Sandbox** | A safe subset of dev-menu knobs exposed to players, unranked. Cheap — a permissions filter over the existing dev registry. |
| **Ascension tiers** | Endless depth ladder: clear a tier, unlock a harder one with a stacked modifier. Gives Endless a spine instead of a plateau. |
| **Weekly mutator** | Rotating absurd rule set (orbiting weapons only, quadruple magnet, 4× enemy speed). Content churn from data alone. |
| **Seeded race** | Async competition on a shared seed. Not versus — nobody shares a screen. Reuses Daily plumbing. |
| **Run recap / death analytics** | Post-run graphs: DPS by weapon, damage taken, gold rate, the moment it went wrong. Players love it; it's also our balancing instrument. |
| **Build share codes** | Export a build as a short code, import as a Custom Run preset. |
| **Hardcore** | One life, no revives, no continues. Optional flag on any mode. |
| **Speedrun toolkit** | Tick-accurate timer, auto-splits, PB ghost, seed entry, instant same-seed restart, verifiable share codes. A settings toggle, read-only, ladder-legal. Nearly free — determinism + replays already exist. |

#### Speedrun toolkit — a settings toggle, not a mode — SETTLED

The engine is already a speedrunning engine by accident. The simulation is deterministic, the clock is a
fixed 60Hz tick count rather than wall time, RNG comes from seeded streams, and every run is already
recorded as a replay and revalidated server-side. That means a real, trustworthy speedrun toolkit costs
almost nothing to add, and — unlike most games — our timer cannot drift, lag, or be fooled by a slow
device, because it counts ticks.

**Toggled on in Settings → Speedrun. Off by default, never in the way for a normal player.**

What it turns on, all of it fair and ladder-legal:

- **A precise in-run timer**, in ticks converted to `mm:ss.mmm`. Identical on a $100 phone and a
  flagship, because it counts simulation ticks, not seconds.
- **Splits**, auto-triggered on real events: each minute survived, each boss killed, each weapon
  evolution, arrival of the Reaper, the White Hand. Auto-compared against your personal best.
- **A PB ghost** — your best run's split times shown live as ahead/behind, since we already store the
  replay.
- **Seed entry.** Type or paste a seed and play that exact run. Community-shared seeds work by
  construction.
- **Instant restart on the same seed**, one button, no menu walk. Already exists as a dev tool; this
  just exposes it safely.
- **A share/verify code** for any finished run. Anyone can load it and watch it back frame-identically,
  so a claimed time is provable by anyone, not just by us.
- **Input display** (the on-screen thumbstick trace) for recording, plus optional load-time exclusion
  from the timer.
- **Categories** the boards already support: any%, per-stage, per-character, no-arcana, Hardcore, and
  seeded race.

**The line between a speedrun tool and a cheat, drawn explicitly.** Everything above only *reads* the
simulation — nothing changes it, so a run with the toolkit on is a completely normal run and posts to
every ladder. Anything that *writes* to the simulation stays where it already is: in the dev menu, at
`self` tier, and touching it taints the run so it cannot post (§5b). That includes slow-motion,
fast-forward, frame advance, save states, RNG rerolling, and input playback. Input **recording** is a
read and is fine; input **playback** is a write and taints. This split is why we can be generous with
the toolkit — the taint flag and mandatory server revalidation already sort the honest runs from the
assisted ones, and nothing new has to be defended.

**Cost and timing.** The timer, splits, and seed entry are a small UI layer over data the run loop
already produces — a day's work. PB ghost and verify codes reuse the replay system verbatim. It lands in
Phase 6 with the ladders and the replay browser, because that's when the boards it feeds exist. Nothing
about it needs to be designed into the engine now; determinism, tick-counted time, and replays are
already in place, which was the only hard part.

---

## Art pipeline — pixel art, dark gothic

1. `image_generate` produces **grid sheets** — e.g. a 4×4 grid of 16 gothic pixel-art enemies on flat
   magenta, consistent 32px scale, prompt-locked palette. Far cheaper than 300 single generations.
2. A script slices grids into frames (ImageMagick), keys out the background, packs a power-of-two atlas
   + `atlas.json` (frame rects, pivots, clips). Menu 9-slice frames and bitmap font glyphs share the atlas.
3. Atlas ships to `packages/mobile/assets/`. Renderer binds one texture.
4. A shared **palette + prompt preamble** file keeps every batch stylistically identical.
5. **4 player palette-swap variants** for co-op readability — done in-shader.

Audio later: `music` for stage loops, `sound-effects` for hits/pickups/level-ups, mixed with ffmpeg.

**Checkpoint:** I generate the first sheet (player + 16 enemies), you approve the look, then the other
~20 sheets get generated.

---

## Cheap now, expensive later — five things worth deciding before Phase 2

These are decisions that cost hours today and days-plus-risk once real players have real save files.
Nothing here changes the plan's scope; they change *when* certain constraints get honored.

### 1. Mid-run resume when the phone kills the app — SETTLED, build in Phase 2

Mobile reality: the OS kills a suspended app whenever it wants memory. We already proved this — the
iPhone discarded a backgrounded bench run at 844 seconds. If a player takes a call at minute 26 of a
30-minute run and loses it, that is the single most infuriating thing this game can do to someone.

So the run is **snapshottable**: the entire simulation writes to a flat byte buffer and restores from it
exactly, resuming the same run at the same tick with the same RNG position.

This is nearly free *only because of how the engine was already built* — every system stores its state in
flat typed arrays with fixed capacities, so a snapshot is a sequence of buffer copies with no object
graph to walk. Written after the fact it would be a rewrite; written now it is a serializer over data
that already sits in the right shape.

- Snapshot on background, on pause, and on a rolling ~30-second autosave.
- Written through the same atomic double-buffered save path, so a snapshot can never half-exist.
- **A resumed run is still a normal run** — same seed, same tick count, same replay stream, so it stays
  ladder-legal and revalidates. Resuming is not a cheat because nothing about the simulation changed.
- Refuses to load across engine versions; on mismatch the player is told the run can't continue rather
  than handed a corrupted one.
- **It pays for itself three more times:** it is exactly what co-op host migration needs when the host
  drops, exactly what dev-menu save states need, and exactly what a crash report needs to reproduce a
  bug on our own machines.

### 2. Every player-facing string goes through an ID table — SETTLED, from Phase 3

Right now card text lives inline in the content rows, which was correct for six weapons. At 40+ weapons
× 8 levels each, plus 40 characters, 22 arcanas, 150+ achievements and ~30 screens, that becomes several
thousand strings welded into logic — and pulling them apart later is exactly the kind of week-long,
zero-visible-progress job that kills momentum.

- Content rows carry a **string ID**; one table maps ID → text. English is just the first column.
- Same rule already in force for content IDs applies: **string IDs are append-only**, never reused.
- The `// FIDELITY:` marker rule extends here — a missing string fails CI content-lint rather than
  shipping as blank space in a card.
- Pseudo-localization (already a dev panel) then does real work: it inflates every string ~40% and
  catches every layout that only fits English, before any translator is ever paid.
- **No translation is committed to.** This is only about being *able* to, cheaply, if the game earns it.
  A German or Spanish release later becomes a spreadsheet, not a refactor.

### 3. The simulation emits sound and effect events, it never plays them — SETTLED, from Phase 1

Audio arrives in Phase 8, but the hook goes in now, and it's a small one: when something happens in the
simulation, it appends an event id to a per-tick buffer. It never calls an audio or particle function.

- Keeps `game/` free of platform code, which is already a hard rule.
- Keeps the simulation deterministic — audio must never be able to affect a run's outcome.
- Makes replays *sound* right on playback, because the events are reproduced, not guessed.
- Gives the accessibility work something concrete to switch off (reduced-VFX, no-flash) without touching
  simulation code.
- Phase 8 audio becomes wiring a table of ids to sounds instead of hunting through combat code.

### 4. Save data gets an account id and a revision counter now — SETTLED, Phase 0 shape, cloud in Phase 8

Cloud save itself is Phase 8 and needs accounts. But the two fields it requires have to exist in the save
layout from the first save a player ever writes, or the first cloud sync has to guess which of two
devices is newer — and that guess is how people lose 200 hours.

- An opaque account id (empty until the player links one) plus a monotonically increasing revision.
- Conflict rule fixed in advance: **higher revision wins, and the loser is kept as a recoverable backup
  slot**, never deleted. If we're wrong about which device was newer, the player still has both.
- Device-loss recovery is the actual feature. It's also the top support ticket in every mobile game that
  didn't plan for it.

### 5. The small ones, decided so they don't get argued about later

| Decision | Why now |
|---|---|
| **Battery saver mode** — a 30fps cap and reduced VFX, user-selectable, plus an automatic prompt if the device thermally throttles. | The sim already runs at a fixed 60Hz independent of rendering, so this is a render-rate change and nothing more. Free today. |
| **Install size budget: under 100MB.** Atlas budget set before art is drawn, not after. | Install size measurably affects install conversion, and it's a nightmare to claw back once 20 art sheets exist at the wrong resolution. |
| **First-run experience: no tutorial screens.** The first run *is* the tutorial — one weapon, gentle first minute, card screen at 30 seconds. | Genre convention, and it means we never build a tutorial system. Decided now so nobody designs one. |
| **Daily Run reminder notification, opt-in, asked on the second day and never again.** | Permission prompt timing is the whole ballgame — asked at first launch, most people decline forever. |
| **Daily seed comes from the server, never the device clock.** | Otherwise changing the phone's date farms Daily attempts. Already listed as a `system`-tier dev capability; this states the server side of it. |

---

## Phases

### Phase 0 — Foundation + renderer go/no-go
- **GitHub connected and first push**, before anything else is worth losing.
- `app_init` → `/home/user/nightreap-survivors`; `design.md` (palette, pixel font, UI language).
- **UI mock approval loop starts here:** static HUD + one menu mock as images for your yes/no, iterated
  until you approve. No screen code before that.
- **Atomic save writes + backup slot from the very first save**, and remote-config scaffolding (needed
  for co-op's locked launch, the dev-menu kill switch, and Chaos Sandbox Day — then permanently useful).
- **`devgate.ts` + run-taint plumbing land now, not later.** The `tainted` bitfield goes into the run
  seed header and the save schema in the very first version, so no migration is ever needed to add it,
  and no dev toggle can be written that forgets to set it.
- **Append-only event-log scaffolding** on the server side (even before there is a server worth
  protecting) so nothing early is written in a shape that can't be replayed or restored later.
- `app.json`: name/slug, bundle ids, orientation, 120Hz opt-in.
- `npx expo install expo-gl expo-asset expo-font @react-native-async-storage/async-storage` — one
  command, before Metro starts.
- `game/core/`: `fx.ts` fixed-point + trig LUTs, fixed-timestep loop, named seeded RNG streams, entity
  pools, spatial hash.
- `game/render/`: GL bootstrap, shader, sprite batcher, camera, atlas loader.
- `game/net/`: input struct + binary codec, tick buffer, state-hash function, correction-sweep
  scaffolding. No transport yet.
- **Replay harness:** record a tick-log, replay headless, compare state hashes. Serves determinism
  testing, anti-cheat validation, and the Endless soak test.
- **Gate A (hard stop, my call):** 5,000 textured quads at 60fps with the overlay on screen. If the
  batcher can't clear it, I stop and pivot the render layer to native Skia right here — not at Phase 5
  with content stacked on top. You told me to make the call, so I won't stall the build asking; I'll
  pivot and report the numbers that forced it. The pivot is contained by design: the engine has zero
  render assumptions outside `game/render/`, so sim, netcode, and data are unaffected either way.
- **Measurement, not a gate:** replay the same tick-log on iOS, Android, and web and report hash
  divergence. Tells us how much correction bandwidth co-op needs. Perfect agreement is a bonus.
- **Establish your testing loop, early and explicitly.** I verify whether `expo-gl` runs under **Expo
  Go**; if it does, that's our daily native loop for the whole project and you get live reload on both
  phones. If it doesn't, I report that and we use dev builds instead. Either way I also identify which
  REVVL you have and record its real baseline numbers, so every later gate compares against measured
  hardware rather than an assumption.
- **Phase 0 gives you:** Gate A numbers, a playable movement test in the app, the first sprite sheet for
  approval, and a confirmed answer on how you'll test natively from here on.

### Phase 1 — Vertical slice + dev menu + modifier stack
- Player movement, 8-direction anim, camera follow, tiled scrolling background.
- Enemy spawner + wave table, walk-at-player steering with separation.
- 6 weapons covering every archetype: melee sweep, homing, directional volley, arcing physics,
  orbiting, aura.
- XP gems + magnet, level curve (5 XP then +10/level to 20), **level-up card draw** with
  reroll/skip/banish, **batch level-up queue**.
- 6 passives, damage/knockback/i-frames, death → results screen.
- **Run modifier stack** (§10) — proven immediately by implementing Hurry and Hyper as pure data.
- **Dev menu v1:** run control, player manipulation, spawning, perf overlays, RNG control, modifier editor
  — every panel tagged `self`/`system` from its first commit, opened only via `devgate.ts`, with the CI
  tier-lint rule active so the rule can never quietly rot.
- **Gate:** a 5-minute run is genuinely fun; 800 enemies hold 60fps; replay test green; Hurry and Hyper
  work **and stack together** with zero mode-specific sim code.

### Phase 2 — Co-op, proven on the small slice
Deliberately early. With 6 weapons netcode bugs are findable; with 40 they aren't.
- WebSocket relay, room codes, public matchmaking by party size, friends-first fill.
- Host authority, authoritative event bus, **rolling correction sweep**, ~2-tick input delay with local
  movement prediction.
- ~~**Run snapshot / restore**~~ — **DONE.** The whole simulation to a flat buffer and back, same tick,
  same RNG position, discovered by walking the run rather than a hand-written field list so a new field
  cannot be silently forgotten; shape fingerprinted into the header so a snapshot from another build is
  refused outright. The input log travels with the world, so a resumed run stays ladder-legal. Zero-run
  compression takes ~500KB down to ~85KB. Powers mid-run resume, host migration, and dev save states.
- ~~**Rolling autosave**~~ — **DONE.** Every 30s of play, on a card screen, and immediately on
  background; two alternating slots with a generation counter; every write read back and compared byte
  for byte; a resume is verified before it is ever offered; colliding rolling autosaves are dropped, not
  queued. Remaining piece is the "continue your run?" screen itself, which waits on mock approval.
- **Found and fixed here:** the replay recorder took its player count from a fixed four-slot character
  array, so every solo run's log claimed four players and no solo run could ever have revalidated.
- **Known hole, Phase 4:** a run that ends on a *time limit* cannot be revalidated from its log alone,
  because the limit is not in the header. Timed modes need to carry their limit as mode data like every
  other rule. Endings that exist today — defeat, White Hand — are fine.
- ~~**The co-op session: host-confirmed lockstep**~~ — **DONE.** The layer that turns four phones into
  one game. Nothing about spawns, damage or deaths is ever sent; the host confirms the seventeen bytes
  of input for each tick and every guest replays them, so all four worlds match for free. A late input
  costs one repeated frame of that player's movement, identically on every machine — a guess everyone
  shares is not a desync. A lost packet is repaired by the next one, not by an acknowledgement. Card
  screens travel inside the confirmed record, arbitrated in fixed slot order, so who answered first is
  reproducible instead of a race. Solo runs through the exact same code and send nothing at all.
- ~~**State-hash reconciliation + chunked resync**~~ — **DONE.** The host publishes a fingerprint of its
  world twice a second; a guest that disagrees stops guessing and is sent the whole world as a snapshot,
  streamed in bounded slices so it never stalls a frame. A snapshot that fails its checksum is refused
  outright rather than half-applied.
- **Found and fixed here:** two failures the fake network caught that four phones on one desk never
  would. A guest that hit a second hash mismatch mid-resync started a second snapshot on top of the
  first, and the two interleaved into a byte stream that looked valid until the final checksum. And a
  resync with a single lost chunk waited forever — frozen for good, on the one connection bad enough to
  need a resync in the first place. Now a guest names the pieces it is missing and gets exactly those
  back; a snapshot survives a wire that eats a quarter of it.
- **Measured here:** hosting four players costs the host about 24KB a second up, each guest about 8KB a
  second down. Confirm redundancy was cut from a full second of history to 0.4s once the numbers were in
  front of us — it still sends every record eight times over, and it halved the host's upload.
- Host migration, drop-out grace, rejoin.
- **Still outstanding in this phase:** the real WebSocket relay and room codes, render-side prediction so
  a guest's own thumb feels instant, and host migration.
- RN co-op lobby with the full 1–4 flow; 4× HUD; palette swaps; shared XP + batch level-up; downs and
  revives; per-player-count scaling.
- **Remote-config gate** so co-op ships locked.
- **Dev menu v2:** full netcode toolkit — latency/loss injector, force desync, correction-traffic view,
  hash comparison, host-migration simulation.
- **Gate (added):** a run snapshotted mid-fight restores to a byte-identical state and still revalidates
  as a legal replay; force-quitting mid-run and reopening resumes the run.
- **Gate:** 4 devices across iOS + Android + web, 10-minute run at 150ms latency and 2% loss — no player
  ever sees a divergent game state, and induced drift visibly self-heals within ~0.3s. Re-run every phase.
- **Gate (added, MET in the engine):** 2, 3 and 4-player sessions run a full minute of simulated play
  over a wire with 150ms of lag, 2% loss, jitter and duplicate packets, with the host and every guest
  agreeing on the state fingerprint at every single tick — plus a 200ms / 10% loss run that may stall and
  resync but is not allowed to disagree. Nine sections, all passing, reproducible from a seed. The
  four-real-devices version of this gate still has to be run on hardware.

### Phase 3 — Progression spine
- Gold, results payout, **PowerUps shop** (24+ powerups, escalating cost curve).
- Character select; 8 characters with distinct stats, starting weapons, growth quirks.
- Unlock system, save/load with migrations, account-backed sync.
- Destructible props; pickups: floor chicken, bomb, magnet, coins.
- Treasure chests with tiered rolls and the **evolution roll** rule.
- **Anti-cheat v1:** run upload, server-side replay validation, heuristic flags.
- **Web admin page v1 (break-glass):** account lookup, per-account and per-feature kill switches,
  flag/ban/shadow-segregate, revoke a run, restore an account from snapshot. Same actions mirrored into
  the private dev build. Every action written to the append-only log with actor and timestamp.
- **Both test tracks go live here.** Internal TestFlight (no review needed) → external TestFlight
  (triggers Beta App Review — our early 4.1 read) → Play closed testing track, recruiting ~18–20 testers.
  The build only needs to be playable, not finished.
- **Full menu-set mock approval** — every out-of-run screen mocked and approved by you before it's built.
- **Gate:** gold → powerups → unlock persists across restart and syncs across devices. Menu fidelity
  reviewed against reference footage; GL escape-hatch decision made here. Both tracks are distributing
  builds to real testers.

### Phase 4 — Content, part 1 (this is the launch content set)
Sized to the launch-smaller recommendation. If you'd rather launch with everything, Phases 4 and 5
simply merge and launch moves later.
- **~15 weapons + their evolutions and unions** (weapon level 8 + maxed passive + chest).
- **20 passives** — all of them; passives are cheap and they gate evolutions.
- 5 normal stages: real layouts, prop sets, per-stage wave and boss tables (including 15-minute stages).
- **~12 characters**, ~8 arcanas, ~50 achievements.
- ~40 enemy types, elites, **bosses** on fixed timestamps.
- **Both test tracks are live and running during this phase** — the Play 14-day closed-test clock burns
  down while content lands, and TestFlight testers cover iPhone/iPad. Cross-store testers also give us
  the real iOS↔Android co-op test.
- **The full Reaper sequence:** Red Reaper at 30:00, +1 per minute after, killable via the invuln-loop
  evolutions, 5-egg drop, character unlock, then the **White Hand** — screen reddens, camera zooms, 12
  bell tolls, unkillable finish.
- **Gate:** every evolution reachable and correct; full 30:00 4-player run at 60fps through peak
  density; the Reaper can be killed and the White Hand ending fires correctly.

### Phase 5 — Content, part 2 (ships as post-launch updates)
Everything here is still in scope and still gets built — it just doesn't hold launch hostage. Because
content is versioned data with a content-lint in CI, these ship as ordinary updates.
- **Up to 40+ characters**, including secret unlocks with joke-tier abilities.
- **The remaining weapons to 40+**, with evolutions.
- **All 22 Arcanas** + the relic that unlocks them, 3-per-run selection, stacking interactions.
- Bonus, challenge, special, and hidden stages. 20+ total.
- Relics, secret unlocks, hidden coffins.
- **Gate:** checklist pass — every stage loads, every arcana applies, every unlock fires. Content-lint
  clean, and existing saves migrate without loss.

### Phase 6 — Endgame, modes, and meta
The Phase 1 modifier stack means this is mostly data records and UI.
- **Limit Break** + the **stat hard-cap table** + **Golden Egg equivalents** with the float32 easter egg.
- **Endless** with per-cycle Curse escalation, plus **Ascension tiers**.
- Hurry, Hyper, Inverse, per-stage modifiers, **Hardcore** flag, **Boss Rush**, **Adventure runs**,
  **Custom Run / Sandbox**, **Weekly mutator**, **build share codes**.
- **Daily Run** + validated leaderboards; **seeded race**.
- **Ladder payouts:** Reaper Marks wallet, percentile bracket tables in remote config, season
  rollover, titles/emblems/banners, Run of the Week featuring. Server-granted only, computed at
  board close from revalidated runs, every grant written to the append-only event log. Leaderboards
  never grant power — see "Leaderboards have to pay out" above.
- **Replay share + spectate**; **run recap / death analytics**.
- **Speedrun toolkit** exposed in Settings: tick timer, auto-splits, PB ghost, seed entry, same-seed
  restart, verify codes, categories. Read-only, ladder-legal — see "Speedrun toolkit" above.
- **Co-op draft.**
- 150+ achievements; collection screen; per-character and per-stage records; run history.
- **Anti-cheat v2:** Reaper response, shadow segregation, telemetry dashboard, validated leaderboards.
- **Incident response, completed:** per-account snapshots + point-in-time restore, leaderboard
  purge-and-rebuild from validated runs, build-version quarantine, automated anomaly detection and
  alerting on gold/score/unlock-rate outliers.
- **Chaos Sandbox Day** wired as a reusable remote-config event: banner, dedicated achievement,
  server-granted participation rewards, all runs auto-tainted. Built once, reruns every 3–6 months with
  no engineering work.
- **Gate:** achievements fire exactly once and survive reload. Endless + Hyper + Inverse stack correctly
  and stay in sync in 4-player co-op. **The Endless perf gate: 90 minutes at 60fps with Limit Break and
  a full loadout**, plus the 3-hour CI soak test clean. A shared replay code plays back identically on
  another device. A deliberately cheated run gets caught and Reaped.

### Phase 7 — Polish
- Screen shake, hit flash, damage numbers, level-up flourish, death slow-mo, CRT/vignette shader.
- Settings: damage numbers, flashing, joystick size/position, gamepad, language scaffold.
- **Gate:** `bun run lint`, `bun run typecheck`, `bun run build` all clean.

### Phase 8 — Audio, monetization, compliance, and launch
- **Audio, all original:** stage music loops, ~40 SFX, ducking and mixing, audio settings, the 12-bell
  death knell. Generated in-sandbox; nothing sourced.
- **Monetization live:** rewarded-ad integration (revive / bonus gold, player-initiated, disableable),
  cosmetic IAP with receipt validation and restore-purchases. Consent flow and ATT prompt wired.
- **Cosmetic store opens**, spending both gold and Reaper Marks. Last season's ladder cosmetics roll
  into the gold shop on schedule; placement emblems stay exclusive.
- **Compliance package:** privacy policy hosted on the web package, age-rating questionnaires,
  EULA, block/report, name filtering, crash + telemetry consent, privacy manifest.
- **Accessibility pass:** colorblind palettes, flash/shake/damage-number toggles, joystick sizing,
  scalable HUD text, reduced-VFX mode.
- Icon, splash, store screenshots and listing copy — **co-op leads, the original is never named.**
- **Play Store production release.** Then **you** connect your Expo account in the mobile preview
  dashboard to trigger the real AAB build. I never build binaries in the sandbox — it would kill it.
- **~1 month later: iOS submission**, with a month of real reviews and crash data in hand. Recommend an
  IP attorney review before this step if the game is earning.
- **Gate:** a real device installs the store build, plays offline, survives a force-quit mid-run without
  save loss, survives an incoming call mid-run, and a rewarded ad returns to the exact game state.

---

## Files (shape, not exhaustive)

```
packages/mobile/
  app/(tabs)/index.tsx   GameHost: GLView + joystick + pause sheet
  screens/               RN out-of-run: title, character-select, stage-select,
                         shop, collection, achievements, settings, coop-lobby,
                         matchmaking, leaderboards, replays, dev-menu/
  components/            Joystick, PixelText, NineSliceFrame, ScreenFade
  game/
    core/      fx.ts (fixed-point + LUTs) loop.ts rng.ts pool.ts grid.ts vec.ts
    net/       codec.ts tickbuffer.ts host.ts client.ts events.ts hash.ts
               predict.ts sweep.ts migration.ts
    render/    gl.ts batcher.ts shader.ts atlas.ts camera.ts layers.ts recolor.ts
    sim/       player.ts enemies.ts spawner.ts projectiles.ts collision.ts
               pickups.ts damage.ts props.ts reaper.ts whitehand.ts
    systems/   leveling.ts batch-levelup.ts cards.ts evolution.ts arcana.ts
               powerups.ts unlocks.ts achievements.ts coop.ts draft.ts
               scaling.ts modifiers.ts limitbreak.ts statcaps.ts eggs.ts
               daily.ts recap.ts replay-share.ts ascension.ts
    data/      weapons.ts passives.ts evolutions.ts characters.ts enemies.ts
               stages.ts waves.ts arcanas.ts powerups.ts achievements.ts
               modifiers.ts modes.ts ascension.ts statcaps.ts mutators.ts
    ui/        in-run GL UI: hud, cardpick, damage-numbers, boss-bar, pause,
               whitehand-sequence
    dev/       registry.ts panels/ (run, player, spawn, perf, net, save, rng,
               visual, modifiers, cheat)
    save/      store.ts migrations.ts
    audio/     bank.ts mixer.ts
  assets/atlas/          atlas.png atlas.json
packages/web/src/api/    routes/rooms.ts routes/matchmaking.ts routes/save.ts
                         routes/validate.ts routes/flags.ts routes/daily.ts
                         routes/leaderboard.ts routes/replays.ts
                         + WS relay in index.ts
scripts/                 gen-sprites.ts pack-atlas.ts replay-test.ts soak-test.ts
design.md
task.md                  running scratchpad: progress, decisions, blockers
```

---

## How we verify

- **No-divergence test:** in a 4-player run I forcibly corrupt one client's sim state via the dev menu,
  then assert it returns to authoritative truth within ~0.3s and that no player ever observes a
  materially different game. Every phase from Phase 2 on.
- **Replay test:** record inputs, replay headless, compare state hashes. Catches physics bugs, RNG leaks,
  drift. Doubles as the anti-cheat validator.
- **Perf gate:** a full 30-minute **4-player** run holds 60fps at 500 enemies, 800 clearing as headroom,
  under 150ms latency and 2% loss, measured on your REVVL after 15 minutes of warm-up.
- **Endless perf gate:** 90 minutes at 60fps with Limit Break and a full loadout.
- **Soak test:** scripted 3-hour Endless run in CI — no frame-time regression, no memory growth, no pool
  exhaustion. Catches the minute-200 leak class no human will sit through.
- **Content checklist script:** asserts every weapon has an icon, every evolution's requirements exist,
  every unlock has a trigger, every stage has a wave table, every stat has a cap entry.
- **Build gate:** `bun run lint` + `bun run typecheck` + `bun run build` clean before every deliver.
- **You play it.** Every phase ships playable. Your feel-feedback outranks my checklist.

---

## Risks

| Risk | Mitigation |
|---|---|
| `expo-gl` can't hit the perf floor | Gate A in Phase 0, before any game logic. Pivot to native Skia there if it fails. |
| **Players drift into different games** | **Structurally prevented:** host authority + rolling correction sweep caps drift at ~0.3s and self-heals. Determinism is an optimization, not the guarantee. Tested by forcing corruption and watching it heal. |
| **Endless melts performance** (a PS5 sputters at 72 min in the original) | Separate 90-minute Endless gate, hard caps on projectiles/VFX/damage numbers with cosmetic-only degradation, 3-hour CI soak test. |
| Limit Break makes stats meaningless | Replicate the per-stat hard-cap table (amount 10, armor +50, pierce 10). Caps apply to base value, not bonus. |
| Batch level-up UI breaks at level 14,000 | Level-ups queue and resolve in batches; auto-apply above a threshold; one authoritative host event per batch in co-op. Dev menu can jump to level 10,000 to stress it. |
| Correction bandwidth too high on cellular | Sweep rate is a tunable percentage with interest management. Phase 0 measures cross-engine divergence so the rate is set from data. |
| Cheating host poisons leaderboards | Server-side replay validation; validated runs only. Reaper response + shadow segregation. |
| Co-op misbehaves in the wild at launch | Ships locked behind remote config; progressive rollout; solo never touches the co-op path. |
| Desync bugs appear late | Netcode at Phase 2 on a small slice; no-divergence test every phase after. |
| Modes become `if (mode === ...)` spaghetti | Modifier stack is a **Phase 1** core system, proven there with Hurry and Hyper as pure data. The sim never sees a mode enum. |
| Endless has no reason to exist once the shop is maxed | Limit Break + Golden Eggs + Ascension tiers give it an infinite sink and a ladder. |
| Dev menu rots or bloats the release build | Panel registry pattern, one shared `devgate.ts` entry point, extended every phase as a deliverable. |
| **Dev menu ships public and gets found** (accepted, by your call) | Assumed from day one, not defended against: dev toggles are sim-only and can never write to the server; using one taints the run; tainted runs can't post, validate, or enter public queues. Remote kill switch flips it off in seconds without an app update. |
| A dangerous dev panel accidentally ships unlocked | Panels are tagged `self` or `system` in the registry; CI lint fails the build if a SYSTEM panel is reachable on the public channel, if a SELF panel doesn't set the taint flag, or if dev-menu code imports a server-write module. Untagged defaults to SYSTEM. |
| Secret unlock leaks earlier than planned | Same kill switch. Nothing about the "wild week" depends on the leak's timing being convenient. |
| Store reviewer stumbles on the debug surface | Flag is off at submission, so a review build behaves like a normal game. Nothing in the store listing or UI references it. |
| Word-of-mouth becomes "the game you can cheat in" during the wild week | Contained by design: ladders are untouched, co-op is unaffected, and the event is framed and later formalized as **Chaos Sandbox Day** — a feature, not a breach. |
| An exploit runs for hours before you notice | Automated anomaly detection and alerting on gold/score/unlock-rate curves, plus point-in-time restore to any moment and leaderboard purge-and-rebuild. |
| A bad admin action or bad restore makes it worse | Append-only event log — nothing overwritten in place, every admin action attributed, any state reconstructable. |
| RN menus don't feel close enough | Fidelity kit + explicit Phase 3 review with a contained GL escape hatch. |
| Maximal scope is large | Data-driven content + phase gates. Great game at Phase 4; stop, expand, or reprioritize at any boundary. |
| Art consistency across 20+ sheets | Locked palette + prompt preamble, approval checkpoint, atlas regenerated as a batch. |
| Balance won't match by feel alone | Formulas and timings from community wikis, encoded as data with sources in comments. |
| 17 Pro Max flatters the build | Gate on your REVVL, measured warm. Emulated profiles catch regressions between hands-on passes. |
| **Competing with a free, established game** | Co-op is the wedge; the leader doesn't own it. Five-year horizon accepted. Launch smaller, iterate — the path the original took. |
| **App Store 4.1 Copycats rejection** | Deliberately distinct identity, co-op-led listing, original never named in metadata, no pixel-matched layouts. Android-first means real players and reviews before Apple review. |
| **Look-and-feel copyright** (*Tetris v. Xio*: Xio lost with all-original code) | Our own art, silhouettes, UI arrangement, stat strings, font glyphs, audio. IP attorney review recommended before iOS launch. |
| Contacting the rights holder backfires | Recommended against: it creates dated evidence of access, forces a decision nobody is currently making, and yields feedback that can't be safely acted on. Attorney review (privileged) plus Beta App Review cover the same ground without a counterparty. |
| **You dislike the UI after it's built** | Mock-first approval loop is a hard gate — static mocks iterated to your approval before any screen code. Rebuilding a mock costs minutes. |
| Server bill grows with success | Players host, relay stateless, replay validation sampled, saves local-first. Cost reviewed at Phase 2 with real bandwidth numbers. |
| Monetization retrofit breaks things | Consent flow, ATT, privacy manifest, receipt validation planned in Phase 0 even though ads/IAP land in Phase 8. |
| **Play's 12-testers-×-14-consecutive-days gate delays launch** | Play account in Phase 0–1, both test tracks live by Phase 3, recruit ~18–20 for slack so lapsed engagement can't reset the clock. The 14-day window burns during Phase 4 content work. |
| **Apple calls it a copycat on launch day** | TestFlight external testing triggers Beta App Review months early — a cheap, free read on 4.1 risk while there's still time to change identity. |
| Player names create a moderation liability (Guideline 1.2) | Generated names by default, custom opt-in and filtered, block/report from day one, EULA prohibiting abuse. |
| **Losing 200 hours of save data** | Atomic writes + backup slot from the first save in Phase 0, versioned migrations, force-quit test in the Phase 8 gate. |
| Licensed pixel font is a hidden landmine | Glyphs drawn into our own atlas. No font files shipped. |
| Sandbox loss wipes the project | GitHub push at every phase gate from Phase 0. |
| Shipping blind without crash data | Crash reporting + telemetry + in-app bug reporting with the last N seconds of input log, so bugs are replayable rather than described. |
| Thermal throttling invalidates benchmarks | All perf gates measured warm, after 15 minutes of play, on the REVVL. |

---

## Decisions now settled

- **Name:** Nightreap Survivors
- **Perf:** 500 @ 60fps hard floor, 800 gate, 4-player under adverse network; separate 90-min Endless
  gate plus a 3-hour CI soak test
- **Netcode:** host-authoritative with rolling correction — divergence structurally prevented
- **Co-op:** 1–4 players, private room codes + public matchmaking by party size, friends-first fill,
  cross-platform, co-op only, built at launch but **shipped locked** behind remote config
- **Cheating:** active program — replay validation, Reaper response, shadow lobbies, telemetry dashboard
- **Dev menu:** extremely thorough, built Phase 1, extended every phase
- **Dev menu ships in the public build behind a secret unlock — your call, and I'm building to it.** No
  pretending the gate holds (Hermes bytecode decompiles; any client-side check is Frida-hookable). Instead
  the blast radius is engineered to zero: dev toggles are sim-only and never write to the server, using
  one **taints the run**, and tainted runs can't post to leaderboards, upload for validation, count for
  Daily/Weekly, or enter public co-op. When it's found you get your wild week, then it's patched out.
- **Taint is on the run, not the save.** Cheat one run, then play clean — the next run counts normally.
- **Cheats on = offline.** Competitive surfaces aren't reachable from a tainted run; personal progression
  still accrues.
- **Offline solo save modding is allowed**, and barred from leaderboards by the same validated-runs-only
  rule. Nothing else happens to those accounts.
- **Chaos Sandbox Day:** the same remote-config switch, used deliberately for 24–48h every 3–6 months,
  with server-granted giveaways so the free stuff can't be forged. Built once in Phase 6, reruns free.
- **Remote kill switch** for the unlock, per-feature and per-account, effective in seconds with no app
  update — so the length of the wild week is your decision, not the mob's.
- **Revert capability: top tier.** Append-only event log (never overwritten in place), per-account
  snapshots with point-in-time restore, leaderboard purge-and-rebuild, build-version quarantine,
  automated anomaly detection and alerting.
- **Break-glass admin tools live in both places:** a web admin page and the private dev build.
- **SELF vs SYSTEM tiering, your split, made structural.** Public builds unlock only self-affecting
  toggles (godmode, grants, spawns, time controls — worst case is your own run got silly). Anything that
  writes to the account, the ladder, the server, or another player's session is SYSTEM: private dev
  channel and web admin only. Enforced by a CI lint, with untagged panels defaulting to SYSTEM so a
  careless addition is locked rather than accidentally public.
- **Co-op gold:** counts fully toward the solo PowerUps shop, validated runs only. Punishing co-op kills
  the feature you most want. Dev-menu flag to test the alternative.
- **UI:** GL in-run pixel-exact, RN out-of-run with fidelity kit
- **Content scale:** Phase 1's 6 weapons are archetype coverage, not the budget. Final: 40+ weapons with
  evolutions, 20 passives, 40+ characters, 20+ stages, 22 arcanas, 150+ achievements
- **Level cap:** none, faithful to the original. The real ceiling is everything-maxed, answered by
  Limit Break → per-stat hard caps → Golden Eggs. Runs end via the Reaper sequence and the White Hand.
- **Modes:** nothing deferred — the full catalog is in scope, all as modifier-stack data
- **Perf gate device: your T-Mobile REVVL**, measured warm, not your iPhone and not an emulator. You
  don't need to buy anything. The iPhone is the feel target; the REVVL is the truth.
- **Testing:** you play it in the Runable app from Phase 0 on, full-screen in Safari for real touch feel,
  and natively via Expo Go or a dev build for anything perf-related. I do all formal verification.
- **Name cleared:** no game, product, or trademark called "Nightreap" exists.
- **Differentiation:** faithful systems, deliberately distinct art/UI/identity, **co-op as the headline**.
  Where faithfulness and differentiation conflict, differentiation wins.
- **UI:** mock-first with your approval as a hard gate. Layout conventions kept (functional, unprotected);
  skin deliberately ours. Iterated until you say it's right.
- **Monetization:** free download, optional rewarded ads (revive / bonus gold, disableable), cosmetic-only
  IAP. Nothing that touches progression. Hooks in Phase 0, live in Phase 8.
- **Launch:** **Play Store first**, iOS ~1 month after full release.
- **Testing: both tracks, in parallel.** Play closed testing (the **12 testers × 14 consecutive days**
  gate that unlocks public release) *and* TestFlight for iPhone/iPad. Both live by Phase 3. TestFlight
  requires the $99 Apple membership early — correcting my earlier "it can wait", because its Beta App
  Review is a free early read on the 4.1 Copycats risk.
- **Launch content — LOCKED:** all systems at full scope; launch with ~15 weapons / ~12 characters /
  5 stages / ~8 arcanas / ~50 achievements. Everything else ships as post-launch updates. Phase 4 is the
  launch set, Phase 5+ is live ops.
- **Compliance:** full package — privacy policy, age ratings, EULA, generated names by default with
  opt-in filtered custom names, block/report, crash + telemetry + in-app bug reporting with consent.
- **Accessibility:** full — colorblind palettes, flash/shake/damage toggles, joystick sizing, scalable
  HUD text, reduced-VFX mode.
- **Assets:** all original, including **font glyphs drawn into our own atlas** (many pixel fonts forbid
  game embedding) and all music/SFX generated in-sandbox.
- **Server cost:** players host, relay is thin and stateless, replay validation sampled not universal,
  saves local-first so solo works fully offline.
- **Backups:** GitHub, pushed at every phase gate, starting Phase 0.
- **Legal:** mechanics aren't protected, look-and-feel is (*Tetris v. Xio*). We keep our distance on
  expression. Recommend a real IP attorney review before the iOS launch if it's earning.
- **Don't contact poncle for feedback or blessing.** It manufactures evidence of access, forces a
  decision nobody is currently making, and produces feedback you can't safely act on. An attorney gives
  you the same read privately; Beta App Review gives you Apple's read free. Post-launch and peer-to-peer
  only, attorney first. Your call — flagged as a recommendation, not a decision.

---

## Nothing is open — the plan is complete

Every decision is settled. No remaining questions on my side. On your go-ahead I start Phase 0.

---

## Next step

Phase 0 on your go-ahead. Highest-information phase in the plan: it either validates the renderer or
tells us to change course before a single weapon exists, and it measures cross-engine drift so the
co-op correction rate comes from data instead of a guess.

I'll come back with benchmark results, a playable movement test you can touch in this app, the first
sprite sheet for your approval, and a confirmed native testing loop for your iPhone and the REVVL.

Nothing is needed from you to start. When it's useful I'll ask you to grab Expo Go (free) or connect
your Expo account — I'll tell you exactly when and why rather than front-loading setup.

**The only things with real-world lead times**, so they're worth starting whenever convenient — none of
them block Phase 0:

1. **Google Play developer account, $25 one-time.** The 12-testers-×-14-days clock can't start until this
   exists, and it's the gate on public release.
2. **Apple Developer Program, $99/yr** — needed for TestFlight, which we now want early for the Beta App
   Review signal.
3. **Line up ~18 people who'd genuinely play a survivors-like.** You need 12 engaged for 14 straight days;
   recruit extra for slack. This is the most likely thing to delay launch, and the easiest to start now.
4. **Confirm GitHub is connected** so Phase 0 ends with the project backed up.

---

## §5b addendum — injected tweak menus (settled 2026-08-11)

Reference case: iOSGods-style dylib menu injected over a shipped app on a jailbroken device.
Assume this exists for our game on day one. Two corrections to §5b:

1. **`tainted` is a courtesy signal, not a security boundary.** It is client-side, therefore
   forgeable by a patched binary. Competitive ladder integrity rests entirely on **mandatory
   server-side replay revalidation** for ladder submissions (resim the tick log, compare state
   hash, reject on mismatch). Previously "sampled/queued"; now mandatory for Daily / Weekly /
   seeded race / global ladders. Still near-zero cost because only ladder submissions resim.
2. **A modded co-op host is authoritative and can corrupt the other three players' runs.**
   Mitigations, all Phase 6:
   - Guest-side plausibility checks on host events (spawn rate, damage magnitude, XP delta,
     chest frequency). Out-of-band → guest leaves the session and marks it non-counting.
   - Report-host button in the co-op HUD.
   - Public matchmaking prefers a host whose prior runs passed revalidation.
   - Private room codes are explicitly out of scope: your friends, your problem.

Neither changes the architecture. Both narrow where trust lives: nothing the client asserts is
ever believed, including its own claim of being clean.

---

## Feature backlog — from the 200-item review (settled 2026-08-13)

A 200-item feature list was reviewed item by item. Full sort with reasoning lives in
`features-review.md`. Counts: 19 already planned, 14 accepted immediately, 74 accepted for a later
phase, 88 rejected, 5 escalated as open decisions. Only the accepted items are recorded here.

### Two new locked rules

- **Difficulty and drops never react to how well the player is doing.** No hidden pity timers, no
  catch-up chests, no secret buffs to unused items, no armour that spikes when you're being hit, no
  spawns that target your weakest stat. Thirteen separate proposals were versions of this and all
  thirteen were rejected. A numbers game whose numbers are secretly adjusted has no numbers.
- **Anti-kite enrage timers apply to normal bosses only, never to the Red Reaper.** Killing the
  Reaper through an invulnerability loop is a deliberate secret path to the Golden Eggs.

### Accepted — folds into work already scheduled

- Restart the same character and stage from the pause and death screens (Phase 3 — treat as a
  launch requirement, not polish).
- In-run stats screen showing the live math behind every stat, plus item tooltips on pause (Phase 3).
- Save three loadout presets — character, Arcanas, modifier stack (Phase 3).
- Copy the run seed and modifier stack to the clipboard from the death screen (Phase 3), and type a
  seed in manually (Phase 6). Format is ours, not a 10-digit one.
- Weapon **tags** as an append-only content field, added when the content layer lands (Phase 3).
  Visible set bonuses and banish-by-tag come later (Phase 5). No hidden bonuses.
- Skip the chest animation; audio mix presets including a music-off/warnings-on mode; player-chosen
  XP gem colours; a slider that fades out your own character (Phase 4/7 settings).
- Ascension handicaps are **chosen by the player**, not assigned.
- Bug reports auto-attach the input log and recent frames.
- Effect sliders replace on/off toggles for shake, hit-stop, flash and particle count.

### Accepted — Phase 4, alongside launch content

- Elites spawn with randomised auras (reflect, aura of speed for nearby mobs, etc.).
- Mimic chests; cursed coins (10× gold, spawns an elite on the player); an overcharge pickup
  (all weapons fire 500% faster for 10s); exploding barrels.
- Enemies that pull player projectiles into themselves; Goliaths (huge, slow, screen-filling);
  enemies that split on death, with a hard cap on split depth.
- Anti-kite enrage on normal bosses; enraged boss variant with better rewards if the player reached
  it having taken no damage.
- A ground-painting weapon archetype (damaging trail along the path walked).
- **Decided before art starts:** palette-swap Shadow variants and insect-free sprite alternates are
  both planned for, so the swaps are drawn in the same pass as the originals.

### Accepted — Phase 5, post-launch content and co-op depth

- **Primer / detonator co-op combo** — one player marks an elite, another detonates it. Highest-value
  co-op idea found; requires no coordination.
- **Ping marker plus a free set of preset messages** in co-op — one button drops a map marker with a
  sound, and a short fixed list (help / chest here / thanks / over here / going down) covers everything
  else. This is the entire communication channel: no voice, no text, and the message list is free, not
  a purchase. Rides the confirmed-input channel.
- Hold a button to transfer your own health to a downed teammate.
- Ban up to 3 passives from the global drop pool.
- Passive items branch into two choices at max level.
- Merge two maxed weapons into one, freeing a slot (the missing answer to late-run slot pressure).
- Shrines and altars with real costs: full heal for −5 minutes off the run clock; half max HP to wipe
  an elite wave; clear all Curse for resetting your best weapon to level 1.
- Marked-for-death state after 1,000 kills untouched — enemies 2× faster, 3× gold, ends on first hit.
- Killing a boss far faster than intended spawns its angry mate.
- New weapon/passive archetypes: tethered "clothesline" projectiles; reverse magnet that shoves
  enemies away; health-cost casting that heals on crit; damage that scales with unbroken straight-line
  movement.
- A minion/necromancer character (own friendly-entity pool — real work, not a data row).
- Shadow character variants; a wandering merchant at minute 15; miniboss squads that support each
  other; a wandering black hole that eats enemies, players and gems; expanding arena boundaries;
  a buildable lightning fence.
- Day/night mutations; holiday reskins; server-flipped daily hazards; pitch-black events;
  trick-or-treat chests; infection/DoT stages; utility pets that must be unlocked, not bought.
- In-run draftable mini-objectives at 5/10/15 minutes.
- Stance-switching character; shared team ultimate; decoy turrets (all low priority).
- Ambush lockdown zones, implemented as hazard rings rather than walls.

### Accepted — Phase 6, endgame and modes

- **Ghost racing** — download a validated replay and race a friend's ghost on an identical seed.
- **Watch the last 30 seconds of the top-ranked run** from the leaderboard.
- **Doppelganger event** — an AI clone with your exact loadout hunts you.
  All three are nearly free because the replay and validation work is already done.
- **Tower climb mode** — 2-minute room clears, pick a permanent handicap per floor. Short sessions,
  which is what mobile actually wants.
- Weekly gauntlet (five 3-minute stages, build carries, no healing); boss rush score attack; defend
  a central core.
- Modifiers, all cheap and data-only: one-hit wonder; loadout rerolled every 60s; forced weapon swap
  every 5 minutes; gun-game (weapon changes every 100 kills); Golden Gun (one slot, 1000% damage);
  glass cannon as a chosen item, never automatic; Nemesis (the elite that killed you returns) as an
  opt-in modifier only, since it makes a run depend on save data.
- Bank an Endless run at intervals (the snapshot work already covers it, including staying
  ladder-legal).
- Permanently corrupt a weapon — large upside, severe downside.
- Account-wide opt-in handicap in exchange for a permanent gold multiplier.
- Faction reputation from killing specific enemy types — cosmetic unlocks only.
- **God-mode sandbox unlocked at 100% completion** — reuses the existing developer menu, exposes only
  the safe half, and flags those runs non-competitive.

### Accepted — Phase 7, polish and accessibility

- Screen-edge arrows for off-screen elites and bosses. Treated as required, not polish.
- Tap-anywhere-to-move as an alternative to the fixed thumbstick.
- Automatic dimming when flash frequency crosses a safe threshold.
- Per-event vibration toggles, including a heartbeat pulse below 20% HP and distinct patterns per
  weapon impact.
- Optional auto-aim for directional weapons — off by default, available to everyone, and
  **fully leaderboard-legal.** No accessibility setting sits behind a competitive penalty.
- High-contrast hitbox overlay; bright outlines on enemy projectiles; thick enemy outlines
  (needs a performance measurement — at 800 enemies this roughly doubles what we draw).
- Music split into layers that build with on-screen threat; weapon sounds duck when a boss winds up.
- Dyslexia-friendly alphabet — honest cost: a second full glyph set drawn by hand.
- Post-run heat map of where you walked, got hurt and died; scrubbable timeline of every pickup.
- Insect-free sprite mode (sprites drawn in Phase 4).
- Screen-reader labelling on every menu element rather than a custom voiced UI.

### Accepted — Phase 8 and post-launch

- Cosmetic only, all of it: tombstones visible to teammates, extra decorative emotes layered on top of
  the free Phase 5 message set,
  lobby pets, in-run pets with zero gameplay effect, trail colours, death animations, CRT/Game Boy/VHS
  screen filters, announcer voice packs, a $5 founders credits roll.
- Golden weapon skins are **earned only**. A separate premium skin line may be sold. Selling the thing
  that proves mastery makes the mastery worthless.
- Streamer mode hiding room codes and player names — may need to land as early as co-op ships.
- Delete-my-data and export-my-data, both one tap. Legally required.
- Charity cosmetic bundles and Discord supporter roles, post-launch, low priority.

### Rejected outright, recorded so it stays rejected

- Anything requiring enemy pathfinding around geometry: destructible terrain, elevation, line-of-sight
  walls, drawbridges, destructible cover, escort missions. Enemies walk straight at the player, and
  that is precisely why 800 of them fit on the target phone.
- Anything that hides the rules: pity timers, catch-up chests, silent buffs to unused items, adaptive
  armour, spawns aimed at your weakest stat, auto-vacuum saves, automatic time-freeze.
- Anything that makes co-op adversarial or role-locked: friendly fire, card stealing, gold wagering,
  hidden traitor roles, revive minigames that punish the reviver, XP penalties for splitting up,
  healer/tank/DPS composition, an asymmetric commander player.
- Second permanent power ladders outside the gold shop: constellation trees, stat inheritance between
  characters, relics that level forever, titles that grant damage, paying gold to permanently weaken a
  monster.
- Gambling and loot-box mechanics: cosmetic slot machines, an in-game stock market.
- Ads or purchases that grant power, including a rewarded ad for a level-2 starting weapon. Rewarded
  ads stay limited to revive and bonus gold, both player-initiated.
- Permadeath profiles that wipe the whole account. Separate save slot, fine. Wiping everything, never.
- Undo on a card pick; turning auto-fire off; manual reload / overheat; weapon durability; a grid
  inventory; rhythm-synced crits; pacifist builds; inverted-control handicaps.
- A HUD that resizes itself; wireframe rendering under load.
- Anything needing a large live population: collective global unlocks, faction wars, server-wide bingo,
  gold tipping, draft tournaments.
- Third-party and community integrations: Twitch chat voting on card picks, community-sourced
  translations, community-drawn weapon skins. (Licensed guest characters are "not now" rather than
  never — see the corrections below.)
- Voice chat in co-op. Needs an audio stack, real-time audio moderation is near-impossible, and a
  hot mic in a stranger's room is the worst moderation surface there is. (Free-text chat was
  originally rejected alongside it and has since been **accepted** — see the moderation engine
  section for why the reasoning changed.)
- An entire second art style for a weekend event.
- Randomising the simulation's own rules mid-run. Chaos Sandbox Day already covers chaos.
- Bribing the Reaper to delay him. His arrival is the game's one ceremony.

### The five decisions — all answered 2026-08-13

1. **Elements: no. Tags instead — but deferred, not dead.** Weapons get tags (Blunt / Magic / Tech)
   for set bonuses and build identity. Elements with resistances stay on the table as a possible
   post-launch depth pass; because every weapon already carries a tag field, adding a type later is
   an additive content change rather than a rewrite. Nothing about elements gets built now.
2. **Active defence button (dash / directional shield): not at launch.** Positioning is the only
   defence. Revisit post-launch as a single character's ability, where it is a build choice rather
   than a change to the game's rules.
3. **Cosmetic battle pass: not at launch.** Launch with the cosmetic store and the season ladder
   rewards already planned. Revisit only once there is a population to justify it.
4. **Shadow variants: yes.** Palette-swap recolours with swapped stats. The Phase 4 art pass must be
   built so a recolour is a data row, not a redraw.
5. **Insect-free sprite mode: yes.** Alternate non-insect sprites are drawn in the same Phase 4 pass
   as the originals, and this also informs which enemies get designed as insects at all.

### Two corrections to the review (2026-08-13)

- **Preset co-op messages are free infrastructure, not a Phase 8 purchase.** Filing the emote wheel
  under cosmetic IAP was wrong. Four strangers who cannot type to each other need a way to
  communicate. A base set of canned messages — help, chest here, thanks, over here, going down —
  ships **free with co-op in Phase 5**, on the same button as the ping marker. Decorative extra
  emotes on top of that free set are what sells in Phase 8.
  **Superseded 2026-08-13 on text chat:** this section originally rejected free-text chat as well,
  on the grounds that it needs moderation. That reasoning assumed moderation means a person reading
  reports. It does not — enforcement automates almost completely. Free-text chat is now **accepted**
  behind an automated moderation engine; see the dedicated section below. Voice chat stays rejected.
  The preset messages are unaffected and still ship free with co-op in Phase 5 — they are what
  players who never want to type will use, and they remain the only communication in the game until
  the moderation engine ships.
- **Licensed guest characters: "not now", not "never".** The blocker is a contract with another
  studio, which realistically only happens after a game succeeds. Post-launch, if a studio
  approaches us, a guest character is a data row plus a sprite sheet — roughly a week. Nothing to
  design for now beyond keeping characters fully data-driven, which they already are.


## Moderation engine and free-text chat (settled 2026-08-13)

Free-text co-op chat is **accepted**, gated behind an automated moderation engine, shipping in
**Phase 8** alongside the cosmetic store and cloud save. It ships there and not earlier because
every meaningful enforcement action has to attach to an account, and the account system is a Phase 8
deliverable. Preset messages plus the ping marker carry all co-op communication from Phase 5 through
launch and remain permanently available.

### The decision that unlocked it

The rating cost was researched and accepted, not dodged. Apple's age rating questionnaire, as of the
2026 revision, asks directly whether users can communicate freely. Answering yes imposes a floor of
**13+** regardless of moderation quality — it is a capability checkbox, not an assessment. Google
Play's content rating questionnaire behaves equivalently, pushing toward Teen. There is no
engineering workaround: a player-facing on/off switch does not help, because shipping the capability
is what must be declared.

**User's ruling: 13+ is acceptable.** The realistic audience for a dark gothic horde survival game
does not skew under 13, so the rating floor costs us approximately nothing in reachable audience.

This also means the earlier reasoning that a switch could preserve a lower rating is dead. The chat
on/off switch still ships, but it is a **player comfort setting, not a compliance mechanism** — it
exists so the roughly half of players who do not want strangers typing at them can turn the channel
off entirely and play with presets only. Default state is decided in the Phase 7 polish pass.

### What the engine must satisfy

Apple's Guideline 1.2 requires, for any app with user-generated content: a method for filtering
objectionable material before it posts, a mechanism for users to report content, a mechanism for
users to block other users, and published contact information. Reports must be acted on within
24 hours. Google Play's equivalent policies are satisfied by the same implementation.

The critical clarification, because it changes the cost enormously: **"eject the offender" is
satisfied by removing them from chat, not from the app.** A chat-banned player keeps the entire
game, keeps their save, keeps buying cosmetics. They cannot type. This meets the requirement in full
and costs zero revenue. Full account bans are reserved for the extreme tail.

### Layer 1 — normalization, before anything is checked

Evasion is the whole game at this layer. Every outgoing message is reduced to a canonical form
before any list is consulted:

- Unicode confusables and homoglyphs folded to ASCII (Cyrillic а, fullwidth ａ, mathematical bold 𝐚).
- Combining marks, zero-width characters, and diacritics stripped.
- Leetspeak reversed (`1`→`i`, `3`→`e`, `0`→`o`, `$`→`s`, `@`→`a`, `!`→`i`).
- Separator characters between letters collapsed (`s-l-u-r`, `s.l.u.r`, `s l u r`, `s_l_u_r`).
- Repeated characters collapsed (`sssluuur` → `slur`).
- Case folded.

Matching then runs on the normalized form, and — critically — also on the normalized form with all
whitespace removed, which is what catches a slur split across word boundaries. Both the original and
the normalized text are retained: the original for display and appeals, the normalized for scoring.

Word lists are **content data, versioned, CI-linted** like every other content table, with separate
severity tiers. They are also **server-updatable via remote config** — a new slur or a new evasion
trick must be blockable in minutes without an app update, which is exactly the existing remote kill
switch infrastructure.

### Layer 2 — severity tiers, not a single blocklist

- **Tier 3 (severe):** slurs, sexual content, threats of violence, anything sexual involving minors.
  Blocked outright, never transmitted, immediate permanent chat ban with no ladder. Sexual content
  involving minors additionally triggers a full account ban and is preserved for legal reporting.
- **Tier 2 (profanity):** blocked from transmission, sender warned, one strike accrued. Not
  transmitted-then-deleted — the recipient never sees it.
- **Tier 1 (mild):** transmitted with the term masked. No strike.

A blocked message never reaches the network. Filtering happens sender-side for instant feedback and
is **re-checked host-side and relay-side**, because a modded client can bypass its own filter. The
sender-side check is UX; the server-side check is the actual enforcement.

### Layer 3 — an AI classifier for the gray middle

A word list cannot catch harassment containing no listed words, grooming patterns, coordinated
targeting, or self-harm content. A cheap text classification model scores every message that passes
the list on: harassment, sexual content, self-harm, threat, grooming. Cost is a fraction of a cent
per message and only messages that clear Layer 2 reach it.

Design constraints: the classifier is **advisory to the ladder, never the sole basis for a permanent
ban** — high scores mute, they do not permanently ban, precisely because classifiers produce false
positives and a false permanent ban is the worst possible outcome for a paying player. Self-harm
detection does **not** punish; it surfaces a crisis-resources card to the sender and takes no
enforcement action, because punishing a person in distress is indefensible.

If the classifier service is unreachable, messages **fail closed for new accounts and open for
accounts in good standing**. A total outage must not silence the entire playerbase.

### Layer 4 — behavioral signals, reading no text at all

The strongest signals in moderation are structural and require no language understanding:

- **Multi-reporter convergence.** Several unrelated players reporting one person inside a short
  window is the highest-confidence signal available. Crossing the threshold auto-mutes pending
  review. Reporters must be unrelated — not the same party repeatedly, which is how a group grief-
  reports one player.
- **Spam and flooding.** Identical or near-identical text to many recipients; message rate above a
  human ceiling. Rate limits are per-account and per-session.
- **New-account risk weighting.** A brand-new account messaging strangers heavily is weighted more
  aggressively than an account with hundreds of clean hours. Tenure earns latitude.
- **Report accuracy tracking.** Every reporter accumulates a precision score. Players whose reports
  are consistently dismissed have their reports deweighted and eventually accrue their own strikes —
  false reporting is itself an abuse vector, and the engine must not be weaponizable.

### Layer 5 — automatic enforcement, and the ladder

**A report does not wait for a human.** On report, the engine re-scores the exact reported text
against a stricter threshold than the live filter, combines that with the reported account's
history and the reporter's precision score, and acts in seconds. Unambiguous violations are removed
and the ladder advances automatically. Unambiguous non-violations are dismissed and count against
the reporter's precision. Only the genuinely ambiguous middle band is queued for a human.

The ladder, running unattended:

| Step | Trigger | Consequence |
| --- | --- | --- |
| 1 | First Tier-2 strike | Message blocked, warning shown in-client |
| 2 | Repeat | Chat muted 24 hours — game fully playable |
| 3 | Repeat | Chat muted 7 days |
| 4 | Repeat | Permanent chat ban |
| — | Any Tier-3 | Permanent chat ban immediately, ladder skipped |
| — | Sexual content involving minors | Full account ban, preserved for reporting |

Strikes **decay** — a clean stretch of play reduces accrued strikes, so a player who swore once a
year ago is not one strike from a permanent ban. The ladder punishes patterns, not history.

**Bans are account-bound and survive reinstalls.** A ban attached to the app on the device is
theater. Enforcement attaches to the opaque account id already specified for cloud save, and every
enforcement action is an **append-only event-log row** — the same log used for leaderboard grants —
so any action can be audited, explained to a player, or reversed in bulk if the engine misbehaves.

### What remains manual, honestly

Appeals, and the ambiguous middle band. Both are queues with **no 24-hour clock**, because the
enforcement action already happened automatically — a human is only ever reviewing whether the
engine was *wrong*, never whether to act. At small scale this is a handful of items a week. Tooling
lives in the existing break-glass admin surfaces: the web admin page and the private dev build.

A bulk-reversal path is mandatory. If a bad word-list update or a misbehaving classifier
mass-punishes innocent players, every action must be revertable in one operation from the event log.

### Player-facing requirements, all mandatory

- **Report button** on any message, and on a player in the co-op roster.
- **Block button.** A blocked player's messages are never delivered, in this session or any future
  one. Blocking is client-enforced *and* server-enforced.
- **Chat on/off switch** in settings, and a separate switch for chat from non-friends.
- **Generated display names by default**, custom names opt-in and filtered through the same engine —
  already settled; names are UGC exactly like messages.
- **Published contact address** for moderation appeals, listed in the store listing and in-app.
- Chat is **never** available during the results screen or any leaderboard submission path, to keep
  harassment out of competitive contexts.

### Explicitly out of scope

- Voice chat. Rejected permanently.
- Chat with players outside your current co-op session. No global channel, no friend DMs, no
  persistent inbox. Chat exists only inside an active run, which bounds the entire abuse surface to
  people you are already playing with and makes stranger-targeting nearly impossible by design.
- Message history retention beyond what appeals require.
- Player-created content of any other kind: no custom emotes, no drawings, no profile bios.

### Where this lands in the plan

- **Phase 5:** preset messages plus ping marker ship free with co-op. No free-text chat, no
  moderation engine, no rating change.
- **Phase 7:** chat UI designed in the polish pass under the mock-first gate, default states chosen.
- **Phase 8:** moderation engine, free-text chat, account-bound enforcement, admin queues. Age
  rating questionnaires updated to declare communication; **13+ accepted**. Ships behind the
  existing remote-config flag so it can be switched off globally in seconds if it goes wrong.
