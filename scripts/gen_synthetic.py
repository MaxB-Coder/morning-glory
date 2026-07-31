"""Generate engine/synthetic.json — the pretraining set encoding coffee science.

Each sample is a coffee+method combination with a target grind position on a
normalized 0..1 dial (0 = finest, 1 = coarsest). Run:

    python scripts/gen_synthetic.py

Deterministic (fixed seed) so the shipped file is reproducible.
"""
from __future__ import annotations

import json
import math
import os
import random

METHOD_BASE = {
    "espresso": 0.12, "moka": 0.22, "aeropress": 0.42, "v60": 0.55,
    "chemex": 0.62, "frenchpress": 0.80, "coldbrew": 0.88,
}
# y is a position on the dial: LOWER = finer, HIGHER = coarser.
#
# Roast: darker beans are more soluble and more brittle, so they extract faster
# and need a COARSER grind; light roasts are denser and less soluble and need a
# FINER grind to get enough extraction and enough back-pressure.
ROASTS = {"light": -0.03, "medium": 0.0, "dark": +0.03}

# How much bean characteristics matter, per method.
#
# Espresso is pressurised and FLOW-limited: bean density, roast development and
# residual CO2 all change how much the puck resists water, so a light dense bean
# genuinely needs several clicks off a dark one. Immersion brewing is
# DIFFUSION-limited over minutes of contact — the same bean swap is worth about
# a click in a French press and less in cold brew.
#
# Previously every bean term was a flat constant in dial space, so "light vs
# dark" moved cold brew exactly as far as it moved espresso. That is the single
# least physical thing in this file.
METHOD_SENSITIVITY = {
    "espresso": 1.0, "moka": 0.8, "aeropress": 0.6, "v60": 0.5,
    "chemex": 0.5, "frenchpress": 0.3, "coldbrew": 0.25,
}

# Process: the evidence that process alone shifts grind size is weak — it
# affects flavour far more than density. A confident prior here would be made
# up, so it starts neutral and the model learns the direction (if any) from
# real logged brews. The feature column still exists for exactly that reason.
PROCESSES = {"washed": 0.0, "honey": 0.0, "natural": 0.0}
ALTITUDES = [None, 900, 1200, 1600, 1900]   # masl
AGES = [None, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45]   # days since roast
# density scores (as features.py would encode them), sampled directly
VARIETY_DENSITIES = [0.0, 0.0, -0.8, -0.5, 0.1, 0.6, 0.4, 1.0]
ORIGIN_DENSITIES = [0.0, 0.0, -0.4, -0.5, 0.3, 0.6, 0.7]
WATER_TEMPS = [None, 88, 92, 93, 96, 100]    # °C
ESPRESSO_RATIOS = [None, 1.5, 2.0, 2.5, 3.0] # yield : dose

SIGMA = 0.02
SEED = 20260724
SAMPLES_PER_METHOD = 120  # 7 * 120 = 840 — more ages to cover now


def clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


def make():
    rng = random.Random(SEED)
    out = []
    for method, base in METHOD_BASE.items():
        for _ in range(SAMPLES_PER_METHOD):
            roast = rng.choice(list(ROASTS))
            process = rng.choice(list(PROCESSES))
            altitude = rng.choice(ALTITUDES)
            age = rng.choice(AGES)
            decaf = rng.random() < 0.12
            variety_density = rng.choice(VARIETY_DENSITIES)
            # origin only contributes when altitude is unknown (see features.py)
            origin_density = rng.choice(ORIGIN_DENSITIES) if altitude is None else 0.0
            water_temp = rng.choice(WATER_TEMPS)
            ratio = rng.choice(ESPRESSO_RATIOS) if method == "espresso" else None

            sens = METHOD_SENSITIVITY[method]
            roast_shift = ROASTS[roast]

            # Every bean term below is scaled by `sens`. Brew-parameter terms
            # (water temp, ratio) are NOT — those act on extraction directly and
            # apply about equally whatever the method.
            bean = roast_shift + PROCESSES[process]

            # denser bean -> finer grind.
            # Scaled by roast: roasting breaks down cell structure, so a dark
            # roast of a dense high-grown bean no longer behaves as dense as its
            # origin suggests. Light roasts keep more of that structure.
            density_keep = 1.0 - 6.0 * roast_shift    # light 1.18 .. dark 0.82
            bean -= 0.020 * variety_density * density_keep
            bean -= 0.015 * origin_density * density_keep

            # high-altitude (dense) beans -> a touch finer
            if altitude and altitude >= 1600:
                bean -= 0.02 * density_keep
            elif altitude and altitude <= 900:
                bean += 0.01 * density_keep

            # Bean age. Fresh coffee is full of CO2, which resists water and
            # slows the flow, so it wants a COARSER grind. As it degasses the
            # flow speeds up and the beans get more brittle, so an older bag
            # needs a FINER grind to hold the same extraction.
            #
            # A smooth decay, not the three-step staircase this used to be:
            # that put a 2.8-click cliff between day 4 and day 6 and taught the
            # model an edge that does not exist. CO2 peaks in the first days and
            # is largely gone by ~3 weeks, so an exponential with a ~9 day
            # half-life, centred so ~14 days is neutral.
            if age is not None:
                co2 = math.exp(-age / 9.0) - math.exp(-14.0 / 9.0)
                # Dark roasts are more porous: they degas faster AND go stale
                # faster, so age moves them further in both directions.
                age_gain = 1.0 + 8.0 * roast_shift     # light 0.76 .. dark 1.24
                bean += 0.045 * co2 * age_gain

            # decaf beans are brittle / extract fast -> coarser
            if decaf:
                bean += 0.03

            y = base + bean * sens

            # hotter water extracts more -> compensate by grinding coarser
            if water_temp is not None:
                y += 0.018 * max(-1.0, min(1.0, (water_temp - 93) / 7))
            # longer ratio extracts more -> coarser
            if ratio is not None:
                y += 0.020 * max(-1.0, min(1.0, (ratio - 2.0) / 2.0))

            y += rng.gauss(0.0, SIGMA)

            out.append({
                "features": {
                    "roast": roast,
                    "process": process,
                    "method": method,
                    "altitudeMasl": altitude,
                    "ageDays": age,
                    "decaf": decaf,
                    "varietyDensity": variety_density,
                    "originDensity": origin_density,
                    "waterTempC": water_temp,
                    "ratio": ratio,
                },
                "y": round(clip01(y), 5),
            })
    rng.shuffle(out)
    return out


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, "..", "engine", "synthetic.json")
    data = make()
    with open(dest, "w") as f:
        json.dump(data, f, indent=0)
    print(f"wrote {len(data)} samples -> {os.path.normpath(dest)}")
