from __future__ import annotations

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .database import Database
from .engine import CampaignEngine
from .importers import import_file, import_graph, import_usernames


RESULT_RE = re.compile(r"^/api/jobs/(\d+)/result$")
CAMPAIGN_RE = re.compile(r"^/api/campaigns/(\d+)/(pause|resume|start|resend)$")
STATIC_DIR = Path(__file__).resolve().parent / "static"
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
}


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "DMHourLocal/0.2"

    @property
    def db(self) -> Database:
        return self.server.db  # type: ignore[attr-defined]

    @property
    def engine(self) -> CampaignEngine:
        return self.server.engine  # type: ignore[attr-defined]

    def log_message(self, format: str, *args) -> None:
        super().log_message(format, *args)

    def _authorized(self) -> bool:
        expected = os.environ.get("DMH_API_TOKEN")
        return not expected or self.headers.get("X-DM-Hour-Token") == expected

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "http://127.0.0.1:8765"))
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-DM-Hour-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, status: int, payload: dict | list) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("JSON body must be an object")
        return parsed

    def _static(self, relative: str) -> bool:
        target = (STATIC_DIR / relative).resolve()
        if STATIC_DIR not in target.parents and target != STATIC_DIR:
            return False
        if not target.is_file():
            return False
        self._bytes(200, target.read_bytes(), MIME.get(target.suffix, "application/octet-stream"))
        return True

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in {"/", "/index.html"}:
            if self._static("index.html"):
                return
            self._json(404, {"error": "dashboard_missing"})
            return
        if parsed.path.startswith("/static/"):
            if self._static(parsed.path.removeprefix("/static/")):
                return
            self._json(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        try:
            if parsed.path == "/api/health":
                self._json(200, {"ok": True, "service": "dm-hour-local", "version": "0.2.0"})
                return
            if parsed.path == "/api/status":
                self._json(200, status_snapshot(self.db))
                return
            if parsed.path == "/api/history":
                query = parse_qs(parsed.query)
                campaign_id = int(query["campaign_id"][0]) if query.get("campaign_id") else None
                limit = int(query.get("limit", ["50"])[0])
                self._json(200, {"items": list_history(self.db, campaign_id, limit)})
                return
            if parsed.path == "/api/jobs/next":
                transport = parse_qs(parsed.query).get("transport", ["web_mqtt"])[0]
                if transport != "web_mqtt":
                    self._json(400, {"error": "Only web_mqtt jobs can be claimed by the Chrome extension"})
                    return
                self.engine.recover_stale_claims()
                job = self.engine.claim_next(transport)
                self._json(200, {"job": job})
                return
            self._json(404, {"error": "not_found"})
        except Exception as exc:
            self._json(400, {"error": f"{type(exc).__name__}: {exc}"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        parsed = urlparse(self.path)
        try:
            body = self._body()
            if parsed.path == "/api/emergency-stop":
                enabled = bool(body.get("enabled"))
                self.db.set_emergency_stop(enabled)
                self._json(200, {"emergency_stop": enabled})
                return
            if parsed.path == "/api/campaigns":
                campaign_id = self.db.create_campaign(
                    name=str(body["name"]),
                    templates=list(body["templates"]),
                    mode=str(body.get("mode") or "bulk"),
                    transport=str(body.get("transport") or "dry_run"),
                    min_delay_seconds=int(body.get("min_delay_seconds") or 60),
                    max_delay_seconds=int(body.get("max_delay_seconds") or 120),
                    daily_limit=int(body.get("daily_limit") or 30),
                    batch_size=int(body.get("batch_size") or 10),
                    batch_pause_seconds=int(body.get("batch_pause_seconds") or 1200),
                    allow_previous=bool(body.get("allow_previous")),
                )
                self._json(200, {"campaign_id": campaign_id})
                return
            if parsed.path == "/api/contacts/import":
                result = import_file(
                    self.db,
                    int(body["campaign_id"]),
                    body["path"],
                    body.get("username_column"),
                )
                self._json(200, result)
                return
            if parsed.path == "/api/contacts/add":
                result = import_usernames(
                    self.db,
                    int(body["campaign_id"]),
                    [str(body["username"])],
                    source=str(body.get("source") or "custom"),
                    extra=body.get("variables") or {},
                )
                self._json(200, result)
                return
            if parsed.path == "/api/contacts/import-ig":
                result = import_graph(
                    self.db,
                    int(body["campaign_id"]),
                    str(body["source"]),
                    str(body["username"]),
                    limit=int(body["limit"]) if body.get("limit") is not None else None,
                )
                self._json(200, result)
                return
            result_match = RESULT_RE.match(parsed.path)
            if result_match:
                result = self.engine.record_result(
                    int(result_match.group(1)),
                    success=bool(body.get("success")),
                    error=body.get("error"),
                    http_status=body.get("http_status"),
                )
                self._json(200, result)
                return
            campaign_match = CAMPAIGN_RE.match(parsed.path)
            if campaign_match:
                campaign_id = int(campaign_match.group(1))
                action = campaign_match.group(2)
                if action == "start":
                    self._json(200, self.engine.enqueue_campaign(campaign_id))
                    return
                if action == "resend":
                    statuses = body.get("statuses") or ["failed", "skipped"]
                    self._json(
                        200,
                        self.engine.resend(
                            campaign_id,
                            statuses=list(statuses),
                            regenerate_message=bool(body.get("regenerate_message")),
                        ),
                    )
                    return
                status = "paused" if action == "pause" else "running"
                with self.db.connect() as connection:
                    cursor = connection.execute(
                        "UPDATE campaigns SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                        (status, campaign_id),
                    )
                if not cursor.rowcount:
                    self._json(404, {"error": "campaign_not_found"})
                else:
                    self._json(200, {"campaign_id": campaign_id, "status": status})
                return
            if parsed.path == "/api/monitor/events":
                result = self.engine.ingest_monitor_event(
                    campaign_id=int(body["campaign_id"]),
                    event_key=str(body["event_key"]),
                    event_type=str(body["event_type"]),
                    username=str(body["username"]),
                    payload=body.get("payload") or {},
                )
                self._json(200, result)
                return
            self._json(404, {"error": "not_found"})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self._json(400, {"error": f"{type(exc).__name__}: {exc}"})
        except Exception as exc:
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})


def list_history(db: Database, campaign_id: int | None, limit: int) -> list[dict]:
    limit = max(1, min(limit, 500))
    with db.connect() as connection:
        if campaign_id is None:
            rows = connection.execute(
                """
                SELECT id, campaign_id, username, status, transport, http_status, error, sent_at
                FROM send_history ORDER BY id DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
        else:
            rows = connection.execute(
                """
                SELECT id, campaign_id, username, status, transport, http_status, error, sent_at
                FROM send_history WHERE campaign_id=? ORDER BY id DESC LIMIT ?
                """,
                (campaign_id, limit),
            ).fetchall()
    return [dict(row) for row in rows]


def status_snapshot(db: Database) -> dict:
    with db.connect() as connection:
        campaigns = [
            dict(row)
            for row in connection.execute(
                """
                SELECT campaigns.id, campaigns.name, campaigns.mode, campaigns.status,
                       campaigns.transport, campaigns.daily_limit, campaigns.next_eligible_at,
                       SUM(CASE WHEN jobs.status='queued' THEN 1 ELSE 0 END) AS queued,
                       SUM(CASE WHEN jobs.status='claimed' THEN 1 ELSE 0 END) AS claimed,
                       SUM(CASE WHEN jobs.status='sent' THEN 1 ELSE 0 END) AS sent,
                       SUM(CASE WHEN jobs.status='skipped' THEN 1 ELSE 0 END) AS skipped,
                       SUM(CASE WHEN jobs.status='failed' THEN 1 ELSE 0 END) AS failed
                FROM campaigns LEFT JOIN jobs ON jobs.campaign_id=campaigns.id
                GROUP BY campaigns.id ORDER BY campaigns.id
                """
            )
        ]
        emergency = db.emergency_stop_enabled(connection)
    return {"emergency_stop": emergency, "campaigns": campaigns}


def serve(db: Database, host: str = "127.0.0.1", port: int = 8765) -> None:
    if host not in {"127.0.0.1", "localhost"}:
        raise ValueError("DM Hour API may only bind to localhost")
    server = ThreadingHTTPServer((host, port), ApiHandler)
    server.db = db  # type: ignore[attr-defined]
    server.engine = CampaignEngine(db)  # type: ignore[attr-defined]
    print(f"DM Hour local API listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDM Hour local API stopped")
    finally:
        server.server_close()
