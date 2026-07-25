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
ROASTS = {"light": +0.03, "medium": 0.0, "dark": -0.03}
PROCESSES = {"washed": 0.0, "honey": -0.007, "natural": -0.015}
ALTITUDES = [None, 900, 1200, 1600, 1900]   # masl
AGES = [None, 2, 7, 20, 45]                  # days since roast

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

            y = base + ROASTS[roast] + PROCESSES[process]
            # high-altitude (dense) beans -> a touch finer
            if altitude and altitude >= 1600:
                y -= 0.02
            elif altitude and altitude <= 900:
                y += 0.01
            # fresh beans on espresso run fast -> grind finer to compensate
            if method == "espresso" and age is not None and age < 5:
                y -= 0.02
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
