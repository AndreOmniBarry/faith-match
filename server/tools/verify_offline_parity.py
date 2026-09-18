"""Check that the offline fallback builds the same level the server does.

js/content.js generates levels when the API is unreachable. It cannot
reproduce this module's random draws — it seeds a mulberry32 from a string
hash where the server seeds Python's Mersenne Twister from a sha256, and two
different generators cannot be made to emit the same stream. That was
tolerable while the only things drawn offline were a veil layout and which two
symbols to gather: a player who dropped offline got a different-looking level
of the same difficulty.

It stopped being tolerable once an era started drawing the objective, the
board's shape and the level's name. Those are the level's identity, and
"Collect 3 Crowns" turning into "Set off 3 chains" because a request timed out
is a different level. So both sides compute those through the same 32-bit hash
(_hash32 here, hashSeed there), and this checks that they agree — field by
field, level by level, across the endless range.

    node server/tools/dump_offline_levels.mjs > /tmp/offline.json
    python3 server/tools/verify_offline_parity.py /tmp/offline.json

Fields deliberately NOT compared, because they are still drawn from each
side's own generator and always have been: the veil layout, which symbols a
collect level chases, the shrink cells, and the score target (the server
calibrates it by simulation, the client approximates it by formula — that gap
is what verify_offline_goals.py measures instead).
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import level_gen as lg  # noqa: E402

FIELDS = ("objective", "rows", "cols", "colors", "moves", "name", "timedSeconds")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    with open(sys.argv[1]) as fh:
        offline = json.load(fh)

    checked = 0
    skipped = 0
    mismatches = []
    for key, off in sorted(offline.items()):
        mode, index = key.rsplit(":", 1)
        index = int(index)
        chapter = index // lg.CHAPTER_SIZE + 1
        slot = index % lg.CHAPTER_SIZE
        if chapter < lg.ENDLESS_START_CHAPTER and slot >= lg.CHAPTER_SIZE - 3:
            # A stage finale below the endless range draws its modifiers from
            # each side's own generator and always has. They cannot be brought
            # into line the way the endless ones were: a finale's modifiers
            # set its move budget, its palette and its target, so changing how
            # they are drawn moves the stars of every player who has cleared
            # one. Counted and reported, not failed.
            skipped += 1
            continue
        srv = lg.get_level(mode, index)
        checked += 1
        diffs = [f"{f}: server {srv.get(f)!r} vs offline {off.get(f)!r}"
                 for f in FIELDS if srv.get(f) != off.get(f)]
        srv_mask = sorted(tuple(c) for c in (srv.get("mask") or []))
        off_mask = sorted(tuple(c) for c in (off.get("mask") or []))
        if srv_mask != off_mask:
            diffs.append(f"mask: server {len(srv_mask)} cells vs offline {len(off_mask)}")
        if sorted(srv.get("twists") or []) != sorted(off.get("twists") or []):
            diffs.append(f'twists: server {srv.get("twists")} vs offline {off.get("twists")}')
        srv_era = (srv.get("era") or {}).get("title")
        off_era = (off.get("era") or {}).get("title")
        if srv_era != off_era:
            diffs.append(f"era: server {srv_era!r} vs offline {off_era!r}")
        if diffs:
            mismatches.append(f"{key}  " + "; ".join(diffs[:4]))

    if mismatches:
        print(f"FAIL: {len(mismatches)} of {checked} levels differ "
              f"({skipped} pre-endless finales skipped)")
        for line in mismatches[:40]:
            print("  " + line)
        if len(mismatches) > 40:
            print(f"  ... and {len(mismatches) - 40} more")
        return 1
    print(f"OK: all {checked} levels match the server on "
          f"{', '.join(FIELDS)}, mask, twists and era")
    print(f"     ({skipped} pre-endless stage finales skipped — see the "
          f"comment above; their modifiers are part of levels already played)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
