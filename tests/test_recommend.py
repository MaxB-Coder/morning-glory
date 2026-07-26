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


def test_dark_coarser_than_light_same_method():
    """Dark roasts are more soluble and more brittle: they extract faster, so
    they need a COARSER grind. Light roasts are denser and less soluble and
    need a FINER grind. (This test previously asserted the opposite and locked
    a backwards prior into the synthetic data.)"""
    dark = rec([_coffee(id=1, roast="dark")], [], 1, "v60")["setting"]
    light = rec([_coffee(id=2, roast="light")], [], 2, "v60")["setting"]
    assert dark > light


def test_fresh_beans_coarser_than_aged():
    """Fresh coffee is full of CO2 which slows the flow -> coarser. As it
    degasses, flow speeds up and beans get brittle -> grind finer."""
    fresh = rec([_coffee(id=1, roastDate="2026-07-24")], [], 1, "espresso")["setting"]
    aged = rec([_coffee(id=2, roastDate="2026-06-01")], [], 2, "espresso")["setting"]
    assert fresh > aged


def test_decaf_coarser():
    """Decaf processing damages cell structure -> brittle, extracts fast."""
    plain = rec([_coffee(id=1)], [], 1, "espresso")["setting"]
    decaf = rec([_coffee(id=2, decaf=True)], [], 2, "espresso")["setting"]
    assert decaf > plain


def test_dense_beans_finer():
    """High-grown / harder beans are less soluble -> finer grind."""
    soft = rec([_coffee(id=1, altitudeMasl=900)], [], 1, "espresso")["setting"]
    dense = rec([_coffee(id=2, altitudeMasl=1900)], [], 2, "espresso")["setting"]
    assert dense < soft


def test_robusta_finer_than_arabica():
    arabica = rec([_coffee(id=1, variety="Bourbon")], [], 1, "espresso")["setting"]
    robusta = rec([_coffee(id=2, variety="Robusta")], [], 2, "espresso")["setting"]
    assert robusta < arabica


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


def test_single_good_brew_is_repeated_exactly():
    """The bug that prompted this: one good brew at 8.5 recommended 9.5.
    A setting you have verified must be repeated, not second-guessed."""
    c = [_coffee()]
    brews = [{"coffeeId": 1, "method": "espresso", "grindSetting": 8.5,
              "verdict": "good", "shotTimeS": 24, "createdAt": "2026-07-25"}]
    assert rec(c, brews, 1, "espresso")["setting"] == 8.5


def test_last_verdict_steps_the_right_way():
    c = [_coffee()]
    used = 8.5
    def after(verdict):
        return rec(c, [{"coffeeId": 1, "method": "espresso", "grindSetting": used,
                        "verdict": verdict, "createdAt": "2026-07-25"}], 1, "espresso")["setting"]
    assert after("under") < used      # sour -> finer
    assert after("over") > used       # bitter -> coarser
    assert after("good") == used      # good  -> stay


def test_dial_in_converges_and_then_holds():
    """Walk a realistic session: two bitter shots, then good — and it must
    stop moving once you're there."""
    c = [_coffee()]
    brews = []
    seq = [(8.5, "over"), (9.5, "over"), (10.5, "good")]
    for i, (s, v) in enumerate(seq, 1):
        brews.append({"coffeeId": 1, "method": "espresso", "grindSetting": s,
                      "verdict": v, "createdAt": f"2026-07-{i:02d}"})
    assert rec(c, brews, 1, "espresso")["setting"] == 10.5


def test_local_dial_in_does_not_leak_across_methods():
    c = [_coffee()]
    brews = [{"coffeeId": 1, "method": "espresso", "grindSetting": 8.5,
              "verdict": "good", "createdAt": "2026-07-25"}]
    # V60 has no history of its own, so it must still come from the model
    assert rec(c, brews, 1, "v60")["setting"] > 15


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


def test_uuid_string_ids_work():
    # real app uses client-generated UUID strings, not ints
    c = [_coffee(id="4f0a-uuid")]
    brews = [{"coffeeId": "4f0a-uuid", "method": "v60", "grindSetting": 18,
              "verdict": "good", "createdAt": "2026-07-20"}]
    r = rec(c, brews, "4f0a-uuid", "v60")
    assert isinstance(r["setting"], float)


def test_missing_coffee_id_raises_clearly():
    with pytest.raises(ValueError, match="no coffeeId"):
        rec([_coffee()], [], None, "v60")


def test_unknown_coffee_id_raises_clearly():
    with pytest.raises(ValueError, match="not found"):
        rec([_coffee(id="a")], [], "does-not-exist", "v60")


def test_run_is_json_roundtrip():
    out = R.run(json.dumps(_payload([_coffee()], [], 1, "v60")))
    parsed = json.loads(out)
    assert isinstance(parsed["setting"], (int, float))
