# Reaper ending — remaining to land on this branch

## Already on `feat/reaper-ending-vs`
- `packages/mobile/game/sim/eggs.ts`
- `packages/mobile/game/render/white-hand.ts`
- `packages/mobile/game/run/reaper.test.ts`
- `packages/mobile/game/render/camera.ts` (zoom)
- `packages/mobile/game/sim/waves.ts` (+1/min via `noteReaperSpawned`)
- `packages/mobile/game/sim/results.ts` (`eggsEarned` / `reaperKills` / `characterId`)
- `packages/mobile/game/save/handoff.ts` (bank eggs + grant unlock)
- `packages/mobile/game/unlocks/awards.ts` (`grantReaperKillUnlock`)
- `docs/reaper-ending-2026-09-12.md`

## Still need (MCP payload size blocked full push)
Complete implementations exist locally under the agent workspace `nightreap-work/out/`.

1. **`packages/mobile/game/run/run.ts`** — no WH on spawn; kill→eggs+WH; die→survived; `forceKillReapersForTest`; stamp summary
2. **`packages/mobile/game/sim/enemies.ts`** — append `nightreaper` (9999 dmg, gravewarden sprite) at **end** of `ENEMY_TYPES`
3. **`packages/mobile/game/characters/roster.ts`** — `CHAR_UNLOCK.REAPER_KILL` + Mord Vane
4. **`packages/mobile/game/save/snapshot.ts`** — egg wire resolve via `eggModifierFromWire`
5. Art allowlists: `art/run-art.ts`, `art/frames.ts` (+ tests)
6. **`packages/mobile/app/dev/play.tsx`** — WhiteHandPresenter + egg loadout + crimson veil
7. **`packages/mobile/game/run/run.test.ts`**, `characters/roster.test.ts`
8. Brief `plan.md` update; append diary to `task.md` (see also `docs/reaper-ending-2026-09-12.md`)

## Note
Cloud Agents unavailable (needs Pro). Large files (~20–70KB) could not all be uploaded through GitHub MCP in this session without truncating.
