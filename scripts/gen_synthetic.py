"""Generate engine/synthetic.json — the pretraining set encoding coffee science.

Each sample is a coffee+method combination with a target grind position on a
normalized 0..1 dial (0 = finest, 1 = coarsest). Run:

    python scripts/gen_synthetic.py

Deterministic (fixed seed) so the shipped file is reproducible.
"""
from __future__ import annotations

import json
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

# Process: the evidence that process alone shifts grind size is weak — it
# affects flavour far more than density. A confident prior here would be made
# up, so it starts neutral and the model learns the direction (if any) from
# real logged brews. The feature column still exists for exactly that reason.
PROCESSES = {"washed": 0.0, "honey": 0.0, "natural": 0.0}
ALTITUDES = [None, 900, 1200, 1600, 1900]   # masl
AGES = [None, 2, 7, 20, 45]                  # days since roast
# density scores (as features.py would encode them), sampled directly
VARIETY_DENSITIES = [0.0, 0.0, -0.8, -0.5, 0.1, 0.6, 0.4, 1.0]
ORIGIN_DENSITIES = [0.0, 0.0, -0.4, -0.5, 0.3, 0.6, 0.7]
WATER_TEMPS = [None, 88, 92, 93, 96, 100]    # °C
ESPRESSO_RATIOS = [None, 1.5, 2.0, 2.5, 3.0] # yield : dose

SIGMA = 0.02
SEED = 20260724
SAMPLES_PER_METHOD = 72   # 7 * 72 = 504


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

            y = base + ROASTS[roast] + PROCESSES[process]

            # denser bean -> finer grind
            y -= 0.020 * variety_density
            y -= 0.015 * origin_density
            # hotter water extracts more -> compensate by grinding coarser
            if water_temp is not None:
                y += 0.018 * max(-1.0, min(1.0, (water_temp - 93) / 7))
            # longer ratio extracts more -> coarser
            if ratio is not None:
                y += 0.020 * max(-1.0, min(1.0, (ratio - 2.0) / 2.0))
            # high-altitude (dense) beans -> a touch finer
            if altitude and altitude >= 1600:
                y -= 0.02
            elif altitude and altitude <= 900:
                y += 0.01
            # Bean age: fresh coffee is full of CO2, which resists water and
            # slows the flow, so it wants a COARSER grind. As it degasses the
            # flow speeds up and the beans get more brittle, so an older bag
            # needs a FINER grind to hold the same extraction.
            if age is not None:
                if age < 5:
                    y += 0.020 if method == "espresso" else 0.010
                elif age > 21:
                    y -= 0.015 if method == "espresso" else 0.008
            # decaf beans are brittle / extract fast -> coarser
            if decaf:
                y += 0.03
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
