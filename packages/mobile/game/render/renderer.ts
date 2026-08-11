/**
 * Renderer — owns the GL objects, the layer order, and nothing else.
 *
 * The engine never imports React Native, so it never creates the GL context either. The host
 * component hands us a `WebGLRenderingContext` from `<GLView>` and, on native, is the only thing
 * that may call `endFrameEXP()`. That keeps `game/` runnable headlessly and on web unchanged.
 *
 * LAYERS
 * Order is submission order — there is no depth buffer, because a 2D game with a fixed layer stack
 * does not need one and every fragment would pay for it. World layers share one camera uniform;
 * screen layers reset it to (0,0) so HUD coordinates are just device pixels / scale.
 *
 * A layer change costs one uniform write plus a flush of whatever is queued, so the target is
 * ~9 draw calls a frame regardless of entity count.
 */

import { Camera } from "./camera";
import { Atlas } from "./atlas";
import { SpriteBatcher, packHex, type PackedColor } from "./batcher";
import { compileSpriteProgram, type SpriteProgram } from "./shader";

/**
 * Draw order, back to front. `space: "screen"` layers ignore the camera.
 *
 * Damage numbers sit above overhead FX so a crit is never swallowed by a smoke puff, and the HUD
 * is last so nothing can cover the health bar.
 */
export const LAYERS = [
  { id: "background", space: "world" },
  { id: "floorFx", space: "world" }, // scorch marks, garlic aura, ground telegraphs
  { id: "pickups", space: "world" }, // gems, chests, chicken, floor items
  { id: "enemies", space: "world" },
  { id: "player", space: "world" },
  { id: "projectiles", space: "world" },
  { id: "overheadFx", space: "world" }, // hit sparks, explosions, level-up burst
  { id: "damageNumbers", space: "world" },
  { id: "hud", space: "screen" },
] as const;

export type LayerId = (typeof LAYERS)[number]["id"];

const SCREEN_LAYERS = new Set<string>(
  LAYERS.filter((l) => l.space === "screen").map((l) => l.id),
);

/**
 * Engine-level debug switches. Deliberately not `__DEV__` — `game/` must type-check and run with
 * no React Native or Node globals in scope. The host flips this off for release builds.
 */
export const engineDebug = { checkLayerOrder: true };

/** Design floor: the shortest side always shows at least this many world pixels. */
export const MIN_VISIBLE_SHORT_SIDE = 240;

export interface RendererStats {
  quads: number;
  drawCalls: number;
  textureSwaps: number;
  layerSwitches: number;
  /** Vertex bytes uploaded this frame. Flat across a run, or something is growing that shouldn't. */
  uploadBytes: number;
}

export class Renderer {
  readonly gl: WebGLRenderingContext;
  readonly camera = new Camera();
  readonly batch: SpriteBatcher;

  private readonly program: SpriteProgram;
  private atlas: Atlas | null = null;
  private currentLayer: LayerId | null = null;
  private layerSwitches = 0;
  private clearColor = packHex("#141320");
  private inFrame = false;

  /** Largest texture this GPU will take — checked before we commit to a 2048px atlas. */
  readonly maxTextureSize: number;
  /** Whether highp is available in fragment shaders. Logged in the dev menu, affects UV bleed. */
  readonly hasHighp: boolean;
  /**
   * What is actually drawing. On Android Chrome this is the difference between a real Mali GPU
   * and Chrome quietly falling back to SwiftShader, its software rasteriser — which looks
   * identical on screen and is roughly ten times slower. Without this string a bad benchmark
   * number is unattributable, so it is read once at construction and shown in the dev readout.
   */
  readonly gpuName: string;

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    this.program = compileSpriteProgram(gl);
    this.batch = new SpriteBatcher(gl, this.program);
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    this.hasHighp = !!precision && precision.precision > 0;
    this.gpuName = readGpuName(gl);
  }

  /** Bind the atlas. One call at load; every layer then draws from the same texture. */
  setAtlas(atlas: Atlas): void {
    this.atlas = atlas;
  }

  get currentAtlas(): Atlas {
    if (!this.atlas) throw new Error("Renderer.setAtlas has not been called");
    return this.atlas;
  }

  /** `#rrggbb`. Stage-specific; parsed here, never per frame. */
  setClearColor(hex: string): void {
    this.clearColor = packHex(hex);
  }

  /**
   * Called on layout and on orientation change. `bufferW/H` are drawing-buffer pixels
   * (`gl.drawingBufferWidth`), not CSS or dp — mixing those up is how a 3x device ends up
   * rendering at a third of its resolution.
   */
  resize(bufferW: number, bufferH: number): void {
    const scale = Camera.chooseScale(bufferW, bufferH, MIN_VISIBLE_SHORT_SIDE);
    this.camera.setViewport(bufferW, bufferH, scale);
    this.gl.viewport(0, 0, bufferW, bufferH);
  }

  /** `alpha` is the interpolation factor between the last two sim ticks. */
  beginFrame(alpha: number): void {
    const gl = this.gl;
    this.camera.beginFrame(alpha);

    const c = this.clearColor;
    gl.clearColor(
      (c & 255) / 255,
      ((c >>> 8) & 255) / 255,
      ((c >>> 16) & 255) / 255,
      1,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.batch.begin(this.camera.viewW, this.camera.viewH, this.camera.scale);
    if (this.atlas) this.batch.setTexture(this.atlas.texture);
    this.currentLayer = null;
    this.layerSwitches = 0;
    this.inFrame = true;
  }

  /**
   * Switch to a layer and get the batcher to draw into.
   *
   * Callers must submit layers in `LAYERS` order. Going backwards would draw behind something
   * already on screen, so in development that is a thrown error rather than a subtle visual bug.
   */
  layer(id: LayerId): SpriteBatcher {
    if (!this.inFrame) throw new Error("Renderer.layer called outside a frame");
    if (this.currentLayer === id) return this.batch;

    if (engineDebug.checkLayerOrder && this.currentLayer !== null) {
      const from = LAYERS.findIndex((l) => l.id === this.currentLayer);
      const to = LAYERS.findIndex((l) => l.id === id);
      if (to <= from) {
        throw new Error(`Layer order violation: "${this.currentLayer}" -> "${id}"`);
      }
    }

    if (SCREEN_LAYERS.has(id)) {
      this.batch.setCamera(0, 0);
    } else {
      this.batch.setCamera(this.camera.topLeftX, this.camera.topLeftY);
    }
    this.currentLayer = id;
    this.layerSwitches++;
    return this.batch;
  }

  /** Flush the tail. The host then calls `gl.endFrameEXP()` on native / nothing on web. */
  endFrame(): RendererStats {
    this.batch.flush();
    this.inFrame = false;
    const s = this.batch.stats;
    return {
      quads: s.quads,
      drawCalls: s.drawCalls,
      textureSwaps: s.textureSwaps,
      layerSwitches: this.layerSwitches,
      uploadBytes: s.uploadBytes,
    };
  }

  /** Tint helper so callers do not need the batcher's packing functions. */
  static color(hex: string, alpha = 255): PackedColor {
    return packHex(hex, alpha);
  }

  dispose(): void {
    this.batch.dispose();
    this.gl.deleteProgram(this.program.program);
  }
}

/**
 * Best-effort GPU identity. The unmasked strings sit behind an optional extension that some
 * browsers withhold for fingerprinting reasons, and the masked fallback is often just
 * "WebKit WebGL", so every step is guarded and an unknown answer is a valid answer.
 */
function readGpuName(gl: WebGLRenderingContext): string {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info") as {
      UNMASKED_RENDERER_WEBGL?: number;
    } | null;
    if (ext && typeof ext.UNMASKED_RENDERER_WEBGL === "number") {
      const name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown;
      if (typeof name === "string" && name.length > 0) return name;
    }
    const masked = gl.getParameter(gl.RENDERER) as unknown;
    if (typeof masked === "string" && masked.length > 0) return masked;
  } catch {
    // Some drivers throw rather than return null. An unreadable name is not worth a crash.
  }
  return "unknown";
}
