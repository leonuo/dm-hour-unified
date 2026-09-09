from __future__ import annotations

import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from dmhour.database import Database  # noqa: E402
from dmhour.engine import CampaignEngine  # noqa: E402
from dmhour.importers import import_csv, import_file, import_usernames, normalize_username  # noqa: E402
from dmhour.spintax import render_message, render_variables  # noqa: E402
from dmhour.xlsx import read_xlsx_dicts, write_xlsx  # noqa: E402


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / "test.sqlite")
        self.db.initialize()
        self.engine = CampaignEngine(self.db, random.Random(7))

    def tearDown(self):
        self.temp.cleanup()

    def campaign(self, **overrides):
        values = {
            "name": "Test",
            "templates": ["{Привіт|Вітаю}, {{first_name}} / {{username}}"],
            "transport": "dry_run",
            "min_delay_seconds": 0,
            "max_delay_seconds": 0,
            "daily_limit": 30,
            "batch_size": 10,
            "batch_pause_seconds": 0,
        }
        values.update(overrides)
        return self.db.create_campaign(**values)

    def add_contact(self, campaign_id, username="creator", **variables):
        values = {"username": username, **variables}
        with self.db.connect() as connection:
            connection.execute(
                "INSERT INTO contacts(campaign_id, username, variables_json) VALUES (?, ?, ?)",
                (campaign_id, username, json.dumps(values, ensure_ascii=False)),
            )

    def test_spintax_and_variables(self):
        rendered = render_message(
            ["{Hi|Hello}, {{name}} from {A|{B|C}}"],
            {"name": "Marta"},
            random.Random(2),
        )
        self.assertIn(rendered.split(",", 1)[0], {"Hi", "Hello"})
        self.assertIn("Marta", rendered)
        self.assertNotIn("|", rendered)
        self.assertEqual(render_variables("{{known}} {{unknown}}", {"known": "yes"}), "yes {{unknown}}")

    def test_csv_import_normalizes_and_deduplicates(self):
        campaign_id = self.campaign()
        csv_path = Path(self.temp.name) / "contacts.csv"
        csv_path.write_text(
            "instagram,first_name\n@Creator,One\nhttps://instagram.com/creator/,Two\n,Nope\n",
            encoding="utf-8",
        )
        result = import_csv(self.db, campaign_id, csv_path)
        self.assertEqual(result, {"inserted": 1, "duplicates": 1, "invalid": 1})
        self.assertEqual(normalize_username("https://instagram.com/name/?x=1"), "name")

    def test_xlsx_roundtrip_import(self):
        campaign_id = self.campaign()
        path = Path(self.temp.name) / "contacts.xlsx"
        write_xlsx(
            path,
            [
                ["username", "first_name"],
                ["@Alpha", "Ann"],
                ["https://instagram.com/alpha/", "Dup"],
                ["", "Nope"],
            ],
        )
        self.assertEqual(read_xlsx_dicts(path)[0]["username"], "@Alpha")
        result = import_file(self.db, campaign_id, path)
        self.assertEqual(result, {"inserted": 1, "duplicates": 1, "invalid": 1})

    def test_custom_username_import(self):
        campaign_id = self.campaign()
        result = import_usernames(
            self.db, campaign_id, ["custom_user"], source="custom", extra={"first_name": "Ira"}
        )
        self.assertEqual(result["inserted"], 1)

    def test_enqueue_claim_and_send(self):
        campaign_id = self.campaign()
        self.add_contact(campaign_id, "creator", first_name="Олена")
        self.assertEqual(self.engine.enqueue_campaign(campaign_id)["queued"], 1)
        job = self.engine.claim_next("dry_run")
        self.assertEqual(job["username"], "creator")
        self.assertIn("Олена", job["message"])
        self.assertEqual(self.engine.record_result(job["id"], success=True)["status"], "sent")
        with self.db.connect() as connection:
            status = connection.execute(
                "SELECT status FROM campaigns WHERE id=?", (campaign_id,)
            ).fetchone()["status"]
        self.assertEqual(status, "completed")

    def test_delays_gate_the_whole_campaign(self):
        campaign_id = self.campaign(min_delay_seconds=30, max_delay_seconds=30)
        self.add_contact(campaign_id, "one")
        self.add_contact(campaign_id, "two")
        self.engine.enqueue_campaign(campaign_id)
        first = self.engine.claim_next("dry_run")
        self.engine.record_result(first["id"], success=True)
        self.assertIsNone(self.engine.claim_next("dry_run"))
        wait = self.engine.next_wait_seconds("dry_run")
        self.assertIsNotNone(wait)
        self.assertGreaterEqual(wait, 1)

    def test_one_claimed_job_at_a_time(self):
        campaign_id = self.campaign()
        self.add_contact(campaign_id, "one")
        self.add_contact(campaign_id, "two")
        self.engine.enqueue_campaign(campaign_id)
        first = self.engine.claim_next("dry_run")
        self.assertIsNotNone(first)
        self.assertIsNone(self.engine.claim_next("dry_run"))

    def test_batch_pause_after_batch_size(self):
        campaign_id = self.campaign(batch_size=2, batch_pause_seconds=90)
        self.add_contact(campaign_id, "one")
        self.add_contact(campaign_id, "two")
        self.add_contact(campaign_id, "three")
        self.engine.enqueue_campaign(campaign_id)
        first = self.engine.claim_next("dry_run")
        self.engine.record_result(first["id"], success=True)
        second = self.engine.claim_next("dry_run")
        result = self.engine.record_result(second["id"], success=True)
        self.assertEqual(result["next_delay_seconds"], 90)
        self.assertIsNone(self.engine.claim_next("dry_run"))

    def test_403_pauses_and_429_retries(self):
        campaign_id = self.campaign()
        self.add_contact(campaign_id, "first")
        self.engine.enqueue_campaign(campaign_id)
        first = self.engine.claim_next("dry_run")
        result = self.engine.record_result(first["id"], success=False, http_status=403, error="blocked")
        self.assertEqual(result["campaign"], "paused")

        second_campaign = self.campaign(name="Retry")
        self.add_contact(second_campaign, "second")
        self.engine.enqueue_campaign(second_campaign)
        second = self.engine.claim_next("dry_run")
        retry = self.engine.record_result(second["id"], success=False, http_status=429, error="slow down")
        self.assertEqual(retry["status"], "queued")
        self.assertEqual(retry["retry_in_seconds"], 3600)
        self.assertIsNone(self.engine.claim_next("dry_run"))

    def test_history_deduplicates_across_campaigns(self):
        first_campaign = self.campaign(name="First")
        self.add_contact(first_campaign, "same_user")
        self.engine.enqueue_campaign(first_campaign)
        job = self.engine.claim_next("dry_run")
        self.engine.record_result(job["id"], success=True)

        second_campaign = self.campaign(name="Second")
        self.add_contact(second_campaign, "same_user")
        result = self.engine.enqueue_campaign(second_campaign)
        self.assertEqual(result["queued"], 0)
        self.assertEqual(result["skipped_previous"], 1)

    def test_monitor_start_does_not_bulk_enqueue(self):
        campaign_id = self.campaign(name="Monitor", mode="monitor")
        self.add_contact(campaign_id, "creator")
        result = self.engine.enqueue_campaign(campaign_id)
        self.assertEqual(result["mode"], "monitor")
        self.assertEqual(result["queued"], 0)
        self.assertIsNone(self.engine.claim_next("dry_run"))

    def test_monitor_event_is_idempotent(self):
        campaign_id = self.campaign(name="Monitor", mode="monitor")
        first = self.engine.ingest_monitor_event(
            campaign_id=campaign_id,
            event_key="follower:creator:1",
            event_type="new_follower",
            username="creator",
        )
        second = self.engine.ingest_monitor_event(
            campaign_id=campaign_id,
            event_key="follower:creator:1",
            event_type="new_follower",
            username="creator",
        )
        self.assertTrue(first["queued"])
        self.assertEqual(second, {"duplicate": True, "queued": False})

    def test_emergency_stop_blocks_claims(self):
        campaign_id = self.campaign()
        self.add_contact(campaign_id, "creator")
        self.engine.enqueue_campaign(campaign_id)
        self.db.set_emergency_stop(True)
        self.assertIsNone(self.engine.claim_next("dry_run"))
        self.db.set_emergency_stop(False)
        self.assertIsNotNone(self.engine.claim_next("dry_run"))

    def test_daily_limit_blocks_additional_claim(self):
        campaign_id = self.campaign(daily_limit=1)
        self.add_contact(campaign_id, "one")
        self.add_contact(campaign_id, "two")
        self.engine.enqueue_campaign(campaign_id)
        first = self.engine.claim_next("dry_run")
        self.engine.record_result(first["id"], success=True)
        self.assertIsNone(self.engine.claim_next("dry_run"))

    def test_resend_failed_jobs(self):
        campaign_id = self.campaign()
        self.add_contact(campaign_id, "one")
        self.engine.enqueue_campaign(campaign_id)
        job = self.engine.claim_next("dry_run")
        self.engine.record_result(job["id"], success=False, http_status=403, error="blocked")
        result = self.engine.resend(campaign_id, statuses=["failed"])
        self.assertEqual(result["requeued"], 1)
        again = self.engine.claim_next("dry_run")
        self.assertEqual(again["username"], "one")
        self.assertEqual(again["attempt"], 1)

    def test_schema_migration_adds_next_eligible_at(self):
        path = Path(self.temp.name) / "legacy.sqlite"
        import sqlite3

        connection = sqlite3.connect(path)
        connection.executescript(
            """
            CREATE TABLE campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'bulk',
                status TEXT NOT NULL DEFAULT 'draft',
                transport TEXT NOT NULL DEFAULT 'dry_run',
                templates_json TEXT NOT NULL,
                min_delay_seconds INTEGER NOT NULL DEFAULT 60,
                max_delay_seconds INTEGER NOT NULL DEFAULT 120,
                daily_limit INTEGER NOT NULL DEFAULT 30,
                batch_size INTEGER NOT NULL DEFAULT 10,
                batch_pause_seconds INTEGER NOT NULL DEFAULT 1200,
                allow_previous INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 3,
                retry_policy_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE contacts (
                id INTEGER PRIMARY KEY,
                campaign_id INTEGER,
                username TEXT,
                variables_json TEXT,
                source TEXT DEFAULT 'custom',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE jobs (
                id INTEGER PRIMARY KEY,
                campaign_id INTEGER,
                contact_id INTEGER,
                status TEXT,
                scheduled_at TEXT,
                claimed_at TEXT,
                attempts INTEGER,
                selected_message TEXT,
                transport TEXT,
                last_error TEXT,
                http_status INTEGER,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE TABLE send_history (
                id INTEGER PRIMARY KEY,
                campaign_id INTEGER,
                username TEXT,
                message TEXT,
                status TEXT,
                transport TEXT,
                http_status INTEGER,
                error TEXT,
                sent_at TEXT
            );
            CREATE TABLE monitor_events (
                id INTEGER PRIMARY KEY,
                campaign_id INTEGER,
                event_key TEXT UNIQUE,
                event_type TEXT,
                username TEXT,
                payload_json TEXT,
                processed_at TEXT,
                created_at TEXT
            );
            CREATE TABLE runtime_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT
            );
            """
        )
        connection.close()
        db = Database(path)
        db.initialize()
        with db.connect() as migrated:
            cols = {row[1] for row in migrated.execute("PRAGMA table_info(campaigns)")}
        self.assertIn("next_eligible_at", cols)


if __name__ == "__main__":
    unittest.main()
