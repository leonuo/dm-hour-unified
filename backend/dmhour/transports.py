from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class SendResult:
    success: bool
    http_status: int | None = None
    error: str | None = None
    metadata: dict | None = None


class DryRunTransport:
    name = "dry_run"

    def send(self, username: str, message: str) -> SendResult:
        return SendResult(
            success=True,
            http_status=204,
            metadata={"dry_run": True, "username": username, "message": message},
        )


def http_status_from_exception(exc: BaseException) -> int | None:
    response = getattr(exc, "response", None)
    if response is not None:
        code = getattr(response, "status_code", None)
        if isinstance(code, int):
            return code
    code = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if isinstance(code, int) and 400 <= code <= 599:
        return code
    name = type(exc).__name__.lower()
    text = str(exc).lower()
    if "429" in text or "throttl" in name or "please wait" in text or "rate limit" in text:
        return 429
    if "403" in text or "forbidden" in name or "challenge" in text or "login_required" in text:
        return 403
    if "503" in text:
        return 503
    if "500" in text or "servererror" in name:
        return 500
    if "400" in text or "not found" in text or "badrequest" in name:
        return 400
    return None


def _thread_id_from(thread: object) -> str | None:
    if thread is None:
        return None
    if isinstance(thread, dict):
        value = (
            thread.get("thread_v2_id")
            or thread.get("thread_id")
            or thread.get("id")
        )
        return str(value) if value else None
    for attr in ("id", "thread_id", "thread_v2_id"):
        value = getattr(thread, attr, None)
        if value:
            return str(value)
    return None


class InstagrapiTransport:
    """Optional private API transport, disabled unless explicitly enabled."""

    def __init__(self, prefer_mqtt: bool = False):
        if os.environ.get("DMH_ENABLE_PRIVATE_API") != "1":
            raise RuntimeError(
                "Private API transport is disabled. Set DMH_ENABLE_PRIVATE_API=1 explicitly."
            )
        try:
            from instagrapi import Client  # type: ignore
        except ImportError as exc:
            raise RuntimeError("Install the optional 'instagrapi' dependency") from exc

        username = os.environ.get("DMH_IG_USERNAME")
        password = os.environ.get("DMH_IG_PASSWORD")
        if not username:
            raise RuntimeError("DMH_IG_USERNAME is required")
        self.prefer_mqtt = prefer_mqtt
        self.client = Client()
        session_path = Path(os.environ.get("DMH_IG_SESSION_FILE", "data/ig-session.json"))
        if session_path.exists():
            self.client.load_settings(session_path)
        if not password and not self.client.sessionid:
            raise RuntimeError("DMH_IG_PASSWORD is required for the first login")
        self.client.login(username, password or "")
        session_path.parent.mkdir(parents=True, exist_ok=True)
        self.client.dump_settings(session_path)

    def send(self, username: str, message: str) -> SendResult:
        try:
            user_id = int(self.client.user_id_from_username(username))
            if not self.prefer_mqtt:
                response = self._http_send(user_id, message)
                return SendResult(
                    True,
                    200,
                    metadata={"transport": "http", "thread_id": _thread_id_from(response), "response": str(response)},
                )

            thread_id = self._existing_thread_id(user_id)
            created = False
            if not thread_id:
                thread_id = self._create_thread_http(user_id)
                created = bool(thread_id)
            if not thread_id:
                response = self._http_send(user_id, message)
                return SendResult(
                    True,
                    200,
                    metadata={
                        "transport": "http_first_message",
                        "thread_id": _thread_id_from(response),
                        "response": str(response),
                    },
                )
            mqtt_response = self._mqtt_send(thread_id, message)
            return SendResult(
                True,
                200,
                metadata={
                    "transport": "mqtt",
                    "thread_id": thread_id,
                    "thread_created_http": created,
                    "response": str(mqtt_response),
                },
            )
        except Exception as exc:  # Adapter boundary: preserve provider error for retry policy.
            return SendResult(False, http_status_from_exception(exc), f"{type(exc).__name__}: {exc}")

    def _http_send(self, user_id: int, message: str):
        return self.client.direct_send(message, user_ids=[user_id])

    def _existing_thread_id(self, user_id: int) -> str | None:
        try:
            thread = self.client.direct_thread_by_participants([user_id])
        except Exception:
            return None
        return _thread_id_from(thread)

    def _create_thread_http(self, user_id: int) -> str | None:
        """Open a Direct thread over HTTP before MQTT send."""
        existing = self._existing_thread_id(user_id)
        if existing:
            return existing
        candidates = (
            ("direct_create_group_thread", ([user_id],)),
            ("direct_create_thread", ([user_id],)),
        )
        for name, args in candidates:
            method = getattr(self.client, name, None)
            if method is None:
                continue
            try:
                thread = method(*args)
            except TypeError:
                try:
                    thread = method(user_ids=[user_id])
                except Exception:
                    continue
            except Exception:
                continue
            thread_id = _thread_id_from(thread)
            if thread_id:
                return thread_id
        return self._existing_thread_id(user_id)

    def _mqtt_send(self, thread_id: str, message: str):
        realtime = self.client.realtime_connect()
        try:
            return realtime.direct_send_text(str(thread_id), message)
        finally:
            disconnect = getattr(self.client, "realtime_disconnect", None)
            if disconnect:
                disconnect()


def build_transport(name: str):
    if name == "dry_run":
        return DryRunTransport()
    if name == "instagrapi_http":
        return InstagrapiTransport(prefer_mqtt=False)
    if name == "instagrapi_mqtt":
        return InstagrapiTransport(prefer_mqtt=True)
    raise ValueError(f"Transport {name!r} is not processed by the local worker")
