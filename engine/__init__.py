"""GrindWise recommendation engine.

Pure Python. No I/O, no storage, no DOM. Runs identically on desktop
(pytest) and in the browser (Pyodide). The JS layer owns storage and UI.
"""
from .recommend import run

__all__ = ["run"]
