"""
Cut the packed sheet into one crisp picture per cell, for the menus.

WHY THIS EXISTS
The game itself draws art through the renderer, which samples the sheet with filtering turned off, so a
pixel stays a pixel. The menus are ordinary phone views, and a phone view has no such switch: hand it a
32-pixel picture and ask for it four times bigger and it will smooth it. On a modern phone that is worse
than it sounds, because the screen has three real dots per point — a sprite in a five-cell box is being
blown up fifteen times, and every single pixel of the original comes out as a soft gradient. It reads as
a blurry photograph of pixel art rather than pixel art, and no amount of care in the drawing survives it.

WHAT THIS DOES
It writes out every cell of the sheet as its own picture, already blown up eight times with hard edges —
each original pixel becomes a solid 8x8 block, decided here where the rules can be enforced, instead of
on the phone where they cannot. The phone is then only ever making a small adjustment to a picture that
is already blocky, so the block edges stay sharp.

This is the trade the old approach refused to make, and it was the wrong call: the sheet-shoving trick
saved a few hundred small files and cost every menu its art.

WHAT IT ALSO WRITES
A TypeScript file listing every picture. The phone's bundler will only include a file that is named
outright in the code, so a list built by hand would rot the first time a cell was added. This one is
generated from the sheet itself and cannot disagree with it.

RUN IT
    python3 art/menu_sprites.py            # from packages/mobile
Re-run it whenever the sheet is repacked. It is safe to run twice; it clears what it wrote last time.
"""

from __future__ import annotations

import json
import os
import shutil
import sys

from PIL import Image

# Each original pixel becomes this many across and down.
#
# Eight is chosen against the worst case in the app: a sprite in a five-cell box on a three-dot screen is
# magnified fifteen times, so at eight the phone is stretching an already-blocky picture by less than two,
# and the soft band on a block edge is under two screen dots. Sixteen would be sharper still and would
# double the memory every open menu holds, for a difference nobody can see on a phone.
SCALE = 8


def slug(name: str) -> str:
    """`bosses/icon-04` -> `bosses_icon-04`. Flat names, because a bundler map wants plain keys."""
    return name.replace("/", "_")


def main(argv: list[str]) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)

    sheet_path = os.path.join(root, "assets", "atlas.png")
    manifest_path = os.path.join(root, "assets", "atlas.json")
    out_dir = os.path.join(root, "assets", "sprites")
    map_path = os.path.join(root, "components", "sprite-map.ts")

    if not os.path.isfile(sheet_path) or not os.path.isfile(manifest_path):
        print("missing atlas.png or atlas.json — run art/pack.py first", file=sys.stderr)
        return 1

    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)

    frames: dict[str, dict[str, int]] = manifest["frames"]
    sheet = Image.open(sheet_path).convert("RGBA")

    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    written = []
    for name in sorted(frames):
        r = frames[name]
        cell = sheet.crop((r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"]))
        # NEAREST is the whole point. Any other resampling here reintroduces exactly the blur this file
        # exists to remove, and it would be invisible in a code review.
        big = cell.resize((r["w"] * SCALE, r["h"] * SCALE), Image.NEAREST)
        out_name = f"{slug(name)}.png"
        big.save(os.path.join(out_dir, out_name), optimize=True)
        written.append((name, out_name))

    lines = [
        "/**",
        " * Every cell of the sheet, as its own crisp picture. GENERATED — do not edit.",
        " *",
        " * Written by `art/menu_sprites.py`. Each picture is the cell blown up eight times with hard edges,",
        " * so a menu can show it at any size without the phone turning every pixel into a gradient.",
        " *",
        " * The list is spelled out rather than built, because the bundler only packs a file whose name it can",
        " * read in the source. Re-run the script after repacking the sheet.",
        " */",
        "",
        "/* eslint-disable */",
        "",
        "export const SPRITE_SOURCES: Record<string, number> = {",
    ]
    for name, out_name in written:
        lines.append(f'  "{name}": require("@/assets/sprites/{out_name}") as number,')
    lines.append("};")
    lines.append("")
    lines.append("/** How many times each picture was blown up when it was written out. */")
    lines.append(f"export const SPRITE_SOURCE_SCALE = {SCALE};")
    lines.append("")

    with open(map_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    total = sum(os.path.getsize(os.path.join(out_dir, n)) for _, n in written)
    print(f"wrote {len(written)} pictures at {SCALE}x, {total / 1024:.0f} KB total")
    print(f"map: {os.path.relpath(map_path, root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
