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


def test_extreme_verdicts_move_further_and_the_right_way():
    """A gusher (ran straight through) means far too coarse -> much finer.
    A choke means far too fine -> much coarser. Both must move more than the
    milder sour/bitter verdicts."""
    c = [_coffee()]
    used = 8.5
    def after(verdict):
        return rec(c, [{"coffeeId": 1, "method": "espresso", "grindSetting": used,
                        "verdict": verdict, "createdAt": "2026-07-25"}], 1, "espresso")["setting"]
    gusher, under = after("gusher"), after("under")
    over, choked = after("over"), after("choked")
    assert gusher < under < used < over < choked          # correct ordering
    assert (used - gusher) > (used - under)               # gusher moves further
    assert (choked - used) > (over - used)                # choke moves further


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


# --- similar-coffee prior ----------------------------------------------------

def _sim_setup():
    """Two light naturals from one roaster that landed fine, two darks that
    landed coarse. A new bag should start near its own kind, not between them."""
    grinder = {"min": 0, "max": 40, "step": 0.5,
               "calibration": {"method": "espresso", "setting": 12}}
    coffees = [
        {"id": "1", "roast": "light", "process": "natural", "roaster": "Kin"},
        {"id": "2", "roast": "light", "process": "natural", "roaster": "Kin"},
        {"id": "3", "roast": "dark", "process": "washed", "roaster": "Other"},
        {"id": "4", "roast": "dark", "process": "washed", "roaster": "Other"},
    ]
    brews = [
        {"coffeeId": "1", "method": "espresso", "grindSetting": 9.0,
         "verdict": "good", "shotTimeS": 27, "createdAt": "2026-01-01"},
        {"coffeeId": "2", "method": "espresso", "grindSetting": 9.5,
         "verdict": "good", "shotTimeS": 27, "createdAt": "2026-01-02"},
        {"coffeeId": "3", "method": "espresso", "grindSetting": 13.0,
         "verdict": "good", "shotTimeS": 27, "createdAt": "2026-01-03"},
        {"coffeeId": "4", "method": "espresso", "grindSetting": 13.5,
         "verdict": "good", "shotTimeS": 27, "createdAt": "2026-01-04"},
    ]
    return grinder, coffees, brews


def _ask(grinder, coffees, brews, new_coffee):
    payload = {"grinder": grinder, "coffees": coffees + [new_coffee],
               "brews": brews, "request": {"coffeeId": "99", "method": "espresso"}}
    return R.recommend(payload)


def test_new_bag_starts_near_similar_coffees_not_between_them():
    grinder, coffees, brews = _sim_setup()
    light = _ask(grinder, coffees, brews,
                 {"id": "99", "roast": "light", "process": "natural", "roaster": "Kin"})
    dark = _ask(grinder, coffees, brews,
                {"id": "99", "roast": "dark", "process": "washed", "roaster": "Other"})
    # each lands on its own cluster, and they stay well apart
    assert light["setting"] < 11.0, light
    assert dark["setting"] > 11.5, dark
    assert dark["setting"] - light["setting"] >= 2.0


def test_similar_prior_is_reported_and_ranged():
    grinder, coffees, brews = _sim_setup()
    r = _ask(grinder, coffees, brews,
             {"id": "99", "roast": "light", "process": "natural", "roaster": "Kin"})
    assert r["nudge"], "should say where the starting point came from"
    lo, hi = r["range"]
    assert lo <= r["setting"] <= hi


def test_cold_start_has_a_wider_range_than_a_similar_backed_guess():
    grinder, coffees, brews = _sim_setup()
    new = {"id": "99", "roast": "light", "process": "natural", "roaster": "Kin"}
    warm = _ask(grinder, coffees, brews, new)
    cold = R.recommend({"grinder": grinder, "coffees": [new], "brews": [],
                      "request": {"coffeeId": "99", "method": "espresso"}})
    span = lambda r: r["range"][1] - r["range"][0]
    assert span(cold) > span(warm), (cold["range"], warm["range"])


def test_decaf_is_not_treated_as_similar_to_regular():
    grinder, coffees, brews = _sim_setup()
    reg = _ask(grinder, coffees, brews,
               {"id": "99", "roast": "light", "process": "natural", "roaster": "Kin"})
    dec = _ask(grinder, coffees, brews,
               {"id": "99", "roast": "light", "process": "natural",
                "roaster": "Kin", "decaf": True})
    assert dec["setting"] != reg["setting"]


# --- espresso is on target across a WINDOW, not at an instant -----------------

def test_shot_time_anywhere_in_the_window_counts_as_on_target():
    assert R._shot_time_error(25) == 0.0
    assert R._shot_time_error(27) == 0.0
    assert R._shot_time_error(30) == 0.0
    assert R._shot_time_error(20) > 0.0
    assert R._shot_time_error(40) > R._shot_time_error(33)


def test_range_disappears_once_the_bag_is_dialled_in():
    grinder = {"min": 0, "max": 40, "step": 0.5}
    coffee = {"id": "9", "roast": "medium", "process": "washed"}

    def ask(brews):
        return R.recommend({"grinder": grinder, "coffees": [coffee], "brews": brews,
                          "request": {"coffeeId": "9", "method": "espresso"}})

    mk = lambda i, v, t: {"coffeeId": "9", "method": "espresso", "grindSetting": 9.0,
                          "verdict": v, "shotTimeS": t, "createdAt": f"2026-02-{i:02d}"}

    assert ask([mk(1, "over", 22)])["range"] is not None      # still hunting
    two_good = ask([mk(1, "good", 26), mk(2, "good", 27)])
    assert two_good["range"] is None                          # dialled in
    assert two_good["setting"] == 9.0                         # and stays put


# --- the range is derived from evidence, not declared ------------------------

_G = {"min": 0, "max": 40, "step": 0.5,
      "calibration": {"method": "espresso", "setting": 12}}


def _c(i, roast="light", process="natural", roaster="Kin", **kw):
    base = {"id": str(i), "roast": roast, "process": process, "roaster": roaster,
            "decaf": False, "roastDate": None, "altitudeMasl": None}
    base.update(kw)
    return base


def _width(res):
    return None if not res["range"] else res["range"][1] - res["range"][0]


def _ask_new(coffees, brews, new):
    return R.recommend({"grinder": _G, "coffees": coffees + [new], "brews": brews,
                        "request": {"coffeeId": "99", "method": "espresso"}})


def test_range_narrows_when_similar_coffees_agree():
    hist = [_c(i) for i in range(1, 6)]
    agree = [{"coffeeId": str(i), "method": "espresso", "grindSetting": 9.0 + 0.5 * (i % 2),
              "verdict": "good", "shotTimeS": 27, "createdAt": f"2026-01-0{i}"}
             for i in range(1, 6)]
    scatter = [{"coffeeId": str(i), "method": "espresso",
                "grindSetting": [7, 9, 11, 13, 15][i - 1],
                "verdict": "good", "shotTimeS": 27, "createdAt": f"2026-01-0{i}"}
               for i in range(1, 6)]

    tight = _ask_new(hist, agree, _c(99))
    loose = _ask_new(hist, scatter, _c(99))
    assert _width(tight) < _width(loose), (tight["range"], loose["range"])


def test_range_widens_for_a_bag_unlike_anything_logged():
    hist = [_c(i) for i in range(1, 6)]
    brews = [{"coffeeId": str(i), "method": "espresso", "grindSetting": 9.0,
              "verdict": "good", "shotTimeS": 27, "createdAt": f"2026-01-0{i}"}
             for i in range(1, 6)]

    familiar = _ask_new(hist, brews, _c(99))
    strange = _ask_new(hist, brews,
                       _c(99, roast="dark", process="honey", roaster="Nobody",
                          altitudeMasl=1900, decaf=True))
    assert _width(strange) > _width(familiar), (strange["range"], familiar["range"])


def test_range_never_claims_finer_than_the_grinder_can_turn():
    hist = [_c(i) for i in range(1, 9)]
    brews = [{"coffeeId": str(i), "method": "espresso", "grindSetting": 9.0,
              "verdict": "good", "shotTimeS": 27, "createdAt": f"2026-01-0{i}"}
             for i in range(1, 9)]
    r = _ask_new(hist, brews, _c(99))
    if r["range"]:
        assert _width(r) >= _G["step"]


def _dial_in(verdict, shot_time):
    brews = [{"coffeeId": "99", "method": "espresso", "grindSetting": 10.0,
              "verdict": verdict, "shotTimeS": shot_time, "createdAt": "2026-02-01"}]
    return R.recommend({"grinder": _G, "coffees": [_c(99)], "brews": brews,
                        "request": {"coffeeId": "99", "method": "espresso"}})


def test_range_leans_the_way_the_correction_is_going():
    """A verdict tells you the direction; the only open question is whether the
    step went far enough. So the window should open that way, not both ways."""
    bitter = _dial_in("over", 34)      # too fine -> going coarser
    sour = _dial_in("under", 19)       # too coarse -> going finer

    lo, hi = bitter["range"]
    assert hi - bitter["setting"] > bitter["setting"] - lo, bitter["range"]

    lo, hi = sour["range"]
    assert sour["setting"] - lo > hi - sour["setting"], sour["range"]


# --- a stray brew must not erase a proven setting ----------------------------

def _dialin(brews, step=0.1, mx=14):
    g = {"min": 0, "max": mx, "step": step}
    c = {"id": "1", "roast": "medium", "process": "washed"}
    return R.recommend({"grinder": g, "coffees": [c], "brews": brews,
                        "request": {"coffeeId": "1", "method": "espresso"}})


def _brew(day, setting, verdict, shot=None):
    b = {"coffeeId": "1", "method": "espresso", "grindSetting": setting,
         "verdict": verdict, "createdAt": f"2026-08-{day:02d}"}
    if shot is not None:
        b["shotTimeS"] = shot
    return b


def test_one_bad_brew_elsewhere_returns_to_the_known_good_setting():
    """Dialled in at 8.1, then a stray 8.8 that ran sour. The answer is 8.1 —
    the mistake says nothing about the setting already proven."""
    r = _dialin([_brew(1, 8.1, "good", 27), _brew(2, 8.8, "under")])
    assert r["setting"] == 8.1, r
    assert r["range"] is None


def test_bad_brew_AT_the_good_setting_still_corrects():
    """Same setting failing now means the bag has moved on, not that the user
    slipped — so correct from it rather than returning to it."""
    r = _dialin([_brew(1, 8.1, "good", 27), _brew(2, 8.1, "under", 19)])
    assert r["setting"] < 8.1, r


def test_missing_shot_time_does_not_halve_the_correction():
    """No shot time is absence of evidence, not evidence of a good shot."""
    with_time = _dialin([_brew(1, 8.8, "under", 20)])
    without = _dialin([_brew(1, 8.8, "under")])
    # both move a full step or more finer; the untimed one is not a token nudge
    assert 8.8 - without["setting"] >= 0.2, without
    assert with_time["setting"] <= without["setting"]
