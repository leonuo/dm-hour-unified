from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from dmhour.transports import (  # noqa: E402
    InstagrapiTransport,
    SendResult,
    _thread_id_from,
    http_status_from_exception,
)


class DummyError(Exception):
    def __init__(self, message, status_code=None):
        super().__init__(message)
        if status_code is not None:
            self.response = type("Resp", (), {"status_code": status_code})()


class FakeRealtime:
    def __init__(self):
        self.sent = []

    def direct_send_text(self, thread_id, message):
        self.sent.append((thread_id, message))
        return {"ok": True, "thread_id": thread_id}


class FakeClient:
    def __init__(self):
        self.threads = {}
        self.http_sends = []
        self.created = []
        self.realtime = FakeRealtime()

    def user_id_from_username(self, username):
        return 99

    def direct_thread_by_participants(self, user_ids):
        return self.threads.get(tuple(user_ids))

    def direct_create_group_thread(self, user_ids):
        thread = {"thread_id": "thread-1"}
        self.created.append(user_ids)
        self.threads[tuple(user_ids)] = thread
        return thread

    def direct_send(self, message, user_ids):
        self.http_sends.append((message, user_ids))
        return {"thread_id": "http-thread"}

    def realtime_connect(self):
        return self.realtime

    def realtime_disconnect(self):
        return None


class TransportTests(unittest.TestCase):
    def test_http_status_mapping(self):
        self.assertEqual(http_status_from_exception(DummyError("nope", 429)), 429)
        self.assertEqual(http_status_from_exception(DummyError("login_required")), 403)
        self.assertEqual(http_status_from_exception(DummyError("please wait a few minutes")), 429)
        self.assertEqual(http_status_from_exception(DummyError("User not found")), 400)

    def test_thread_id_extraction(self):
        self.assertEqual(_thread_id_from({"thread_v2_id": "abc"}), "abc")
        self.assertEqual(_thread_id_from(type("T", (), {"id": 12})()), "12")

    def test_mqtt_creates_thread_over_http_then_sends(self):
        transport = InstagrapiTransport.__new__(InstagrapiTransport)
        transport.prefer_mqtt = True
        transport.client = FakeClient()
        result = transport.send("creator", "hello")
        self.assertTrue(result.success)
        self.assertEqual(result.metadata["transport"], "mqtt")
        self.assertTrue(result.metadata["thread_created_http"])
        self.assertEqual(transport.client.realtime.sent, [("thread-1", "hello")])
        self.assertEqual(transport.client.http_sends, [])

    def test_http_transport_sends_directly(self):
        transport = InstagrapiTransport.__new__(InstagrapiTransport)
        transport.prefer_mqtt = False
        transport.client = FakeClient()
        result = transport.send("creator", "hello")
        self.assertIsInstance(result, SendResult)
        self.assertEqual(result.metadata["transport"], "http")
        self.assertEqual(transport.client.http_sends, [("hello", [99])])


if __name__ == "__main__":
    unittest.main()
