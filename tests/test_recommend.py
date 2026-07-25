"""Behavioral tests — these encode what the product must actually do."""
import json

import pytest

from engine import recommend as R

GRINDER = {"min": 0.0, "max": 40.0, "step": 0.5, "calibration": None}


def _payload(coffees, brews, coffee_id, method, grinder=None):
    return {
        "grinder": grinder or GRINDER,
        "coffees": coffees,
        "brews": brews,
        "request": {"coffeeId": coffee_id, "method": method},
    }


def _coffee(id=1, roast="medium", process="washed", **kw):
    c = {"id": id, "roast": roast, "process": process}
    c.update(kw)
    return c


def rec(coffees, brews, cid, method, grinder=None):
    return R.recommend(_payload(coffees, brews, cid, method, grinder))


# --- synthetic-only ordering ------------------------------------------------

def test_method_ordering_on_the_dial():
    c = [_coffee()]
    order = ["espresso", "moka", "aeropress", "v60", "chemex", "frenchpress", "coldbrew"]
    settings = [rec(c, [], 1, m)["setting"] for m in order]
    assert settings == sorted(settings), settings
    assert settings[0] < settings[-1]


def test_dark_finer_than_light_same_method():
    dark = rec([_coffee(id=1, roast="dark")], [], 1, "v60")["setting"]
    light = rec([_coffee(id=2, roast="light")], [], 2, "v60")["setting"]
    assert dark < light


# --- learning from feedback -------------------------------------------------

def test_repeated_under_pushes_finer():
    c = [_coffee()]
    base = rec(c, [], 1, "v60")["setting"]
    brews = [
        {"coffeeId": 1, "method": "v60", "grindSetting": base,
         "verdict": "under", "createdAt": f"2026-07-2{i}"}
        for i in range(1, 4)
    ]
    after = rec(c, brews, 1, "v60")["setting"]
    assert after < base


def test_repeated_over_pushes_coarser():
    c = [_coffee()]
    base = rec(c, [], 1, "v60")["setting"]
    brews = [
        {"coffeeId": 1, "method": "v60", "grindSetting": base,
         "verdict": "over", "createdAt": f"2026-07-2{i}"}
        for i in range(1, 4)
    ]
    after = rec(c, brews, 1, "v60")["setting"]
    assert after > base


def test_repeated_good_converges_to_used_setting():
    c = [_coffee()]
    used = 15.0
    brews = [
        {"coffeeId": 1, "method": "v60", "grindSetting": used,
         "verdict": "good", "createdAt": f"2026-07-2{i}"}
        for i in range(1, 6)
    ]
    after = rec(c, brews, 1, "v60")["setting"]
    assert abs(after - used) <= 1.5


def test_real_data_overrides_synthetic():
    # espresso would normally be very fine (~5); teach it 30 repeatedly
    c = [_coffee()]
    brews = [
        {"coffeeId": 1, "method": "espresso", "grindSetting": 30.0,
         "verdict": "good", "createdAt": f"2026-07-{i:02d}"}
        for i in range(1, 41)
    ]
    after = rec(c, brews, 1, "espresso")["setting"]
    assert after > 20  # real logs won over the fine synthetic prior


# --- robustness -------------------------------------------------------------

def test_zero_brews_still_returns():
    r = rec([_coffee()], [], 1, "espresso")
    assert "setting" in r and r["confidence"] == "low"


def test_confidence_rises_with_history():
    c = [_coffee()]
    brews = [
        {"coffeeId": 1, "method": "v60", "grindSetting": 15,
         "verdict": "good", "createdAt": f"2026-07-2{i}"}
        for i in range(1, 4)
    ]
    assert rec(c, brews, 1, "v60")["confidence"] == "high"


def test_nudge_after_bad_brew():
    c = [_coffee()]
    brews = [{"coffeeId": 1, "method": "v60", "grindSetting": 14,
              "verdict": "under", "createdAt": "2026-07-20"}]
    assert "sour" in (rec(c, brews, 1, "v60")["nudge"] or "")


def test_calibration_pins_referenced_method_scale():
    # user says: "V60 at 22 works for me" -> V60 rec on a fresh coffee ~= 22
    g = {"min": 0.0, "max": 40.0, "step": 0.5,
         "calibration": {"method": "v60", "setting": 22.0}}
    r = rec([_coffee()], [], 1, "v60", grinder=g)
    assert abs(r["setting"] - 22.0) <= 2.0


def test_calibration_transfers_across_methods():
    # calibrating on V60 also shifts the espresso scale sensibly (finer than V60)
    g = {"min": 0.0, "max": 40.0, "step": 0.5,
         "calibration": {"method": "v60", "setting": 22.0}}
    esp = rec([_coffee()], [], 1, "espresso", grinder=g)["setting"]
    v60 = rec([_coffee()], [], 1, "v60", grinder=g)["setting"]
    assert esp < v60


def test_calibration_ignored_once_method_has_logs():
    g = {"min": 0.0, "max": 40.0, "step": 0.5,
         "calibration": {"method": "v60", "setting": 5.0}}  # deliberately off
    brews = [
        {"coffeeId": 1, "method": "v60", "grindSetting": 22,
         "verdict": "good", "createdAt": f"2026-07-2{i}"}
        for i in range(1, 4)
    ]
    # real logs should dominate the bad calibration
    assert rec([_coffee()], brews, 1, "v60", grinder=g)["setting"] > 12


def test_run_is_json_roundtrip():
    out = R.run(json.dumps(_payload([_coffee()], [], 1, "v60")))
    parsed = json.loads(out)
    assert isinstance(parsed["setting"], (int, float))
