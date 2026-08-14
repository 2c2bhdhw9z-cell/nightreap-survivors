"""Checks for the black-background keyer.

Every check must be able to fail, and the file exits non-zero when any of them does. Anything that only
prints and exits zero is not a check.

Run: python3 art/key_black_test.py
"""

import os
import sys
import tempfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import key_black as K  # noqa: E402
import pixelize as P  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        FAILURES.append(name)


def blank(height=40, width=40):
    """A black sheet with nothing drawn on it."""
    return np.zeros((height, width, 3), dtype=np.uint8)


def ring(sheet, top, left, size, colour=(200, 190, 160), fill=None):
    """Draw a hollow square outline, optionally filled.

    The outline defaults to a bright bone colour on purpose: the keyer can only protect dark pixels that
    something bright stands between and the border, so a drawing that is dark all the way to its own edge
    is a drawing whose rim is background as far as any flood can tell.
    """
    bottom, right = top + size - 1, left + size - 1
    sheet[top : bottom + 1, left] = colour
    sheet[top : bottom + 1, right] = colour
    sheet[top, left : right + 1] = colour
    sheet[bottom, left : right + 1] = colour
    if fill is not None:
        sheet[top + 1 : bottom, left + 1 : right] = fill
    return sheet


# -------------------------------------------------------------------- the mask

print("finding the background")

sheet = ring(blank(), 10, 10, 16, fill=(0, 0, 0))
mask = K.background_mask(sheet)

check("the border itself is background", bool(mask[0, 0]) and bool(mask[39, 39]))
check(
    "the drawn outline is not background",
    not bool(mask[10, 10]) and not bool(mask[25, 25]),
    "a drawn pixel was keyed away",
)
check(
    "black enclosed by an outline is not background",
    not bool(mask[17, 17]),
    "the flood leaked inside a closed shape",
)

# The honest limitation, written down as a check so nobody later assumes otherwise: near-black that runs
# all the way out to the black background is background as far as any flood can tell. The generated sheets
# draw bright silhouettes on black, so what is lost is at most the outermost dark rim.
rim = ring(blank(), 10, 10, 16, colour=(11, 10, 16), fill=(0, 0, 0))
check(
    "a dark rim touching the background is keyed with it",
    bool(K.background_mask(rim)[10, 10]),
    "if this ever passes the other way the docstring is wrong",
)
check(
    "black outside the drawing is background",
    bool(mask[5, 5]) and bool(mask[30, 5]),
)

# The flood must not squeeze through a corner touch. Two dark blocks meeting only diagonally are separate.
diagonal = ring(blank(20, 20), 6, 6, 8, fill=(0, 0, 0))
diagonal[6, 6] = (0, 0, 0)  # one dark corner pixel, so outside and inside touch diagonally only
corner_mask = K.background_mask(diagonal)
check(
    "the flood does not squeeze through a diagonal gap",
    not bool(corner_mask[9, 9]),
    "background leaked through a corner",
)

# The border is seeded on all four edges. A sheet drawn with bright bands across the top and bottom rows
# leaves the background reachable only from the left and right edges, and a keyer that only looks at rows
# would call the whole middle a drawing.
sides = blank(20, 20)
sides[0, :] = (200, 190, 160)
sides[19, :] = (200, 190, 160)
side_mask = K.background_mask(sides)
check(
    "background reachable only from the side edges is still found",
    bool(side_mask[10, 0]) and bool(side_mask[10, 10]),
    "the left and right edges are not being seeded",
)

bright = blank(20, 20)
bright[:, :] = (200, 30, 40)
check(
    "a sheet with no dark pixels keys nothing",
    int(K.background_mask(bright).sum()) == 0,
)

lit = blank(20, 20)
lit[:, :] = (60, 60, 60)
check(
    "grey above the dark limit is not background",
    int(K.background_mask(lit).sum()) == 0,
    "DARK is letting mid-grey through",
)

# ------------------------------------------------------------------- the repaint

print("repainting")

sheet = ring(blank(), 10, 10, 16, fill=(90, 40, 30))
keyed, share = K.key(sheet)

check("background becomes magenta", tuple(keyed[0, 0].tolist()) == K.MAGENTA)
check("the outline is untouched", tuple(keyed[10, 10].tolist()) == (200, 190, 160))
check("the fill is untouched", tuple(keyed[17, 17].tolist()) == (90, 40, 30))
check("the input array is not modified", tuple(sheet[0, 0].tolist()) == (0, 0, 0))
check("the share is reported", 0.5 < share < 0.95, "got %.3f" % share)
check("shape is preserved", keyed.shape == sheet.shape)

# The magenta the keyer writes must be magenta as far as the pixeliser is concerned, or the two halves of
# the pipeline disagree and every icon comes out with a pink halo baked in.
check(
    "the pixeliser reads the keyed background as background",
    bool(P.magenta_mask(keyed)[0, 0]) and not bool(P.magenta_mask(keyed)[17, 17]),
)

# --------------------------------------------------------------------- refusals

print("refusing what is not a background")

full = blank(20, 20)
full[:, :] = (200, 200, 200)
refused = False
try:
    K.key(full)
except ValueError:
    refused = True
check("a sheet with no background is refused", refused)

empty = blank(20, 20)
refused = False
try:
    K.key(empty)
except ValueError:
    refused = True
check("an entirely empty sheet is refused", refused, "nothing was drawn on it")

# ------------------------------------------------------------- the command line

print("the command line")

with tempfile.TemporaryDirectory() as folder:
    src = os.path.join(folder, "in.png")
    dst = os.path.join(folder, "out.png")
    Image.fromarray(ring(blank(), 10, 10, 16, fill=(90, 40, 30))).save(src)
    code = K.main([src, dst])
    check("a good sheet exits zero", code == 0, "got %s" % code)
    check("the output file is written", os.path.exists(dst))
    written = np.array(Image.open(dst).convert("RGB"))
    check("the written file is keyed", tuple(written[0, 0].tolist()) == K.MAGENTA)
    check("the written outline survived", tuple(written[10, 10].tolist()) == (200, 190, 160))

    bad = os.path.join(folder, "bad.png")
    Image.fromarray(np.full((20, 20, 3), 200, dtype=np.uint8)).save(bad)
    out = os.path.join(folder, "bad-out.png")
    check("a refused sheet exits non-zero", K.main([bad, out]) != 0)
    check("a refused sheet writes nothing", not os.path.exists(out))
    check("wrong arguments exit non-zero", K.main([src]) != 0)

print()
if FAILURES:
    print("FAIL — black-background keyer: %d check%s failed" % (len(FAILURES), "" if len(FAILURES) == 1 else "s"))
    raise SystemExit(1)
print("PASS — black-background keyer")
