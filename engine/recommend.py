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
      "setting": float, "range": [lo, hi] | None,
      "confidence": "low"|"med"|"high",
      "explanation": [ {"label": str, "delta": float}, ... ],
      "nudge": str | None
    }
"""
from __future__ import annotations

import json
import math
import os
from datetime import date, datetime

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
# the model is generic coffee science anchored on one calibration point. Each
# similar coffee contributes ONE point, so a single close match already takes
# about 60% of the answer and three take over 80%.
SIMILAR_MIN_WEIGHT = 0.4
SIMILAR_SHRINK_K = 0.6

# --- uncertainty -------------------------------------------------------------
# The range is derived, not declared. Three things feed it:
#   1. how noisy this person's own brewing is       (residual variance)
#   2. how far this bag sits from anything logged   (ridge leverage)
#   3. how much similar coffees disagreed           (weighted spread / sqrt n)
# SIGMA_PRIOR is only the starting belief about (1) before there is any real
# data to measure it from — roughly +/- 3 clicks on a typical dial.
SIGMA_PRIOR = 0.045
RESID_PRIOR_K = 4.0        # pseudo-observations of the prior noise level
SIGMA_FLOOR_STEPS = 0.75   # never claim finer than ~1 step of the grinder
SIGMA_CAP = 0.11           # and never sprawl across the whole dial


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


# --- dial-in learning -------------------------------------------------------
# A bad brew followed by a good one this many days later counts as "fixed by".
RESOLVE_WINDOW_DAYS = 10.0
# Bitter and sour brews this close together bracket the answer between them.
BRACKET_WINDOW_DAYS = 5.0
# Consecutive brews further apart than this say nothing about shot-time response
# (the bag has aged, the machine has changed).
PAIR_WINDOW_DAYS = 7.0
# Fewer usable pairs than this and a learned value is noise; use the prior.
MIN_LEARN_SAMPLES = 3
# Calibration fades as CAL_FADE_K / (CAL_FADE_K + good brews on the method).
CAL_FADE_K = 3.0
# Shot time ∝ setting^-kappa; 5 is the typical espresso response until learned.
KAPPA_PRIOR = 5.0
# A bag with no roast date is assumed to be this many days old when first brewed.
ASSUMED_OPEN_AGE_DAYS = 7.0
# Keep a learned kappa physically plausible whatever a few noisy pairs say.
KAPPA_MIN, KAPPA_MAX = 1.5, 15.0
# Fallback mild correction as a share of the setting (see _correction).
MILD_FRACTION = 0.03
# Largest combined bean adjustment, as a share of the neutral setting.
BEAN_DELTA_CAP = 0.15
# Scale of the roast-age gap (days) over which a similar coffee's evidence fades.
SIMILAR_AGE_TAU_DAYS = 12.0
# Older similar-coffee brews are reweighted by 0.5 ** (age / this). Replaying a real
# five-month history showed settled settings on the same grinder drifting coarser
# (about 8.5 in July to about 10.8 in October), so a bag from months ago is weaker
# evidence than last month's. 60 days tracked that drift; 30 began to overshoot.
SIMILAR_RECENCY_HALFLIFE_DAYS = 60.0
# Reference bean used to read calibration without any bean effect in it.
NEUTRAL_COFFEE = {"roast": "medium", "process": "washed"}


def _when(b):
    """Brew timestamp as a naive datetime, or None if missing or unparseable.

    Timestamps arrive as ISO strings from the browser, sometimes with a "Z";
    comparing aware and naive datetimes would raise, so the zone is dropped.
    """
    raw = b.get("createdAt")
    if not raw:
        return None
    try:
        d = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return d.replace(tzinfo=None)


def _days(a, b):
    """Days between two brews; 0 when either has no usable date, so a missing
    timestamp never silently excludes a brew from a time-windowed rule."""
    ta, tb = _when(a), _when(b)
    if ta is None or tb is None:
        return 0.0
    return abs((tb - ta).total_seconds()) / 86400.0


def _g(b):
    return float(b["grindSetting"])


def _shot_time(b):
    """Logged shot time in seconds, or None. A blank or zero is "not recorded",
    never a real 0 s shot, so it must not feed any time-based arithmetic."""
    try:
        t = float(b.get("shotTimeS"))
    except (TypeError, ValueError):
        return None
    return t if t > 0 else None


def _median(xs):
    """Median rather than mean: one fat-fingered pair must not skew a learned
    step size or kappa."""
    xs = sorted(xs)
    n = len(xs)
    return xs[n // 2] if n % 2 else 0.5 * (xs[n // 2 - 1] + xs[n // 2])


def _series_by_coffee(brews, method):
    """Brews of one method grouped per coffee and ordered in time, because
    every dial-in rule reads a bag's history as a sequence, not a pile."""
    out = {}
    for b in brews:
        if b["method"] == method:
            out.setdefault(b["coffeeId"], []).append(b)
    for s in out.values():
        s.sort(key=lambda b: b.get("createdAt", ""))
    return out


def _learn_dial(series, grinder):
    """What this grinder + this person's history say about step sizes.

    Learned from the grinder's own history because a fixed "2 steps" is
    meaningless across grinders: on a 0.1-step dial it is 0.2 units while a 41 s
    shot needs about 0.8, and dial-in then takes many shots.

    kappa  — how sharply shot time responds to grind, as a power law:
             time ∝ setting^-kappa  (setting measured from the dial minimum).
             A power law keeps the prior independent of dial span and step
             size. It stays at the prior of 5.0 until 3 usable pairs exist.
    mild / severe — typical distance, in dial units, between a bad brew and the
             good brew that later fixed it. None until there is enough history.
    """
    step = float(grinder["step"]) or 0.5
    span = float(grinder["max"]) - float(grinder["min"])
    lo = float(grinder["min"])
    kappas, mild, severe = [], [], []
    for s in series.values():
        for a, b in zip(s, s[1:]):
            ta, tb = _shot_time(a), _shot_time(b)
            ga, gb = _g(a) - lo, _g(b) - lo
            if not (ta and tb) or ga <= 0 or gb <= 0:
                continue
            if abs(gb - ga) < step * 0.999 or _days(a, b) > PAIR_WINDOW_DAYS:
                continue
            da, db_ = a.get("doseG"), b.get("doseG")
            if da and db_ and abs(float(da) - float(db_)) > 0.5:
                continue
            k = math.log(ta / tb) / math.log(gb / ga)
            if k > 0:
                kappas.append(k)
        for i, a in enumerate(s):
            dirn = VERDICT_STEPS.get(a.get("verdict", "good"), 0.0)
            if dirn == 0.0:
                continue
            j = _resolved(i, s)
            if j is None:
                continue
            d = _g(s[j]) - _g(a)
            if d * dirn <= 0:
                continue
            (mild if abs(dirn) == 1.0 else severe).append(abs(d))
    kappa = _median(kappas) if len(kappas) >= MIN_LEARN_SAMPLES else KAPPA_PRIOR
    kappa = max(KAPPA_MIN, min(KAPPA_MAX, kappa))
    mild_d = _median(mild) if len(mild) >= MIN_LEARN_SAMPLES else None
    severe_d = _median(severe) if len(severe) >= MIN_LEARN_SAMPLES else None
    if mild_d is not None:
        mild_d = max(step, min(0.05 * span, mild_d))
    if severe_d is not None:
        severe_d = max(step, min(0.10 * span, severe_d))
    return {"kappa": kappa, "mild": mild_d, "severe": severe_d}


def _correction(b, method, dial, grinder):
    """Signed dial-unit move this brew's outcome calls for (0 for good).

    Taste alone sets the direction. Shot time sets the size of the move, but
    only when it agrees with the taste verdict: a slow shot that tasted sour
    contradicts itself, and the verdict is what the person actually tasted. A
    missing time is not evidence of anything, so it falls back to the learned
    (or default) mild/severe distance.

    The fallback is max(2 steps, 3% of the setting) because "2 steps" alone is
    meaningless on a fine-step grinder, where it is a barely perceptible move.
    """
    dirn = VERDICT_STEPS.get(b.get("verdict", "good"), 0.0)
    if dirn == 0.0:
        return 0.0
    step = float(grinder["step"]) or 0.5
    span = float(grinder["max"]) - float(grinder["min"])
    g_rel = max(0.0, _g(b) - float(grinder["min"]))
    mild = dial["mild"] if dial["mild"] is not None else max(2.0 * step, MILD_FRACTION * g_rel)
    severe = dial["severe"] if dial["severe"] is not None else 2.5 * mild
    severe = max(severe, mild)
    base = mild if abs(dirn) == 1.0 else severe
    cap = 0.10 * span

    t = _shot_time(b) if method == "espresso" else None
    lo, hi = ESPRESSO_TIME_BAND
    if t is not None and not (lo <= t <= hi) and g_rel > 0:
        timed = g_rel * (math.exp(math.log(t / ESPRESSO_TARGET_TIME) / dial["kappa"]) - 1.0)
        if timed * dirn > 0:
            mag = max(step, min(cap, abs(timed)))
            return math.copysign(mag, dirn)
    if t is not None and lo <= t <= hi:
        base = mild
    return math.copysign(min(cap, base), dirn)


def _resolved(i, s):
    """Index of the good brew that later fixed bad brew s[i], or None.

    A bad brew that was later fixed teaches nothing the fix does not already
    teach, and its too-fine or too-coarse setting would only drag training
    toward the dial-in trail, so callers drop it.
    """
    for j in range(i + 1, len(s)):
        if s[j].get("verdict") == "good" and _days(s[i], s[j]) <= RESOLVE_WINDOW_DAYS:
            return j
    return None


def _real_points(series_by_method, grinder, dials):
    """(brew, target_norm, weight) for every real brew worth training on.

    Good brews train on the setting used. Bad brews that were later fixed are
    dropped (see _resolved): the fixing brew already carries the lesson. Bad
    brews with no fix yet are kept, aimed at the corrected setting rather than
    the one that failed, so a lone bitter shot still pushes the model coarser.
    """
    out = []
    for method, series in series_by_method.items():
        dial = dials[method]
        for s in series.values():
            for i, b in enumerate(s):
                if b.get("verdict", "good") == "good":
                    out.append((b, F.normalize_setting(_g(b), grinder), REAL_WEIGHT_GOOD))
                elif _resolved(i, s) is None:
                    tgt = _g(b) + _correction(b, method, dial, grinder)
                    out.append((b, F.normalize_setting(tgt, grinder), REAL_WEIGHT_ADJUSTED))
    return out


def _encode_real(b):
    """Feature vector for a logged brew, with bean age taken as of that brew.

    Encoding with today's date made every historical brew look like it was
    made from an old bag, so the model learned that old beans need the settings
    that were really used on fresh ones. Falls back to today only when the
    brew has no usable timestamp.
    """
    w = _when(b)
    return F.encode(b["_coffee"], b["method"], brew=b, today=w.date() if w else None)


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


def _build_training_set(points, n_real):
    """Assemble (X, y, w) from synthetic priors + the user's real brews.

    Targets arrive already corrected by _real_points. The old clamp to
    max(0.5, min(2.0, err)) halved most corrections, so it is gone.
    """
    X, y, w = [], [], []
    synth_scale = max(SYNTH_FLOOR, 1.0 - n_real / SYNTH_FULL_UNTIL)
    for s in _load_synthetic():
        X.append(_synth_feature_vector(s["features"]))
        y.append(s["y"])
        w.append(1.0 * synth_scale)
    for b, y_t, wt in points:
        X.append(_encode_real(b))
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


def _bag_age_days(coffee, when, first_brew):
    """Age in days of a bag on the date `when`, or None if `when` is unknown.

    Every bag needs an age to be compared with another, roast date or not. With
    no roast date the best available proxy is an assumed opening age plus the
    days since the bag's first brew, so older logs of an undated bag still read
    as older than its first ones.
    """
    if when is None:
        return None
    known = F.days_since(coffee.get("roastDate"), when)
    if known is not None:
        return known
    if first_brew is None:
        return ASSUMED_OPEN_AGE_DAYS
    return ASSUMED_OPEN_AGE_DAYS + max(0.0, (when - first_brew).days)


def _age_feature(days):
    """The log scaling features.encode_age applies, for a raw day count, so an
    age gap can be priced with the fitted model's own age coefficient."""
    return min(math.log1p(max(0.0, days)), math.log1p(60.0)) / math.log1p(60.0)


def _similar_prior(coffee, series, grinder, method, dial, today, age_coef=0.0, first_brews=None):
    """One point per similar coffee: the setting it needed at the age this bag
    is now. Returns (y, weight, spread, n_eff) in normalised units, or None.

    Averaging every brew of a similar coffee mixed in its too-fine dial-in
    trail and its late-life settings from an aged bag. A new bag is brewed
    fresh, and fresh coffee needs a coarser grind, so that average was
    systematically low. Instead each coffee contributes the good brew nearest
    in age to the new bag (age comes from the roast date, or from an assumed
    opening age plus days since the bag's first brew when there is none). Even
    that nearest brew is usually older than a just-opened bag, since a good
    brew tends to come a few days after opening, so the point is shifted by
    `age_coef` times the age-feature gap. `age_coef` is the fitted model's age
    coefficient, clamped to <= 0 by the caller (older never means coarser). A
    coffee with no good brew contributes its corrected last brew at half
    weight.

    Recency reweights the points but does not reduce total evidence: an old
    bag is still proof of how this grinder behaves, so the trust threshold and
    shrinkage use the unweighted total while the mean uses the recency weights.
    """
    first_brews = first_brews or {}
    new_age = _bag_age_days(coffee, today, first_brews.get(str(coffee.get("id"))))
    pts, wts, evid = [], [], []
    for cid, s in series.items():
        other = s[0]["_coffee"]
        if cid == str(coffee.get("id")):
            continue
        sim = _similarity(coffee, other)
        if sim <= 0.05:
            continue
        goods = [b for b in s if b.get("verdict") == "good"]
        factor = 1.0
        age_shift = 0.0
        if goods:
            def age_of(b):
                w = _when(b)
                return _bag_age_days(other, w.date() if w else None, first_brews.get(cid))
            def gap(b):
                a = age_of(b)
                return abs(a - new_age) if a is not None and new_age is not None else 1e9
            pick = min(goods, key=gap)
            if gap(pick) < 1e9:
                factor *= math.exp(-gap(pick) / SIMILAR_AGE_TAU_DAYS)
                age_shift = age_coef * (_age_feature(new_age) - _age_feature(age_of(pick)))
            y_t = _g(pick)
        else:
            pick = s[-1]
            y_t = _g(pick) + _correction(pick, method, dial, grinder)
            factor *= 0.5
        w = _when(pick)
        recency = 1.0
        if w is not None:
            age = max(0.0, (datetime.combine(today, datetime.min.time()) - w).total_seconds() / 86400.0)
            recency = 0.5 ** (age / SIMILAR_RECENCY_HALFLIFE_DAYS)
        pts.append(max(0.0, min(1.0, F.normalize_setting(y_t, grinder) + age_shift)))
        evid.append(sim * factor)
        wts.append(sim * factor * recency)

    total = sum(evid)
    if not pts or total < SIMILAR_MIN_WEIGHT:
        return None
    wsum = sum(wts)
    mean = sum(p * w for p, w in zip(pts, wts)) / wsum
    var = sum(w * (p - mean) ** 2 for p, w in zip(pts, wts)) / wsum
    n_eff = (wsum ** 2) / sum(w * w for w in wts)
    return mean, total, var ** 0.5, n_eff


def _real_residual_var(beta, points):
    """Weighted variance of the model's error on THIS user's real brews.

    Synthetic rows are excluded on purpose: they are our own invention, and
    fitting them well says nothing about how well the model predicts reality.
    Shrunk toward SIGMA_PRIOR so a couple of lucky brews can't collapse the
    range to nothing.
    """
    sq, wsum = 0.0, 0.0
    for b, y_t, wt in points:
        sq += wt * (y_t - ridge.predict(beta, _encode_real(b))) ** 2
        wsum += wt
    prior = SIGMA_PRIOR ** 2
    if wsum <= 0:
        return prior
    n_eff = wsum / REAL_WEIGHT_GOOD
    return (n_eff * (sq / wsum) + RESID_PRIOR_K * prior) / (n_eff + RESID_PRIOR_K)


def _clamp_sigma(sigma, grinder):
    """Keep the uncertainty between about one grinder step and SIGMA_CAP, so
    the range never claims finer than the dial can set nor spans the whole dial."""
    span = float(grinder["max"]) - float(grinder["min"])
    floor = SIGMA_FLOOR_STEPS * float(grinder["step"]) / span if span > 0 else 0.01
    return max(floor, min(SIGMA_CAP, sigma))


def _per_coffee_bias(beta, points, coffee_id):
    """Mean residual of this coffee's real brews (other methods), shrunk to 0.

    Carries what this bag taught us on a different method over to the new one,
    shrunk by n/(n+BIAS_SHRINK_K) so a single brew is not over-trusted.
    """
    resid = [y_t - ridge.predict(beta, _encode_real(b))
             for b, y_t, _ in points if b["coffeeId"] == coffee_id]
    if not resid:
        return 0.0
    n = len(resid)
    return (sum(resid) / n) * (n / (n + BIAS_SHRINK_K))


def _calibration_shift(beta, grinder, n_good_method):
    """Offset that maps the generic dial onto this grinder, measured on a
    NEUTRAL coffee so bean differences survive, and faded out as real good
    brews on the requested method accumulate.

    Measuring the offset on the requested coffee's own features cancelled its
    bean terms exactly whenever the calibration method matched the requested
    one, so every new bag landed on the calibration setting whatever the bean.
    That version also never faded, because it was gated on this coffee's own
    brews, which are always empty on the model path. The fade is
    CAL_FADE_K / (CAL_FADE_K + n_good_method).
    """
    cal = grinder.get("calibration")
    if not cal:
        return 0.0
    cal_method = cal.get("method")
    cal_setting = cal.get("setting")
    if cal_method not in F.METHODS or cal_setting in (None, ""):
        return 0.0
    predicted = ridge.predict(beta, F.encode(NEUTRAL_COFFEE, cal_method))
    target = F.normalize_setting(cal_setting, grinder)
    return (target - predicted) * (CAL_FADE_K / (CAL_FADE_K + n_good_method))


def _local_dial_in(same, grinder, method, n_cm, n_m, dial):  # noqa: C901
    """Step from the user's own last setting for this coffee+method.

    Once a coffee has been brewed on a method, this — not the model — decides
    the recommendation. Dialling in is a feedback loop: keep what was good, go
    finer when it was sour, coarser when it was bitter, and move further for an
    outright gusher or choke. The model owns only the cold start, so it can
    never talk you off a setting you have personally verified, and the
    synthetic prior can't drag a well-dialled bag back to its generic guess.

    Takes the whole history for this coffee+method, not just the last brew.
    Looking only at the last one meant a single stray brew erased everything
    already learned: dial in at 8.1, fat-finger 8.8 the next morning, log it as
    sour, and the app would answer 8.7 — nudging down from the mistake instead
    of going back to the setting you had already proven.

    Three guards keep that feedback loop from misfiring:
    - Return to the proven setting only when it lies in the direction the
      verdict points AND has not failed since. Without the first check, a bag
      that aged past its old sweet spot (good@10.6, sour@10.6, sour@10.4) was
      sent back to 10.6 forever; without the second, the same bounce recurs.
    - When bitter and sour brews bracket the answer, aim for the midpoint of
      the bracket instead of overshooting out of it, which matters once steps
      are large (bitter@10.0 then sour@11.0 must not bounce back to 10.0).
    - A bad verdict always moves at least one grinder step, so rounding a
      small correction on a coarse-step dial can never repeat the failed setting.
    """
    last = same[-1]
    used = _g(last)
    verdict = last.get("verdict", "good")
    dirn = VERDICT_STEPS.get(verdict, 0.0)
    step = float(grinder["step"]) or 0.5
    span = float(grinder["max"]) - float(grinder["min"])

    idx_good = None
    for i in range(len(same) - 2, -1, -1):
        if same[i].get("verdict") == "good":
            idx_good = i
            break

    if dirn != 0.0 and idx_good is not None:
        ref = _g(same[idx_good])
        contradicted = any(abs(_g(b) - ref) <= step * 0.5 and b.get("verdict") != "good"
                           for b in same[idx_good + 1:])
        if (not contradicted and (ref - used) * dirn > 0
                and abs(ref - used) > step * 0.5):
            setting = F.round_to_step(ref, grinder)
            return {"setting": float(setting), "range": None,
                    "confidence": _confidence(n_cm, n_m), "explanation": [],
                    "nudge": f"{used} missed — back to {ref}, which worked"}

    move = _correction(last, method, dial, grinder)
    target = used + move
    nudges = {
        "gusher": f"{used} gushed → going much finer",
        "under":  f"{used} was sour → going finer",
        "good":   f"{used} was good last time",
        "over":   f"{used} was bitter → going coarser",
        "choked": f"{used} choked → going much coarser",
    }
    nudge = nudges.get(verdict, nudges["good"])

    if dirn != 0.0:
        start = idx_good + 1 if idx_good is not None else 0
        recent = [b for b in same[start:] if _days(b, last) <= BRACKET_WINDOW_DAYS]
        fine = [_g(b) for b in recent if VERDICT_STEPS.get(b.get("verdict"), 0) > 0]
        coarse = [_g(b) for b in recent if VERDICT_STEPS.get(b.get("verdict"), 0) < 0]
        if fine and coarse and max(fine) < min(coarse):
            lo_b, hi_b = max(fine), min(coarse)
            if not (lo_b < target < hi_b):
                target = (lo_b + hi_b) / 2.0
            nudge = f"between {lo_b} (bitter) and {hi_b} (sour)"

    y = max(0.0, min(1.0, F.normalize_setting(target, grinder)))
    setting = F.round_to_step(F.denormalize_setting(y, grinder), grinder)
    if dirn != 0.0 and abs(setting - used) < step * 0.5:
        setting = F.round_to_step(used + math.copysign(step, dirn), grinder)
        y = F.normalize_setting(setting, grinder)

    unit = max(step, abs(move) / 2.0) / span if span > 0 else 0.0125
    on_target = verdict == "good" and (
        method != "espresso" or not last.get("shotTimeS")
        or _shot_time_error(last["shotTimeS"]) == 0.0)
    if on_target and n_cm >= 2:
        lo_s = hi_s = None
    elif on_target:
        lo_s = hi_s = unit
    elif dirn < 0:
        lo_s, hi_s = 2.0 * unit, 0.5 * unit
    elif dirn > 0:
        lo_s, hi_s = 0.5 * unit, 2.0 * unit
    else:
        lo_s = hi_s = 1.5 * unit

    return {"setting": float(setting), "range": _range(y, lo_s, hi_s, grinder),
            "confidence": _confidence(n_cm, n_m), "explanation": [], "nudge": nudge}


def _range(y, lo_sigma, hi_sigma, grinder):
    """A plausible window around the suggestion, in real dial units.

    Takes the two half-widths separately: evidence is often one-sided. After a
    choked shot you know the answer is at or coarser than the new suggestion,
    so a symmetric window would claim a finer setting is equally likely when it
    plainly isn't.

    Returns None once the window would be noise — the range exists to say "this
    is a guess, expect to move", and should disappear when that stops being true.
    """
    if not lo_sigma and not hi_sigma:
        return None
    lo = F.round_to_step(F.denormalize_setting(max(0.0, y - (lo_sigma or 0)), grinder), grinder)
    hi = F.round_to_step(F.denormalize_setting(min(1.0, y + (hi_sigma or 0)), grinder), grinder)
    if hi - lo < float(grinder["step"]):
        return None
    return [float(lo), float(hi)]


def _confidence(n_coffee_method, n_method):
    """Confidence follows how much of the person's own history backs the
    answer, not how sure the model sounds."""
    if n_coffee_method >= 3:
        return "high"
    if n_method >= 5:
        return "med"
    return "low"


def _explanation(beta, x, grinder, scale=1.0):
    """Top feature contributions expressed in real dial units.

    `scale` shrinks every delta by what was actually applied (bean cap and
    similar-coffee share), so the listed adjustments add up to the move the
    person sees rather than to the uncapped model output.
    """
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
        delta_dial = float(beta[i]) * float(x[i]) * span * scale
        if abs(delta_dial) >= 0.05:
            contribs.append({"label": labels.get(name, name),
                             "delta": round(delta_dial, 2)})
    contribs.sort(key=lambda c: abs(c["delta"]), reverse=True)
    return contribs[:4]


def recommend(payload: dict, today: date | None = None) -> dict:
    """Suggest a grind setting for one coffee+method.

    `today` is injectable so bean age, and tests that depend on it, do not
    hang on the wall clock.

    Bean effects in the synthetic prior are fractions of the whole dial, which
    over-shoots on wide dials. BEAN_DELTA_CAP therefore limits the combined
    bean adjustment to 15% of the neutral setting; the explanation deltas are
    scaled by what was actually applied so they still add up.
    """
    today = today or date.today()
    grinder = payload["grinder"]
    req = payload["request"]
    coffee_by_id = {str(c["id"]): c for c in payload["coffees"]}
    requested_id = req.get("coffeeId")
    if requested_id is None:
        raise ValueError("no coffeeId in request")
    coffee = coffee_by_id.get(str(requested_id))
    if coffee is None:
        raise ValueError(f"coffee {requested_id!r} not found in payload")
    method = req["method"]
    cid = str(coffee["id"])

    brews = []
    for b in payload.get("brews", []):
        bc = str(b.get("coffeeId"))
        c = coffee_by_id.get(bc)
        if c is None or b.get("method") not in F.METHODS:
            continue
        b = dict(b)
        b["coffeeId"] = bc
        b["_coffee"] = c
        brews.append(b)

    series_by_method = {m: _series_by_coffee(brews, m) for m in {b["method"] for b in brews}}
    dials = {m: _learn_dial(s, grinder) for m, s in series_by_method.items()}
    series = series_by_method.get(method, {})
    dial = dials.get(method) or _learn_dial({}, grinder)

    same = series.get(cid, [])
    n_cm = len(same)
    n_m = sum(len(s) for s in series.values())

    if same:
        return _local_dial_in(same, grinder, method, n_cm, n_m, dial)

    points = _real_points(series_by_method, grinder, dials)
    X, y, w = _build_training_set(points, len(points))
    beta, A_inv = ridge.fit_cov(X, y, w)

    n_good_method = sum(1 for s in series.values() for b in s if b.get("verdict") == "good")
    x_req = F.encode(coffee, method, today=today)
    x_neutral = F.encode(NEUTRAL_COFFEE, method)
    y_neutral = ridge.predict(beta, x_neutral) + _calibration_shift(beta, grinder, n_good_method)
    bean = (ridge.predict(beta, x_req) - ridge.predict(beta, x_neutral)
            + _per_coffee_bias(beta, points, cid))
    cap = BEAN_DELTA_CAP * max(y_neutral, 0.0)
    bean_scale = 1.0 if abs(bean) <= cap or bean == 0 else cap / abs(bean)
    y_model = max(0.0, min(1.0, y_neutral + bean * bean_scale))

    resid_var = _real_residual_var(beta, points)
    h = ridge.leverage(A_inv, x_req)
    sigma_model = (resid_var * (1.0 + max(0.0, h))) ** 0.5

    # First brew date per bag on any method: the age proxy for undated bags.
    first_brews = {}
    for b in brews:
        w = _when(b)
        if w is not None and (b["coffeeId"] not in first_brews or w.date() < first_brews[b["coffeeId"]]):
            first_brews[b["coffeeId"]] = w.date()
    age_coef = min(0.0, float(beta[F.FEATURES.index("age")]))
    sim = _similar_prior(coffee, series, grinder, method, dial, today, age_coef, first_brews)
    nudge = None
    share = 0.0
    if sim is not None:
        y_sim, weight, spread, n_eff = sim
        share = weight / (weight + SIMILAR_SHRINK_K)
        y_hat = (1.0 - share) * y_model + share * y_sim
        sigma_sim = max(spread, SIGMA_PRIOR * 0.5) / max(1.0, n_eff) ** 0.5
        sigma = ((1.0 - share) ** 2 * sigma_model ** 2 + share ** 2 * sigma_sim ** 2) ** 0.5
        nudge = "starting from similar coffees you've brewed"
    else:
        y_hat = y_model
        sigma = sigma_model

    sigma = _clamp_sigma(sigma, grinder)
    y_hat = max(0.0, min(1.0, y_hat))
    setting = F.round_to_step(F.denormalize_setting(y_hat, grinder), grinder)

    return {
        "setting": float(setting),
        "range": _range(y_hat, sigma, sigma, grinder),
        "confidence": _confidence(n_cm, n_m),
        "explanation": _explanation(beta, x_req, grinder, bean_scale * (1.0 - share)),
        "nudge": nudge,
    }


def run(payload_json: str) -> str:
    """String-in / string-out wrapper — this is what JS calls across the bridge."""
    payload = json.loads(payload_json)
    return json.dumps(recommend(payload))
