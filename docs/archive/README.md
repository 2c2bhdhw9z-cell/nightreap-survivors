# Archive

These documents are kept for their reasoning, not as instructions. **`plan.md` at the repo root is
the plan of record.**

## Why they were moved

Both were written around a hosting platform this project was scaffolded on, and their delivery and
testing strategies assume it is still there. It is not — the preview host now returns 502. Specific
examples from `plan-detail.md`:

- *"Stack: Runable managed template via `app_init`"*
- *"Path 1 — In the Runable app (every phase, zero setup)"*
- *"you play it in the Runable app from Phase 0 on"*
- *"Runable web preview | Fast iteration, playable in the Runable app."*

Following that plan today means waiting on a service that cannot answer. The new `plan.md` lists four
independent ways to run the game, none of which depend on one company staying online.

## What is still worth reading here

- **`plan-detail.md`** — the long-form original: the arguments, the numbers, the gates, the market
  research, the anti-cheat threat model, the reasoning on why obfuscation is not worth an hour. All of
  that survives the platform going away. Ignore the sections on delivery, testing paths and stack
  setup.
- **`features-review.md`** — a 200-item feature backlog, sorted into ten sections with five forks at
  the end. Nothing platform-specific; it is a menu of things the game could become. Still useful.

Nothing was deleted.
