import numpy as np

from engine import ridge


def test_recovers_known_coefficients():
    rng = np.random.default_rng(0)
    n, d = 500, 4
    X = rng.normal(size=(n, d))
    X[:, 0] = 1.0  # bias column
    true_beta = np.array([2.0, -1.5, 0.7, 3.0])
    y = X @ true_beta + rng.normal(scale=0.01, size=n)
    beta = ridge.fit(X, y, lam=1e-6)
    assert np.allclose(beta, true_beta, atol=0.05)


def test_weight_equals_duplication():
    X = np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 2.0]])
    y = np.array([0.0, 1.0, 2.0])

    w = np.array([1.0, 1.0, 5.0])
    beta_w = ridge.fit(X, y, w, lam=1e-6)

    X_dup = np.vstack([X, np.tile(X[2], (4, 1))])
    y_dup = np.concatenate([y, np.repeat(y[2], 4)])
    beta_dup = ridge.fit(X_dup, y_dup, lam=1e-6)

    assert np.allclose(beta_w, beta_dup, atol=1e-6)


def test_bias_not_regularized():
    # constant target -> intercept should reach the mean even with big lambda
    X = np.ones((10, 2))
    X[:, 1] = np.linspace(-1, 1, 10)
    y = np.full(10, 7.0)
    beta = ridge.fit(X, y, lam=1000.0, bias_index=0)
    assert abs(beta[0] - 7.0) < 1e-6
    assert abs(beta[1]) < 1e-3  # slope crushed toward 0
