"""Checks for the atlas packer.

Every check must be able to fail. Anything that only prints and exits zero is
not a check. Run: python3 art/pack_test.py
"""

import hashlib
import json
import os
import sys
import tempfile

import numpy as np
from PIL import Image

# Never import a cached compile of the packer. A saved .pyc is matched against its source by timestamp
# and size, so a harness that edits the packer, runs it, and puts the original back with the same
# timestamp can leave a compiled copy of the EDITED packer behind — and the next run tests that copy
# instead of the file on disk. That once made a passing packer report an impossible sheet size.
sys.dont_write_bytecode = True

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pack as K  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        FAILURES.append(name)


def solid(colour, size=K.CELL):
    """One flat opaque square, the simplest thing whose every pixel is known."""
    pixels = np.zeros((size, size, 4), dtype=np.uint8)
    pixels[:, :, 0] = colour[0]
    pixels[:, :, 1] = colour[1]
    pixels[:, :, 2] = colour[2]
    pixels[:, :, 3] = 255
    return pixels


def fake_art(root, sets, size=K.CELL):
    """A small art tree: {folder: count}. Each icon is a different flat colour."""
    made = []
    tone = 0
    for folder, count in sets.items():
        os.makedirs(os.path.join(root, folder), exist_ok=True)
        for index in range(count):
            tone += 7
            name = "icon-%02d" % (index + 1)
            path = os.path.join(root, folder, name + ".png")
            Image.fromarray(solid((tone % 256, (tone * 3) % 256, (tone * 5) % 256), size)).save(path)
            made.append((folder + "/" + name, path))
    return made


def digest(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


# ------------------------------------------------------------------ sheet sizes

print("what counts as a sheet we can bind")
check("thirty-two is a power of two", K.is_power_of_two(32))
check("thirty-four is not", not K.is_power_of_two(34))
check("zero is not a sheet size", not K.is_power_of_two(0))
check("every allowed sheet size is a power of two", all(K.is_power_of_two(p) for p in K.POWERS))
check("the gutter is one pixel", K.GUTTER == 1)
check("the cell is thirty-two", K.CELL == 32)


# ---------------------------------------------------------------------- layout

print("planning where each icon sits")
plan = K.plan_layout(4)
check("four icons fit somewhere", plan is not None)
width, height, spots = plan
check("the sheet is a power of two both ways", K.is_power_of_two(width) and K.is_power_of_two(height))
check("there is one spot per icon", len(spots) == 4, "got %d" % len(spots))
check("the first icon is inset by the gutter", spots[0] == (K.GUTTER, K.GUTTER), "%s" % (spots[0],))
pitch = K.CELL + K.GUTTER * 2
check(
    "neighbours sit a full pitch apart, gutter included",
    spots[1][0] - spots[0][0] == pitch,
    "%s vs %s" % (spots[0], spots[1]),
)

# Determinism is the whole reason the sheet can be committed to the repository.
check("the same count plans the same layout twice", K.plan_layout(40) == K.plan_layout(40))

big = K.plan_layout(238)
check("all the art we have today fits one sheet", big is not None)
if big is not None:
    bw, bh, bspots = big
    columns = bw // pitch
    rows = bh // pitch
    check("the chosen sheet has room to spare, not less", columns * rows >= 238)
    check(
        "and it is the smallest allowed sheet that does",
        not any(
            (w * h) < (bw * bh) and (w // pitch) * (h // pitch) >= 238
            for w in K.POWERS
            for h in K.POWERS
        ),
        "chose %dx%d" % (bw, bh),
    )
    check(
        "and the squarest of the sheets that tie on size",
        abs(bw - bh) <= min(
            abs(w - h)
            for w in K.POWERS
            for h in K.POWERS
            if w * h == bw * bh and (w // pitch) * (h // pitch) >= 238
        ),
        "chose %dx%d" % (bw, bh),
    )
    check("no planned spot repeats", len(set(bspots)) == len(bspots))
    check(
        "every planned icon lands wholly inside the sheet",
        all(x + K.CELL <= bw and y + K.CELL <= bh for x, y in bspots),
    )

check("nothing to pack is not a layout", K.plan_layout(0) is None)
check("a negative count is not a layout", K.plan_layout(-3) is None)
check(
    "more art than the largest sheet holds is refused, not squeezed",
    K.plan_layout(100_000) is None,
)
check(
    "an icon larger than every sheet is refused",
    K.plan_layout(1, cell=4096) is None,
)


# -------------------------------------------------------------------- discovery

print("finding the finished icons")
with tempfile.TemporaryDirectory() as tmp:
    fake_art(tmp, {"beta": 2, "alpha": 3})
    os.makedirs(os.path.join(tmp, "source"), exist_ok=True)
    Image.fromarray(solid((1, 2, 3), 64)).save(os.path.join(tmp, "source", "sheet-01.png"))
    Image.fromarray(solid((1, 2, 3))).save(os.path.join(tmp, "alpha", "_contact-sheet.png"))
    with open(os.path.join(tmp, "alpha", "icons.json"), "w") as handle:
        handle.write("{}")

    found = K.discover(tmp)
    names = [name for name, _ in found]
    check("only the finished icons are found", len(found) == 5, "got %s" % names)
    check("painted sources are not treated as icons", not any(n.startswith("source/") for n in names))
    check("contact sheets are left for human eyes", not any("_contact" in n for n in names))
    check("the manifest beside the icons is not an icon", not any(n.endswith("icons.json") for n in names))
    check("folders come back in a fixed order", names == sorted(names), "%s" % names)
    check("a name carries its set", names[0] == "alpha/icon-01", names[0])
    check("every path found exists", all(os.path.exists(p) for _, p in found))

real = K.discover(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "art"))
check("the real art folder is readable", len(real) > 0, "found %d" % len(real))
check(
    "every real icon is exactly the size the packer requires",
    all(K.load_cell(path) is not None for _, path in real),
    "sizes differ",
)


# ------------------------------------------------------------------ one icon in

print("reading one icon")
with tempfile.TemporaryDirectory() as tmp:
    right = os.path.join(tmp, "right.png")
    wrong = os.path.join(tmp, "wrong.png")
    Image.fromarray(solid((10, 20, 30))).save(right)
    Image.fromarray(solid((10, 20, 30), 31)).save(wrong)
    check("a correctly sized icon reads back", K.load_cell(right) is not None)
    check("an icon one pixel short is refused, not stretched", K.load_cell(wrong) is None)
    loaded = K.load_cell(right)
    check("it reads back with an alpha channel", loaded.shape == (K.CELL, K.CELL, 4), "%s" % (loaded.shape,))
    check("and with the colour it was written with", tuple(loaded[0, 0].tolist()) == (10, 20, 30, 255))


# -------------------------------------------------------------------- composing

print("drawing the sheet")
cells = [solid((200, 0, 0)), solid((0, 200, 0))]
_, _, two = K.plan_layout(2)
sheet = K.compose(cells, two, 256, 256)
check("the sheet is the size asked for", sheet.shape == (256, 256, 4), "%s" % (sheet.shape,))
check(
    "each icon lands byte for byte where it was planned",
    np.array_equal(sheet[two[0][1] : two[0][1] + K.CELL, two[0][0] : two[0][0] + K.CELL], cells[0])
    and np.array_equal(sheet[two[1][1] : two[1][1] + K.CELL, two[1][0] : two[1][0] + K.CELL], cells[1]),
)
check("the gutter between two icons is nothing at all", sheet[0, 0, 3] == 0 and sheet[0, K.CELL + 1, 3] == 0)
check("the rest of the sheet is empty", int((sheet[:, :, 3] > 0).sum()) == 2 * K.CELL * K.CELL)


# --------------------------------------------------------------- manifest shape

print("the manifest")
frames = K.frames_of(["a/one", "a/two"], two)
check("one entry per icon", sorted(frames.keys()) == ["a/one", "a/two"])
check("a rect is pixels, top-left origin", frames["a/one"] == {"x": 1, "y": 1, "w": 32, "h": 32})
grouped = K.sets_of(["a/one", "b/one", "a/two"])
check("icons are grouped by their set", sorted(grouped.keys()) == ["a", "b"])
check("a set lists its own icons only", grouped["a"] == ["a/one", "a/two"], "%s" % grouped["a"])

check("two icons in the same place are reported", K.overlaps({"a": frames["a/one"], "b": dict(frames["a/one"])}) != [])
check("icons a pitch apart are not reported", K.overlaps(frames) == [])
check(
    "an icon hanging off the edge is reported",
    K.out_of_bounds({"a": {"x": 240, "y": 0, "w": 32, "h": 32}}, 256, 256) == ["a"],
)
check("an icon inside the sheet is not reported", K.out_of_bounds(frames, 256, 256) == [])


# ------------------------------------------------------------------ end to end

print("packing a whole folder")
with tempfile.TemporaryDirectory() as tmp:
    root = os.path.join(tmp, "art")
    out = os.path.join(tmp, "assets")
    made = fake_art(root, {"enemies": 5, "weapons": 4})
    code = K.main([root, out])
    check("packing succeeds", code == 0, "exit %d" % code)

    png = os.path.join(out, "atlas.png")
    manifest_path = os.path.join(out, "atlas.json")
    check("a sheet was written", os.path.exists(png))
    check("a manifest was written", os.path.exists(manifest_path))

    with open(manifest_path) as handle:
        manifest = json.load(handle)
    sheet = np.asarray(Image.open(png).convert("RGBA"))
    check(
        "the manifest describes the sheet that was written",
        manifest["width"] == sheet.shape[1] and manifest["height"] == sheet.shape[0],
    )
    check("every icon is in the manifest", len(manifest["frames"]) == len(made), "%d" % len(manifest["frames"]))
    check("the sets are listed", sorted(manifest["sets"].keys()) == ["enemies", "weapons"])

    wrong_pixels = []
    for name, path in made:
        rect = manifest["frames"][name]
        cut = sheet[rect["y"] : rect["y"] + rect["h"], rect["x"] : rect["x"] + rect["w"]]
        if not np.array_equal(cut, np.asarray(Image.open(path).convert("RGBA"))):
            wrong_pixels.append(name)
    check(
        "every icon survives the trip byte for byte",
        wrong_pixels == [],
        "changed: %s" % wrong_pixels[:4],
    )

    check(
        "no two icons were placed on top of each other",
        K.overlaps(manifest["frames"]) == [],
    )
    check(
        "nothing fell off the sheet",
        K.out_of_bounds(manifest["frames"], manifest["width"], manifest["height"]) == [],
    )
    check(
        "the art on the sheet is exactly the art that went in",
        int((sheet[:, :, 3] > 0).sum()) == len(made) * K.CELL * K.CELL,
    )

    # Committed output: a second run must produce identical bytes, or every run
    # of the packer would land as a two megabyte diff nobody can review.
    before_png = digest(png)
    before_json = digest(manifest_path)
    check("packing twice writes the same sheet", K.main([root, out]) == 0 and digest(png) == before_png)
    check("and the same manifest", digest(manifest_path) == before_json)

    # A single bad file must stop the whole write. A half-correct atlas that
    # shipped would draw one silently squashed sprite.
    Image.fromarray(solid((9, 9, 9), 16)).save(os.path.join(root, "enemies", "icon-06.png"))
    check("one wrongly sized icon refuses the whole pack", K.main([root, out]) == 2)
    check("and the good sheet is left untouched", digest(png) == before_png)

    check("an empty art folder is refused", K.main([os.path.join(tmp, "nothing-here"), out]) == 2)


print()
if FAILURES:
    print("FAIL — %d check%s failed" % (len(FAILURES), "" if len(FAILURES) == 1 else "s"))
    for name in FAILURES:
        print("  - %s" % name)
    sys.exit(1)
print("PASS — atlas packer")
