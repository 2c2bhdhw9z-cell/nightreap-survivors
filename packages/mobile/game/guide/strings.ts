/**
 * Guide strings — the first string table in the project.
 *
 * WHY THIS EXISTS BEFORE THERE IS ANY LOCALISATION
 * The guided run is the first feature whose entire output is words. If those words are written as
 * literals inside the logic, then the Phase 3 string table lands on top of a feature that has to be
 * rewritten to join it. So the guide is built the other way round: every line it can ever show is an
 * id in this table from its first day, and the logic never contains a sentence.
 *
 * THE RULES, SAME SHAPE AS CUES, STATS AND CONTENT IDS
 * 1. Ids are numbers, added at the bottom, and NEVER renumbered or reused. A settings profile, a bug
 *    report or a saved dev-menu filter can hold an id, so a renumber silently changes meaning.
 * 2. Every id has exactly one English line. A missing line is a build error, not an empty label.
 * 3. Nothing in `game/` may show text that is not an id in a table like this one.
 *
 * PSEUDO-LOCALISATION
 * `pseudo()` is the cheap version of translating the game, and it exists now rather than later because
 * it answers a layout question that is expensive to answer after the fact: does the panel still work
 * when every line is forty percent longer? German and Finnish routinely are. The transform keeps the
 * text readable — an English speaker can still test the game with it switched on — while making a
 * layout that only fits English fail immediately and visibly.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No plurals, no gendered forms, no number formatting, no interpolation. The guide's lines are whole
 * sentences with no values in them, which is a deliberate constraint on the writing rather than a
 * limitation of the table: a sentence assembled from fragments is the single most common way a game
 * becomes untranslatable, so the guide never assembles one.
 */

/**
 * Every line the guided run and the reference page can show.
 *
 * Append-only. New lines go at the bottom with the next free number.
 */
export const STR = {
  /* ---- the first-launch offer ---------------------------------------------------------------- */
  offerTitle: 0,
  offerBodyOne: 1,
  offerBodyTwo: 2,
  offerYes: 3,
  offerNo: 4,
  offerFootnote: 5,

  /* ---- Settings entry points ---------------------------------------------------------------- */
  howToPlayTitle: 6,
  startGuidedRun: 7,
  whatThingsMean: 8,
  guidedRunArmed: 9,
  guidedRunDisarmed: 10,

  /* ---- in-run prompts ---------------------------------------------------------------------- */
  promptMove: 11,
  promptAttacks: 12,
  promptGems: 13,
  promptMagnet: 14,
  promptLevelUp: 15,
  promptPicksQueue: 16,
  promptBanish: 17,
  promptHealth: 18,
  promptLowHealth: 19,
  promptGold: 20,
  promptChest: 21,
  promptSlotsFull: 22,
  promptMaxed: 23,
  promptBoss: 24,
  promptReaper: 25,
  promptTeammateDown: 26,
  promptTeammateUp: 27,
  promptPause: 28,
  promptSkip: 29,

  /* ---- the reference page ------------------------------------------------------------------ */
  refGemsTitle: 30,
  refGemsBody: 31,
  refMagnetTitle: 32,
  refMagnetBody: 33,
  refCardsTitle: 34,
  refCardsBody: 35,
  refArcanaTitle: 36,
  refArcanaBody: 37,
  refEvolveTitle: 38,
  refEvolveBody: 39,
  refDownedTitle: 40,
  refDownedBody: 41,
  refReaperTitle: 42,
  refReaperBody: 43,
} as const;

export type StringId = (typeof STR)[keyof typeof STR];

/**
 * The English lines, indexed by id.
 *
 * Written to be read at a glance in the middle of a fight: one idea per line, no line longer than can
 * be taken in without stopping moving. The prompts are instructions; the reference lines are
 * explanations, and are allowed to be a little longer because nothing is attacking while they are read.
 */
export const EN: readonly string[] = [
  /* 0 */ "FIRST TIME HERE?",
  /* 1 */ "I CAN WALK YOU THROUGH YOUR FIRST RUN.",
  /* 2 */ "IT CHANGES NOTHING ABOUT HOW THE RUN PLAYS.",
  /* 3 */ "SHOW ME HOW",
  /* 4 */ "I'VE GOT IT",
  /* 5 */ "SETTINGS > HOW TO PLAY, ANY TIME",
  /* 6 */ "HOW TO PLAY",
  /* 7 */ "START A GUIDED RUN",
  /* 8 */ "WHAT THINGS MEAN",
  /* 9 */ "PROMPTS ARE ON FOR YOUR NEXT RUN",
  /* 10 */ "PROMPTS ARE OFF",
  /* 11 */ "TOUCH ANYWHERE TO MOVE",
  /* 12 */ "YOUR WEAPONS FIRE THEMSELVES",
  /* 13 */ "GEMS LEVEL YOU UP. GO AND GET THEM",
  /* 14 */ "GEMS COME TO YOU FROM THIS FAR OUT",
  /* 15 */ "PICK ONE. THE OTHERS ARE GONE",
  /* 16 */ "MORE PICKS ARE WAITING. THEY NEVER INTERRUPT",
  /* 17 */ "BANISH SOMETHING YOU NEVER WANT TO SEE AGAIN",
  /* 18 */ "THAT'S YOUR HEALTH. NOTHING REFILLS IT ON ITS OWN",
  /* 19 */ "YOU ARE ABOUT TO DIE. GET OUT",
  /* 20 */ "GOLD IS KEPT AFTER THE RUN",
  /* 21 */ "CHESTS CAN EVOLVE A MAXED WEAPON",
  /* 22 */ "SLOTS ARE FULL. NEW PICKS ONLY LEVEL WHAT YOU HAVE",
  /* 23 */ "THAT ONE IS MAXED. A CHEST CAN CHANGE IT NOW",
  /* 24 */ "THIS ONE DOES NOT DIE QUICKLY. KEEP MOVING",
  /* 25 */ "THE REAPER IS COMING. IT IS NOT A NORMAL ENEMY",
  /* 26 */ "SOMEONE IS DOWN. STAND NEXT TO THEM",
  /* 27 */ "THEY'RE UP. STAY CLOSER THAN THAT",
  /* 28 */ "PAUSE IS HERE IF YOU NEED IT",
  /* 29 */ "TAP A PROMPT TO TURN THEM ALL OFF",
  /* 30 */ "XP GEMS",
  /* 31 */ "DROPPED BY ENEMIES. THEY LEVEL YOU UP.",
  /* 32 */ "PICKUP RANGE",
  /* 33 */ "HOW FAR GEMS COME TO YOU. NOT HOW FAST.",
  /* 34 */ "LEVEL UP",
  /* 35 */ "PICK ONE OF FOUR. THEY QUEUE, NEVER INTERRUPT.",
  /* 36 */ "ARCANA",
  /* 37 */ "A RULE CHANGE FOR THE WHOLE RUN.",
  /* 38 */ "EVOLUTION",
  /* 39 */ "A MAXED WEAPON PLUS THE RIGHT ITEM BECOMES SOMETHING ELSE.",
  /* 40 */ "DOWNED",
  /* 41 */ "A TEAMMATE CAN STAND YOU BACK UP. STAY CLOSE.",
  /* 42 */ "THE REAPER",
  /* 43 */ "ARRIVES AT THE CLOCK'S END. IT IS NOT A NORMAL ENEMY.",
];

export const STRING_COUNT = EN.length;

if (Object.keys(STR).length !== STRING_COUNT) {
  throw new Error("STR and EN are out of step — every string id needs exactly one English line");
}

for (let i = 0; i < EN.length; i++) {
  const line = EN[i] ?? "";
  if (line.length === 0) throw new Error(`string id ${i} has no text`);
}

/** Look a line up. An id this build has never heard of gives a visible marker, never an empty label. */
export function text(id: number, table: readonly string[] = EN): string {
  if (!Number.isInteger(id) || id < 0 || id >= table.length) return `?${id}?`;
  return table[id] ?? `?${id}?`;
}

/**
 * How much longer a translation is allowed to be before we call the layout broken.
 *
 * 1.4 is the number the industry uses for European languages against an English source, and it is the
 * number the panels are sized against.
 */
export const PSEUDO_GROWTH = 1.4;

const ACCENTS: Readonly<Record<string, string>> = {
  A: "Å",
  E: "Ë",
  I: "Ï",
  O: "Ø",
  U: "Ü",
  N: "Ñ",
  C: "Ç",
  S: "Š",
  Y: "Ý",
};

/**
 * Pseudo-localise one line: accent the vowels so unlocalised text stands out, then pad to the growth
 * factor so a layout that only fits English fails now rather than on a translator's first delivery.
 *
 * The padding is added as a bracketed tail rather than as spaces, so a line that is being clipped is
 * obviously being clipped instead of just looking oddly spaced.
 */
export function pseudo(line: string): string {
  let out = "";
  for (const ch of line) out += ACCENTS[ch] ?? ch;
  const target = Math.ceil(line.length * PSEUDO_GROWTH);
  if (out.length >= target) return out;
  let pad = "";
  while (out.length + pad.length + 2 < target) pad += "·";
  return `${out}[${pad}]`;
}

/** A whole pseudo-localised table, for the dev menu's language switch. */
export function pseudoTable(table: readonly string[] = EN): readonly string[] {
  return table.map(pseudo);
}

/* ---- the reference page ------------------------------------------------------------------------- */

/**
 * The icon each reference row shows.
 *
 * Numbers rather than file names because these become atlas cells in Phase 4 and nothing outside the
 * atlas should ever name an image. `evolve` is deliberately not crossed weapons — no held weapon
 * appears in our art anywhere — it is two item sockets and a star.
 */
export const REF_ICON = {
  gem: 0,
  magnet: 1,
  cards: 2,
  arcana: 3,
  evolve: 4,
  downed: 5,
  reaper: 6,
} as const;

export interface ReferenceRow {
  readonly icon: number;
  readonly title: number;
  readonly body: number;
  /** True when the row is only meaningful with other players in the run. */
  readonly coopOnly: boolean;
}

/**
 * The reference page, in order.
 *
 * Ordered by when a new player meets the thing, not by importance — the page is read top to bottom by
 * someone who has just been confused by something near the start of a run.
 */
export const REFERENCE_ROWS: readonly ReferenceRow[] = [
  { icon: REF_ICON.gem, title: STR.refGemsTitle, body: STR.refGemsBody, coopOnly: false },
  { icon: REF_ICON.magnet, title: STR.refMagnetTitle, body: STR.refMagnetBody, coopOnly: false },
  { icon: REF_ICON.cards, title: STR.refCardsTitle, body: STR.refCardsBody, coopOnly: false },
  { icon: REF_ICON.arcana, title: STR.refArcanaTitle, body: STR.refArcanaBody, coopOnly: false },
  { icon: REF_ICON.evolve, title: STR.refEvolveTitle, body: STR.refEvolveBody, coopOnly: false },
  { icon: REF_ICON.downed, title: STR.refDownedTitle, body: STR.refDownedBody, coopOnly: true },
  { icon: REF_ICON.reaper, title: STR.refReaperTitle, body: STR.refReaperBody, coopOnly: false },
];

/** The rows worth showing to this player. Solo players are not taught about reviving. */
export function referenceRowsFor(playerCount: number): readonly ReferenceRow[] {
  if (playerCount > 1) return REFERENCE_ROWS;
  return REFERENCE_ROWS.filter((r) => !r.coopOnly);
}
