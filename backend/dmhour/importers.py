from __future__ import annotations

import csv
import json
from collections.abc import Iterable, Mapping
from pathlib import Path

from .database import Database
from .xlsx import read_xlsx_dicts


USERNAME_COLUMNS = ("username", "instagram", "handle", "user")
GRAPH_SOURCES = ("followers", "followings")
FILE_SOURCES = ("csv", "xlsx", "custom")


def normalize_username(value: str) -> str:
    username = value.strip()
    if "instagram.com/" in username:
        username = username.split("instagram.com/", 1)[1].split("?", 1)[0].strip("/")
    return username.lstrip("@").strip()


def _username_column(fieldnames: Iterable[str], username_column: str | None) -> str:
    names = list(fieldnames)
    if username_column:
        if username_column not in names:
            raise ValueError("Username column not found")
        return username_column
    lower_to_original = {name.lower(): name for name in names}
    for candidate in USERNAME_COLUMNS:
        if candidate in lower_to_original:
            return lower_to_original[candidate]
    raise ValueError("Username column not found")


def import_records(
    db: Database,
    campaign_id: int,
    records: Iterable[Mapping[str, object]],
    *,
    username_column: str | None = None,
    source: str = "custom",
) -> dict[str, int]:
    materialized = [dict(record) for record in records]
    if not materialized:
        return {"inserted": 0, "duplicates": 0, "invalid": 0}
    selected = _username_column(materialized[0].keys(), username_column)
    inserted = 0
    duplicates = 0
    invalid = 0
    with db.connect() as connection:
        exists = connection.execute(
            "SELECT 1 FROM campaigns WHERE id=?", (campaign_id,)
        ).fetchone()
        if not exists:
            raise ValueError(f"Campaign {campaign_id} does not exist")
        for row in materialized:
            username = normalize_username(str(row.get(selected, "") or ""))
            if not username:
                invalid += 1
                continue
            variables = {
                str(key): value
                for key, value in row.items()
                if key and value is not None and str(value) != ""
            }
            variables["username"] = username
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO contacts(campaign_id, username, variables_json, source)
                VALUES (?, ?, ?, ?)
                """,
                (campaign_id, username, json.dumps(variables, ensure_ascii=False), source),
            )
            if cursor.rowcount:
                inserted += 1
            else:
                duplicates += 1
    return {"inserted": inserted, "duplicates": duplicates, "invalid": invalid}


def import_csv(
    db: Database,
    campaign_id: int,
    path: str | Path,
    username_column: str | None = None,
    source: str = "csv",
) -> dict[str, int]:
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError("CSV has no header")
        return import_records(
            db, campaign_id, list(reader), username_column=username_column, source=source
        )


def import_xlsx(
    db: Database,
    campaign_id: int,
    path: str | Path,
    username_column: str | None = None,
    source: str = "xlsx",
) -> dict[str, int]:
    return import_records(
        db,
        campaign_id,
        read_xlsx_dicts(path),
        username_column=username_column,
        source=source,
    )


def import_file(
    db: Database,
    campaign_id: int,
    path: str | Path,
    username_column: str | None = None,
) -> dict[str, int]:
    suffix = Path(path).suffix.lower()
    if suffix == ".csv":
        return import_csv(db, campaign_id, path, username_column=username_column)
    if suffix in {".xlsx", ".xlsm"}:
        return import_xlsx(db, campaign_id, path, username_column=username_column)
    raise ValueError(f"Unsupported contact file type: {suffix or path}")


def import_usernames(
    db: Database,
    campaign_id: int,
    usernames: Iterable[str],
    *,
    source: str,
    extra: Mapping[str, object] | None = None,
) -> dict[str, int]:
    records = []
    for username in usernames:
        record = {"username": username, **(extra or {})}
        records.append(record)
    return import_records(db, campaign_id, records, source=source)


def fetch_graph_usernames(
    source: str,
    target_username: str,
    *,
    limit: int | None = None,
    client=None,
) -> list[str]:
    if source not in GRAPH_SOURCES:
        raise ValueError("Source must be 'followers' or 'followings'")
    if client is None:
        from .transports import InstagrapiTransport

        client = InstagrapiTransport(prefer_mqtt=False).client
    target = normalize_username(target_username)
    if not target:
        raise ValueError("Target username is required")
    user_id = int(client.user_id_from_username(target))
    amount = 0 if limit is None else max(0, int(limit))
    if source == "followers":
        mapping = client.user_followers(user_id, amount=amount)
    else:
        mapping = client.user_following(user_id, amount=amount)
    usernames: list[str] = []
    seen: set[str] = set()
    values = mapping.values() if isinstance(mapping, dict) else mapping
    for user in values:
        username = normalize_username(
            getattr(user, "username", None) or (user.get("username") if isinstance(user, dict) else "") or ""
        )
        if not username or username.lower() in seen:
            continue
        seen.add(username.lower())
        usernames.append(username)
        if limit is not None and len(usernames) >= limit:
            break
    return usernames


def import_graph(
    db: Database,
    campaign_id: int,
    source: str,
    target_username: str,
    *,
    limit: int | None = None,
    client=None,
) -> dict[str, int | str]:
    usernames = fetch_graph_usernames(
        source, target_username, limit=limit, client=client
    )
    result = import_usernames(
        db,
        campaign_id,
        usernames,
        source=source,
        extra={"graph_target": normalize_username(target_username)},
    )
    result["source"] = source
    result["fetched"] = len(usernames)
    return result
