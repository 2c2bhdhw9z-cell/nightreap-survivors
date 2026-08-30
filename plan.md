# NIGHTREAP SURVIVORS — THE PLAN

This is the plan of record. It is written from what is **verified in the code**, not from what an
earlier document claimed. Every number below was counted or measured, and where something is
unproven it says so.

---

## THE ONE-LINE ANSWER

**The engine is built and measured. Content is ~80% of the launch list. What is genuinely left is
finishing the Reaper ending, then polish, sound, money and store paperwork.**

Read the Reaper section below before planning around it — it is further along than previous versions
of this document claimed, and what remains needs three decisions from you before it can be coded.

---

## HOW YOU RUN IT — FOUR WAYS, ALL WORKING

This section exists because the old plan assumed a hosting platform that is gone. None of these
depend on anyone else's service staying up.

| Way | What it needs | Best for |
|---|---|---|
| **Expo Go + EAS Update** | Nothing but your phone | **Day-to-day. This is the main way now.** |
| Single-file HTML | Any browser | A fallback with no account at all |
| `expo start` | A computer | Live reload while editing |
| Store build | Apple/Google accounts | Launch, stage 8 |

### Expo Go (the one to use)

The project is published to EAS as **`nightreap-survivors-preview`**. Open Expo Go signed into your
account, go to **Projects**, tap it. No dev server, no computer, no QR code.

To ship a change to the phone:

```sh
cd packages/mobile
EXPO_TOKEN=<token> bunx eas-cli update --branch preview --message "what changed"
```

Force-close Expo Go and reopen to pick it up. Two things make this work and must not be changed
casually: `runtimeVersion: { policy: "sdkVersion" }` in `app.json`, which produces
`exposdk:54.0.0` — the value Expo Go matches on — and the `preview` **channel** being connected to
the `preview` **branch**. Publishing to a branch with no channel pointed at it returns 404 to the
phone.

### Single-file HTML

```sh
cd packages/mobile && bunx expo export --platform web --output-dir ../../.webdist
cd ../.. && node tools/build-single-html.mjs .webdist nightreap.html
```

One ~2 MB file, no server. Open it in a real browser, not the iOS Files preview.

### On a computer

```sh
bun install && cd packages/mobile && bunx expo start
```

QR code in the terminal, live reload. Add `--tunnel` if the phone is on another network.

### The old way, for the record

It used to be `exp://…-4300.runable.site` pasted into Safari — a dev server hosted by the platform
this project was scaffolded on. That host now returns 502. Nothing in the game was wrong; the
server simply went away. That single point of failure is why the four ways above are listed.

---

## WHAT IS ACTUALLY IN THE GAME — COUNTED, NOT CLAIMED

- **30 weapons** — 15 offerable, each with an upgraded final form
- **26 enemies** — 18 that walk at you, 8 named fights
- **51 achievements**, with their own screen
- **12 characters**, each with art, a starting weapon, a strength and a weakness
- **5 stages**, each with its own look, crowd schedule and named fights
- **8 arcanas** — run-warping cards, three per run, at 4/12/22 minutes
- **20 items** (passive upgrades), five levels each
- **Treasure chests** with the full opening ceremony
- **1–4 player online co-op** — built, tested over a real socket, switched off until launch
- **Anti-cheat** via full run recording and replay, plus an admin review page
- **Saving** that survives the app being killed mid-run, plus cloud backup
- **A dev menu** that jumps to any minute, stage, character or enemy count
- **A title screen** — painted art, and menus for every screen listed above

---

## THE ENGINE — WHAT MAKES IT FAST, AND WHY THAT MATTERS

Worth knowing so nobody "tidies" it into slowness later:

- **Fixed 60Hz timestep** with the clock injected, never read. The same code runs headless for tests
  and replays.
- **Struct-of-arrays over pre-allocated typed arrays.** An enemy is an integer index into 16 parallel
  arrays. No objects, no allocation inside a tick — which is why there is no GC pause, which is why
  frame times are flat.
- **Seeded RNG** (xoshiro128\*\*) with 10 independent named streams, so adding a visual-effect roll
  cannot shift the enemy spawn table.
- **The engine does not know screens exist.** Nothing in `packages/mobile/game/` imports React,
  React Native or Expo — verified across all 165 files. That is what lets one engine run on Android,
  iPhone and a browser.
- **Integer trig.** Angles are "brads" (4096 per turn) through a lookup table in `core/fx.ts`, never
  `Math.cos`. JS does not specify `sin`/`cos`/`pow`/`hypot`, so those differ between phones and
  servers — and anything that differs breaks replay validation.

---

## MEASURED PERFORMANCE

Real device, real build, from the in-game bench:

| | iPhone 17 Pro (A19 Pro), Expo Go |
|---|---|
| Quads at 60fps | **8,176** (target was 5,000) |
| p50 / p95 / p99 / worst | **16.7 / 16.7 / 16.7 / 16.7 ms** |
| Frames over 16.7ms | **0.0%** (target under 1%) |
| Dropped ticks | **0** |
| Overdraw | 54.1× screen, still holding |

Not one frame missed out of ~14,500. Flat p99 is the payoff of the no-allocation rule.

**Two caveats, stated plainly.** That run was 4 minutes of a 15-minute warm test, and the harness
refuses a verdict before 15 because a phone flatters itself for about three minutes before it
throttles. And an A19 Pro is the opposite end of the market from the **$100 phone** this is supposed
to run on. The flagship number proves the engine is clean. It says nothing about the target device.

**Next measurement that matters: the same bench on a cheap Android.** One `eas update` away — the
Android manifest already resolves.

---

## WHAT IS LEFT BEFORE LAUNCH

### Content — the last of it

**1. The Reaper ending — about 60% built, not 0%.** An earlier version of this plan said this was
entirely unbuilt. It is not. Verified in `run/run.ts:739` (`tickReaper`):

| Piece | State |
|---|---|
| Reaper arrives on time, once | **Built.** Spawns `gravewarden` (900hp, boss, heavy, persistent) above the player |
| `CUE.reaperArrived` fires | **Built** |
| Twelve bell tolls, one per second, numbered for the audio layer | **Built** |
| The White Hand ends the run | **Built.** `RUN_END.whiteHand`, "Taken by the White Hand" — counts as completed, not a death |
| HUD countdown and last-minute warning | **Built and tested** (`hud.test.ts`) |
| First-timer prompt when he is near | **Built** (`guide/`) |
| **One more Reaper every minute after** | **Missing.** `reaperSpawned` latches after the first |
| **Killing him drops five eggs** | **Missing.** Golden Eggs do not exist yet — only a comment in `stats.ts` |
| **Killing him unlocks a character** | **Missing.** No run fact records it |
| **Screen reddens, camera pushes in** | **Unverified** — the cues exist, the visual response may not |
| Any test of the White Hand sequence | **Missing.** Zero test coverage |

There is also a **design tension to settle before this can be finished.** Today the Reaper arrives and
the White Hand ends the run **12 seconds later** (`WHITE_HAND_TICKS = 12 * TICKS_PER_SECOND`). Twelve
seconds leaves no room for "one more every minute", and not enough to kill a 900hp boss. Three
decisions are needed, and they are yours because they set the difficulty of the game's ending:

- **How long between the Reaper arriving and the White Hand?** One minute? Five? Until some number of
  Reapers are dead?
- **Does killing Reapers delay or prevent the White Hand,** or is it purely a reward path?
- **What is a Golden Egg?** A permanent stat point spent between runs, or something else? This is a new
  save-level currency and needs a cap, or it becomes the off switch `stats.ts` warns about.

**2. In-run tutorial prompts — built, not missing.** `guide/` is 822 lines with a 997-line test suite,
prompt lanes, hold timings, phases and a first-run offer, and it is wired into the run screen. If
anything is left here it is art polish, not implementation.

### Engineering — known, small, tracked

| Item | State |
|---|---|
| Replay revalidation is over its time budget — 7.76s against a 5s gate | Open. Decide: optimise, or re-baseline with a written reason. |
| Cross-runtime replay proof (record on phone, revalidate on server, hashes match) | Open. **Must exist before anti-cheat rejects anybody.** |
| `test:web` cannot run without a database (client is built at import time) | Open |
| `hashState` walks pool slots in allocation order, not a canonical one | Open — a desync report currently means "real divergence *or* slot-order divergence" |
| Dropped ticks are invisible to the player (the game runs in slow motion, not stalled) | Open — surface it in the dev HUD |
| Platform coupling in `packages/web` / `packages/desktop` | **Done.** No vendor packages, no injected badge, no analytics script. |

### Then

**Polish. Sound and music. Ads and cosmetics. Legal review. Store listings.**

---

## THE ONLY THINGS THAT NEED *YOU*

1. **Look at the menus and say yes or no.** Nothing outside a run ships without your approval.
2. **Start both test tracks with real testers.** Google requires 12 real people opted in for 14
   consecutive days before you may release. That clock only starts when you start it. Recruit 18–20
   so a few dropping out doesn't reset you. TestFlight runs alongside it.
3. **Run the bench on a cheap Android** for 15 warm minutes, and the iPhone one to 15 too.

---

## LOCKED DECISIONS

Settled. Not reopening without a reason written down here.

- Mobile first. **Google Play first, Apple about a month later.**
- Free to play. Rewarded ads and cosmetics only. **No paying for power.**
- Original art, original font. Nothing traced, nothing borrowed.
- Same genre rules as the game that inspired it, different names for everything.
- **Host-runs-the-game co-op. No voice chat, ever.**
- Difficulty never quietly adjusts to how well you are doing.
- Leaderboards never grant power.
- Launch small on content, never on systems: **cut a stage before cutting a feature.**
- Every run is recorded and replayable — that is also how cheating is caught.
- **The game must run on a $100 phone.**
- **No third-party telemetry.** The save carries `telemetryOptIn` and it defaults to off. Anything
  that reports regardless of that flag does not ship.
- **No dependency on one company's hosting to run or test the game.** Four ways in, listed above.

---

## HOW TO CHECK THE PROJECT IS HEALTHY

```sh
bun run lint          # conventions + oxlint. Clean.
bun run typecheck     # all packages. Clean.
bun run test:game     # 37 headless engine suites
bun run test:e2e      # the whole co-op stack over a real socket, starts its own relay
bun run test:soak     # 20 minutes of simulated quad-storm, headless
bun run build:web     # the API + web frontend
```

**Vite is declared once, at the repo root.** It used to be declared separately by `packages/web` and
`packages/desktop`, which gave TypeScript two distinct copies of every Vite type and made a plugin
from one package unassignable to the config of the other. If `typecheck` ever starts failing with
`Plugin<any> is not assignable to PluginOption`, someone has re-added it to a package.

`test:game` has **one** known failure — the revalidation budget in the table above. Anything else
failing is new and is a regression.

The engine also lints itself: `dev/lint.ts` reads all 165 engine files and rejects `Math.random`
anywhere, and unspecified maths (`sin`, `cos`, `pow`, `hypot`, and 13 more) anywhere its result gets
hashed. That rule exists because the fixed-point layer was written, documented, tested — and then
not used by the simulation for months, because nothing checked.

---

## HISTORY

- `docs/archive/plan-detail.md` — the original long-form plan. Kept for its arguments and numbers.
  Its testing and delivery sections are obsolete: they assume the hosting platform that has gone away.
- `docs/archive/features-review.md` — the 200-item feature backlog, sorted.
- `task.md` — the running diary, newest at the bottom. Still the place to append what changed today.
- `design.md` — palette, fonts, spacing, motion rules, screen list.
- `audit-handoff.md` — a full engineering audit with every finding and its evidence.
