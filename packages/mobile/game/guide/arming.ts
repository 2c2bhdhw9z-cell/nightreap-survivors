/**
 * Arming the guided run.
 *
 * Three rules, and they are the whole file:
 *
 *  1. The offer is made once, at the first launch, and never again. Not once per version, not once per
 *     character, not "again after a week off". A game that keeps asking whether you want the tutorial is
 *     telling you it does not trust you, and the second ask is the one people resent.
 *
 *  2. Neither answer is permanent. "Show me how" arms the prompts for the next run. "I've got it" does
 *     not, and does not lock anything away either — Settings -> How to play is there forever, for the
 *     player who said no in week one and wants the reminder in week three, and for the friend who picked
 *     the phone up after them.
 *
 *  3. Arming is a *choice about prompts*, never a mode. Nothing here reaches the simulation. Turning the
 *     guide on does not change a spawn, a stat or a seed, so a guided run is a real run and stays legal
 *     on every leaderboard. That property is pinned by test in `guide.test.ts`, not merely asserted here.
 *
 * The two facts live in the save's settings block: `guideOffered` (has the one-time question happened)
 * and `guideArmed` (are prompts on). They are deliberately separate. One boolean cannot tell "asked and
 * declined" apart from "never asked", and those two states must behave differently — the first must stay
 * quiet, the second must speak up.
 *
 * Why the offer is not simply "runsStarted === 0": a player who force-quits during the very first run
 * would be asked twice. The moment the question is put on screen we write down that it happened, and the
 * answer is written separately. Asking is an event; the answer is a preference.
 */

import type { SaveData, SaveSettings } from "../save/schema";

/** The two answers to the one-time offer. Values are for readability only; nothing persists them. */
export const OFFER_ANSWER = {
  SHOW_ME: 1,
  GOT_IT: 2,
} as const;

export type OfferAnswer = (typeof OFFER_ANSWER)[keyof typeof OFFER_ANSWER];

/**
 * True when the first-launch offer should be shown. Exactly one condition: it has never been shown.
 *
 * Note what is *not* here. No build check, no "re-offer after an update", no run count. The moment any of
 * those appear, the offer stops being a one-time offer and becomes a recurring interruption.
 */
export function shouldOfferGuide(save: SaveData): boolean {
  return !save.settings.guideOffered;
}

/**
 * Records that the offer was put on screen. Called when the dialog *appears*, before the player touches
 * anything, so a crash or a force-quit at that exact moment still costs the question rather than repeating
 * it. The caller is expected to save soon after; if it does not, the worst case is the offer appearing once
 * more, which is the failure we can live with.
 */
export function markGuideOffered(save: SaveData): void {
  save.settings.guideOffered = true;
}

/**
 * Applies the player's answer. Also marks the offer as made, so a caller that forgot `markGuideOffered`
 * still cannot end up asking twice — the two calls are idempotent and safe in either order.
 *
 * "Show me how" arms. "I've got it" leaves the guide off; it does not record a refusal anywhere, because
 * there is nothing a refusal would ever be used for.
 */
export function recordOfferAnswer(save: SaveData, answer: OfferAnswer): void {
  save.settings.guideOffered = true;
  save.settings.guideArmed = answer === OFFER_ANSWER.SHOW_ME;
}

/** Settings -> How to play -> Start a guided run. Available forever, whatever was answered at launch. */
export function armGuide(save: SaveData): void {
  save.settings.guideArmed = true;
}

/**
 * Turns prompts off. Two callers: the Settings switch, and the one-tap skip inside a run. Both write the
 * same fact, which is why skipping mid-run is permanent for that run *and* the next one until the player
 * asks again — a player who taps "skip" is telling us they do not want this, and asking them the same
 * question at the start of the following run would be ignoring the answer.
 */
export function disarmGuide(save: SaveData): void {
  save.settings.guideArmed = false;
}

/**
 * Whether a run starting right now should arm prompts. A separate function from reading the flag because
 * the run start is the only place allowed to care, and because co-op needs the distinction: a guest's
 * armed guide is a fact about that guest's screen only, and no other player's prompts depend on it.
 */
export function guideArmedForRun(settings: SaveSettings): boolean {
  return settings.guideArmed;
}

/**
 * Whether the "What things mean" reference page should be reachable. Always. It is a page of definitions,
 * costs nothing to leave in, and the player most likely to need it is the one who declined the guide.
 * The function exists so the screen has something to ask instead of hardcoding `true`, and so that if we
 * ever do gate it the gate has one home.
 */
export function referenceAvailable(): boolean {
  return true;
}

/**
 * Summary for the Settings screen, so the page renders one object rather than reaching into the save.
 * `everOffered` is shown to nobody — it is here for the dev menu and for bug reports, where "was this
 * player ever offered the guide" is the first question worth asking about a confused new player.
 */
export interface GuideArmingView {
  armed: boolean;
  everOffered: boolean;
  offerPending: boolean;
}

export function armingView(save: SaveData, out?: GuideArmingView): GuideArmingView {
  const v: GuideArmingView = out ?? { armed: false, everOffered: false, offerPending: false };
  v.armed = save.settings.guideArmed;
  v.everOffered = save.settings.guideOffered;
  v.offerPending = !save.settings.guideOffered;
  return v;
}
