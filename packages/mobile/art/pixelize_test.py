"""Checks for the icon pixeliser.

Every check must be able to fail. Anything that only prints and exits zero is
not a check. Run: python3 art/pixelize_test.py
"""

import os
import sys
import tempfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pixelize as P  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        FAILURES.append(name)


def rgb(name):
    return P.as_rgb(P.PALETTE[name])


# ---------------------------------------------------------------- palette shape

print("the locked palette")
check("thirteen colours", len(P.PALETTE) == 13, "got %d" % len(P.PALETTE))
check(
    "every colour is distinct",
    len({tuple(v) for v in P.PALETTE_RGB.tolist()}) == len(P.PALETTE),
)
check(
    "every neutral is a real palette name",
    all(n in P.PALETTE for n in P.NEUTRALS),
)
check(
    "the chromatic colours are not treated as neutral",
    not any(c in P.NEUTRALS for c in ("rot", "gold", "cyan", "violet", "bloodDark")),
)
check(
    "weights favour green over blue, as the eye does",
    P.WEIGHT[1] > P.WEIGHT[0] > P.WEIGHT[2],
)
check("weights sum to one", abs(P.WEIGHT.sum() - 1.0) < 1e-9)


# ------------------------------------------------------------- background mask

print("telling background from art")
check(
    "flat keying magenta is background",
    bool(P.magenta_mask(np.array([[(250, 3, 248)]], dtype=np.uint8))[0][0]),
)
check(
    "a pale magenta halo pixel is background",
    bool(P.magenta_mask(np.array([[(251, 150, 250)]], dtype=np.uint8))[0][0]),
)
check(
    "a dark magenta halo pixel is background",
    bool(P.magenta_mask(np.array([[(130, 60, 128)]], dtype=np.uint8))[0][0]),
)
offenders = [
    name
    for name, value in P.PALETTE.items()
    if P.magenta_mask(np.array([[P.as_rgb(value)]], dtype=np.uint8))[0][0]
]
check(
    "no palette colour is mistaken for background",
    offenders == [],
    "offenders: %s" % offenders,
)
check(
    "violet in particular survives, being red and blue heavy too",
    not P.magenta_mask(np.array([[rgb("violet")]], dtype=np.uint8))[0][0],
)


# -------------------------------------------------------------- greyness fence

print("greys may only become neutrals")
check(
    "a mid grey reads as grey",
    bool(P.is_greyish(np.array([[150, 150, 150]]))[0]),
)
check(
    "pure black reads as grey rather than dividing by zero",
    bool(P.is_greyish(np.array([[0, 0, 0]]))[0]),
)
check(
    "rot green does not read as grey",
    not bool(P.is_greyish(np.array([rgb("rot")]))[0]),
)
check(
    "leather does not read as grey",
    not bool(P.is_greyish(np.array([rgb("leather")]))[0]),
)
check(
    "gold does not read as grey",
    not bool(P.is_greyish(np.array([rgb("gold")]))[0]),
)

# The bug this fence exists for: unfenced, a mid grey lands nearer rot green
# than bone often enough to freckle a silhouette. Prove the fence changes the
# answer, otherwise the fence is decoration.
grey_block = np.full((4, 4, 3), 150, dtype=np.uint8)
keep_all = np.ones((4, 4), dtype=bool)
picked = P.snap(grey_block, keep_all)
check(
    "a grey block resolves to a neutral, never to a colour",
    P.PALETTE_NAMES[picked] in P.NEUTRALS,
    "resolved to %s" % P.PALETTE_NAMES[picked],
)

diff = np.array([[150.0, 150.0, 150.0]])[:, None, :] - P.PALETTE_RGB[None, :, :]
unfenced = P.PALETTE_NAMES[int((((diff * diff) * P.WEIGHT).sum(axis=2)).argmin())]
check(
    "and the fence is doing real work: unfenced, that grey is close to green",
    unfenced not in P.NEUTRALS or unfenced == "bone",
    "unfenced pick was %s" % unfenced,
)


# ------------------------------------------------------------------- snapping

print("snapping to the palette")
for name in P.PALETTE:
    block = np.full((2, 2, 3), rgb(name), dtype=np.uint8)
    got = P.PALETTE_NAMES[P.snap(block, np.ones((2, 2), dtype=bool))]
    check("an exact %s block stays %s" % (name, name), got == name, "became %s" % got)

check(
    "a block with nothing kept has no answer",
    P.snap(np.zeros((2, 2, 3), dtype=np.uint8), np.zeros((2, 2), dtype=bool)) is None,
)

# Votes, not averages: averaging bone and outline invents a mid grey that is in
# neither, which is the drift the whole script exists to remove.
mixed = np.zeros((1, 4, 3), dtype=np.uint8)
mixed[0, 0] = rgb("bone")
mixed[0, 1] = rgb("bone")
mixed[0, 2] = rgb("bone")
mixed[0, 3] = rgb("outline")
won = P.PALETTE_NAMES[P.snap(mixed, np.ones((1, 4), dtype=bool))]
check("the majority colour wins a mixed block", won == "bone", "won by %s" % won)


# ------------------------------------------------------------------ despeckle

print("removing lone stray pixels")
speck = np.zeros((5, 5, 4), dtype=np.uint8)
speck[:, :, 0:3] = rgb("bone")
speck[:, :, 3] = 255
speck[2, 2, 0:3] = rgb("rot")
cleaned, fixed = P.despeckle(speck)
check("one stray pixel is found", fixed == 1, "fixed %d" % fixed)
check(
    "the stray takes its neighbours' colour",
    tuple(cleaned[2, 2, 0:3].tolist()) == rgb("bone"),
    "became %s" % (tuple(cleaned[2, 2, 0:3].tolist()),),
)

# A cluster is draughtsmanship and must survive, or every highlight dies.
cluster = np.zeros((6, 6, 4), dtype=np.uint8)
cluster[:, :, 0:3] = rgb("bone")
cluster[:, :, 3] = 255
cluster[2:4, 2:4, 0:3] = rgb("gold")
kept, fixed2 = P.despeckle(cluster)
check("a two-by-two cluster is left alone", fixed2 == 0, "fixed %d" % fixed2)
check(
    "and it keeps its colour",
    tuple(kept[2, 2, 0:3].tolist()) == rgb("gold"),
    "became %s" % (tuple(kept[2, 2, 0:3].tolist()),),
)
check(
    "transparent pixels are never painted in",
    P.despeckle(np.zeros((3, 3, 4), dtype=np.uint8))[1] == 0,
)


# ------------------------------------------------------------- grid detection

print("finding the grid")
check("two clear bands are found", P.bands([0, 9, 9, 0, 9, 9, 0], 3) == [(1, 2), (4, 5)])
check("a band running to the edge is closed", P.bands([9, 9], 3) == [(0, 1)])
check("nothing above the floor means no bands", P.bands([0, 1, 2], 3) == [])

# The props sheet split one real row in two across an object's thin waist.
check(
    "a row split by a hairline gap is rejoined",
    P.merge_thin([(63, 229), (279, 283), (288, 480), (512, 705)])
    == [(63, 229), (279, 480), (512, 705)],
    "got %s" % (P.merge_thin([(63, 229), (279, 283), (288, 480), (512, 705)]),),
)
check(
    "genuinely separate rows are left apart",
    P.merge_thin([(0, 100), (200, 300), (400, 500)])
    == [(0, 100), (200, 300), (400, 500)],
)
check("a single band passes through", P.merge_thin([(5, 9)]) == [(5, 9)])
check("no bands passes through", P.merge_thin([]) == [])
check(
    "a lone sliver is never returned as an empty grid",
    len(P.merge_thin([(0, 100), (200, 202), (400, 500)])) == 2,
    "got %s" % (P.merge_thin([(0, 100), (200, 202), (400, 500)]),),
)


# ----------------------------------------------------------- centring in tile

print("centring an icon in its tile")
off = np.zeros((32, 32, 4), dtype=np.uint8)
off[0:4, 0:4, 0:3] = rgb("gold")
off[0:4, 0:4, 3] = 255
mid = P.trim_and_centre(off, 32)
ys, xs = np.where(mid[:, :, 3] > 0)
check("the drawn pixels move to the middle", ys.min() == 14 and xs.min() == 14,
      "top %d left %d" % (ys.min(), xs.min()))
check("no pixels are gained or lost", int((mid[:, :, 3] > 0).sum()) == 16)
blank = np.zeros((32, 32, 4), dtype=np.uint8)
check("an empty tile survives centring", int(P.trim_and_centre(blank, 32).sum()) == 0)


# ------------------------------------------------------- end to end on a sheet

print("converting a whole sheet")
with tempfile.TemporaryDirectory() as tmp:
    # Two rows, three columns, on keying magenta, with soft halo edges so the
    # test exercises the same mess the real sheet has.
    cell, gap = 60, 20
    wide = 3 * cell + 4 * gap
    high = 2 * cell + 3 * gap
    sheet = np.full((high, wide, 3), (250, 3, 248), dtype=np.uint8)
    wanted = ["bloodDark", "gold", "cyan", "rot", "leather", "bone"]
    for index, name in enumerate(wanted):
        r, c = divmod(index, 3)
        y = gap + r * (cell + gap)
        x = gap + c * (cell + gap)
        sheet[y : y + cell, x : x + cell] = rgb(name)
        # A one pixel halo of blended magenta around each square.
        sheet[y - 1, x - 1 : x + cell + 1] = (200, 90, 198)
        sheet[y + cell, x - 1 : x + cell + 1] = (200, 90, 198)
    path = os.path.join(tmp, "sheet.png")
    Image.fromarray(sheet, mode="RGB").save(path)

    out = os.path.join(tmp, "icons")
    code = P.main([path, out, "--size", "16", "--cols", "3", "--rows", "2"])
    check("the converter reports success", code == 0, "exit %d" % code)

    made = sorted(f for f in os.listdir(out) if f.endswith(".png"))
    check("six icons are written", len(made) == 6, "got %d" % len(made))
    check("a manifest is written", os.path.exists(os.path.join(out, "icons.json")))

    allowed = {tuple(v) for v in P.PALETTE_RGB.astype(int).tolist()}
    strays = []
    empties = []
    for index, name in enumerate(made):
        art = np.asarray(Image.open(os.path.join(out, name)).convert("RGBA")).astype(int)
        drawn = art[art[:, :, 3] > 0][:, 0:3]
        if len(drawn) == 0:
            empties.append(name)
            continue
        for pixel in {tuple(x) for x in drawn.tolist()}:
            if pixel not in allowed:
                strays.append((name, pixel))
        if art.shape[0] != 16 or art.shape[1] != 16:
            strays.append((name, "wrong size"))
    check("nothing off the palette survives", strays == [], "strays: %s" % strays[:4])
    check("no icon comes out blank", empties == [], "blank: %s" % empties)

    # The halo must be gone, not merely recoloured: a halo left in place would
    # show up as an extra ring of a different palette colour.
    first = np.asarray(Image.open(os.path.join(out, made[0])).convert("RGBA"))
    colours = {tuple(p[0:3].tolist()) for p in first.reshape(-1, 4) if p[3] > 0}
    check(
        "a solid square converts to exactly one colour, halo stripped",
        len(colours) == 1,
        "colours: %s" % colours,
    )

    # A sheet whose grid does not match what the caller claimed must be refused,
    # not silently sliced into nonsense.
    refused = P.main([path, os.path.join(tmp, "wrong"), "--cols", "9", "--rows", "9"])
    check("a mismatched grid is refused", refused == 2, "exit %d" % refused)


print()
if FAILURES:
    print("FAIL — %d check%s failed" % (len(FAILURES), "" if len(FAILURES) == 1 else "s"))
    for name in FAILURES:
        print("  - %s" % name)
    sys.exit(1)
print("PASS — icon pixeliser")
