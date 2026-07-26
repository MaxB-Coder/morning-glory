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
SYNTH_FULL_UNTIL = 40.0      # real-brew count at which synthetic fades to floor
SYNTH_FLOOR = 0.15
BIAS_SHRINK_K = 3.0
ESPRESSO_TARGET_TIME = 28.0


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
            err = abs(float(b["shotTimeS"]) - ESPRESSO_TARGET_TIME) / ESPRESSO_TARGET_TIME
            d = delta * max(0.5, min(2.0, err))

        if verdict == "good":
            y_t, wt = y_used, REAL_WEIGHT_GOOD
        elif verdict == "under":            # sour/weak -> grind finer -> lower y
            y_t, wt = max(0.0, y_used - d), REAL_WEIGHT_ADJUSTED
        elif verdict == "over":             # bitter/harsh -> coarser -> higher y
            y_t, wt = min(1.0, y_used + d), REAL_WEIGHT_ADJUSTED
        else:
            y_t, wt = y_used, REAL_WEIGHT_GOOD

        X.append(x)
        y.append(y_t)
        w.append(wt)

    return np.array(X), np.array(y), np.array(w)


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
        v = b.get("verdict", "good")
        y_t = y_used
        if v == "under":
            y_t = max(0.0, y_used - delta)
        elif v == "over":
            y_t = min(1.0, y_used + delta)
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

    X, y, w = _build_training_set(grinder, coffee, brews, method)
    beta = ridge.fit(X, y, w)

    coffee_brews = [b for b in brews if b["coffeeId"] == str(coffee["id"])]
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
    y_hat = ridge.predict(beta, x_req) + bias + calibration
    y_hat = max(0.0, min(1.0, y_hat))
    setting = F.round_to_step(F.denormalize_setting(y_hat, grinder), grinder)

    n_cm = sum(1 for b in coffee_brews if b["method"] == method)
    n_m = sum(1 for b in brews if b["method"] == method)
    confidence = _confidence(n_cm, n_m)

    # last-brew nudge for this coffee+method
    nudge = None
    same = sorted(
        [b for b in coffee_brews if b["method"] == method],
        key=lambda b: b.get("createdAt", ""),
    )
    if same:
        last = same[-1]
        if last.get("verdict") == "under":
            nudge = f"last: {last['grindSetting']} was sour → try finer"
        elif last.get("verdict") == "over":
            nudge = f"last: {last['grindSetting']} was bitter → try coarser"

    return {
        "setting": float(setting),
        "confidence": confidence,
        "explanation": _explanation(beta, x_req, grinder),
        "nudge": nudge,
    }


def run(payload_json: str) -> str:
    """String-in / string-out wrapper — this is what JS calls across the bridge."""
    payload = json.loads(payload_json)
    return json.dumps(recommend(payload))
