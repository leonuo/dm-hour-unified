from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from parity_rubric import evaluate  # noqa: E402


verification = subprocess.run(
    [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"],
    cwd=ROOT,
    check=False,
    capture_output=True,
    text=True,
    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
)
rows = evaluate(ROOT)
score = sum(row["points"] for row in rows)
result = {
    "validated": verification.returncode == 0,
    "validation_command": "PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q",
    "formula": "sum(weight * row_score)",
    "maximum": sum(row["weight"] for row in rows),
    "score": score if verification.returncode == 0 else None,
    "similarity_percent": score if verification.returncode == 0 else None,
    "passed": [row["id"] for row in rows if row["score"] == 1],
    "partial": [row["id"] for row in rows if row["score"] == 0.5],
    "failed_or_unimplemented": [row["id"] for row in rows if row["score"] == 0],
    "rows": rows,
}
print(json.dumps(result, ensure_ascii=False, indent=2))
if verification.returncode != 0:
    print(verification.stdout, file=sys.stderr)
    print(verification.stderr, file=sys.stderr)
    raise SystemExit(1)
