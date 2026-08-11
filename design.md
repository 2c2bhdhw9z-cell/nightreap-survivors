# Nightreap Survivors — Design

A mobile-first bullet-heaven survivors roguelite with 1–4 player online co-op. Ships on iOS and
Android (web build exists for preview and desktop port). Visual direction: **dark gothic pixel art** —
candlelit stone, bone, tarnished brass, and blood, rendered at a strict low resolution and scaled by
whole integers only. The core job: hand the player a 30-minute run that starts fragile and ends as an
absurd screen-filling storm of their own construction, and let them bring up to three friends.

**This file is the single source of truth for palette, typography, and UI language.** Read it before
writing any UI code. The in-run HUD is drawn by the GL engine and the out-of-run menus are React
Native — but they must look like the same game, so both read the tokens below.

---

## The two UI worlds

| | In-run | Out-of-run |
|---|---|---|
| Screens | HUD, level-up card draw, damage numbers, boss bar, pause, 4× co-op HUD, White Hand | Title, character/stage select, PowerUps shop, collection, achievements, settings, co-op lobby, leaderboards, replays, dev menu |
| Tech | GL engine-drawn, pixel-exact, inside `<GLView>` | React Native components + "fidelity kit" |
| Why | Must not cost a frame at 800 enemies, must align to the pixel grid | Needs scrolling, text input, accessibility, platform behaviour |

The fidelity kit is what stops the RN side from looking like a web app bolted to a pixel game:
bitmap font glyphs sampled from our own atlas, 9-slice panel frames from the same atlas,
**integer-only scaling**, no anti-aliasing, no rounded corners, no shadows, no gradients that aren't
dithered.

---

## Brand & Colors

A deliberately tight palette. Every sprite, every panel, every glyph comes from this list — that is
what makes generated art from 20+ sheets look like one game. Colour is **information first**: gold is
always currency, crimson is always damage or danger, cold cyan is always XP and level-up.

### Core ramp (stone, bone, ink)

| Token | Hex | Use |
|---|---|---|
| `ink` | `#0B0A10` | Deepest background, letterboxing, dead space |
| `crypt` | `#141320` | Screen background, stage floor base |
| `stone` | `#232132` | Panel fill, unlit props |
| `stoneLit` | `#3A3550` | Panel highlight edge, lit stone |
| `ash` | `#6B6480` | Disabled text, hairlines, inactive icons |
| `bone` | `#C8BFA6` | Body text, sprite highlights |
| `boneLit` | `#EFE6CE` | Primary text, brightest highlight |

### Accents (each one means exactly one thing)

| Token | Hex | Meaning — never used for anything else |
|---|---|---|
| `gold` | `#E0A62B` | Gold, coins, chests, currency, prices |
| `goldLit` | `#F7D774` | Gold highlight, treasure shine |
| `crimson` | `#B02033` | Player damage taken, danger, Reaper, destructive actions |
| `crimsonLit` | `#E8455A` | Health bar fill, critical warnings |
| `cyan` | `#3FB8C4` | XP gems, XP bar, level-up, gained levels |
| `cyanLit` | `#7BE8EE` | Level-up flash, card-draw glow |
| `violet` | `#7A4FA8` | Arcana, curses, magic, evolution |
| `violetLit` | `#B27FE0` | Evolution flash, arcana card frames |
| `venom` | `#5C9E45` | Healing, chicken, buffs, success |
| `rust` | `#8A4B2A` | Wood, leather, prop shadow |

### Co-op player identity

Four palette swaps applied in-shader to the same sprite, chosen to stay distinct for the most common
colourblind types (never red-vs-green as the only difference):

| Player | Hex | Also shown as |
|---|---|---|
| P1 | `#E8455A` crimsonLit | ● one pip |
| P2 | `#7BE8EE` cyanLit | ●● two pips |
| P3 | `#F7D774` goldLit | ●●● three pips |
| P4 | `#B27FE0` violetLit | ●●●● four pips |

Player identity is **always** carried by both colour and pip count, so it survives a colourblind
palette and a greyscale screenshot.

### Mobile token mapping

`packages/mobile/constants/theme.ts` maps these to the template's token names. The game is
dark-only — `Colors.light` and `Colors.dark` hold the **same** values so the app never changes
appearance with the system setting (a light-mode gothic pixel game is not a thing), and
`app.json` keeps `userInterfaceStyle: "automatic"` untouched.

| Template token | Value |
|---|---|
| `background` | `crypt` `#141320` |
| `foreground` | `boneLit` `#EFE6CE` |
| `card` | `stone` `#232132` |
| `cardForeground` | `bone` `#C8BFA6` |
| `primary` | `gold` `#E0A62B` |
| `primaryForeground` | `ink` `#0B0A10` |
| `secondary` | `stoneLit` `#3A3550` |
| `muted` | `stone` `#232132` |
| `mutedForeground` | `ash` `#6B6480` |
| `accent` | `violet` `#7A4FA8` |
| `border` | `stoneLit` `#3A3550` |
| `destructive` | `crimson` `#B02033` |
| `success` | `venom` `#5C9E45` |
| `warning` | `gold` `#E0A62B` |

---

## Typography

**No licensed font file ever ships.** Many pixel fonts forbid game embedding, and it is a real legal
landmine for a small studio. So we draw our own glyphs into the sprite atlas and render text from
them. That also guarantees in-run and out-of-run text are pixel-identical, because they are literally
the same pixels.

- **`NightreapGlyph`** — our bitmap face, drawn as atlas cells. Two sizes only:
  - **6×8 small** — HUD numbers, item levels, tooltips, dev menu
  - **10×12 display** — titles, headers, card names, big numbers
- Character set: A–Z (uppercase only — cheaper, and correct for the genre), 0–9, and
  `. , : ; ! ? ' " ( ) [ ] + - × ÷ % / \ < > = @ # & * ° ▲ ▼ ◄ ► ● ○ ✕ ✓ ♥ ⚡ ☠`
- **Integer scaling only.** Text renders at 1×, 2×, 3×, 4× — never 1.5×, never a fractional device
  pixel ratio. Sub-pixel text in a pixel game reads as a bug.
- Fallback: until the atlas exists (early Phase 0), RN screens use the platform monospace face so
  layout can be built. Every such use is marked `// FIDELITY: replace with NightreapGlyph`, and CI
  greps for that marker so none survive to launch.

---

## Layout language

- **Base grid: 8px** at 1× logical scale. Every panel edge, gap, and inset is a multiple of 8. Icons
  are 16×16 or 32×32. Nothing lands on an odd pixel.
- **9-slice panels.** One frame style in three weights: `frameHeavy` (modal dialogs), `frameLight`
  (list rows, inventory cells), `frameInset` (recessed wells — bars, text fields). Corners are
  4×4 atlas cells, edges tile.
- **No rounded corners, no drop shadows, no blur.** Depth comes from a 1px `stoneLit` top/left
  highlight and a 1px `ink` bottom/right shadow. That is the entire lighting model.
- **Thumb-first.** Bottom 40% of the screen is reachable one-handed; every primary action lives
  there. Nothing tappable within 44px of the top edge on a run screen.
- **Floating joystick**, position and size adjustable (accessibility requirement, also just correct).
  Left half by default, appears where the thumb lands rather than at a fixed spot.
- **Safe areas respected everywhere** — `SafeAreaView` with `edges={["top","left","right"]}`, and the
  GL canvas gets explicit inset padding so the HUD never sits under a notch or a home indicator.

---

## Motion

- **Sim is 60Hz fixed; rendering interpolates** to the display rate (up to 120Hz where available).
- UI motion is **snappy and stepped**, not eased and floaty: 4–8 frame transitions, discrete steps,
  no spring physics. A card draw slams in; it does not bounce.
- All `Animated` calls use `useNativeDriver: false` (the dashboard preview has no native driver).
- Every screen-shake, flash, and damage-number effect is individually toggleable in settings — both
  an accessibility need and a free performance win on the REVVL.

---

## Screens

### In-run (GL-drawn)
- **HUD** — top: XP bar + level, run timer, kill count, gold. Left: health bar. Bottom-left: weapon +
  passive slot rows with level pips. Bottom: joystick. Co-op adds three compact ally strips.
- **Level-up card draw** — 3–4 cards, reroll / skip / banish, batch counter when multiple levels queue.
- **Pause** — resume, settings, abandon; shows the full current build.
- **Results** — survived time, kills, gold, DPS-by-weapon breakdown, unlocks earned.
- **White Hand** — the 30:00 finish: screen reddens, camera zooms, twelve bell tolls, unkillable end.

### Out-of-run (React Native)
- **Title** (`app/index.tsx`) — logo, Play, Co-op, Collection, Shop, Settings.
- **Character select** (`app/select/character.tsx`) — grid, stats, starting weapon, locked silhouettes.
- **Stage select** (`app/select/stage.tsx`) — stage art, hazards, boss timeline, modifier toggles.
- **PowerUps shop** (`app/shop.tsx`) — 24+ upgrades, escalating costs, gold counter, refund-all.
- **Collection** (`app/collection.tsx`) — weapons, evolutions, enemies, arcanas; found vs unfound.
- **Achievements** (`app/achievements.tsx`) — 150+ eventually, grouped, with unlock hints.
- **Co-op lobby** (`app/coop/*.tsx`) — room code, public queue by party size, ready states, 1–4 slots.
- **Leaderboards** (`app/leaderboards.tsx`) — daily, weekly, per-stage; validated runs only.
- **Settings** (`app/settings.tsx`) — audio, accessibility, joystick, VFX, privacy, data.
- **Dev menu** (`app/dev/*.tsx`) — panel registry; every panel tagged `self` or `system`.

---

## Non-negotiables

1. **Mock-first.** Any new visual surface is generated as a static mock image and approved before a
   line of screen code is written. Rebuilding a mock costs minutes; rebuilding a screen costs a day.
2. **Integer scaling, always.** If something looks slightly soft, it is wrong.
3. **One atlas.** Sprites, 9-slice frames, and font glyphs share a single power-of-two texture.
4. **Colour carries meaning** — gold=currency, crimson=danger, cyan=XP, violet=arcana. No exceptions
   for aesthetics.
5. **Accessible by default** — colourblind-safe palettes, toggles for flash/shake/damage numbers,
   scalable HUD text, adjustable joystick, reduced-VFX mode.
6. **Our own art, our own glyphs, our own audio.** Nothing licensed, nothing traced.

---

## Architecture note

The game engine lives in `packages/mobile/game/` and imports **zero** React Native modules. It is
plain TypeScript: simulation, rendering, and netcode talk to the host through a thin adapter. That is
what lets the same engine run headless in CI (replay validation, soak tests) and later power a web or
desktop build by swapping the shell. UI code may import from `game/`; `game/` may never import UI.
