/**
 * White Hand presentation — the screen reading of the ending the simulation already announces.
 *
 * WHY THIS IS SEPARATE FROM THE SIM
 * `CUE.reaperArrived` and `CUE.bellTolled` already fire. Nothing used to consume them, so the ending
 * was "the Reaper appears and twelve seconds later the run silently stops". This module is the missing
 * consumer: it turns those cues into a redden, a camera push, and a toll pulse. It never writes back
 * into the simulation — same rule as the HUD and the guide.
 *
 * Audio is out of scope. The toll index is kept so a future sound layer can hang off the same state.
 */

import { CUE, type CueBus } from "../sim/cues";

/** How hard the camera pushes in at full White Hand, as a zoom multiplier above 1. */
export const WHITE_HAND_ZOOM = 1.28;

/** Peak crimson overlay alpha (0..1) at the final toll. */
export const WHITE_HAND_RED_PEAK = 0.55;

/** How many ticks a toll flash takes to fade. */
export const TOLL_FLASH_TICKS = 20;

export interface WhiteHandView {
  /** 0..1 crimson overlay. */
  redden: number;
  /** Camera zoom multiplier (>= 1). */
  zoom: number;
  /** 0..1 toll flash pulse, for a brief brighten on each bell. */
  tollFlash: number;
  /** Last toll index seen (1..12), or 0. */
  lastToll: number;
  /** True once the Reaper has arrived or the White Hand countdown has begun. */
  active: boolean;
}

/**
 * Display-only state machine driven by cues and the run's `whiteHandTicks`.
 *
 * Constructed once per screen. `observe` runs on the sim tick (cues live one tick); `paint` runs every
 * frame so the flash can decay smoothly between tolls.
 */
export class WhiteHandPresenter {
  readonly view: WhiteHandView = {
    redden: 0,
    zoom: 1,
    tollFlash: 0,
    lastToll: 0,
    active: false,
  };

  private arrived = false;
  private tollFlashTicks = 0;
  private whiteHandTotal = 0;
  private whiteHandLeft = -1;

  /** Call once when a run begins so a previous ending cannot leak. */
  reset(): void {
    this.arrived = false;
    this.tollFlashTicks = 0;
    this.whiteHandTotal = 0;
    this.whiteHandLeft = -1;
    this.view.redden = 0;
    this.view.zoom = 1;
    this.view.tollFlash = 0;
    this.view.lastToll = 0;
    this.view.active = false;
  }

  /**
   * Read this tick's cues and the live White Hand countdown.
   *
   * `whiteHandTicks` is -1 before the Hand starts, then counts down from `whiteHandTotal`.
   */
  observe(cues: CueBus, whiteHandTicks: number, whiteHandTotal: number): void {
    if (cues.indexOf(CUE.reaperArrived) >= 0) this.arrived = true;

    const tollAt = cues.indexOf(CUE.bellTolled);
    if (tollAt >= 0) {
      const toll = Math.trunc(cues.value[tollAt] as number);
      this.view.lastToll = toll > 0 ? toll : this.view.lastToll;
      this.tollFlashTicks = TOLL_FLASH_TICKS;
      this.arrived = true;
    }

    this.whiteHandTotal = whiteHandTotal > 0 ? whiteHandTotal : this.whiteHandTotal;
    this.whiteHandLeft = whiteHandTicks;
    if (whiteHandTicks >= 0) this.arrived = true;
  }

  /** Advance display decay one frame-equivalent tick and refresh the view numbers. */
  paint(): void {
    if (this.tollFlashTicks > 0) this.tollFlashTicks--;

    const v = this.view;
    v.active = this.arrived;
    if (!this.arrived) {
      v.redden = 0;
      v.zoom = 1;
      v.tollFlash = 0;
      return;
    }

    // Progress through the Hand: 0 at start of countdown, 1 at the end. Before the Hand starts
    // (Reaper is out but not yet killed) we hold a mild redden so the arrival still reads.
    let progress = 0.15;
    if (this.whiteHandLeft >= 0 && this.whiteHandTotal > 0) {
      progress = 1 - this.whiteHandLeft / this.whiteHandTotal;
      if (progress < 0) progress = 0;
      if (progress > 1) progress = 1;
    }

    v.redden = progress * WHITE_HAND_RED_PEAK;
    v.zoom = 1 + (WHITE_HAND_ZOOM - 1) * progress;
    v.tollFlash = this.tollFlashTicks > 0 ? this.tollFlashTicks / TOLL_FLASH_TICKS : 0;
  }
}
