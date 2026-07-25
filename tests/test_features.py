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


def test_age_monotonic():
    fresh = F.encode_age("2000-01-01", today=__import__("datetime").date(2000, 1, 3))
    old = F.encode_age("2000-01-01", today=__import__("datetime").date(2000, 3, 1))
    assert 0.0 <= fresh < old <= 1.0
