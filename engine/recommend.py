"""Recommendation orchestration — the single entry point the browser calls.

Contract (both directions are JSON strings, so nothing but plain data crosses
the Pyodide bridge):

    payload = {
      "grinder":  {"min", "max", "step", "calibration"?: {"method", "setting"}},
      "coffees":  [ {id, roast, process, roastDate?, altitudeMasl?, decaf?}, ... ],
      "brews":    [ {coffeeId, method, grindSetting, verdict, doseG?, shotTimeS?,
                     createdAt}, ... ],
      "request":  {"coffeeId", "method"}
    }

    result = {
      "setting": float, "confidence": "low"|"med"|"high",
      "explanation": [ {"label": str, "delta": float}, ... ],
      "nudge": str | None
    }
"""
from __future__ import annotations

import json
import os
from datetime import date

import numpy as np

from . import features as F
from . import ridge

SYNTH_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synthetic.json")
_SYNTH_CACHE = None

REAL_WEIGHT_GOOD = 5.0
REAL_WEIGHT_ADJUSTED = 3.5   # under / over samples

# How far each verdict moves the grind, as a multiple of the base adjustment.
# "gusher" (ran straight through) and "choked" (stalled) are unambiguous
# mechanical failures rather than taste calls, so they warrant a much bigger
# correction than a shot that was merely a bit sour or bitter.
#   negative = grind finer, positive = grind coarser
VERDICT_STEPS = {
    "gusher": -2.5,   # far too coarse
    "under":  -1.0,   # slightly too coarse (sour / weak)
    "good":    0.0,
    "over":   +1.0,   # slightly too fine (bitter / harsh)
    "choked": +2.5,   # far too fine
}
SYNTH_FULL_UNTIL = 40.0      # real-brew count at which synthetic fades to floor
SYNTH_FLOOR = 0.15
# Shrinkage for the per-coffee offset: n/(n+k). k=3 meant a single brew only
# contributed 25% of what it had actually taught us, so even repeated "good"
# brews never pulled the recommendation onto the setting that worked. k=1 makes
# one brew worth 50% and three brews 75%.
BIAS_SHRINK_K = 1.0

# A shot is on target anywhere in 25-30s, not at a single instant. Measuring
# error from a 28s point meant a perfectly good 26s shot still registered a 7%
# miss and scaled the correction up accordingly.
ESPRESSO_TIME_BAND = (25.0, 30.0)
ESPRESSO_TARGET_TIME = 27.5          # band centre, used only for scaling

# --- similar-coffee prior ---------------------------------------------------
# Weight floor before a set of similar coffees is trusted at all, and the
# shrinkage constant controlling how fast it takes over from the generic model.
# K is low on purpose: past brews are direct evidence from THIS grinder, while
# the model is generic coffee science anchored on one calibration point. Two
# closely-matching good brews should already be worth ~4x the model.
SIMILAR_MIN_WEIGHT = 1.2
SIMILAR_SHRINK_K = 0.6

# Uncertainty of the suggestion, in normalised dial units, used to draw the
# range. Cold start is deliberately wide: a first guess at an unknown bag really
# is worth about +/- 3 clicks, and saying so is more useful than false precision.
SIGMA_COLD = 0.045
SIGMA_SIMILAR_FLOOR = 0.018


def _shot_time_error(shot_time) -> float:
    """Relative miss from the 25-30s window. Zero anywhere inside it.

    Returned as a fraction of the band centre so it stays comparable with the
    old point-target behaviour for genuinely fast or slow shots.
    """
    try:
        t = float(shot_time)
    except (TypeError, ValueError):
        return 0.0
    lo, hi = ESPRESSO_TIME_BAND
    if lo <= t <= hi:
        return 0.0
    miss = (lo - t) if t < lo else (t - hi)
    return miss / ESPRESSO_TARGET_TIME


def _load_synthetic():
    global _SYNTH_CACHE
    if _SYNTH_CACHE is None:
        with open(SYNTH_PATH) as f:
            _SYNTH_CACHE = json.load(f)
    return _SYNTH_CACHE


def _synth_feature_vector(feat: dict) -> list[float]:
    """Synthetic samples carry raw attributes; encode them the same way as
    real coffees so the model sees one consistent feature space. ageDays is a
    plain integer here, so translate it via a synthetic roastDate offset."""
    coffee = {
        "roast": feat["roast"],
        "process": feat["process"],
        "altitudeMasl": feat.get("altitudeMasl"),
        "decaf": feat.get("decaf", False),
        "roastDate": None,
    }
    age_days = feat.get("ageDays")
    if age_days is not None:
        # a fixed reference date keeps encode_age() as the single age formula
        ref = date(2000, 1, 1)
        coffee["roastDate"] = ref.isoformat()
        x = F.encode(coffee, feat["method"],
                     today=date.fromordinal(ref.toordinal() + int(age_days)))
    else:
        x = F.encode(coffee, feat["method"])

    # The synthetic rows carry density scores / temp / ratio directly rather
    # than as free text, so write them straight into their feature slots.
    x[F.FEATURES.index("variety_density")] = float(feat.get("varietyDensity") or 0.0)
    x[F.FEATURES.index("origin_density")] = float(feat.get("originDensity") or 0.0)
    x[F.FEATURES.index("water_temp")] = F.encode_water_temp(feat.get("waterTempC"))
    ratio = feat.get("ratio")
    if ratio:
        typical = F.TYPICAL_RATIO.get(feat["method"])
        if typical:
            x[F.FEATURES.index("ratio_dev")] = max(-1.0, min(1.0, (ratio - typical) / typical))
    return x


def _build_training_set(grinder, coffee, real_brews_all, method_of_request):
    """Assemble (X, y, w) from synthetic priors + the user's real brews."""
    X, y, w = [], [], []

    n_real = len(real_brews_all)
    synth_scale = max(SYNTH_FLOOR, 1.0 - n_real / SYNTH_FULL_UNTIL)

    for s in _load_synthetic():
        X.append(_synth_feature_vector(s["features"]))
        y.append(s["y"])
        w.append(1.0 * synth_scale)

    step = float(grinder["step"])
    span = float(grinder["max"]) - float(grinder["min"])
    delta = 2.0 * step / span if span > 0 else 0.05

    for b in real_brews_all:
        c = b["_coffee"]  # attached by run()
        x = F.encode(c, b["method"], brew=b)
        y_used = F.normalize_setting(b["grindSetting"], grinder)
        verdict = b.get("verdict", "good")

        d = delta
        if b["method"] == "espresso" and b.get("shotTimeS"):
            err = _shot_time_error(b["shotTimeS"])
            d = delta * max(0.5, min(2.0, err))

        step_mult = VERDICT_STEPS.get(verdict, 0.0)
        y_t = max(0.0, min(1.0, y_used + step_mult * d))
        wt = REAL_WEIGHT_GOOD if step_mult == 0.0 else REAL_WEIGHT_ADJUSTED

        X.append(x)
        y.append(y_t)
        w.append(wt)

    return np.array(X), np.array(y), np.array(w)



# --- similar-coffee prior ---------------------------------------------------
ROAST_ORDER = {"light": 0, "medium": 1, "dark": 2}


def _similarity(a: dict, b: dict) -> float:
    """How much a past brew of coffee `b` should inform a new bag `a`.

    Zero to one, multiplicative across facets. This is the piece that makes the
    FIRST brew of a new bag useful: the generic model only knows coffee science,
    but by the time you have twenty logs you have real evidence about how YOUR
    grinder handles light naturals versus dark washed, and that evidence should
    set the starting point rather than a one-size anchor.
    """
    score = 1.0

    # Roast is the strongest single signal; adjacent roasts still inform.
    ra, rb = ROAST_ORDER.get(a.get("roast"), 1), ROAST_ORDER.get(b.get("roast"), 1)
    score *= (1.0, 0.5, 0.15)[abs(ra - rb)]

    # Roasters are remarkably consistent in how far they take a development, so
    # a bag from a roaster you know is a better guide than the same roast level
    # from a stranger. A bonus, never a penalty — capped below.
    ao, bo = (a.get("roaster") or "").strip().lower(), (b.get("roaster") or "").strip().lower()
    if ao and ao == bo:
        score *= 1.4

    # Process: weak evidence that it shifts grind at all (see gen_synthetic.py),
    # so a mismatch is only a mild discount rather than a real penalty.
    if a.get("process") != b.get("process"):
        score *= 0.85

    # Decaf really is a different material — brittle, fast-extracting.
    if bool(a.get("decaf")) != bool(b.get("decaf")):
        score *= 0.25

    # Density, via whichever signals each bag has.
    da = F.encode_altitude(a.get("altitudeMasl")) or F.encode_variety_density(a.get("variety"))
    db_ = F.encode_altitude(b.get("altitudeMasl")) or F.encode_variety_density(b.get("variety"))
    score *= max(0.5, 1.0 - abs(da - db_) * 0.35)

    return min(score, 1.0)


def _similar_prior(coffee, brews, grinder, method):
    """Weighted mean target setting from past brews of *similar* coffees.

    Returns (y, weight, spread) in normalised dial units, or None.
    """
    step = float(grinder["step"])
    span = float(grinder["max"]) - float(grinder["min"])
    delta = 2.0 * step / span if span > 0 else 0.05

    pts, wts = [], []
    for b in brews:
        if b["method"] != method:
            continue
        other = b["_coffee"]
        if str(other.get("id")) == str(coffee.get("id")):
            continue                      # the coffee's own history is handled elsewhere
        sim = _similarity(coffee, other)
        if sim <= 0.05:
            continue
        # Same verdict->target correction as the training set: a brew that was
        # bitter tells us where the setting SHOULD have been, not where it was.
        step_mult = VERDICT_STEPS.get(b.get("verdict", "good"), 0.0)
        y_t = max(0.0, min(1.0, F.normalize_setting(b["grindSetting"], grinder)
                           + step_mult * delta))
        # a verified-good brew is worth more than an inferred correction
        wt = sim * (1.0 if step_mult == 0.0 else 0.6)
        pts.append(y_t)
        wts.append(wt)

    total = sum(wts)
    if not pts or total < SIMILAR_MIN_WEIGHT:
        return None

    mean = sum(p * w for p, w in zip(pts, wts)) / total
    var = sum(w * (p - mean) ** 2 for p, w in zip(pts, wts)) / total
    return mean, total, var ** 0.5


def _per_coffee_bias(beta, grinder, coffee_brews):
    """Mean residual of this coffee's real brews, shrunk toward 0."""
    if not coffee_brews:
        return 0.0
    resid = []
    step = float(grinder["step"])
    span = float(grinder["max"]) - float(grinder["min"])
    delta = 2.0 * step / span if span > 0 else 0.05
    for b in coffee_brews:
        c = b["_coffee"]
        x = F.encode(c, b["method"], brew=b)
        y_used = F.normalize_setting(b["grindSetting"], grinder)
        # same verdict->direction table as the training set, so a gusher or a
        # choke moves this coffee's offset as hard as it moves the model
        step_mult = VERDICT_STEPS.get(b.get("verdict", "good"), 0.0)
        y_t = max(0.0, min(1.0, y_used + step_mult * delta))
        resid.append(y_t - ridge.predict(beta, x))
    n = len(resid)
    return (sum(resid) / n) * (n / (n + BIAS_SHRINK_K))


def _calibration_shift(beta, grinder, coffee, has_logs_for_method):
    """Calibrate the abstract 0..1 dial to this specific grinder.

    The user optionally provides ONE reference point: a method + a grind
    setting that worked for them (any method, e.g. "V60 at 22"). We compare
    the model's generic prediction for that method against the real setting and
    apply the resulting offset to a coffee that has no logs on the *requested*
    method yet. Once real brews exist for that method, this fades out.

    This is a scale/offset fix (grinder geometry differs), NOT a claim about
    the "correct" grind for any brew.
    """
    cal = grinder.get("calibration")
    if not cal or has_logs_for_method:
        return 0.0
    cal_method = cal.get("method")
    cal_setting = cal.get("setting")
    if cal_method not in F.METHODS or cal_setting in (None, ""):
        return 0.0
    # model's generic prediction for the reference method on this coffee's beans
    x_ref = F.encode(coffee, cal_method)
    predicted = ridge.predict(beta, x_ref)
    target = F.normalize_setting(cal_setting, grinder)
    return target - predicted


def _local_dial_in(last, grinder, method, n_cm, n_m):  # noqa: C901
    """Step from the user's own last setting for this coffee+method.

    Once a coffee has been brewed on a method, this — not the model — decides
    the recommendation. Dialling in is a feedback loop: keep what was good, go
    finer when it was sour, coarser when it was bitter, and move further for an
    outright gusher or choke. The model owns only the cold start, so it can
    never talk you off a setting you have personally verified, and the
    synthetic prior can't drag a well-dialled bag back to its generic guess.
    """
    used = float(last["grindSetting"])
    verdict = last.get("verdict", "good")

    step = float(grinder["step"]) or 0.5
    adjust = 2.0 * step
    # a wildly fast/slow shot warrants a bigger correction than a near miss
    if method == "espresso" and last.get("shotTimeS"):
        err = _shot_time_error(last["shotTimeS"])
        adjust *= max(0.5, min(2.0, err * 3.0))

    target = used + VERDICT_STEPS.get(verdict, 0.0) * adjust
    nudges = {
        "gusher": f"{used} ran through → going much finer",
        "under":  f"{used} was sour → going finer",
        "good":   f"{used} was good last time",
        "over":   f"{used} was bitter → going coarser",
        "choked": f"{used} choked → going much coarser",
    }
    y = max(0.0, min(1.0, F.normalize_setting(target, grinder)))
    setting = F.round_to_step(F.denormalize_setting(y, grinder), grinder)

    # Range while dialling in only. Once a setting has been confirmed good —
    # and, for espresso, pulled inside the 25-30s window — there is nothing left
    # to hedge about, so the range disappears entirely.
    span = float(grinder["max"]) - float(grinder["min"])
    on_target = verdict == "good" and (
        method != "espresso"
        or not last.get("shotTimeS")
        or _shot_time_error(last["shotTimeS"]) == 0.0
    )
    if on_target and n_cm >= 2:
        sigma = None
    elif on_target:
        sigma = (1.0 * float(grinder["step"])) / span if span else None
    else:
        sigma = (2.0 * float(grinder["step"])) / span if span else None

    return {
        "setting": float(setting),
        "range": _range(y, sigma, grinder),
        "confidence": _confidence(n_cm, n_m),
        "explanation": [],
        "nudge": nudges.get(verdict, nudges["good"]),
    }


def _range(y, sigma, grinder):
    """A plausible window around the suggestion, in real dial units.

    Deliberately returns None once it would be noise: the range exists to say
    "this is a starting guess, expect to move" and should disappear as soon as
    that stops being true.
    """
    if sigma is None or sigma <= 0:
        return None
    lo = F.round_to_step(F.denormalize_setting(max(0.0, y - sigma), grinder), grinder)
    hi = F.round_to_step(F.denormalize_setting(min(1.0, y + sigma), grinder), grinder)
    if hi - lo < float(grinder["step"]):
        return None
    return [float(lo), float(hi)]


def _confidence(n_coffee_method, n_method):
    if n_coffee_method >= 3:
        return "high"
    if n_method >= 5:
        return "med"
    return "low"


def _explanation(beta, x, grinder):
    """Top feature contributions expressed in real dial units."""
    span = float(grinder["max"]) - float(grinder["min"])
    labels = {
        "roast": "roast", "process": "process", "age": "bean age",
        "altitude": "altitude", "decaf": "decaf", "dose_dev": "dose",
        "ratio_dev": "brew ratio", "water_temp": "water temp",
        "variety_density": "variety", "origin_density": "origin",
    }
    contribs = []
    for i, name in enumerate(F.FEATURES):
        if name == "bias" or name.startswith("m_"):
            continue
        delta_dial = float(beta[i]) * float(x[i]) * span
        if abs(delta_dial) >= 0.05:
            contribs.append({"label": labels.get(name, name),
                             "delta": round(delta_dial, 2)})
    contribs.sort(key=lambda c: abs(c["delta"]), reverse=True)
    return contribs[:4]


def recommend(payload: dict) -> dict:
    grinder = payload["grinder"]
    req = payload["request"]
    # ids are client-generated UUID strings; normalise so a numeric-looking id
    # from an older record still matches.
    coffee_by_id = {str(c["id"]): c for c in payload["coffees"]}
    requested_id = req.get("coffeeId")
    if requested_id is None:
        raise ValueError("no coffeeId in request")
    coffee = coffee_by_id.get(str(requested_id))
    if coffee is None:
        raise ValueError(f"coffee {requested_id!r} not found in payload")
    method = req["method"]

    # attach the coffee record to each brew for encoding convenience.
    # coffeeId is normalised to str to match coffee_by_id's keys.
    brews = []
    for b in payload.get("brews", []):
        cid = str(b.get("coffeeId"))
        c = coffee_by_id.get(cid)
        if c is None:
            continue
        b = dict(b)
        b["coffeeId"] = cid
        b["_coffee"] = c
        brews.append(b)

    coffee_brews = [b for b in brews if b["coffeeId"] == str(coffee["id"])]
    same = sorted(
        [b for b in coffee_brews if b["method"] == method],
        key=lambda b: b.get("createdAt", ""),
    )
    n_cm = len(same)
    n_m = sum(1 for b in brews if b["method"] == method)

    # FAST PATH: if this coffee already has history on this method, the answer
    # is a step from the last setting (see the local dial-in block below) and
    # the model isn't consulted at all. Return before building the training set
    # so we don't solve a ~500-row least-squares problem and discard it — this
    # is the common case once a bag is in use, and it's the slowest thing the
    # engine does inside WebAssembly.
    if same:
        return _local_dial_in(same[-1], grinder, method, n_cm, n_m)

    X, y, w = _build_training_set(grinder, coffee, brews, method)
    beta = ridge.fit(X, y, w)

    bias = _per_coffee_bias(beta, grinder, coffee_brews)

    has_logs_for_method = any(b["method"] == method for b in coffee_brews)
    calibration = _calibration_shift(beta, grinder, coffee, has_logs_for_method)

    # Encode the request using the most recent brew of this coffee+method as
    # context (dose, ratio, temp), so the suggestion reflects how this person
    # actually brews this bag rather than assuming defaults.
    prior = sorted(
        [b for b in coffee_brews if b["method"] == method],
        key=lambda b: b.get("createdAt", ""),
    )
    context = prior[-1] if prior else None
    x_req = F.encode(coffee, method, brew=context)
    y_model = max(0.0, min(1.0, ridge.predict(beta, x_req) + bias + calibration))

    # Blend in what similar bags have actually needed on this grinder. The model
    # knows coffee science; this knows YOUR machine. As soon as there is real
    # evidence it should dominate, because the alternative is a generic anchor
    # that lands on the same number for every new bag.
    sim = _similar_prior(coffee, brews, grinder, method)
    nudge = None
    if sim is not None:
        y_sim, weight, spread = sim
        share = weight / (weight + SIMILAR_SHRINK_K)
        y_hat = (1.0 - share) * y_model + share * y_sim
        sigma = max(SIGMA_SIMILAR_FLOOR, spread) * (1.0 - 0.4 * share)
        nudge = "starting from similar coffees you've brewed"
    else:
        y_hat = y_model
        sigma = SIGMA_COLD

    y_hat = max(0.0, min(1.0, y_hat))
    setting = F.round_to_step(F.denormalize_setting(y_hat, grinder), grinder)

    return {
        "setting": float(setting),
        "range": _range(y_hat, sigma, grinder),
        "confidence": _confidence(n_cm, n_m),
        "explanation": _explanation(beta, x_req, grinder),
        "nudge": nudge,
    }


def run(payload_json: str) -> str:
    """String-in / string-out wrapper — this is what JS calls across the bridge."""
    payload = json.loads(payload_json)
    return json.dumps(recommend(payload))
