import math

import pytest

from engine import features as F


def _coffee(**kw):
    base = {"roast": "medium", "process": "washed"}
    base.update(kw)
    return base


def test_vector_length_and_bias():
    x = F.encode(_coffee(), "v60")
    assert len(x) == F.N_FEATURES
    assert x[F.FEATURES.index("bias")] == 1.0


def test_one_hot_exactly_one():
    x = F.encode(_coffee(), "espresso")
    method_slots = [x[F.FEATURES.index(f"m_{m}")] for m in F.METHODS]
    assert sum(method_slots) == 1.0
    assert x[F.FEATURES.index("m_espresso")] == 1.0


def test_missing_age_is_neutral():
    x = F.encode(_coffee(roastDate=None), "v60")
    assert x[F.FEATURES.index("age")] == 0.5


def test_missing_altitude_is_zero():
    x = F.encode(_coffee(altitudeMasl=None), "v60")
    assert x[F.FEATURES.index("altitude")] == 0.0


def test_roast_ordinal():
    light = F.encode(_coffee(roast="light"), "v60")[F.FEATURES.index("roast")]
    dark = F.encode(_coffee(roast="dark"), "v60")[F.FEATURES.index("roast")]
    assert light == -1.0 and dark == 1.0


def test_invalid_inputs_raise():
    with pytest.raises(ValueError):
        F.encode(_coffee(roast="charcoal"), "v60")
    with pytest.raises(ValueError):
        F.encode(_coffee(), "turkish")


def test_normalize_roundtrip():
    g = {"min": 0.0, "max": 40.0, "step": 0.5}
    for s in (0.0, 10.0, 23.5, 40.0):
        y = F.normalize_setting(s, g)
        assert 0.0 <= y <= 1.0
        assert abs(F.denormalize_setting(y, g) - s) < 1e-9


def test_round_to_step():
    g = {"min": 0.0, "max": 40.0, "step": 0.5}
    assert F.round_to_step(6.8, g) == 7.0
    assert F.round_to_step(6.7, g) == 6.5
    assert F.round_to_step(-5, g) == 0.0
    assert F.round_to_step(999, g) == 40.0


def test_variety_density_lookup():
    assert F.encode_variety_density("Gesha") < 0        # soft, low density
    assert F.encode_variety_density("SL28") > 0         # dense
    assert F.encode_variety_density("Robusta") == 1.0
    assert F.encode_variety_density(None) == 0.0
    assert F.encode_variety_density("something unknown") == 0.0
    # tolerates extra words
    assert F.encode_variety_density("SL28 / SL34 mix") > 0


def test_origin_density_only_when_altitude_unknown():
    assert F.encode_origin_density("Ethiopia", altitude_known=False) > 0
    # altitude already captures this — don't count it twice
    assert F.encode_origin_density("Ethiopia", altitude_known=True) == 0.0
    assert F.encode_origin_density("Brazil", altitude_known=False) < 0
    assert F.encode_origin_density(None, altitude_known=False) == 0.0
    # longest match wins
    assert F.encode_origin_density("Costa Rica Tarrazu", altitude_known=False) > 0


def test_ratio_dev():
    # espresso 18g -> 36g is the reference 1:2
    assert F.encode_ratio_dev(18, 36, "espresso") == 0.0
    assert F.encode_ratio_dev(18, 54, "espresso") > 0     # longer ratio
    assert F.encode_ratio_dev(18, 27, "espresso") < 0     # shorter ratio
    assert F.encode_ratio_dev(18, None, "espresso") == 0.0
    assert F.encode_ratio_dev(20, 320, "v60") == 0.0      # no ratio for filter yet


def test_water_temp():
    assert F.encode_water_temp(93) == 0.0
    assert F.encode_water_temp(100) > 0
    assert F.encode_water_temp(88) < 0
    assert F.encode_water_temp(None) == 0.0
    assert -1.0 <= F.encode_water_temp(200) <= 1.0        # clamped


def test_new_features_default_to_neutral_when_absent():
    x = F.encode(_coffee(), "v60")
    for name in ("ratio_dev", "water_temp", "variety_density", "origin_density"):
        assert x[F.FEATURES.index(name)] == 0.0


def test_age_monotonic():
    fresh = F.encode_age("2000-01-01", today=__import__("datetime").date(2000, 1, 3))
    old = F.encode_age("2000-01-01", today=__import__("datetime").date(2000, 3, 1))
    assert 0.0 <= fresh < old <= 1.0
