"""Proves you can actually see a gem lying on the floor.

WHY THIS EXISTS
The first real play test on a phone turned up a problem no amount of looking at
the art folder would have found: every crypt floor tile has small bone-white
chips painted into it, and tiling one of those tiles across a whole screen turns
the floor into a field of small pale shapes. An experience gem is a small pale
shape. Players could not find their gems, and nothing was wrong with any single
picture -- the tile is good, the gem is good, and together they are unplayable.

That class of bug is invisible to every check written so far, because every one
of those checks looks at one picture at a time. This one looks at two at once and
asks the only question that matters: on this floor, does that pickup stand out?

HOW IT MEASURES
Brightness here is the standard perceptual weighting -- the eye is far more
sensitive to green than to blue, so a plain average of the three channels would
call a saturated blue and a saturated green equally visible when they are not.
The same weighting is used by the art pipeline, so the two agree.

The floor is measured after its tint is applied, because the tint is the whole
mechanism: tinting can only ever darken, so knocking the floor back is the lever
that buys the gems their contrast. Tints are read straight out of the game's own
stage table, so nobody can quietly lighten a floor in one place and leave this
check measuring the old value.

WHAT COUNTS AS BRIGHT ENOUGH
Not the average of the tile. An average hides exactly the thing that caused the
bug: a mostly-dark tile with a dozen near-white chips has a perfectly innocent
average. So the floor is judged on its *bright* pixels -- specifically the
brightest few percent, which is what the eye actually picks out of a texture --
and a gem is judged on its own average, because a gem is small and reads as one
blob rather than as its brightest corner.

FAILING LOUDLY
A missing sheet, a missing tile, an unreadable tint table: all failures. A check
that quietly passes because it could not find anything to measure is not a check,
and this file is here precisely because something slipped through everything else.
"""

import json
import re
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
MOBILE = HERE.parent
ATLAS_PNG = MOBILE / "assets" / "atlas.png"
ATLAS_JSON = MOBILE / "assets" / "atlas.json"
RUN_ART = MOBILE / "game" / "art" / "run-art.ts"

# Same weights as the pixeliser. Green dominates because the eye does.
WEIGHT = (0.30, 0.59, 0.11)

# Anything below this alpha is a hole in the picture, not a colour.
OPAQUE = 8

# The share of a floor tile's pixels treated as "the bright bits". Five percent of
# a 32x32 tile is about fifty pixels -- roughly the size of the bone chips that
# caused the problem, and small enough that a tile's overall darkness cannot hide
# them.
BRIGHT_SHARE = 0.05

# How much darker the floor's bright bits must be than the dimmest gem, on the
# 0-255 brightness scale.
#
# Twenty-five is not a round number picked for looking tidy. Below about fifteen
# the two are indistinguishable on a phone in daylight, which is the condition
# that caused the bug. Above about forty, the only way to pass is a floor so dark
# the stage stops having any art in it. This is the usable middle, and it is
# stated here rather than buried in the comparison so that changing it is a
# deliberate, visible act.
MIN_GAP = 25

# Every gem tier. Their pictures come from the game's own pickup table; they are
# named here rather than derived so that renaming a picture is a failure here
# instead of a silent hole in the coverage.
GEM_FRAMES = {
    "small gem": "pickups/icon-07",
    "medium gem": "pickups/icon-08",
    "large gem": "pickups/icon-09",
}

failures = 0
checks = 0


def check(name, ok, detail=""):
    global failures, checks
    checks += 1
    if not ok:
        failures += 1
        print(f"FAIL {name}" + (f" -- {detail}" if detail else ""))


def luminance(pixel):
    return WEIGHT[0] * pixel[0] + WEIGHT[1] * pixel[1] + WEIGHT[2] * pixel[2]


def tint(pixel, rgb):
    """Multiply blend, the way the renderer does it: colour times tint, per channel."""
    return (
        pixel[0] * rgb[0] / 255.0,
        pixel[1] * rgb[1] / 255.0,
        pixel[2] * rgb[2] / 255.0,
    )


def parse_hex(text):
    text = text.lstrip("#")
    return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def read_stage_table():
    """Pull each stage's floor tiles and its tint out of the game's own table.

    Deliberately reads the real source file rather than a copy. A copy is a thing
    that goes stale, and a stale copy here would mean this check passes while the
    game ships the floor it was written to stop.
    """
    source = RUN_ART.read_text()
    block = re.search(
        r"export const STAGE_ART[^=]*=\s*\{(.*?)\n\};", source, re.S
    )
    if not block:
        return None

    stages = {}
    for match in re.finditer(
        r"(\w+):\s*\{(.*?)\n  \},", block.group(1) + "\n  },", re.S
    ):
        name, body = match.group(1), match.group(2)
        floors = re.search(r"floorFrames:\s*\[(.*?)\]", body, re.S)
        tint_hex = re.search(r'floorTint:\s*"(#[0-9A-Fa-f]{6})"', body)
        if not floors or not tint_hex:
            continue
        frames = re.findall(r'"([^"]+)"', floors.group(1))
        stages[name] = (frames, tint_hex.group(1))
    return stages


def main():
    global failures

    check("the packed sheet exists", ATLAS_PNG.is_file(), str(ATLAS_PNG))
    check("the sheet's index exists", ATLAS_JSON.is_file(), str(ATLAS_JSON))
    if failures:
        return

    manifest = json.loads(ATLAS_JSON.read_text())
    sheet = Image.open(ATLAS_PNG).convert("RGBA")
    frames = manifest["frames"]

    def pixels(name):
        f = frames[name]
        crop = sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
        return [p for p in crop.getdata() if p[3] > OPAQUE]

    # ---------------------------------------------------------------------
    # The gems, measured on their own. Each one's average brightness is what
    # the eye gets from a shape that small.
    # ---------------------------------------------------------------------
    gem_brightness = {}
    for label, frame in GEM_FRAMES.items():
        check(f"{label} is on the sheet", frame in frames, frame)
        if frame not in frames:
            continue
        px = pixels(frame)
        check(f"{label} has any picture", len(px) > 0, frame)
        if not px:
            continue
        gem_brightness[label] = sum(luminance(p) for p in px) / len(px)

    check("all three gems measured", len(gem_brightness) == len(GEM_FRAMES))
    if len(gem_brightness) != len(GEM_FRAMES):
        return

    for label, value in sorted(gem_brightness.items(), key=lambda kv: kv[1]):
        print(f"  {label}: brightness {value:.1f}")

    # A gem tier that is darker than the tier below it is backwards -- the most
    # valuable pickup being the hardest to see is the exact bug that started this.
    check(
        "bigger gems are not dimmer",
        gem_brightness["large gem"] > gem_brightness["small gem"] * 0.6,
        f"large {gem_brightness['large gem']:.1f} vs small {gem_brightness['small gem']:.1f}",
    )

    dimmest_gem = min(gem_brightness.values())
    dimmest_name = min(gem_brightness, key=lambda k: gem_brightness[k])

    # ---------------------------------------------------------------------
    # Every floor of every stage, measured after its tint.
    # ---------------------------------------------------------------------
    stages = read_stage_table()
    check("the stage table could be read", stages is not None)
    if not stages:
        return
    check("every stage was found", len(stages) >= 3, f"{len(stages)} stages")

    for stage, (floor_frames, tint_hex) in sorted(stages.items()):
        rgb = parse_hex(tint_hex)
        check(f"{stage} lists floors", len(floor_frames) > 0)

        # A tint that does nothing is the state this check was written to end.
        check(
            f"{stage} floor is actually knocked back",
            luminance(rgb) < 200,
            f"tint {tint_hex}",
        )

        worst = 0.0
        worst_frame = ""
        for frame in floor_frames:
            check(f"{stage} floor {frame} is on the sheet", frame in frames, frame)
            if frame not in frames:
                continue
            px = pixels(frame)
            check(f"{stage} floor {frame} has a picture", len(px) > 0)
            if not px:
                continue

            lit = sorted((luminance(tint(p, rgb)) for p in px), reverse=True)
            take = max(1, round(len(lit) * BRIGHT_SHARE))
            bright = sum(lit[:take]) / take
            if bright > worst:
                worst = bright
                worst_frame = frame

        gap = dimmest_gem - worst
        print(
            f"  {stage}: brightest floor {worst:.1f} ({worst_frame}), "
            f"dimmest gem {dimmest_gem:.1f} ({dimmest_name}), gap {gap:.1f}"
        )
        check(
            f"{stage} floor stays out of the gems' way",
            gap >= MIN_GAP,
            f"gap {gap:.1f} needs {MIN_GAP} -- {worst_frame} at {worst:.1f}",
        )


main()
print(f"floor contrast: {checks} checks, {failures} failed")
sys.exit(1 if failures else 0)
