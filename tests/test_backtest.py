import importlib.util
import os

_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "scripts", "backtest.py")
_spec = importlib.util.spec_from_file_location("backtest", _PATH)
backtest_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(backtest_mod)


def _brew(cid, g, verdict, created):
    return {"coffeeId": cid, "method": "espresso", "grindSetting": g,
            "verdict": verdict, "createdAt": created}


def test_backtest_replays_first_brews():
    data = {
        "grinder": {"min": 1, "max": 90, "step": 0.1},
        "coffees": [
            {"id": 1, "name": "One", "roast": "medium", "process": "washed"},
            {"id": 2, "name": "Two", "roast": "medium", "process": "washed"},
        ],
        "brews": [
            _brew(1, 9.0, "over", "2026-10-01T08:00:00.000Z"),
            _brew(1, 10.0, "good", "2026-10-02T08:00:00.000Z"),
            _brew(2, 11.0, "good", "2026-10-09T08:00:00.000Z"),
        ],
    }
    rows = backtest_mod.backtest(data)
    assert len(rows) == 2
    assert rows[0]["settled"] == 10.0
    for r in rows:
        assert set(r) == {"date", "coffee", "recommended", "used", "settled", "error"}
        assert r["error"] == r["recommended"] - r["settled"]
