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
