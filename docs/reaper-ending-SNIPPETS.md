# Apply snippets (until full files land)

## enemies.ts — append at END of `ENEMY_TYPES` (after graveTyrant)

```ts
  {
    id: "nightreaper",
    kind: ENEMY_KIND.boss,
    sprite: "enemy.gravewarden",
    health: 900,
    damage: 9999,
    speed: 36,
    radius: 18,
    xp: 0,
    goldChance: 0,
    flags: ENEMY_FLAG.heavy | ENEMY_FLAG.boss | ENEMY_FLAG.persistent,
  },
```

## roster.ts — add to CHAR_UNLOCK and append character

```ts
  REAPER_KILL: 4,
```

```ts
  {
    id: "mord",
    name: "Mord Vane",
    title: "The Crimson Toll",
    blurb: "What the White Hand could not keep. Hits harder the longer the night runs.",
    startingWeaponId: "reapersLash",
    shifts: [
      { stat: STAT.damage, add: 20 * PCT },
      { stat: STAT.moveSpeed, add: 10 * PCT },
      { stat: STAT.maxHealth, add: -25 * HP },
    ],
    growth: {
      stat: STAT.damage,
      everyLevels: 4,
      add: 5 * PCT,
      maxTiers: 10,
      blurb: "+5% damage every 4 levels, up to ten times.",
    },
    unlock: CHAR_UNLOCK.REAPER_KILL,
    unlockValue: 1,
  },
```

Also wire `isCharacterUnlocked` / `unlockHint` / `earnedLine` / `characterConditionMet` for `REAPER_KILL` (bit-only; see awards.ts).

Full `run.ts` and other files: see `docs/reaper-ending-REMAINING.md` and agent workspace `nightreap-work/out/`.
