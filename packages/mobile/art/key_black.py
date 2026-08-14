"""Repaint a generated sheet's black background as the keying magenta the pixeliser expects.

WHY THIS EXISTS
The icon pipeline keys on flat magenta, but a sheet occasionally comes back drawn on black instead. Black
cannot simply be keyed out by colour: the locked palette's outline colour is very nearly black, so a
colour test would eat the outline of every icon and leave holes where the drawing was darkest.

So the background is found by spreading inwards from the border rather than by colour alone. Only
near-black that is connected to the edge of the sheet counts as background; near-black enclosed by an
icon's own silhouette is an outline and is left exactly as it was. Four-way spreading, not eight-way: a
diagonal-only touch between two dark regions is a corner pixel, and letting the flood squeeze through it
would let the background leak inside a closed outline through a single pixel.

THE LIMITATION, STATED PLAINLY
Near-black that runs all the way out to the black background cannot be told apart from the background by
any flood, so a drawing whose rim is dark loses that rim. The generated sheets draw bright silhouettes on
black, which is why this is acceptable here, and there is a check that fails if that ever stops being true
quietly.

Nothing here draws, resizes or recolours anything else — every pixel that is not background comes out
byte for byte as it went in.

Usage:
    python3 key_black.py <sheet.png> <out.png>
"""

import sys
from collections import deque

import numpy as np
from PIL import Image

# A pixel counts as near-black when every channel sits under this. The palette's outline is 0B0A10 and the
# generator's background is flat black, so both are under it — which is the whole reason the border flood
# is doing the work instead of this number.
DARK = 44

MAGENTA = (255, 0, 255)

# A keyed share outside this band is not a background. Too little means the flood never got going and the
# icons are about to come out as black squares; too much means the sheet is nearly empty and something is
# wrong upstream. Both are worth stopping for, because both produce output that looks plausible in a folder
# listing and is useless in the game.
MIN_SHARE = 0.25
MAX_SHARE = 0.95


def background_mask(rgb):
    """True where a pixel is background: near-black and reachable from the border.

    rgb is an (h, w, 3) uint8 array. Returns an (h, w) bool array.
    """
    height, width = rgb.shape[0], rgb.shape[1]
    dark = rgb.max(axis=2) <= DARK

    seen = np.zeros((height, width), dtype=bool)
    queue = deque()

    def seed(y, x):
        if dark[y, x] and not seen[y, x]:
            seen[y, x] = True
            queue.append((y, x))

    for x in range(width):
        seed(0, x)
        seed(height - 1, x)
    for y in range(height):
        seed(y, 0)
        seed(y, width - 1)

    while queue:
        y, x = queue.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < height and 0 <= nx < width:
                seed(ny, nx)

    return seen


def key(rgb):
    """Return (keyed image, keyed share). Raises ValueError when the share is not a background."""
    mask = background_mask(rgb)
    share = float(mask.sum()) / float(rgb.shape[0] * rgb.shape[1])
    if not (MIN_SHARE <= share <= MAX_SHARE):
        raise ValueError("refusing: keyed share %.2f is not a background" % share)
    out = rgb.copy()
    out[mask] = MAGENTA
    return out, share


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    src, dst = argv
    rgb = np.array(Image.open(src).convert("RGB"))
    try:
        out, share = key(rgb)
    except ValueError as problem:
        print(str(problem), file=sys.stderr)
        return 2
    Image.fromarray(out).save(dst)
    print("keyed %.1f%% of the sheet as background -> %s" % (100.0 * share, dst))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
