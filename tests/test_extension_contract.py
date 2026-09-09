from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"


class ExtensionContractTests(unittest.TestCase):
    def test_dom_sending_is_absent(self):
        sources = "\n".join(
            (EXTENSION / name).read_text(encoding="utf-8")
            for name in ("background-parity.js", "content-parity.js", "ijsource.js")
        )
        forbidden = (
            "browser_dom",
            "execCommand",
            "InputEvent",
            "contenteditable",
            "textarea",
            "Message button",
            "DM composer",
            "KeyboardEvent",
            "navigator.clipboard",
        )
        for marker in forbidden:
            self.assertNotIn(marker, sources, marker)

    def test_cookie_thread_and_mqtt_contract_is_present(self):
        background = (EXTENSION / "background-parity.js").read_text(encoding="utf-8")
        content = (EXTENSION / "content-parity.js").read_text(encoding="utf-8")
        injected = (EXTENSION / "ijsource.js").read_text(encoding="utf-8")

        self.assertIn('get("ds_user_id")', content)
        self.assertIn('get("csrftoken")', content)
        self.assertIn("/web/search/topsearch/", background)
        self.assertIn("/api/v1/users/", background)
        self.assertIn("direct_v2/create_group_thread/", content)
        self.assertIn('credentials: "include"', content)
        self.assertIn('type: "INJECT_DISPATCH_DM_REQUEST"', content)
        self.assertIn("wss://edge-chat.instagram.com:443/chat", injected)
        self.assertIn('ct: "cookie_auth"', injected)
        self.assertIn('client.publish("/ig_send_message"', injected)
        self.assertIn('action: "send_item"', injected)
        self.assertIn('item_type: "text"', injected)

    def test_manifest_has_cookie_and_instagram_permissions(self):
        manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
        self.assertIn("cookies", manifest["permissions"])
        self.assertIn("https://*.instagram.com/*", manifest["host_permissions"])
        self.assertEqual(manifest["background"]["service_worker"], "service-worker.js")
        resources = manifest["web_accessible_resources"][0]["resources"]
        self.assertIn("ijsource.js", resources)


if __name__ == "__main__":
    unittest.main()
