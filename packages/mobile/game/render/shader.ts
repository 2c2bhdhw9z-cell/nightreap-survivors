/**
 * The only shader pair in the game.
 *
 * WebGL1 / GLSL ES 1.00 on purpose: `expo-gl` exposes an ES 2.0 context, and the cheap Android
 * devices we're targeting are exactly where WebGL2 support gets patchy. No instancing, no VAOs,
 * no uniform buffers — one attribute layout, one texture, one draw call per layer.
 *
 * Everything the sprite needs travels in the vertex data (position, UV, packed colour), so a whole
 * layer of 8,000 sprites is a single `drawElements`. Uniforms change only between layers.
 */

export const SPRITE_VERT = `
attribute vec2 a_pos;
attribute vec2 a_uv;
attribute vec4 a_color;

uniform vec2 u_viewport;  // drawing-buffer size in device pixels
uniform vec2 u_camera;    // camera top-left in world pixels, pre-snapped to the pixel grid
uniform float u_scale;    // integer pixel scale (1, 2, 3, 4)

varying vec2 v_uv;
varying vec4 v_color;

void main() {
  // World -> screen -> clip. Y is flipped because sprite space is top-left origin like every
  // 2D tool, while clip space is bottom-left.
  vec2 screen = (a_pos - u_camera) * u_scale;
  vec2 clip = (screen / u_viewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
  v_color = a_color;
}
`;

export const SPRITE_FRAG = `
// UVs need more than mediump: at a 2048px atlas, mediump's ~10-bit mantissa is not enough to
// address a texel exactly and sprites bleed into their neighbours. Ask for highp where it exists.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D u_tex;

varying vec2 v_uv;
varying vec4 v_color;

void main() {
  vec4 tex = texture2D(u_tex, v_uv);
  // v_color is a multiply: white = untouched, tint for hit flashes, alpha for fades.
  // Co-op palette swaps ride on this for now; Phase 2 swaps in a palette-index lookup so the
  // four players can differ by hue without washing out sprite shading.
  gl_FragColor = tex * v_color;
}
`;

export interface SpriteProgram {
  program: WebGLProgram;
  aPos: number;
  aUv: number;
  aColor: number;
  uViewport: WebGLUniformLocation | null;
  uCamera: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
  uTex: WebGLUniformLocation | null;
}

export function compileSpriteProgram(gl: WebGLRenderingContext): SpriteProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, SPRITE_VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, SPRITE_FRAG);
  const program = gl.createProgram();
  if (!program) throw new Error("gl.createProgram returned null");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Sprite program link failed: ${log ?? "unknown"}`);
  }
  // Shader objects are reference-counted by the program; detach so the sources can be freed.
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  return {
    program,
    aPos: gl.getAttribLocation(program, "a_pos"),
    aUv: gl.getAttribLocation(program, "a_uv"),
    aColor: gl.getAttribLocation(program, "a_color"),
    uViewport: gl.getUniformLocation(program, "u_viewport"),
    uCamera: gl.getUniformLocation(program, "u_camera"),
    uScale: gl.getUniformLocation(program, "u_scale"),
    uTex: gl.getUniformLocation(program, "u_tex"),
  };
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("gl.createShader returned null");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new Error(`${kind} shader compile failed: ${log ?? "unknown"}`);
  }
  return shader;
}
