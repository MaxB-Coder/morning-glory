"""Weighted ridge regression — closed form.

    beta = (Xᵀ W X + lam * I)⁻¹ Xᵀ W y

with the bias column (index 0) left un-regularized so predictions aren't
shrunk toward the middle of the dial.
"""
from __future__ import annotations

import numpy as np

DEFAULT_LAMBDA = 1.0


def fit(X, y, weights=None, lam: float = DEFAULT_LAMBDA, bias_index: int = 0):
    """Return coefficient vector beta.

    X: (n, d) design matrix. y: (n,). weights: (n,) or None (=> all 1).
    """
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).ravel()
    n, d = X.shape
    if weights is None:
        w = np.ones(n)
    else:
        w = np.asarray(weights, dtype=float).ravel()

    reg = lam * np.eye(d)
    if 0 <= bias_index < d:
        reg[bias_index, bias_index] = 0.0  # never regularize the intercept

    XtW = X.T * w  # (d, n) broadcasting each column by its weight
    A = XtW @ X + reg
    b = XtW @ y
    # solve is more stable than explicit inverse
    beta = np.linalg.solve(A, b)
    return beta


def predict(beta, x) -> float:
    return float(np.dot(np.asarray(beta, dtype=float), np.asarray(x, dtype=float)))
