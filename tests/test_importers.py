from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from dmhour.database import Database  # noqa: E402
from dmhour.importers import fetch_graph_usernames, import_graph  # noqa: E402


class FakeUser:
    def __init__(self, username):
        self.username = username


class FakeClient:
    def user_id_from_username(self, username):
        self.target = username
        return 42

    def user_followers(self, user_id, amount=0):
        self.seen = ("followers", user_id, amount)
        return {1: FakeUser("first"), 2: FakeUser("@First"), 3: FakeUser("second")}

    def user_following(self, user_id, amount=0):
        self.seen = ("followings", user_id, amount)
        return {1: FakeUser("alpha")}


class GraphImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / "test.sqlite")
        self.db.initialize()
        self.campaign_id = self.db.create_campaign(name="Graph", templates=["Hi {{username}}"])
        self.client = FakeClient()

    def tearDown(self):
        self.temp.cleanup()

    def test_followers_deduplicate_and_limit(self):
        names = fetch_graph_usernames("followers", "brand", limit=2, client=self.client)
        self.assertEqual(names, ["first", "second"])
        result = import_graph(
            self.db, self.campaign_id, "followers", "brand", limit=2, client=self.client
        )
        self.assertEqual(result["inserted"], 2)
        self.assertEqual(result["source"], "followers")

    def test_followings_source(self):
        names = fetch_graph_usernames("followings", "brand", client=self.client)
        self.assertEqual(names, ["alpha"])
        self.assertEqual(self.client.seen[0], "followings")


if __name__ == "__main__":
    unittest.main()
