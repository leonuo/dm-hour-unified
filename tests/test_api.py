from __future__ import annotations

import json
import random
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from dmhour.api import ApiHandler  # noqa: E402
from dmhour.database import Database  # noqa: E402
from dmhour.engine import CampaignEngine  # noqa: E402


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / "test.sqlite")
        self.db.initialize()
        self.engine = CampaignEngine(self.db, random.Random(3))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ApiHandler)
        self.server.db = self.db
        self.server.engine = self.engine
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.host, self.port = self.server.server_address

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method, path, body=None):
        conn = HTTPConnection(self.host, self.port, timeout=5)
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        data = json.loads(raw.decode("utf-8")) if response.headers.get("Content-Type", "").startswith("application/json") else raw
        return response.status, data

    def test_health_and_dashboard(self):
        status, payload = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        html_status, html = self.request("GET", "/")
        self.assertEqual(html_status, 200)
        self.assertIn(b"DM Hour", html)

    def test_campaign_lifecycle(self):
        status, created = self.request(
            "POST",
            "/api/campaigns",
            {
                "name": "API",
                "templates": ["Hi {{username}}"],
                "min_delay_seconds": 0,
                "max_delay_seconds": 0,
                "batch_pause_seconds": 0,
            },
        )
        self.assertEqual(status, 200)
        campaign_id = created["campaign_id"]
        csv_path = Path(self.temp.name) / "n.csv"
        csv_path.write_text("username\nalice\n", encoding="utf-8")
        status, imported = self.request(
            "POST",
            "/api/contacts/import",
            {"campaign_id": campaign_id, "path": str(csv_path)},
        )
        self.assertEqual(imported["inserted"], 1)
        status, started = self.request("POST", f"/api/campaigns/{campaign_id}/start", {})
        self.assertEqual(started["queued"], 1)
        status, snapshot = self.request("GET", "/api/status")
        self.assertEqual(snapshot["campaigns"][0]["queued"], 1)
        job = self.engine.claim_next("dry_run")
        self.engine.record_result(job["id"], success=False, http_status=400, error="bad")
        status, resent = self.request(
            "POST",
            f"/api/campaigns/{campaign_id}/resend",
            {"statuses": ["skipped"]},
        )
        self.assertEqual(resent["requeued"], 1)
        status, history = self.request("GET", f"/api/history?campaign_id={campaign_id}")
        self.assertGreaterEqual(len(history["items"]), 1)

    def test_extension_claims_only_web_mqtt_and_receives_variables(self):
        status, created = self.request(
            "POST",
            "/api/campaigns",
            {
                "name": "Web MQTT",
                "templates": ["Hi {{username}}"],
                "transport": "web_mqtt",
                "min_delay_seconds": 0,
                "max_delay_seconds": 0,
            },
        )
        campaign_id = created["campaign_id"]
        self.request(
            "POST",
            "/api/contacts/add",
            {
                "campaign_id": campaign_id,
                "username": "alice",
                "variables": {"instagram_user_id": "12345"},
            },
        )
        self.request("POST", f"/api/campaigns/{campaign_id}/start", {})

        rejected_status, _ = self.request("GET", "/api/jobs/next?transport=browser_dom")
        self.assertEqual(rejected_status, 400)
        claim_status, payload = self.request("GET", "/api/jobs/next?transport=web_mqtt")
        self.assertEqual(claim_status, 200)
        self.assertEqual(payload["job"]["transport"], "web_mqtt")
        self.assertEqual(payload["job"]["variables"]["instagram_user_id"], "12345")


if __name__ == "__main__":
    unittest.main()
