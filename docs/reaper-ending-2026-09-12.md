## 2026-09-12 — Reaper ending (VS-shaped)

Finished the Reaper / White Hand close so it matches genre rules and this repo's docs:

- Reaper still arrives at per-stage `reaperSecond` (~30:00); not globally shortened to 15:00.
- After the first Reaper, `noteReaperSpawned` schedules +1 every 60s (no forever-latch on `reaperSpawned`).
- Spawn no longer starts the silent 12s White Hand; dying in the Reaper phase ends as `RUN_END.survived`.
- Killing a Reaper drops 5 Golden Eggs, unlocks Mord Vane on first kill, then starts the real White Hand.
- `WhiteHandPresenter` consumes redden / zoom / twelve-toll cues; eggs are hard-capped (max 100) with a diminishing permille curve so Int32 stats cannot wrap.
- Tests: `packages/mobile/game/run/reaper.test.ts`.

Branch: `feat/reaper-ending-vs`.
