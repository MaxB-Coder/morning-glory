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
# New features are APPENDED so existing positions stay stable.
FEATURES = [
    "bias", "roast", "process", "age", "altitude", "decaf", "dose_dev",
    "m_espresso", "m_moka", "m_aeropress", "m_v60", "m_chemex",
    "m_frenchpress", "m_coldbrew",
    # appended v2:
    "ratio_dev",       # brew ratio vs typical (espresso: yield/dose)
    "water_temp",      # hotter water extracts more
    "variety_density", # bean hardness/density by variety
    "origin_density",  # density proxy by origin (only when altitude unknown)
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

# Typical brew ratio (liquid out : dry coffee in) per method. Only espresso
# reliably records a yield, so ratio is currently espresso-only.
TYPICAL_RATIO = {"espresso": 2.0}

REFERENCE_TEMP_C = 93.0     # neutral brew temperature
TEMP_SPAN_C = 7.0           # ±7°C maps to ±1

# --- density lookups --------------------------------------------------------
# Free-text origin/variety can't be one-hot encoded — hundreds of values, a
# handful of brews each. Instead each maps to ONE density score in [-1, 1]:
#   negative = softer / less dense  -> tends to want a coarser grind
#   positive = harder / denser      -> tends to want a finer grind
# Unknown values sit at 0 (neutral), so leaving the field blank costs nothing.
# Confidence varies a lot across this table, so the magnitudes do too:
#   Robusta vs Arabica is a large, well-established hardness difference.
#   Large-bean varieties (Pacamara, Maragogype) are reliably less dense.
#   Everything else is a modest nudge — variety correlates with density, but
#   growing altitude and processing dominate, so these stay deliberately small
#   and are quickly overridden by the per-coffee offset once you log brews.
VARIETY_DENSITY = {
    "gesha": -0.3, "geisha": -0.3,
    "pacamara": -0.5, "maragogipe": -0.5, "maragogype": -0.5,
    "bourbon": 0.0, "typica": 0.0, "caturra": 0.1, "catuai": 0.1,
    "castillo": 0.15, "colombia": 0.15, "mundo novo": 0.1,
    "sl28": 0.4, "sl34": 0.4, "ruiru": 0.3, "batian": 0.3,
    "heirloom": 0.25, "ethiopian heirloom": 0.25, "74110": 0.25, "74112": 0.25,
    "catimor": 0.2, "sarchimor": 0.2, "villa sarchi": 0.1,
    "robusta": 1.0, "canephora": 1.0, "liberica": 0.6,
}
ORIGIN_DENSITY = {
    "brazil": -0.4, "brasil": -0.4,
    "sumatra": -0.5, "indonesia": -0.3, "java": -0.2, "sulawesi": -0.2,
    "india": -0.1, "vietnam": 0.3,
    "guatemala": 0.3, "costa rica": 0.3, "honduras": 0.1, "el salvador": 0.1,
    "nicaragua": 0.1, "mexico": 0.0, "panama": 0.2, "peru": 0.1,
    "colombia": 0.2, "bolivia": 0.2, "ecuador": 0.2,
    "ethiopia": 0.6, "kenya": 0.7, "rwanda": 0.5, "burundi": 0.5,
    "tanzania": 0.4, "uganda": 0.3, "yemen": 0.4,
}


def _lookup_density(value, table):
    """Match free text against a density table, tolerating extra words
    (e.g. "Ethiopia Yirgacheffe" or "SL28 / SL34")."""
    if not value:
        return 0.0
    text = str(value).strip().lower()
    if text in table:
        return table[text]
    # longest key that appears in the text wins, so "costa rica" beats "rica"
    best, best_len = 0.0, 0
    for key, score in table.items():
        if key in text and len(key) > best_len:
            best, best_len = score, len(key)
    return best


def encode_variety_density(variety) -> float:
    return _lookup_density(variety, VARIETY_DENSITY)


def encode_origin_density(origin, altitude_known: bool) -> float:
    """Origin is largely a proxy for altitude/density, so it only contributes
    when altitude wasn't supplied — otherwise the same physical property would
    be counted twice."""
    if altitude_known:
        return 0.0
    return _lookup_density(origin, ORIGIN_DENSITY)


def encode_ratio_dev(dose, yield_g, method: str) -> float:
    """Relative deviation from the method's typical brew ratio. A longer ratio
    extracts more, so it needs a coarser grind to compensate."""
    typical = TYPICAL_RATIO.get(method)
    if typical is None or not dose or not yield_g:
        return 0.0
    try:
        d, y = float(dose), float(yield_g)
    except (ValueError, TypeError):
        return 0.0
    if d <= 0 or y <= 0:
        return 0.0
    return _clip((y / d - typical) / typical, -1.0, 1.0)


def encode_water_temp(temp_c) -> float:
    """Centred on 93 °C. Hotter water extracts more (-> grind coarser)."""
    if temp_c in (None, "", 0):
        return 0.0
    try:
        return _clip((float(temp_c) - REFERENCE_TEMP_C) / TEMP_SPAN_C, -1.0, 1.0)
    except (ValueError, TypeError):
        return 0.0


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

    b = brew or {}
    dose = b.get("doseG")
    altitude_known = coffee.get("altitudeMasl") not in (None, "", 0)

    vec = {
        "bias": 1.0,
        "roast": ROAST_MAP[roast],
        "process": PROCESS_MAP[process],
        "age": encode_age(coffee.get("roastDate"), today),
        "altitude": encode_altitude(coffee.get("altitudeMasl")),
        "decaf": 1.0 if coffee.get("decaf") else 0.0,
        "dose_dev": encode_dose_dev(dose, method),
        "ratio_dev": encode_ratio_dev(dose, b.get("yieldG"), method),
        "water_temp": encode_water_temp(b.get("waterTempC")),
        "variety_density": encode_variety_density(coffee.get("variety")),
        "origin_density": encode_origin_density(coffee.get("origin"), altitude_known),
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
