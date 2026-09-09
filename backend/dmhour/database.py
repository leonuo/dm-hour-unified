from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'bulk' CHECK(mode IN ('bulk', 'monitor')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'running', 'paused', 'completed')),
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
    next_eligible_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    username TEXT NOT NULL COLLATE NOCASE,
    variables_json TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'custom',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(campaign_id, username)
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'claimed', 'sent', 'skipped', 'failed')),
    scheduled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    selected_message TEXT NOT NULL,
    transport TEXT NOT NULL,
    last_error TEXT,
    http_status INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(campaign_id, contact_id)
);

CREATE TABLE IF NOT EXISTS send_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    username TEXT NOT NULL COLLATE NOCASE,
    message TEXT NOT NULL,
    status TEXT NOT NULL,
    transport TEXT NOT NULL,
    http_status INTEGER,
    error TEXT,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_history_username_status
ON send_history(username, status);

CREATE INDEX IF NOT EXISTS idx_jobs_due
ON jobs(campaign_id, transport, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_history_campaign_sent
ON send_history(campaign_id, status, sent_at);

CREATE TABLE IF NOT EXISTS monitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK(event_type IN ('new_follower', 'new_liker')),
    username TEXT NOT NULL COLLATE NOCASE,
    payload_json TEXT NOT NULL DEFAULT '{}',
    processed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runtime_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO runtime_state(key, value) VALUES ('emergency_stop', '0');
"""


DEFAULT_RETRY_POLICY = {
    "400": {"action": "skip"},
    "403": {"action": "pause"},
    "429": {"action": "retry", "delay_seconds": 3600},
    "500": {"action": "retry", "delay_seconds": 300},
    "503": {"action": "retry", "delay_seconds": 600},
    "default": {"action": "retry", "delay_seconds": 120},
}


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            self._migrate(connection)

    @staticmethod
    def _migrate(connection: sqlite3.Connection) -> None:
        campaign_cols = {
            row[1] for row in connection.execute("PRAGMA table_info(campaigns)")
        }
        if "next_eligible_at" not in campaign_cols:
            connection.execute("ALTER TABLE campaigns ADD COLUMN next_eligible_at TEXT")
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_history_campaign_sent
            ON send_history(campaign_id, status, sent_at)
            """
        )
        # browser_dom was removed: existing local campaigns now use the
        # current Chrome cookie session and injected Web MQTT transport.
        connection.execute(
            "UPDATE campaigns SET transport='web_mqtt' WHERE transport='browser_dom'"
        )
        connection.execute(
            "UPDATE jobs SET transport='web_mqtt' WHERE transport='browser_dom'"
        )

    def create_campaign(
        self,
        *,
        name: str,
        templates: list[str],
        mode: str = "bulk",
        transport: str = "dry_run",
        min_delay_seconds: int = 60,
        max_delay_seconds: int = 120,
        daily_limit: int = 30,
        batch_size: int = 10,
        batch_pause_seconds: int = 1200,
        allow_previous: bool = False,
        max_attempts: int = 3,
        retry_policy: dict | None = None,
    ) -> int:
        if not templates:
            raise ValueError("At least one template is required")
        if min_delay_seconds < 0 or max_delay_seconds < min_delay_seconds:
            raise ValueError("Invalid delay range")
        if daily_limit < 1 or batch_size < 1 or max_attempts < 1:
            raise ValueError("Limits must be positive")
        with self.connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO campaigns(
                    name, mode, transport, templates_json,
                    min_delay_seconds, max_delay_seconds, daily_limit,
                    batch_size, batch_pause_seconds, allow_previous,
                    max_attempts, retry_policy_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    mode,
                    transport,
                    json.dumps(templates, ensure_ascii=False),
                    min_delay_seconds,
                    max_delay_seconds,
                    daily_limit,
                    batch_size,
                    batch_pause_seconds,
                    int(allow_previous),
                    max_attempts,
                    json.dumps(retry_policy or DEFAULT_RETRY_POLICY),
                ),
            )
            return int(cursor.lastrowid)

    def set_emergency_stop(self, enabled: bool) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO runtime_state(key, value, updated_at)
                VALUES ('emergency_stop', ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
                """,
                ("1" if enabled else "0",),
            )

    def emergency_stop_enabled(self, connection: sqlite3.Connection | None = None) -> bool:
        if connection is not None:
            row = connection.execute(
                "SELECT value FROM runtime_state WHERE key='emergency_stop'"
            ).fetchone()
            return bool(row and row["value"] == "1")
        with self.connect() as own_connection:
            return self.emergency_stop_enabled(own_connection)
