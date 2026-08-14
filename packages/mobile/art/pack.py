"""Pack every finished 32x32 icon into one power-of-two atlas plus its manifest.

Why one texture: the renderer flushes a draw call every time the bound texture
changes, so the moment the art lives in two files the number of draw calls
follows the art instead of the number of layers. One atlas keeps a whole layer
at one call, which is the only reason a cheap phone holds sixty frames a second.

What this is not: it does not paint, resample, recolour, trim or rename
anything. Every icon lands in the sheet byte for byte as it was drawn. If a
source file is the wrong size, this refuses to write rather than quietly
squashing it, because a squashed sprite is a bug nobody notices until it is
shipped.

Deterministic: the same folder always produces the same sheet, in the same
order, at the same coordinates. That matters because the sheet is committed —
a packer that shuffled positions would show up as a two megabyte diff every
time anyone ran it.

Usage:
    python3 pack.py <art-root> <out-dir> [--cell 32] [--gutter 1]
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

# Every icon in the finished art folders is this wide and tall. This is asserted,
# never assumed: see refusals below.
CELL = 32

# One transparent pixel around every icon. Sampling is NEAREST and the manifest
# is read with a half-texel inset, so in theory a gutter is unnecessary; in
# practice a rotated sprite on a driver that rounds differently reads one column
# past its own edge, and the bug looks like a bright thread down one side of
# every enemy. One pixel of nothing is cheaper than that hunt.
GUTTER = 1

# Folders under the art root that hold painted sources, not finished icons.
NOT_ICON_SETS = ("source",)

# Sheets we will consider, smallest area first. Anything larger than this is a
# sign the art has outgrown one atlas and the renderer needs a real answer
# rather than a bigger texture on a phone that cannot hold it.
POWERS = (256, 512, 1024, 2048)


def is_power_of_two(value):
    return value > 0 and (value & (value - 1)) == 0


def discover(root):
    """Every finished icon under the art root, in a fixed order.

    Sorted by folder then by file name so the layout is a function of the
    contents and nothing else — not of the order the filesystem happens to
    hand back.
    """
    found = []
    for set_name in sorted(os.listdir(root)):
        if set_name in NOT_ICON_SETS:
            continue
        folder = os.path.join(root, set_name)
        if not os.path.isdir(folder):
            continue
        for file_name in sorted(os.listdir(folder)):
            if not file_name.endswith(".png"):
                continue
            if file_name.startswith("_"):
                continue  # contact sheets are for human eyes, not for the game
            found.append((set_name + "/" + file_name[:-4], os.path.join(folder, file_name)))
    return found


def plan_layout(count, cell=CELL, gutter=GUTTER):
    """Where each icon goes, and how big a sheet holds them all.

    Returns (width, height, [(x, y), ...]) or None when no allowed sheet fits.
    Cells sit on a fixed pitch: no clever packing, because every icon is the
    same size, so clever packing would buy nothing and cost determinism.
    """
    if count <= 0:
        return None
    pitch = cell + gutter * 2
    best = None
    for width in POWERS:
        columns = width // pitch
        if columns <= 0:
            continue
        for height in POWERS:
            rows = height // pitch
            if columns * rows < count:
                continue
            area = width * height
            # Smallest sheet wins; on a tie take the squarest one. Two sheets of
            # equal area are equally cheap in memory, but the long thin one runs
            # closer to the 2048-pixel limit the oldest phones guarantee, and it
            # leaves no rows spare for the art still to come.
            key = (area, abs(width - height), -width)
            if best is None or key < best[0]:
                best = (key, width, height, columns)
    if best is None:
        return None
    _, width, height, columns = best
    spots = []
    for index in range(count):
        row = index // columns
        column = index % columns
        spots.append((column * pitch + gutter, row * pitch + gutter))
    return width, height, spots


def load_cell(path, cell=CELL):
    """One icon as RGBA, or None if it is not the size every icon must be."""
    image = Image.open(path).convert("RGBA")
    if image.size != (cell, cell):
        return None
    return np.asarray(image)


def compose(cells, spots, width, height):
    """Draw the icons into a fully transparent sheet, byte for byte."""
    sheet = np.zeros((height, width, 4), dtype=np.uint8)
    for pixels, (x, y) in zip(cells, spots):
        rows = pixels.shape[0]
        columns = pixels.shape[1]
        sheet[y : y + rows, x : x + columns] = pixels
    return sheet


def frames_of(names, spots, cell=CELL):
    """The manifest's frame table: pixel rects, top-left origin."""
    frames = {}
    for name, (x, y) in zip(names, spots):
        frames[name] = {"x": int(x), "y": int(y), "w": int(cell), "h": int(cell)}
    return frames


def sets_of(names):
    """Which icons belong to which folder, so content code can list a set."""
    grouped = {}
    for name in names:
        folder = name.split("/", 1)[0]
        grouped.setdefault(folder, []).append(name)
    return grouped


def overlaps(frames):
    """Any two frames sharing a pixel. Should always be empty; proven, not hoped."""
    boxes = [(name, f["x"], f["y"], f["w"], f["h"]) for name, f in sorted(frames.items())]
    clashes = []
    for i in range(len(boxes)):
        an, ax, ay, aw, ah = boxes[i]
        for j in range(i + 1, len(boxes)):
            bn, bx, by, bw, bh = boxes[j]
            if ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah:
                clashes.append((an, bn))
    return clashes


def out_of_bounds(frames, width, height):
    return sorted(
        name
        for name, f in frames.items()
        if f["x"] < 0 or f["y"] < 0 or f["x"] + f["w"] > width or f["y"] + f["h"] > height
    )


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root", help="the art folder holding one subfolder per icon set")
    ap.add_argument("out", help="where atlas.png and atlas.json are written")
    ap.add_argument("--cell", type=int, default=CELL)
    ap.add_argument("--gutter", type=int, default=GUTTER)
    args = ap.parse_args(argv)

    if not os.path.isdir(args.root):
        print("no such art folder: %s" % args.root, file=sys.stderr)
        return 2

    found = discover(args.root)
    if not found:
        print("no icons found under %s" % args.root, file=sys.stderr)
        return 2

    names = [name for name, _ in found]
    if len(set(names)) != len(names):
        print("two icons share a name", file=sys.stderr)
        return 2

    cells = []
    wrong = []
    for name, path in found:
        pixels = load_cell(path, args.cell)
        if pixels is None:
            wrong.append(name)
            continue
        cells.append(pixels)
    if wrong:
        print(
            "%d icon(s) are not %dx%d: %s"
            % (len(wrong), args.cell, args.cell, ", ".join(wrong[:6])),
            file=sys.stderr,
        )
        return 2

    layout = plan_layout(len(cells), args.cell, args.gutter)
    if layout is None:
        print("%d icons do not fit any allowed sheet" % len(cells), file=sys.stderr)
        return 2
    width, height, spots = layout

    frames = frames_of(names, spots, args.cell)
    clashes = overlaps(frames)
    if clashes:
        print("frames overlap: %s" % clashes[:4], file=sys.stderr)
        return 2
    outside = out_of_bounds(frames, width, height)
    if outside:
        print("frames fall off the sheet: %s" % outside[:4], file=sys.stderr)
        return 2

    sheet = compose(cells, spots, width, height)

    os.makedirs(args.out, exist_ok=True)
    Image.fromarray(sheet, mode="RGBA").save(os.path.join(args.out, "atlas.png"))
    manifest = {
        "width": int(width),
        "height": int(height),
        "cell": int(args.cell),
        "gutter": int(args.gutter),
        "frames": frames,
        "sets": sets_of(names),
    }
    with open(os.path.join(args.out, "atlas.json"), "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)

    drawn = int((sheet[:, :, 3] > 0).sum())
    print(
        "packed %d icons into %dx%d (%.1f%% of the sheet carries art)"
        % (len(cells), width, height, 100.0 * drawn / (width * height))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
