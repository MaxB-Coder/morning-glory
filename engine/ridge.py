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


def fit_cov(X, y, weights=None, lam: float = DEFAULT_LAMBDA, bias_index: int = 0):
    """Like fit(), but also returns (XᵀWX + lam·I)⁻¹.

    That inverse is what turns a point estimate into an honest error bar: the
    leverage xᵀA⁻¹x says how far a request sits from the data the model was
    actually fitted on, so a bag unlike anything logged reports more
    uncertainty than one sitting in the middle of the evidence.
    """
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).ravel()
    n, d = X.shape
    w = np.ones(n) if weights is None else np.asarray(weights, dtype=float).ravel()

    reg = lam * np.eye(d)
    if 0 <= bias_index < d:
        reg[bias_index, bias_index] = 0.0

    XtW = X.T * w
    A = XtW @ X + reg
    beta = np.linalg.solve(A, XtW @ y)
    try:
        A_inv = np.linalg.inv(A)
    except np.linalg.LinAlgError:
        A_inv = np.linalg.pinv(A)
    return beta, A_inv


def leverage(A_inv, x) -> float:
    """xᵀ A⁻¹ x — how much of an extrapolation this request is."""
    x = np.asarray(x, dtype=float)
    return float(x @ np.asarray(A_inv, dtype=float) @ x)


def predict(beta, x) -> float:
    return float(np.dot(np.asarray(beta, dtype=float), np.asarray(x, dtype=float)))
