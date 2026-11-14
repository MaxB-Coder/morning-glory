"""Backtest the first-recommendation against a real exported backup.

Read-only: replays each bag's first brew with only the history that existed
before it, and compares the recommendation with the grind that settled.

    python3 scripts/backtest.py path/to/morning-glory-backup.json [--method espresso]
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from datetime import datetime, timedelta

# Make `engine` importable whichever directory this is run from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.recommend import recommend  # noqa: E402

SETTLE_WINDOW_DAYS = 10.0


def _t(brew):
    """Brew time as a naive datetime (zone dropped, as the engine does)."""
    raw = str(brew["createdAt"]).replace("Z", "+00:00")
    return datetime.fromisoformat(raw).replace(tzinfo=None)


def backtest(data: dict, method: str = "espresso") -> list[dict]:
    grinder = data["grinder"]
    coffees = [c for c in data.get("coffees", []) if not c.get("deleted")]
    brews = [b for b in data.get("brews", []) if not b.get("deleted") and b.get("createdAt")]
    names = {str(c["id"]): c.get("name", "") for c in coffees}

    firsts = []
    for c in coffees:
        mine = sorted((b for b in brews
                       if str(b["coffeeId"]) == str(c["id"]) and b.get("method") == method),
                      key=_t)
        if mine:
            firsts.append((c, mine))
    firsts.sort(key=lambda cm: _t(cm[1][0]))

    rows = []
    for c, mine in firsts:
        first = mine[0]
        t0 = _t(first)
        truth = next((b["grindSetting"] for b in mine
                      if b.get("verdict") == "good"
                      and _t(b) - t0 <= timedelta(days=SETTLE_WINDOW_DAYS)), None)
        if truth is None:
            continue
        history = [b for b in brews if _t(b) < t0]
        rec = recommend({"grinder": grinder, "coffees": coffees, "brews": history,
                         "request": {"coffeeId": c["id"], "method": method}},
                        today=t0.date())["setting"]
        rows.append({"date": t0.date().isoformat(), "coffee": names[str(c["id"])],
                     "recommended": rec, "used": first["grindSetting"],
                     "settled": truth, "error": rec - truth})
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("backup")
    ap.add_argument("--method", default="espresso")
    args = ap.parse_args(argv)
    try:
        with open(args.backup) as f:
            data = json.load(f)
        rows = backtest(data, args.method)
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f"Cannot read backup {args.backup}: {e}")
        sys.exit(1)

    if not rows:
        print("No bags with a good first-week brew to test.")
        return
    for r in rows:
        print(f"{r['date']}  {r['coffee']}: recommended {r['recommended']}, "
              f"used {r['used']}, settled {r['settled']}, error {r['error']:+.2f}")
    errs = [r["error"] for r in rows]
    low = sum(1 for e in errs if e < 0) / len(errs)
    print(f"bags {len(rows)}  mean error {statistics.mean(errs):+.2f}  "
          f"median {statistics.median(errs):+.2f}  "
          f"mean abs {statistics.mean(abs(e) for e in errs):.2f}  "
          f"started too fine {low:.0%}")


if __name__ == "__main__":
    main()
