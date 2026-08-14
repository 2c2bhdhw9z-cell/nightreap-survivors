/**
 * Hand the packed sheet of art to the game.
 *
 * WHY THIS IS NOT IN `game/`
 * Turning a `.png` file into something a graphics chip can use is the one job that is completely different
 * on a phone and in a browser, and `game/` is kept free of anything platform-shaped so it stays testable
 * at a desk. So the platform work happens here, and the game is handed a finished sheet.
 *
 * WHAT IT REFUSES TO DO
 * It does not fall back to placeholder squares when the art fails to load. A build with no art that looks
 * like a build with placeholder art is the worst of both: it ships. If the sheet cannot be loaded, or the
 * written list of positions does not match the sheet that arrived, this throws and the screen says so.
 */

import { Asset } from "expo-asset";
import { Platform } from "react-native";

import { checkManifest, type CheckedManifest } from "@/game/art/manifest-check";
import { createAtlas, type Atlas, type AtlasManifest } from "@/game/render/atlas";

import manifestJson from "@/assets/atlas.json";

const MANIFEST = manifestJson as unknown as AtlasManifest & CheckedManifest;

const SHEET = require("@/assets/atlas.png") as number;

/**
 * Load the sheet and give the game an atlas it can draw from.
 *
 * Called once, when the drawing surface is first created. The texture stays for the life of the surface:
 * one texture is the whole reason a layer of sprites costs one draw call.
 */
export async function loadRunAtlas(gl: WebGLRenderingContext): Promise<Atlas> {
  const asset = Asset.fromModule(SHEET);
  if (!asset.downloaded) await asset.downloadAsync();

  const source = await decodeSheet(asset);

  const complaints = checkManifest(MANIFEST, source.width, source.height);
  if (complaints.length > 0) {
    throw new Error(`the art sheet and its list of positions disagree:\n- ${complaints.join("\n- ")}`);
  }

  const texture = gl.createTexture();
  if (!texture) throw new Error("the graphics chip would not give us a texture for the art");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    source.image as unknown as TexImageSource,
  );

  return createAtlas(gl, texture, MANIFEST);
}

interface DecodedSheet {
  image: unknown;
  width: number;
  height: number;
}

/**
 * Get the sheet into whatever shape the graphics layer on this platform will accept.
 *
 * On a phone the graphics bridge takes the downloaded asset itself and does the decoding natively, which is
 * both faster and far less memory than decoding it in JavaScript. In a browser there is no such bridge, so
 * the sheet is loaded as an ordinary image element first and the browser does the decoding.
 */
async function decodeSheet(asset: Asset): Promise<DecodedSheet> {
  if (Platform.OS !== "web") {
    return {
      image: asset,
      width: asset.width ?? MANIFEST.width,
      height: asset.height ?? MANIFEST.height,
    };
  }

  const uri = asset.localUri ?? asset.uri;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`the art sheet would not load from ${uri}`));
    el.src = uri;
  });

  return { image, width: image.naturalWidth, height: image.naturalHeight };
}
