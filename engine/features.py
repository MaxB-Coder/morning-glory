"""Feature encoding + normalization.

Turns a coffee record + a brew context into a fixed-length numeric vector.
This is the single source of truth for validation and encoding, so both the
desktop tests and the browser use identical logic.
"""
from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any

# Canonical feature order. NEVER reorder without retraining everything.
FEATURES = [
    "bias", "roast", "process", "age", "altitude", "decaf", "dose_dev",
    "m_espresso", "m_moka", "m_aeropress", "m_v60", "m_chemex",
    "m_frenchpress", "m_coldbrew",
]
N_FEATURES = len(FEATURES)

METHODS = [
    "espresso", "moka", "aeropress", "v60", "chemex", "frenchpress", "coldbrew",
]

ROAST_MAP = {"light": -1.0, "medium": 0.0, "dark": 1.0}
PROCESS_MAP = {"washed": 0.0, "honey": 0.5, "natural": 1.0}

# Typical dose (g) per method — used to compute a relative dose deviation.
DEFAULT_DOSE = {
    "espresso": 18.0, "moka": 16.0, "aeropress": 14.0, "v60": 20.0,
    "chemex": 30.0, "frenchpress": 30.0, "coldbrew": 60.0,
}

_AGE_CLAMP_DAYS = 60.0
_AGE_DENOM = math.log1p(_AGE_CLAMP_DAYS)


def _clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except (ValueError, TypeError):
        return None


def days_since(roast_date: Any, today: date | None = None) -> float | None:
    d = _parse_date(roast_date)
    if d is None:
        return None
    today = today or date.today()
    return max(0.0, (today - d).days)


def encode_age(roast_date: Any, today: date | None = None) -> float:
    """Bean age in [0,1]. Unknown date -> 0.5 (neutral)."""
    days = days_since(roast_date, today)
    if days is None:
        return 0.5
    return min(math.log1p(days), _AGE_DENOM) / _AGE_DENOM


def encode_altitude(masl: Any) -> float:
    if masl in (None, "", 0):
        return 0.0
    try:
        return _clip((float(masl) - 1200.0) / 800.0, -1.0, 1.0)
    except (ValueError, TypeError):
        return 0.0


def encode_dose_dev(dose: Any, method: str) -> float:
    if dose in (None, "", 0):
        return 0.0
    try:
        d = float(dose)
    except (ValueError, TypeError):
        return 0.0
    base = DEFAULT_DOSE.get(method, d)
    if base <= 0:
        return 0.0
    return (d - base) / base


def encode(coffee: dict, method: str, brew: dict | None = None,
           today: date | None = None) -> list[float]:
    """Build the feature vector for a (coffee, method[, brew]) combination.

    `coffee` uses the browser/JS field names (roast, process, roastDate,
    altitudeMasl, decaf). `brew` optionally supplies doseG.
    """
    if method not in METHODS:
        raise ValueError(f"unknown method: {method!r}")
    roast = coffee.get("roast")
    if roast not in ROAST_MAP:
        raise ValueError(f"unknown roast: {roast!r}")
    process = coffee.get("process")
    if process not in PROCESS_MAP:
        raise ValueError(f"unknown process: {process!r}")

    dose = (brew or {}).get("doseG")

    vec = {
        "bias": 1.0,
        "roast": ROAST_MAP[roast],
        "process": PROCESS_MAP[process],
        "age": encode_age(coffee.get("roastDate"), today),
        "altitude": encode_altitude(coffee.get("altitudeMasl")),
        "decaf": 1.0 if coffee.get("decaf") else 0.0,
        "dose_dev": encode_dose_dev(dose, method),
    }
    for m in METHODS:
        vec[f"m_{m}"] = 1.0 if m == method else 0.0

    return [vec[f] for f in FEATURES]


# --- grind-setting normalization (model works in [0,1]) --------------------

def normalize_setting(setting: float, grinder: dict) -> float:
    lo, hi = float(grinder["min"]), float(grinder["max"])
    if hi <= lo:
        raise ValueError("grinder max must exceed min")
    return _clip((float(setting) - lo) / (hi - lo), 0.0, 1.0)


def denormalize_setting(y: float, grinder: dict) -> float:
    lo, hi = float(grinder["min"]), float(grinder["max"])
    return lo + _clip(y, 0.0, 1.0) * (hi - lo)


def round_to_step(value: float, grinder: dict) -> float:
    lo, hi = float(grinder["min"]), float(grinder["max"])
    step = float(grinder["step"])
    if step <= 0:
        return round(_clip(value, lo, hi), 2)
    n = round((value - lo) / step)
    snapped = lo + n * step
    snapped = _clip(snapped, lo, hi)
    # tidy float noise (e.g. 6.8000000001)
    return round(snapped, 4)
