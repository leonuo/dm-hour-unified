from __future__ import annotations

import json
import random
import sqlite3
from datetime import datetime, timedelta, timezone

from .database import Database
from .spintax import render_message


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def sql_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


RESENDABLE_STATUSES = frozenset({"failed", "skipped", "sent"})


class CampaignEngine:
    def __init__(self, db: Database, rng: random.Random | None = None):
        self.db = db
        self.rng = rng or random.Random()

    def enqueue_campaign(self, campaign_id: int) -> dict[str, int | str]:
        queued = 0
        skipped_previous = 0
        with self.db.connect() as connection:
            campaign = connection.execute(
                "SELECT * FROM campaigns WHERE id=?", (campaign_id,)
            ).fetchone()
            if not campaign:
                raise ValueError(f"Campaign {campaign_id} does not exist")
            if campaign["mode"] == "monitor":
                connection.execute(
                    """
                    UPDATE campaigns
                    SET status='running', next_eligible_at=NULL, updated_at=CURRENT_TIMESTAMP
                    WHERE id=?
                    """,
                    (campaign_id,),
                )
                return {
                    "queued": 0,
                    "skipped_previous": 0,
                    "mode": "monitor",
                }
            templates = json.loads(campaign["templates_json"])
            contacts = connection.execute(
                "SELECT * FROM contacts WHERE campaign_id=? ORDER BY id", (campaign_id,)
            ).fetchall()
            previously_sent = {
                row["username"].lower()
                for row in connection.execute(
                    "SELECT DISTINCT username FROM send_history WHERE status='sent'"
                )
            }
            for contact in contacts:
                if not campaign["allow_previous"] and contact["username"].lower() in previously_sent:
                    skipped_previous += 1
                    continue
                variables = json.loads(contact["variables_json"])
                variables.setdefault("username", contact["username"])
                message = render_message(templates, variables, self.rng)
                cursor = connection.execute(
                    """
                    INSERT OR IGNORE INTO jobs(
                        campaign_id, contact_id, selected_message, transport
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (campaign_id, contact["id"], message, campaign["transport"]),
                )
                queued += cursor.rowcount
            connection.execute(
                """
                UPDATE campaigns
                SET status='running', next_eligible_at=NULL, updated_at=CURRENT_TIMESTAMP
                WHERE id=?
                """,
                (campaign_id,),
            )
        return {"queued": queued, "skipped_previous": skipped_previous, "mode": "bulk"}

    def claim_next(self, transport: str) -> dict | None:
        now = sql_time(utc_now())
        today = now[:10]
        with self.db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if self.db.emergency_stop_enabled(connection):
                return None
            candidate_campaigns = connection.execute(
                """
                SELECT * FROM campaigns
                WHERE status='running' AND transport=?
                ORDER BY id
                """,
                (transport,),
            ).fetchall()
            for campaign in candidate_campaigns:
                eligible_at = campaign["next_eligible_at"]
                if eligible_at and eligible_at > now:
                    continue
                in_flight = connection.execute(
                    """
                    SELECT 1 FROM jobs
                    WHERE campaign_id=? AND status='claimed'
                    LIMIT 1
                    """,
                    (campaign["id"],),
                ).fetchone()
                if in_flight:
                    continue
                sent_today = connection.execute(
                    """
                    SELECT COUNT(*) AS count FROM send_history
                    WHERE campaign_id=? AND status='sent' AND substr(sent_at, 1, 10)=?
                    """,
                    (campaign["id"], today),
                ).fetchone()["count"]
                if sent_today >= campaign["daily_limit"]:
                    continue
                job = connection.execute(
                    """
                    SELECT jobs.*, contacts.username, contacts.variables_json
                    FROM jobs JOIN contacts ON contacts.id=jobs.contact_id
                    WHERE jobs.campaign_id=? AND jobs.status='queued'
                      AND jobs.scheduled_at <= ?
                    ORDER BY jobs.scheduled_at, jobs.id
                    LIMIT 1
                    """,
                    (campaign["id"], now),
                ).fetchone()
                if not job:
                    self._complete_if_finished(connection, campaign["id"])
                    continue
                updated = connection.execute(
                    """
                    UPDATE jobs SET status='claimed', claimed_at=CURRENT_TIMESTAMP,
                        attempts=attempts+1, updated_at=CURRENT_TIMESTAMP
                    WHERE id=? AND status='queued'
                    """,
                    (job["id"],),
                )
                if not updated.rowcount:
                    continue
                return {
                    "id": job["id"],
                    "campaign_id": job["campaign_id"],
                    "username": job["username"],
                    "message": job["selected_message"],
                    "variables": json.loads(job["variables_json"] or "{}"),
                    "transport": job["transport"],
                    "attempt": job["attempts"] + 1,
                }
        return None

    def record_result(
        self,
        job_id: int,
        *,
        success: bool,
        error: str | None = None,
        http_status: int | None = None,
    ) -> dict:
        with self.db.connect() as connection:
            job = connection.execute(
                """
                SELECT jobs.*, contacts.username, campaigns.retry_policy_json,
                       campaigns.max_attempts, campaigns.min_delay_seconds,
                       campaigns.max_delay_seconds, campaigns.batch_size,
                       campaigns.batch_pause_seconds
                FROM jobs
                JOIN contacts ON contacts.id=jobs.contact_id
                JOIN campaigns ON campaigns.id=jobs.campaign_id
                WHERE jobs.id=?
                """,
                (job_id,),
            ).fetchone()
            if not job:
                raise ValueError(f"Job {job_id} does not exist")
            if job["status"] != "claimed":
                raise ValueError(f"Job {job_id} is not claimed")

            if success:
                final_status = "sent"
                connection.execute(
                    """
                    UPDATE jobs SET status='sent', http_status=?, last_error=NULL,
                        updated_at=CURRENT_TIMESTAMP WHERE id=?
                    """,
                    (http_status, job_id),
                )
                self._write_history(connection, job, final_status, http_status, None)
                delay = self._mark_campaign_wait(connection, job)
                self._complete_if_finished(connection, job["campaign_id"])
                return {"status": final_status, "next_delay_seconds": delay}

            policy = json.loads(job["retry_policy_json"])
            rule = policy.get(str(http_status), policy.get("default", {"action": "skip"}))
            action = rule.get("action", "skip")
            if action == "pause":
                connection.execute(
                    "UPDATE jobs SET status='failed', http_status=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (http_status, error, job_id),
                )
                connection.execute(
                    "UPDATE campaigns SET status='paused', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (job["campaign_id"],),
                )
                self._write_history(connection, job, "failed", http_status, error)
                return {"status": "failed", "campaign": "paused"}

            if action == "retry" and job["attempts"] < job["max_attempts"]:
                delay = int(rule.get("delay_seconds", 120))
                connection.execute(
                    """
                    UPDATE jobs SET status='queued', scheduled_at=?, http_status=?,
                        last_error=?, claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
                    WHERE id=?
                    """,
                    (sql_time(utc_now() + timedelta(seconds=delay)), http_status, error, job_id),
                )
                self._mark_campaign_wait(connection, job, delay_seconds=delay)
                return {"status": "queued", "retry_in_seconds": delay}

            connection.execute(
                "UPDATE jobs SET status='skipped', http_status=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (http_status, error, job_id),
            )
            self._write_history(connection, job, "skipped", http_status, error)
            delay = self._mark_campaign_wait(connection, job)
            self._complete_if_finished(connection, job["campaign_id"])
            return {"status": "skipped", "next_delay_seconds": delay}

    def recover_stale_claims(self, older_than_seconds: int = 300) -> int:
        threshold = sql_time(utc_now() - timedelta(seconds=older_than_seconds))
        with self.db.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE jobs SET status='queued', claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
                WHERE status='claimed' AND claimed_at < ?
                """,
                (threshold,),
            )
            return cursor.rowcount

    def resend(
        self,
        campaign_id: int,
        *,
        statuses: list[str] | tuple[str, ...] = ("failed", "skipped"),
        regenerate_message: bool = False,
    ) -> dict[str, int | str]:
        requested = {status.strip() for status in statuses if status.strip()}
        unknown = requested - RESENDABLE_STATUSES
        if unknown:
            raise ValueError(f"Cannot resend statuses: {sorted(unknown)}")
        if not requested:
            raise ValueError("At least one status is required")
        placeholders = ",".join("?" for _ in requested)
        with self.db.connect() as connection:
            campaign = connection.execute(
                "SELECT * FROM campaigns WHERE id=?", (campaign_id,)
            ).fetchone()
            if not campaign:
                raise ValueError(f"Campaign {campaign_id} does not exist")
            templates = json.loads(campaign["templates_json"])
            jobs = connection.execute(
                f"""
                SELECT jobs.*, contacts.username, contacts.variables_json
                FROM jobs JOIN contacts ON contacts.id=jobs.contact_id
                WHERE jobs.campaign_id=? AND jobs.status IN ({placeholders})
                ORDER BY jobs.id
                """,
                (campaign_id, *requested),
            ).fetchall()
            reset = 0
            for job in jobs:
                message = job["selected_message"]
                if regenerate_message:
                    variables = json.loads(job["variables_json"])
                    variables.setdefault("username", job["username"])
                    message = render_message(templates, variables, self.rng)
                cursor = connection.execute(
                    """
                    UPDATE jobs
                    SET status='queued', selected_message=?, attempts=0, claimed_at=NULL,
                        last_error=NULL, http_status=NULL, scheduled_at=CURRENT_TIMESTAMP,
                        updated_at=CURRENT_TIMESTAMP
                    WHERE id=? AND status IN ({})
                    """.format(placeholders),
                    (message, job["id"], *requested),
                )
                reset += cursor.rowcount
            connection.execute(
                """
                UPDATE campaigns
                SET status='running', next_eligible_at=NULL, updated_at=CURRENT_TIMESTAMP
                WHERE id=?
                """,
                (campaign_id,),
            )
        return {"requeued": reset, "campaign_id": campaign_id}

    def ingest_monitor_event(
        self,
        *,
        campaign_id: int,
        event_key: str,
        event_type: str,
        username: str,
        payload: dict | None = None,
    ) -> dict:
        if event_type not in {"new_follower", "new_liker"}:
            raise ValueError("Unsupported monitor event type")
        username = username.strip().lstrip("@")
        if not username:
            raise ValueError("Username is required")
        with self.db.connect() as connection:
            campaign = connection.execute(
                "SELECT * FROM campaigns WHERE id=?", (campaign_id,)
            ).fetchone()
            if not campaign:
                raise ValueError(f"Campaign {campaign_id} does not exist")
            event_cursor = connection.execute(
                """
                INSERT OR IGNORE INTO monitor_events(
                    campaign_id, event_key, event_type, username, payload_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (campaign_id, event_key, event_type, username, json.dumps(payload or {})),
            )
            if not event_cursor.rowcount:
                return {"duplicate": True, "queued": False}
            variables = {"username": username, "event_type": event_type, **(payload or {})}
            contact_cursor = connection.execute(
                """
                INSERT OR IGNORE INTO contacts(campaign_id, username, variables_json, source)
                VALUES (?, ?, ?, ?)
                """,
                (campaign_id, username, json.dumps(variables, ensure_ascii=False), event_type),
            )
            contact = connection.execute(
                "SELECT * FROM contacts WHERE campaign_id=? AND username=?",
                (campaign_id, username),
            ).fetchone()
            previous = None
            if not campaign["allow_previous"]:
                previous = connection.execute(
                    "SELECT 1 FROM send_history WHERE username=? AND status='sent' LIMIT 1",
                    (username,),
                ).fetchone()
            queued = False
            if not previous:
                message = render_message(
                    json.loads(campaign["templates_json"]), variables, self.rng
                )
                job_cursor = connection.execute(
                    """
                    INSERT OR IGNORE INTO jobs(campaign_id, contact_id, selected_message, transport)
                    VALUES (?, ?, ?, ?)
                    """,
                    (campaign_id, contact["id"], message, campaign["transport"]),
                )
                queued = bool(job_cursor.rowcount)
            connection.execute(
                "UPDATE monitor_events SET processed_at=CURRENT_TIMESTAMP WHERE event_key=?",
                (event_key,),
            )
            if campaign["status"] in {"draft", "completed"}:
                connection.execute(
                    "UPDATE campaigns SET status='running', updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (campaign_id,),
                )
            return {
                "duplicate": False,
                "contact_inserted": bool(contact_cursor.rowcount),
                "queued": queued,
                "skipped_previous": bool(previous),
            }

    def next_wait_seconds(self, transport: str | None = None) -> int | None:
        now = utc_now()
        now_sql = sql_time(now)
        with self.db.connect() as connection:
            if self.db.emergency_stop_enabled(connection):
                return None
            query = """
                SELECT next_eligible_at FROM campaigns
                WHERE status='running'
            """
            params: list = []
            if transport:
                query += " AND transport=?"
                params.append(transport)
            query += " ORDER BY CASE WHEN next_eligible_at IS NULL THEN 0 ELSE 1 END, next_eligible_at"
            row = connection.execute(query, params).fetchone()
            if not row:
                return None
            eligible = row["next_eligible_at"]
            if not eligible or eligible <= now_sql:
                return 0
            due = datetime.strptime(eligible, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            return max(0, int((due - now).total_seconds()))

    def _mark_campaign_wait(
        self,
        connection: sqlite3.Connection,
        job: sqlite3.Row,
        delay_seconds: int | None = None,
    ) -> int:
        if delay_seconds is None:
            sent_count = connection.execute(
                "SELECT COUNT(*) AS count FROM send_history WHERE campaign_id=? AND status='sent'",
                (job["campaign_id"],),
            ).fetchone()["count"]
            if sent_count and sent_count % job["batch_size"] == 0:
                delay_seconds = int(job["batch_pause_seconds"])
            else:
                delay_seconds = self.rng.randint(
                    int(job["min_delay_seconds"]), int(job["max_delay_seconds"])
                )
        connection.execute(
            """
            UPDATE campaigns
            SET next_eligible_at=?, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
            """,
            (sql_time(utc_now() + timedelta(seconds=delay_seconds)), job["campaign_id"]),
        )
        return int(delay_seconds)

    @staticmethod
    def _write_history(
        connection: sqlite3.Connection,
        job: sqlite3.Row,
        status: str,
        http_status: int | None,
        error: str | None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO send_history(
                campaign_id, username, message, status, transport, http_status, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job["campaign_id"],
                job["username"],
                job["selected_message"],
                status,
                job["transport"],
                http_status,
                error,
            ),
        )

    @staticmethod
    def _complete_if_finished(connection: sqlite3.Connection, campaign_id: int) -> None:
        remaining = connection.execute(
            "SELECT 1 FROM jobs WHERE campaign_id=? AND status IN ('queued', 'claimed') LIMIT 1",
            (campaign_id,),
        ).fetchone()
        if not remaining:
            connection.execute(
                "UPDATE campaigns SET status='completed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'",
                (campaign_id,),
            )
