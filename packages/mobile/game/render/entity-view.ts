/**
 * EntityView — smooths the crowd's drawn motion, display only.
 *
 * THE PROBLEM
 * The player sprites interpolate: the simulation carries a `prevX/prevY` per player, so between two
 * ticks the renderer draws the body part-way from where it was to where it is, and at 120fps a 60Hz
 * walk reads as a glide instead of a strobe. Enemies do not carry that history — the crowd is 800
 * indices and every extra typed array is real memory and a real copy every tick, so the simulation
 * only keeps `x/y`. Drawn straight, an enemy therefore JUMPS from tick position to tick position.
 *
 * On the host that is a mild 60Hz stutter most eyes forgive. On a GUEST it is the whole feel of the
 * lag. A guest does not advance the world every frame; it applies whatever the host has confirmed
 * when `GuestSession.pump()` runs, which is often zero ticks on one frame and two or three on the
 * next. The local player hides this behind `LocalView` dead reckoning, and the camera hides its own
 * motion behind interpolation — so the one thing left reading as "laggy" is everything the guest does
 * NOT predict: the other players' authoritative catch-up and, above all, the enemies. They freeze for
 * a frame or two and then leap. That leap is what "co-op still feels laggy" is pointing at once the
 * local player is already smooth.
 *
 * THE FIX — INTERPOLATE THE CROWD ON THE SAME ALPHA CLOCK, DISPLAY ONLY
 * Keep, outside the simulation, the previous and current authoritative position of every live enemy.
 * Snapshot them once per applied tick (`sample`), exactly where the sim snapshots a player's
 * `prevX/prevY`, and read them back interpolated by the loop's `alpha` (`renderX/renderY`) — the same
 * 0..1 the camera, the batcher and `LocalView` already use. A burst of two applied ticks in one frame
 * now spreads across the frames that follow instead of teleporting, so the crowd glides on a guest the
 * way the player already does.
 *
 * WHY IT CANNOT DESYNC
 * Nothing here is read by the simulation. It holds no reference to a `Run` or a session, writes no
 * position, stat or input, and never reaches `hashState` or the wire. It is written by the presentation
 * layer and read by the presentation layer, precisely like `WalkTracker` and `LocalView` beside it. If
 * this file were deleted the game would still be correct, only steppier — which is the definition of a
 * safe display-only change.
 *
 * POOLED SLOTS AND THE RECYCLE TRAP
 * Enemies live in a fixed pool; a slot freed by a death is handed to the next spawn. If a fresh enemy
 * inherited the dead one's `prev`, it would glide across the map from a corpse's position on its first
 * frame. `WalkTracker` solved the identical problem by only recording — never crediting distance — on
 * the first sighting of an index. This does the same: a slot seen for the first time, or seen again
 * after it went empty, SNAPS (prev = cur) so there is nothing to glide from, and only interpolates once
 * it has two real consecutive samples. `seenTick` per slot detects the gap: a slot that was not sampled
 * on the immediately preceding call is treated as new.
 *
 * ZERO ALLOCATION
 * Four typed arrays plus a bookkeeping one, all sized once to the pool capacity. `new` inside `sample`
 * or a draw is a bug here as much as anywhere else in the crowd's code.
 */

export class EntityView {
  /** Position at the most recently sampled tick. */
  private readonly curX: Float32Array;
  private readonly curY: Float32Array;
  /** Position at the tick before that. The renderer interpolates cur from prev by alpha. */
  private readonly prevX: Float32Array;
  private readonly prevY: Float32Array;
  /**
   * The sample counter value at which each slot was last written. A slot whose stored counter is not
   * the previous counter was not alive last tick, so it is new (or recycled) and must snap.
   */
  private readonly seenAt: Int32Array;

  /** Monotonic count of `sample` calls. Cheap, wraps far past any real run length. */
  private counter = 0;

  constructor(capacity: number) {
    this.curX = new Float32Array(capacity);
    this.curY = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.seenAt = new Int32Array(capacity).fill(-1);
  }

  /**
   * Forget everything. Called when a run starts or restarts, so a new crowd does not glide out of the
   * last run's positions.
   */
  reset(): void {
    this.curX.fill(0);
    this.curY.fill(0);
    this.prevX.fill(0);
    this.prevY.fill(0);
    this.seenAt.fill(-1);
    this.counter = 0;
  }

  /**
   * Take one authoritative snapshot of the live crowd. Call once per applied simulation tick, after the
   * world has advanced, with the pool's live `slots`, its `count`, and the position arrays.
   *
   * A slot alive last call rolls cur into prev and takes the new position, so it has a segment to glide
   * along. A slot NOT alive last call — a spawn, or a recycled index — snaps: prev and cur both take the
   * new position, so its first drawn frame sits exactly on the truth with nothing to slide from.
   */
  sample(slots: Int32Array, count: number, x: Float32Array, y: Float32Array): void {
    const now = this.counter + 1;
    const prevCounter = this.counter;
    for (let i = 0; i < count; i++) {
      const s = slots[i] as number;
      const sx = x[s] as number;
      const sy = y[s] as number;
      if (this.seenAt[s] === prevCounter) {
        // Alive last tick too: a real segment to interpolate along.
        this.prevX[s] = this.curX[s] as number;
        this.prevY[s] = this.curY[s] as number;
      } else {
        // New or recycled: snap, so nothing glides in from a stale or a dead enemy's position.
        this.prevX[s] = sx;
        this.prevY[s] = sy;
      }
      this.curX[s] = sx;
      this.curY[s] = sy;
      this.seenAt[s] = now;
    }
    this.counter = now;
  }

  /**
   * Interpolated X of a slot. `alpha` is the loop's 0..1 between-ticks factor, the same one the camera,
   * the batcher and `LocalView` draw with, so the whole scene moves on one clock.
   *
   * A slot that has never been sampled returns 0; callers only ever ask about slots the pool reports
   * live, and those were sampled on the tick they became live.
   */
  renderX(slot: number, alpha: number): number {
    const p = this.prevX[slot] as number;
    return p + ((this.curX[slot] as number) - p) * alpha;
  }

  renderY(slot: number, alpha: number): number {
    const p = this.prevY[slot] as number;
    return p + ((this.curY[slot] as number) - p) * alpha;
  }
}
