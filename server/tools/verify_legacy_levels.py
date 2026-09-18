"""Check that no level below the endless range has moved.

A level's score target is what its star thresholds hang off, and its collect
or veil goal is what "cleared" means, so changing either moves the progress of
every player already past that level. The endless-progression work in
level_gen.py adds eras, shaped boards, rotating objectives and new goal types
from ENDLESS_START_CHAPTER on, and the guarantee that comes with it is that
everything before that point generates exactly what it generated before —
not "close enough", the same bytes.

This is what checks that guarantee, level by level and mode by mode, against a
snapshot taken before the change:

    python3 server/tools/verify_legacy_levels.py snapshot  old-levels.json
    #  ... make the change ...
    python3 server/tools/verify_legacy_levels.py check     old-levels.json

`check` exits non-zero and prints the first differing field of every level
that moved. The range it covers ends at ENDLESS_START_CHAPTER, since that is
the whole set of levels the guarantee is about.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import level_gen as lg  # noqa: E402

MODES = ("grace-path", "harvest", "refiners-fire")
DAILY_DATES = ("2026-01-01", "2026-06-15", "2026-09-18", "2027-03-02")


def levels() -> dict:
    limit = (lg.ENDLESS_START_CHAPTER - 1) * lg.CHAPTER_SIZE
    out = {}
    for mode in MODES:
        for i in range(limit):
            out[f"{mode}:{i}"] = lg.get_level(mode, i)
    for date in DAILY_DATES:
        out[f"daily:{date}"] = lg.get_daily_level(date)
    return out


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] not in ("snapshot", "check"):
        print(__doc__)
        return 2
    action, path = sys.argv[1], sys.argv[2]
    limit = (lg.ENDLESS_START_CHAPTER - 1) * lg.CHAPTER_SIZE
    print(f"generating levels 0..{limit - 1} for {len(MODES)} modes "
          f"+ {len(DAILY_DATES)} dailies", flush=True)
    current = levels()

    if action == "snapshot":
        with open(path, "w") as fh:
            json.dump(current, fh, sort_keys=True)
        print(f"wrote {len(current)} levels to {path}")
        return 0

    with open(path) as fh:
        before = json.load(fh)

    moved = []
    for key in sorted(set(before) | set(current)):
        was, now = before.get(key), current.get(key)
        if was == now:
            continue
        fields = sorted(set(was or {}) | set(now or {}))
        diffs = [f"{f}: {(was or {}).get(f)!r} -> {(now or {}).get(f)!r}"
                 for f in fields if (was or {}).get(f) != (now or {}).get(f)]
        moved.append(f"{key}  " + "; ".join(diffs[:3]))

    if moved:
        print(f"FAIL: {len(moved)} of {len(current)} levels moved")
        for line in moved[:40]:
            print("  " + line)
        if len(moved) > 40:
            print(f"  ... and {len(moved) - 40} more")
        return 1
    print(f"OK: all {len(current)} levels below chapter "
          f"{lg.ENDLESS_START_CHAPTER} are byte-identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
