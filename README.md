# DM Hour Unified

This repository now contains an extension-native implementation of the verified core behavior of the locally installed **IGDMBot 1.6.4**. The active Chrome runtime is in `extension/`; it does not depend on the Python server.

The earlier Python/SQLite campaign engine remains under `backend/` as preserved, optional code. The superseded extension files `background.js`, `content.js`, `popup.html`, `popup.css`, and `popup.js` now live in `extension-legacy/`: they are kept for comparison and are no longer part of the loaded extension directory.

See [`UPDATES.md`](./UPDATES.md) for the 10 September 2026 change log: account-scoped pools, mid-run account-switch guard, story-reply `doc_id` self-healing, MQTT `reel_share` fallback, and XLS/XLSX history import/export.

## The working tab

The bot drives its own Instagram tab and opens it itself, so it does not depend on what the person already has open. That tab is covered and labelled the way IGDMBot covers its own — a dark mask, the icon, and "DM Hour працює. / Не закривай цю вкладку." — plus a `beforeunload` prompt, mirroring `addLeaveAlert`. Without the marker the bot silently opens an Instagram tab and the operator has no way to tell which of their tabs must stay open; closing it stops the run.

`shouldKeepTabOpen` decides, and only covers the tab whose id matches `permanent_tab_info`: other Instagram tabs the person opened themselves are left untouched. The mask is lifted when the bot stops or completes, and after a one-shot test send finishes.

## Verifying the live transport

The **Тест** tab holds the two tools for proving the send path against real Instagram.

`sendTestDm` performs one send over the exact campaign path — `topsearch` → `/api/v1/users/{id}/info/` → `create_group_thread` → MQTT `/ig_send_message` — and deliberately touches no pool, history, counter, work bot or alarm, so a failed attempt leaves no residue and a running campaign is unaffected.

The diagnostics buffer (off by default, `diag_enabled`) keeps the last 300 entries in `diag_log`: HTTP requests and responses, plus raw MQTT frames as hex — CONNECT, PUBLISH, and everything received. `X-CSRFToken`, `Cookie` and `Authorization` values are replaced before anything is stored. The page bridge cannot reach `chrome.storage`, so it hands frames to the content script over an `INJECT_DIAG` message. Export the buffer as JSON from the same tab.

The first live send arrived twice, and the transport was not at fault. The exported diagnostics settled it: the two messages sit 10 ms apart in the thread, and a later clean run logs exactly one `mqtt.frame.publish`. The duplicate came from the handshake.

The deviation was in `connectToTab`, which called `attempt()` immediately and then every three seconds. IGDMBot's `se()` is *only* `setInterval(fn, 3000)` — it never connects straight away, and that delay is load-bearing: a tab created a moment earlier has not loaded its content script, so an immediate port answers late, exactly when the retry has already opened a second one. Both ports then receive `connect_content_res` and both post the instruction. Matching the source removes the window.

Two guards back it up, and both are deliberate deviations from IGDMBot, which carries the same latent race. In the background, only the first completed handshake dispatches; superseded ports are closed unanswered. In the content script, `runExclusive` permits one sending task at a time and records a `duplicate_action_ignored` note when a second arrives. This matters well beyond the test button: `dispatch` also carries `send_dm_to_new_follower` and `send_bulk_dm_to_follower`, so the same race could have doubled a campaign message to a real recipient.

Turn diagnostics on, send one message to an account you control, then read the frames.

### Capturing Instagram's own traffic

The diagnostics above only see frames this extension sends. Instagram's web client has its own edge-chat socket, so an action performed by hand — replying to a story, for instance — is invisible to them. `igcapture.js` is declared with `world: "MAIN"` at `run_at: "document_start"`, so it executes in the page's own realm before Instagram's bundle takes its reference to `WebSocket`. The first attempt injected it as a `<script src>` instead and captured nothing: an external script loads asynchronously and loses that race.

Binary payloads are hex-dumped and, since the official client compresses them, run through `DecompressionStream` (deflate, deflate-raw, gzip in turn) so the JSON is readable.

It observes only and never alters a frame. Nothing is forwarded unless the **Знімати трафік Instagram** toggle is on, which the hook checks through the `data-dmh-capture` attribute the content script sets. Because the content script loads at `document_end`, long after the hook, early events wait in a capped queue rather than being lost — including `capture.armed`, which records that the hook installed at all. Every socket the page opens is logged as `instagram.socket` with its URL. Frames keep their real label (`instagram.frame` / `instagram.http`) and URL. `fetch` and `XMLHttpRequest` on Instagram/Meta hosts are hooked the same way. Pigeon analytics, static assets, and MQTT PING frames are dropped so a story-reply is not buried. Reload the Instagram tab after enabling capture, otherwise the page keeps its already-open sockets.

This is the intended route to the story-reply payload: switch capture on, reply to a story by hand, switch it off, export the JSON. That capture is also how the story-reply payload gets established later: reply to a story by hand in the same tab and compare the frame.

## Storage safety

`chrome.storage.local` carries a `schema_version` stamp. `DMHCore.migrateStorage()` runs on install and on every service-worker start; it applies the entries in `MIGRATIONS` in order and refuses a store written by a newer build rather than misreading it.

The **Дані** tab in the popup exports the whole store as one JSON file and restores it. Session-only keys (`permanent_tab_info`) are stripped from a backup, a restore is refused while a bot is running, and a file that is not a `dm-hour-backup` — or was written by a newer schema — is rejected before the store is touched. Take a backup before changing anything.

## Active extension architecture

```text
popup-parity.html
  -> service-worker.js -> common.js + background-parity.js
  -> common.js + content-parity.js on https://www.instagram.com/*
  -> injected ijsource.js in the Instagram page context
```

The active implementation uses `chrome.storage.local`, Chrome alarms, and a non-active Instagram inbox tab. It has the two verified modes:

- **DM by Monitor**: polls the Instagram news inbox for new-follower (`3/101`) and new-like (`1/768`) events, applies lookback/deduplication/daily-limit rules, then selects the configured DM List.
- **DM by Bulk**: discovers followers or followings through the two verified GraphQL queries, or consumes manual/CSV custom users, then applies limits and deduplication.

Messages are chosen randomly from the selected DM List. Nested `{one|two}` Spintax, `<Username>`, and `<CSVHeader>` fields are supported. Normal and group intervals, Skip Current User, separate DM History/DM Box pools, and the verified HTTP-code settings are implemented.

An optional bot checkbox **prefer_story_reply** sends the first message as a web story reply when the recipient has a replyable story:

```text
GET /api/v1/feed/user/{id}/story/
  -> POST /api/graphql IGDirectStoryShareReplyMutation
```

Page tokens (`av` / `fb_dtsg` / `lsd`) come from the Instagram HTML, not from `ds_user_id`. If there is no story, replies are disabled, or the mutation fails, the existing Direct path runs unchanged (`create_group_thread` + MQTT `/ig_send_message`). MQTT `reel_share` is not used.

## First-message send path

The active path does **not** open Instagram's composer, type into it, paste into it, press Enter, or infer success from an empty field.

```text
service worker: chrome.cookies.get(ds_user_id, csrftoken)
  -> background: exact username topsearch -> user info
  -> content: create_group_thread with the current Chrome cookie session
  -> window.postMessage(INJECT_DISPATCH_DM_REQUEST)
  -> page bridge: MQTT 3.1 over wss://edge-chat.instagram.com:443/chat
  -> publish /ig_send_message
  -> verified response -> history, counters, and next alarm
```

Only `ds_user_id` and `csrftoken` are read explicitly. `credentials: "include"` lets Chrome attach the rest of the current cookie session to the HTTP requests. No cookie or password is written into this repository.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the absolute `extension/` directory inside this project.
5. Log in to Instagram in Chrome, open the DM Hour popup, configure a DM List and bot, then start it.

Starting a bot is a live action: it can call Instagram's web endpoints and send DMs from the currently logged-in account. Tests do not send live requests.

## Recipient and history files

- Campaign recipients: CSV only, exact `Username` header, maximum 10,000 data rows and 10 MiB; all other columns are retained for placeholders.
- History: CSV export/import is implemented. DM History import replaces its pool; DM Box import merges into its pool. XLS/XLSX history import/export is implemented via `extension/xlsx.js` (a dependency-free port of `backend/dmhour/xlsx.py`); the full 100/100 rubric now passes.

## Verification and mathematical score

Run all tests:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

Run the mocked browser/API/MQTT runtime check directly:

```bash
node tests/runtime_parity_checks.js
```

Calculate the frozen weighted score:

```bash
python3 scripts/score_similarity.py
```

The score is `sum(weight × row_score)` over a 100-point rubric frozen before implementation. A row scores 1 only when its deterministic check passes. The result measures the reproduced, verified **core behavior**, not source-code identity, pixel-level UI identity, vendor login/payment/telemetry, or guaranteed future compatibility with undocumented Instagram endpoints.

## Preserved optional Python layer

The Python backend is not part of the IGDMBot-parity extension path. It is retained for local SQLite/dry-run experiments:

```bash
PYTHONPATH=backend python3 -m dmhour --db data/dmhour.sqlite init
PYTHONPATH=backend python3 -m dmhour --db data/dmhour.sqlite serve
```

Its optional private-API transports and localhost dashboard are separate implementations and are excluded from the IGDMBot similarity score.
