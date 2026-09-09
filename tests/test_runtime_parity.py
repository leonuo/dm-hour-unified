from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RuntimeParityTests(unittest.TestCase):
    def test_instagram_api_and_mqtt_runtime_contract(self) -> None:
        completed = subprocess.run(
            ["node", str(ROOT / "tests" / "runtime_parity_checks.js")],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        self.assertIn("runtime parity checks: ok", completed.stdout)


if __name__ == "__main__":
    unittest.main()
