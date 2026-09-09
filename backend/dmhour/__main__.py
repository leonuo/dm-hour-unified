from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .api import list_history, serve, status_snapshot
from .database import Database
from .engine import CampaignEngine
from .importers import import_file, import_graph, import_usernames
from .transports import build_transport


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="dmhour")
    root.add_argument("--db", default="data/dmhour.sqlite")
    commands = root.add_subparsers(dest="command", required=True)

    commands.add_parser("init")

    create = commands.add_parser("campaign-create")
    create.add_argument("--name", required=True)
    create.add_argument("--template", action="append", required=True)
    create.add_argument("--mode", choices=("bulk", "monitor"), default="bulk")
    create.add_argument(
        "--transport",
        choices=("dry_run", "web_mqtt", "instagrapi_http", "instagrapi_mqtt"),
        default="dry_run",
    )
    create.add_argument("--min-delay", type=int, default=60)
    create.add_argument("--max-delay", type=int, default=120)
    create.add_argument("--daily-limit", type=int, default=30)
    create.add_argument("--batch-size", type=int, default=10)
    create.add_argument("--batch-pause", type=int, default=1200)
    create.add_argument("--allow-previous", action="store_true")

    contact_import = commands.add_parser("contacts-import")
    contact_import.add_argument("--campaign", type=int, required=True)
    contact_import.add_argument("--file", dest="path")
    contact_import.add_argument("--csv", dest="path")
    contact_import.add_argument("--xlsx", dest="path")
    contact_import.add_argument("--username-column")

    contact_add = commands.add_parser("contacts-add")
    contact_add.add_argument("--campaign", type=int, required=True)
    contact_add.add_argument("--username", required=True)
    contact_add.add_argument("--var", action="append", default=[], help="key=value")

    graph = commands.add_parser("contacts-import-ig")
    graph.add_argument("--campaign", type=int, required=True)
    graph.add_argument("--source", choices=("followers", "followings"), required=True)
    graph.add_argument("--username", required=True)
    graph.add_argument("--limit", type=int)

    start = commands.add_parser("campaign-start")
    start.add_argument("--campaign", type=int, required=True)

    control = commands.add_parser("campaign-control")
    control.add_argument("--campaign", type=int, required=True)
    control.add_argument("action", choices=("pause", "resume"))

    resend = commands.add_parser("campaign-resend")
    resend.add_argument("--campaign", type=int, required=True)
    resend.add_argument(
        "--status",
        action="append",
        dest="statuses",
        choices=("failed", "skipped", "sent"),
    )
    resend.add_argument("--regenerate", action="store_true")

    process = commands.add_parser("process")
    process.add_argument("--transport", default="dry_run")
    process.add_argument("--once", action="store_true")
    process.add_argument("--loop", action="store_true")
    process.add_argument("--idle-sleep", type=float, default=1.0)

    monitor = commands.add_parser("monitor-ingest")
    monitor.add_argument("--campaign", type=int, required=True)
    monitor.add_argument("--event-key", required=True)
    monitor.add_argument("--event-type", choices=("new_follower", "new_liker"), required=True)
    monitor.add_argument("--username", required=True)
    monitor.add_argument("--payload", default="{}")

    stop = commands.add_parser("emergency-stop")
    stop.add_argument("state", choices=("on", "off"))

    commands.add_parser("status")
    history = commands.add_parser("history")
    history.add_argument("--campaign", type=int)
    history.add_argument("--limit", type=int, default=50)

    server = commands.add_parser("serve")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8765)
    return root


def _parse_vars(items: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(f"Expected key=value, got {item!r}")
        key, value = item.split("=", 1)
        values[key] = value
    return values


def _run_process(engine: CampaignEngine, args) -> None:
    if args.transport == "web_mqtt":
        raise SystemExit("web_mqtt jobs are claimed by the Chrome extension, not process")
    transport = build_transport(args.transport)
    processed = 0
    while True:
        engine.recover_stale_claims()
        job = engine.claim_next(args.transport)
        if not job:
            if args.once or not args.loop:
                break
            wait = engine.next_wait_seconds(args.transport)
            time.sleep(args.idle_sleep if wait is None else max(args.idle_sleep, min(wait, 30)))
            continue
        result = transport.send(job["username"], job["message"])
        outcome = engine.record_result(
            job["id"],
            success=result.success,
            error=result.error,
            http_status=result.http_status,
        )
        processed += 1
        print(json.dumps({"job": job, "outcome": outcome, "meta": result.metadata}, ensure_ascii=False))
        if args.once:
            break
        if not args.loop:
            wait = engine.next_wait_seconds(args.transport) or 0
            if wait > 0:
                break
    if not processed:
        print(json.dumps({"processed": 0}))


def main() -> None:
    args = parser().parse_args()
    db = Database(Path(args.db))
    db.initialize()
    engine = CampaignEngine(db)

    if args.command == "init":
        print(json.dumps({"initialized": str(db.path)}, ensure_ascii=False))
    elif args.command == "campaign-create":
        campaign_id = db.create_campaign(
            name=args.name,
            templates=args.template,
            mode=args.mode,
            transport=args.transport,
            min_delay_seconds=args.min_delay,
            max_delay_seconds=args.max_delay,
            daily_limit=args.daily_limit,
            batch_size=args.batch_size,
            batch_pause_seconds=args.batch_pause,
            allow_previous=args.allow_previous,
        )
        print(json.dumps({"campaign_id": campaign_id}))
    elif args.command == "contacts-import":
        if not args.path:
            raise SystemExit("Provide --file, --csv or --xlsx")
        print(
            json.dumps(
                import_file(db, args.campaign, args.path, args.username_column),
                ensure_ascii=False,
            )
        )
    elif args.command == "contacts-add":
        print(
            json.dumps(
                import_usernames(
                    db,
                    args.campaign,
                    [args.username],
                    source="custom",
                    extra=_parse_vars(args.var),
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "contacts-import-ig":
        print(
            json.dumps(
                import_graph(
                    db,
                    args.campaign,
                    args.source,
                    args.username,
                    limit=args.limit,
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "campaign-start":
        print(json.dumps(engine.enqueue_campaign(args.campaign), ensure_ascii=False))
    elif args.command == "campaign-control":
        status = "paused" if args.action == "pause" else "running"
        with db.connect() as connection:
            cursor = connection.execute(
                "UPDATE campaigns SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                (status, args.campaign),
            )
        if not cursor.rowcount:
            raise SystemExit(f"Campaign {args.campaign} does not exist")
        print(json.dumps({"campaign_id": args.campaign, "status": status}))
    elif args.command == "campaign-resend":
        print(
            json.dumps(
                engine.resend(
                    args.campaign,
                    statuses=args.statuses or ["failed", "skipped"],
                    regenerate_message=args.regenerate,
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "process":
        _run_process(engine, args)
    elif args.command == "monitor-ingest":
        print(
            json.dumps(
                engine.ingest_monitor_event(
                    campaign_id=args.campaign,
                    event_key=args.event_key,
                    event_type=args.event_type,
                    username=args.username,
                    payload=json.loads(args.payload),
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "emergency-stop":
        enabled = args.state == "on"
        db.set_emergency_stop(enabled)
        print(json.dumps({"emergency_stop": enabled}))
    elif args.command == "status":
        print(json.dumps(status_snapshot(db), ensure_ascii=False, indent=2))
    elif args.command == "history":
        print(json.dumps({"items": list_history(db, args.campaign, args.limit)}, ensure_ascii=False, indent=2))
    elif args.command == "serve":
        serve(db, args.host, args.port)


if __name__ == "__main__":
    main()
