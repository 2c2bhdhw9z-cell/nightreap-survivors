"""Turn a painted icon sheet into true 32x32 pixel art on the locked palette.

Deterministic, no network, no generation. Reads a grid sheet drawn on flat
magenta, cuts each cell, reduces it to a real 32x32 grid, snaps every pixel to
the nearest colour in the locked palette, and writes the background out as
transparent.

Usage:
    python3 pixelize.py <sheet.png> <out-dir> [--size 32] [--cols 6] [--rows 4]
"""

import argparse
import json
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image

# The locked palette. Nothing outside this list may survive into an icon.
PALETTE = {
    "outline": "#0B0A10",
    "clothDark": "#232132",
    "clothLight": "#3A3550",
    "bone": "#C8BFA6",
    "bonePale": "#EFE6CE",
    "bloodDark": "#B02033",
    "bloodBright": "#E8455A",
    "rot": "#5C9E45",
    "leather": "#8A4B2A",
    "gold": "#E0A62B",
    "slate": "#16141F",
    "cyan": "#3FC7D6",
    "violet": "#7A4FA8",
}


def as_rgb(text):
    text = text.lstrip("#")
    return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


PALETTE_NAMES = list(PALETTE.keys())
PALETTE_RGB = np.array([as_rgb(PALETTE[n]) for n in PALETTE_NAMES], dtype=float)

# Perceptual weights: the eye is far more sensitive to green than to blue, so an
# unweighted distance happily swaps a brown for a violet of the same darkness.
WEIGHT = np.array([0.30, 0.59, 0.11], dtype=float)

# The palette has no neutral mid-grey, and the source art shades with grey. A
# plain nearest-colour search puts those greys almost exactly between bone and
# rot green, and green wins often enough to freckle every silhouette. So a
# near-grey source pixel may only become a neutral, never a chromatic one.
NEUTRALS = ("outline", "slate", "clothDark", "clothLight", "bone", "bonePale")
NEUTRAL_IDX = np.array(
    [PALETTE_NAMES.index(n) for n in NEUTRALS], dtype=int
)
# Below this colourfulness a pixel counts as grey. Measured against the source
# sheet: real leather and rot sit far above it, grey shading far below.
GREY_SATURATION = 0.18


def is_greyish(pixels):
    """Colourfulness test. pixels is an (n, 3) array."""
    high = pixels.max(axis=1).astype(float)
    low = pixels.min(axis=1).astype(float)
    # Guard black: max of zero has no meaningful saturation, and black is a
    # neutral anyway, so calling it grey is correct.
    safe = np.where(high <= 0.0, 1.0, high)
    return ((high - low) / safe) < GREY_SATURATION


def magenta_mask(rgb):
    """True where the pixel is background keying magenta, halo included.

    The generator does not lay down an exact colour, so this is a tolerance
    band rather than an equality test. It also has to catch the soft halo where
    an icon edge blends into the background: those pinks are not part of any
    icon, and because the eye weights green so heavily they otherwise snap to
    rot green and fringe every silhouette.
    """
    r = rgb[..., 0].astype(int)
    g = rgb[..., 1].astype(int)
    b = rgb[..., 2].astype(int)
    flat = (r > 190) & (b > 190) & (g < 100)
    # Magenta-dominant: red and blue both clearly above green AND close to each
    # other. The balance matters. Palette violet is also red-and-blue heavy but
    # leans firmly blue, so requiring near-equal red and blue keeps violet in
    # the icons while still stripping the background halo.
    balanced = np.abs(r - b) <= 30
    halo = (r - g > 35) & (b - g > 35) & (r > 110) & (b > 110) & balanced
    return flat | halo


def bands(counts, floor):
    """Contiguous runs where counts rise above floor. Used to find the grid."""
    out = []
    start = None
    for i, value in enumerate(counts):
        if value > floor and start is None:
            start = i
        elif value <= floor and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(counts) - 1))
    return out


def merge_thin(found):
    """Join bands split by a hairline gap, then drop leftover slivers.

    A tall object can have a few rows of near-nothing across its middle — the
    neck of an urn, the gap under a lid — which splits one real row of the grid
    into two bands and makes the sheet look like it has more rows than it does.
    Anything separated by much less than a real band is the same band.
    """
    if len(found) < 2:
        return list(found)
    sizes = sorted((b - a + 1) for a, b in found)
    typical = sizes[len(sizes) // 2]
    # Deliberately small. A hairline gap inside one object is a few pixels; the
    # real gutter between two cells is a large fraction of a cell. Anything
    # near the gutter's size must stay a gutter, or a sheet quietly collapses
    # into fewer, wrongly cropped cells.
    gap_floor = max(2, typical // 8)

    joined = [list(found[0])]
    for a, b in found[1:]:
        if a - joined[-1][1] - 1 <= gap_floor:
            joined[-1][1] = b
        else:
            joined.append([a, b])

    # A band far smaller than the typical one is debris, not a cell.
    keep = [(a, b) for a, b in joined if (b - a + 1) >= max(2, typical // 3)]
    return keep or [tuple(x) for x in joined]


def snap(block_rgb, keep):
    """Pick one palette colour for a block of source pixels.

    Votes rather than averages. Averaging two neighbouring palette colours
    invents a third that is in neither, which is exactly the drift being
    removed here.
    """
    picked = block_rgb[keep]
    if picked.size == 0:
        return None
    diff = picked[:, None, :].astype(float) - PALETTE_RGB[None, :, :]
    dist = ((diff * diff) * WEIGHT).sum(axis=2)
    # Fence the greys into the neutral ramp before choosing.
    grey = is_greyish(picked)
    if grey.any():
        blocked = np.ones(len(PALETTE_NAMES), dtype=bool)
        blocked[NEUTRAL_IDX] = False
        dist[np.ix_(grey, blocked)] = np.inf
    idx = dist.argmin(axis=1)
    votes = Counter(idx.tolist())
    # Ties break toward the darker palette entry so outlines stay crisp.
    best = max(votes.items(), key=lambda kv: (kv[1], -PALETTE_RGB[kv[0]].sum()))
    return int(best[0])


def cell_to_icon(cell_rgb, size):
    """Reduce one cropped cell to a size x size palette-snapped RGBA icon."""
    height, width = cell_rgb.shape[0], cell_rgb.shape[1]
    background = magenta_mask(cell_rgb)
    out = np.zeros((size, size, 4), dtype=np.uint8)
    used = Counter()
    for y in range(size):
        y0 = (y * height) // size
        y1 = max(y0 + 1, ((y + 1) * height) // size)
        for x in range(size):
            x0 = (x * width) // size
            x1 = max(x0 + 1, ((x + 1) * width) // size)
            block = cell_rgb[y0:y1, x0:x1]
            bg = background[y0:y1, x0:x1]
            keep = ~bg
            # A block that is mostly background stays empty, so silhouettes do
            # not grow a halo of half-claimed edge pixels.
            if keep.mean() < 0.5:
                continue
            index = snap(block, keep)
            if index is None:
                continue
            used[PALETTE_NAMES[index]] += 1
            out[y, x, 0:3] = PALETTE_RGB[index].astype(np.uint8)
            out[y, x, 3] = 255
    return out, used


def despeckle(icon):
    """Remove lone pixels whose colour no neighbour shares.

    Deliberately hue-blind. A single pixel of a colour that appears nowhere in
    its own eight neighbours is reduction noise, not draughtsmanship, whatever
    colour it happens to be. Real highlights come in touching clusters and are
    left alone. Returns a new array and the number of pixels rewritten.
    """
    height, width = icon.shape[0], icon.shape[1]
    out = icon.copy()
    fixed = 0
    for y in range(height):
        for x in range(width):
            if icon[y, x, 3] == 0:
                continue
            mine = tuple(icon[y, x, 0:3].tolist())
            neighbours = []
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height and 0 <= nx < width and icon[ny, nx, 3] > 0:
                        neighbours.append(tuple(icon[ny, nx, 0:3].tolist()))
            if not neighbours or mine in neighbours:
                continue
            winner = Counter(neighbours).most_common(1)[0][0]
            out[y, x, 0:3] = winner
            fixed += 1
    return out, fixed


def trim_and_centre(icon, size):
    """Centre the drawn pixels in the tile so icons sit level in a row."""
    alpha = icon[:, :, 3] > 0
    if not alpha.any():
        return icon
    ys, xs = np.where(alpha)
    top, bottom = ys.min(), ys.max()
    left, right = xs.min(), xs.max()
    cut = icon[top : bottom + 1, left : right + 1]
    high, wide = cut.shape[0], cut.shape[1]
    if high > size or wide > size:
        return icon
    out = np.zeros((size, size, 4), dtype=np.uint8)
    oy = (size - high) // 2
    ox = (size - wide) // 2
    out[oy : oy + high, ox : ox + wide] = cut
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("out")
    ap.add_argument("--size", type=int, default=32)
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--rows", type=int, default=4)
    args = ap.parse_args(argv)

    image = Image.open(args.sheet).convert("RGB")
    rgb = np.asarray(image)
    foreground = ~magenta_mask(rgb)

    # Take whichever reading matches what the caller asked for. Merging fixes
    # a row split across an object's thin waist, but on a sheet with no such
    # split it can glue two real rows together, so neither reading is right
    # on its own.
    def best(counts, want):
        raw = bands(counts, 3)
        if len(raw) == want:
            return raw
        merged = merge_thin(raw)
        return merged if len(merged) == want else raw

    row_bands = best(foreground.sum(axis=1), args.rows)
    col_bands = best(foreground.sum(axis=0), args.cols)
    if len(row_bands) != args.rows or len(col_bands) != args.cols:
        print(
            "grid not found: expected %dx%d, read %d rows and %d columns"
            % (args.rows, args.cols, len(row_bands), len(col_bands)),
            file=sys.stderr,
        )
        return 2

    os.makedirs(args.out, exist_ok=True)
    manifest = []
    offenders = 0
    for r, (y0, y1) in enumerate(row_bands):
        for c, (x0, x1) in enumerate(col_bands):
            cell = rgb[y0 : y1 + 1, x0 : x1 + 1]
            icon, used = cell_to_icon(cell, args.size)
            icon, speckles = despeckle(icon)
            icon = trim_and_centre(icon, args.size)
            name = "icon-%02d" % (r * args.cols + c + 1)
            path = os.path.join(args.out, name + ".png")
            Image.fromarray(icon, mode="RGBA").save(path)

            drawn = int((icon[:, :, 3] > 0).sum())
            if drawn == 0:
                offenders += 1
                print("EMPTY ICON: %s" % name, file=sys.stderr)
            manifest.append(
                {
                    "name": name,
                    "row": r,
                    "col": c,
                    "size": args.size,
                    "drawnPixels": drawn,
                    "speckledPixelsFixed": speckles,
                    "colours": sorted(used.keys()),
                }
            )

    with open(os.path.join(args.out, "icons.json"), "w") as handle:
        json.dump({"size": args.size, "icons": manifest}, handle, indent=2)

    print("wrote %d icons at %dpx into %s" % (len(manifest), args.size, args.out))
    return 1 if offenders else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
