from __future__ import annotations

import json
from pathlib import Path


WEIGHTS = {
    "API-01": 3, "API-02": 5, "API-03": 4, "API-04": 4, "API-05": 4, "API-06": 5, "API-07": 5,
    "ARC-01": 3, "ARC-02": 4, "ARC-03": 5, "ARC-04": 3,
    "RUN-01": 7, "RUN-02": 7, "RUN-03": 5, "RUN-04": 3, "RUN-05": 3,
    "MSG-01": 3, "MSG-02": 3, "MSG-03": 4,
    "UI-01": 4, "UI-02": 3, "UI-03": 3, "UI-04": 3, "UI-05": 2,
    "ERR-01": 2, "ERR-02": 3,
}


def evaluate(root: Path) -> list[dict]:
    ext = root / "extension"
    files = {p.name: p.read_text(encoding="utf-8") for p in ext.iterdir() if p.suffix in {".js", ".html", ".json"}}
    bg = files["background-parity.js"]
    content = files["content-parity.js"]
    common = files["common.js"]
    mqtt = files["ijsource.js"]
    popup = files["popup-parity.js"] + files["popup-parity.html"]
    manifest = json.loads(files["manifest.json"])

    def all_in(text: str, *needles: str) -> bool:
        return all(needle in text for needle in needles)

    checks = {
        "API-01": all_in(bg + content, "chrome.cookies.get", 'get("ds_user_id")', 'get("csrftoken")'),
        "API-02": all_in(content, "/api/v1/news/inbox/", 'credentials: "include"', "story.type === 3", "story.story_type === 101", "story.type === 1", "story.story_type === 768"),
        "API-03": all_in(bg, "/web/search/topsearch/", "toLowerCase() === username.toLowerCase()", "randomInt(400, 1500)", "/api/v1/users/", "x-ig-www-claim"),
        "API-04": all_in(common + content, "37479f2b8209594dde7facb0d904896a", "edge_followed_by", "first: 50", "end_cursor"),
        "API-05": all_in(common + content, "58712303d941c6855d4e888c5f0cd22f", "edge_follow", "first: 50", "end_cursor"),
        "API-06": all_in(content, "/api/v1/direct_v2/create_group_thread/", "recipient_users", 'credentials: "include"', "X-CSRFToken", "X-IG-App-ID", "payload.thread_id", "payload.viewer_id"),
        "API-07": all_in(mqtt, "MQIsdp", "new WebSocket(this.url);", "payloadDeviceId", "d: crypto.randomUUID()", 'ct: "cookie_auth"', 'client.publish("/ig_send_message"', 'action: "send_item"', 'item_type: "text"', "clientContext - 100000"),
        "ARC-01": manifest.get("manifest_version") == 3 and manifest["background"]["service_worker"] == "service-worker.js" and manifest["content_scripts"][0]["js"] == ["common.js", "content-parity.js"] and manifest["content_scripts"][0]["matches"] == ["https://www.instagram.com/*"],
        "ARC-02": all_in(common + bg + content, "bot_list", "work_bot", "comment_list", "comments", "monitor_inbox_pool", "dm_custom_queue_bot_pool", "dm_message_history_pool", "dm_user_history_pool", "dm_custom_dup_users_history_bot", "dm_404_custom_dup_users_history_bot", "permanent_tab_info"),
        "ARC-03": all_in(common + bg, "polling_monitor_schedule", "next_dm_schedule", "active: false", "setInterval(attempt, 3000)", "Date.now() - start > 30000"),
        "ARC-04": all_in(common + bg + content, "connect_content_req", "connect_content_res", "monitor_new_follower", "send_dm_to_new_follower", "send_bulk_dm_to_follower", "req_user_info", "INJECT_DISPATCH_DM_REQUEST", "INJECT_DISPATCH_DM_RESPONSE"),
        "RUN-01": all_in(bg + content, "skip_day_before_by_monitor_num", "monitor_store_date", "day_dm_num", "monitor_inbox_pool", "dm_user_history_pool", "profile_id"),
        "RUN-02": all_in(content, "bulk_limit_max_users_count", "has_next_page", "runtime.edges.shift", "randomInt(3000, 6000)", "edge_followed_by", "edge_follow"),
        "RUN-03": all_in(content + popup, "dm_custom_queue_bot_pool", "send_message_type", "can_dm_to_privious_user", "dm_custom_dup_users_history_bot", "dm_404_custom_dup_users_history_bot"),
        "RUN-04": all_in(bg, "group_message_num", "group_range_interval", "range_interval", "60000", "APP.ALARM.NEXT_DM"),
        "RUN-05": all_in(bg + content + popup, "randomInt(10000, 30000)", "SKIP_CURRENT_USER", "skipCurrent"),
        "MSG-01": all_in(common + popup, "comment_list", "comments", "list_id", "randomInt(0, candidates.length - 1)"),
        "MSG-02": all_in(common, "renderSpintax", "SpintaxError", 'char === "{"', 'char === "|"', 'char === "}"'),
        "MSG-03": all_in(common, 'replaceAll("<Username>"', "Object.entries(csvRow)", "renderSpintax(selected)", "replacePlaceholders"),
        "UI-01": all_in(popup, "DM by Monitor", "DM by Bulk", "data-start", "data-edit", '"pause"', '"resume"', '"stop"', '"skip"'),
        "UI-02": all_in(popup, "list-form", "data-rename-list", "data-add-message", "data-edit-message", "data-delete-message", "data-delete-list"),
        "UI-03": all_in(popup, 'accept=".csv"', "10485760", "10000", 'key.trim() === "Username"', "pendingCsv"),
        "UI-04": all_in(popup, "dm_message_history_pool", "dm_user_history_pool", "data-export", "data-clear", "data-import", 'key === "dm_message_history_pool"'),
        "UI-05": all_in(popup, ".xlsx", ".xls", "XLSX"),
        "ERR-01": all_in(common + popup, '"401"', '"400"', '"403"', '"429"', '"500"', '"503"', "enable_handle_status_", "batch_interval_nums_"),
        "ERR-02": all_in(content, "response.status === 404", "This may be due to their app version or other settings.", "result.status_code === 403", "result.error_code === 1545120", "error.lookup", "Send DM Error"),
    }
    assert set(checks) == set(WEIGHTS)
    return [{"id": key, "weight": WEIGHTS[key], "score": 1.0 if checks[key] else 0.0, "points": WEIGHTS[key] if checks[key] else 0.0} for key in WEIGHTS]
