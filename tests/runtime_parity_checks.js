"use strict";

const assert = require("node:assert/strict");
const cryptoModule = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION = path.join(ROOT, "extension");

function eventHook() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
}

function storageMock(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    local: {
      async get(keys) {
        if (keys == null) return structuredClone(state);
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = structuredClone(state[key]);
        return result;
      },
      async set(values) { Object.assign(state, structuredClone(values)); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
      },
      async clear() {
        for (const key of Object.keys(state)) delete state[key];
      }
    }
  };
}

function baseContext(extra = {}) {
  return vm.createContext({
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Date,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    Error,
    Object,
    String,
    Number,
    Boolean,
    console,
    crypto: { randomUUID: cryptoModule.randomUUID },
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    __DMH_TEST__: true,
    ...extra
  });
}

function load(context, filename) {
  const source = fs.readFileSync(path.join(EXTENSION, filename), "utf8");
  vm.runInContext(source, context, { filename });
}

async function testBackgroundLookup() {
  const store = storageMock({ installed_flag: true });
  const calls = [];
  const chrome = {
    storage: { local: store.local },
    runtime: {
      onInstalled: eventHook(),
      onMessage: eventHook(),
      async sendMessage() {}
    },
    alarms: { onAlarm: eventHook(), async create() {}, async get() {}, async clear() {} },
    cookies: { async get() { return null; } },
    tabs: { async get() {}, async create() {}, async remove() {}, connect() { throw new Error("unused"); } }
  };
  const context = baseContext({
    chrome,
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    async fetch(url, options) {
      calls.push({ url: String(url), options });
      if (String(url).includes("/web/search/topsearch/")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { users: [{ user: { username: "wrong", pk: "1" } }, { user: { username: "Target.Name", pk: "42" } }] };
          }
        };
      }
      return { ok: true, status: 200, async json() { return { user: { pk: "42", username: "Target.Name" } }; } };
    }
  });
  load(context, "common.js");
  load(context, "background-parity.js");
  const result = await context.__DMH_PARITY_BACKGROUND__.lookup({ igname: "target.name", headers: { "X-CSRFToken": "csrf" } });
  assert.equal(result.data.user.id, "42");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /topsearch\/\?context=blended&query=target\.name$/);
  assert.match(calls[1].url, /\/api\/v1\/users\/42\/info\/\?from_module=profile$/);
  assert.equal(calls[0].options.headers["x-ig-app-id"], "936619743392459");
  assert.equal(calls[0].options.headers["x-asbd-id"], "129477");
  assert.equal(calls[1].options.headers["x-ig-www-claim"], "0");
}

async function testContentApiFlows() {
  const now = Math.floor(Date.now() / 1000);
  const store = storageMock({
    installed_flag: true,
    work_bot: {
      id: "bot",
      is_working: true,
      is_complete: false,
      bot_type: 0,
      enable_when_get_new_follower_by_monitor: true,
      enable_when_get_new_like_by_monitor: true,
      enable_skip_day_before_by_monitor: true,
      skip_day_before_by_monitor_num: 1,
      dm_num: 0,
      day_dm_num: 10
    },
    monitor_inbox_pool: [],
    comments: [{ id: "message", list_id: "bulk-list", content: "Hi <Username> from <City>" }],
    dm_message_history_pool: [],
    dm_user_history_pool: [],
    dm_custom_queue_bot_pool: [{ Username: "creator", City: "Kyiv" }]
  });
  const runtimeMessages = [];
  const portMessages = [];
  const messageListeners = [];
  const posted = [];
  const windowObject = {
    addEventListener(type, listener) { if (type === "message") messageListeners.push(listener); },
    postMessage(data) {
      posted.push(data);
      if (data.type !== "INJECT_DISPATCH_DM_REQUEST") return;
      queueMicrotask(() => {
        const response = { type: "INJECT_DISPATCH_DM_RESPONSE", request_id: data.request_id, ret: 1, status_code: 200 };
        for (const listener of messageListeners) listener({ source: windowObject, data: response });
      });
    }
  };
  const chrome = {
    storage: { local: store.local, onChanged: eventHook() },
    runtime: {
      onConnect: eventHook(),
      getURL(file) { return `chrome-extension://test/${file}`; },
      async sendMessage(message) {
        runtimeMessages.push(message);
        // The content script re-reads the cookie session at every campaign
        // entry point, so the mock has to answer GET_COOKIE.
        if (message?.type === "GET_COOKIE") {
          return message.data.name === "ds_user_id" ? "viewer-cookie" : "csrf-token";
        }
        return undefined;
      }
    }
  };
  const appended = [];
  const document = {
    documentElement: { dataset: {}, appendChild(node) { appended.push(node); } },
    body: { appendChild(node) { appended.push(node); } },
    createElement() { return { src: "", onload: null, remove() {} }; }
  };
  const calls = [];
  let responseKind = "monitor";
  const context = baseContext({
    chrome,
    window: windowObject,
    document,
    async fetch(url, options) {
      const request = { url: String(url), options };
      calls.push(request);
      if (responseKind === "monitor") {
        const body = {
          status: "ok",
          new_stories: [
            { type: 3, story_type: 101, args: { profile_id: "10", profile_name: "new_follower", profile_image: "f.jpg", timestamp: now } },
            { type: 1, story_type: 768, args: { profile_id: "11", profile_name: "new_liker", profile_image: "l.jpg", timestamp: now }, ignored: false },
            { type: 3, story_type: 999, args: { profile_id: "12", profile_name: "ignored", timestamp: now } }
          ]
        };
        return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
      }
      if (responseKind === "followers") {
        const body = { data: { user: { edge_followed_by: { edges: [{ node: { id: "20", username: "follower" } }], page_info: { end_cursor: "fc", has_next_page: true } } } } };
        return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
      }
      if (responseKind === "followings") {
        const body = { data: { user: { edge_follow: { edges: [{ node: { id: "21", username: "following" } }], page_info: { end_cursor: "gc", has_next_page: false } } } } };
        return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
      }
      if (responseKind === "logged-out") {
        const body = "<!doctype html><html><body>login</body></html>";
        return { ok: true, status: 200, async json() { throw new Error("not json"); }, async text() { return body; } };
      }
      const thread = { status: "ok", thread_id: "thread-1", viewer_id: "viewer-1" };
      return { ok: true, status: 200, async json() { return thread; }, async text() { return JSON.stringify(thread); } };
    }
  });
  load(context, "common.js");
  load(context, "content-parity.js");
  const api = context.__DMH_PARITY_CONTENT__;
  api.setSession({ ds_user_id: "viewer-cookie", csrftoken: "csrf-token" });
  api.setExecutionPort({ postMessage(message) { portMessages.push(message); } });

  await api.monitorInbox();
  assert.equal(calls[0].url, "https://i.instagram.com/api/v1/news/inbox/");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.headers["X-CSRFToken"], "csrf-token");
  assert.equal(calls[0].options.headers["X-IG-App-ID"], "936619743392459");
  assert.deepEqual(store.state.monitor_inbox_pool.map((entry) => [entry.id, entry.type]), [["10", 0], ["11", 1]]);
  assert.equal(portMessages.at(-1).type, "checkMonitorAlarmOrSendDM");

  responseKind = "followers";
  const followedBy = await api.fetchGraphPage({ bulk_dm_target_type: 0 }, { target_id: "42", cursor: "old" });
  const followersUrl = new URL(calls.at(-1).url);
  assert.equal(followersUrl.searchParams.get("query_hash"), "37479f2b8209594dde7facb0d904896a");
  assert.deepEqual(JSON.parse(followersUrl.searchParams.get("variables")), { id: "42", after: "old", first: 50 });
  assert.equal(followedBy.cursor, "fc");
  assert.equal(followedBy.has_next_page, true);

  responseKind = "followings";
  const follows = await api.fetchGraphPage({ bulk_dm_target_type: 1 }, { target_id: "42", cursor: "" });
  const followingsUrl = new URL(calls.at(-1).url);
  assert.equal(followingsUrl.searchParams.get("query_hash"), "58712303d941c6855d4e888c5f0cd22f");
  assert.equal(follows.cursor, "gc");
  assert.equal(follows.has_next_page, false);

  responseKind = "thread";
  store.state.work_bot = {
    id: "bot", is_working: true, is_complete: false, bot_type: 1,
    bulk_dm_target_type: 2, dm_num: 0, bulk_limit_max_users_count: 50
  };
  await api.sendRecipient({ id: "99", username: "creator", type: 2 }, "bulk-list", { Username: "creator", City: "Kyiv" });
  const createCall = calls.at(-1);
  assert.equal(createCall.url, "https://i.instagram.com/api/v1/direct_v2/create_group_thread/");
  assert.equal(createCall.options.method, "POST");
  assert.equal(createCall.options.credentials, "include");
  assert.equal(createCall.options.headers["X-CSRFToken"], "csrf-token");
  assert.equal(createCall.options.headers["X-IG-App-ID"], "936619743392459");
  assert.equal(createCall.options.body.get("recipient_users"), '["99"]');
  const dispatch = posted.find((entry) => entry.type === "INJECT_DISPATCH_DM_REQUEST");
  assert.equal(dispatch.thread_id, "thread-1");
  assert.equal(dispatch.viewer_id, "viewer-1");
  assert.equal(dispatch.text, "Hi creator from Kyiv");
  assert.equal(store.state.dm_message_history_pool.length, 1);
  assert.equal(store.state.dm_user_history_pool.length, 1);
  assert.equal(store.state.work_bot.dm_num, 1);
  assert.equal(store.state.work_bot.is_complete, true);
  assert.equal(store.state.dm_custom_queue_bot_pool.length, 0);
  assert.ok(runtimeMessages.some((message) => message.type === "RELOAD_WORK_BOT_HOME_MSG"));
}

/**
 * Behavioural coverage for the IGDMBot 1.6.4 semantics that the string-matching
 * rubric cannot see: signed-out detection, empty-list pre-flight, the 404 pool
 * leaving the custom queue alone, the last-chance duplicate guard, and the
 * next-DM scheduling fallback when the service worker port is gone.
 */
function contentHarness(initialState, options = {}) {
  const store = storageMock(initialState);
  const runtimeMessages = [];
  const posted = [];
  const messageListeners = [];
  const windowObject = {
    addEventListener(type, listener) { if (type === "message") messageListeners.push(listener); },
    postMessage(data) {
      posted.push(data);
      if (data.type !== "INJECT_DISPATCH_DM_REQUEST") return;
      queueMicrotask(() => {
        const response = { type: "INJECT_DISPATCH_DM_RESPONSE", request_id: data.request_id, ret: 1, status_code: 200 };
        for (const listener of messageListeners) listener({ source: windowObject, data: response });
      });
    }
  };
  const chrome = {
    storage: { local: store.local, onChanged: eventHook() },
    runtime: {
      onConnect: eventHook(),
      getURL(file) { return `chrome-extension://test/${file}`; },
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message?.type === "GET_COOKIE") {
          return message.data.name === "ds_user_id" ? "viewer-cookie" : "csrf-token";
        }
        return undefined;
      }
    }
  };
  const document = {
    documentElement: { dataset: {}, appendChild() {} },
    body: { appendChild() {} },
    createElement() { return { src: "", onload: null, remove() {} }; }
  };
  const calls = [];
  const context = baseContext({
    chrome,
    window: windowObject,
    document,
    // `fastNext` arms a 10–30 s skip delay. Let it be scheduled — the delay is
    // part of the contract — but do not hold the test process open for it.
    setTimeout(handler, delay, ...args) {
      const timer = setTimeout(handler, delay, ...args);
      if (typeof timer?.unref === "function") timer.unref();
      return timer;
    },
    async fetch(url, init) {
      calls.push({ url: String(url), options: init });
      return options.respond ? options.respond(String(url), init) : { ok: true, status: 200, async json() { return { status: "ok", thread_id: "t", viewer_id: "v" }; }, async text() { return "{}"; } };
    }
  });
  load(context, "common.js");
  load(context, "content-parity.js");
  return { api: context.__DMH_PARITY_CONTENT__, store, calls, runtimeMessages, posted, chrome };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

async function testParityFixes() {
  // 1. A signed-out GraphQL response is reported as status 302, not a parse error.
  {
    const html = "<!doctype html><html><body>login</body></html>";
    const { api } = contentHarness({}, {
      respond: () => ({ ok: true, status: 200, async json() { throw new Error("not json"); }, async text() { return html; } })
    });
    const error = await rejection(api.fetchGraphPage({ bulk_dm_target_type: 0 }, { target_id: "1", cursor: "" }));
    assert.equal(error.status, 302);
    assert.match(error.message, /log in to your Instagram account again/);
  }

  // 2. An empty DM list stops the bot before a thread is created.
  {
    const { api, calls } = contentHarness({ comments: [{ id: "c1", list_id: "other", content: "hi" }] });
    const error = await rejection(api.assertDmListsReady({
      bot_type: 0, enable_when_get_new_follower_by_monitor: true, new_follower_dm_list_id: "missing"
    }));
    assert.equal(error.status, 10002);
    assert.equal(error.message, "The DM list for the robot is empty.");
    assert.equal(calls.length, 0, "no network call may happen before the list check");
  }

  // 3. handle404Username records the username and leaves the custom queue intact.
  {
    const { api, store } = contentHarness({
      dm_custom_queue_bot_pool: [{ Username: "queued_one" }, { Username: "queued_two" }],
      dm_404_custom_dup_users_history_bot: []
    });
    await api.unavailable("someone_else");
    assert.deepEqual(store.state.dm_custom_queue_bot_pool.map((row) => row.Username), ["queued_one", "queued_two"]);
    assert.deepEqual(store.state.dm_404_custom_dup_users_history_bot.map((row) => row.username), ["someone_else"]);
  }

  // 4. The pre-publish duplicate guard consults both pools, and honours go_dup.
  {
    const { api } = contentHarness({
      dm_user_history_pool: [{ id: "1", username: "already_messaged" }],
      dm_404_custom_dup_users_history_bot: [{ username: "gone" }]
    });
    assert.equal(await api.isDuplicateRecipient("already_messaged", true), true);
    assert.equal(await api.isDuplicateRecipient("already_messaged", false), false);
    assert.equal(await api.isDuplicateRecipient("gone", false), true);
    assert.equal(await api.isDuplicateRecipient("fresh_user", true), false);
  }

  // 5. With no port, scheduling falls back to a runtime message so the campaign
  //    still gets its next alarm.
  {
    const { api, runtimeMessages } = contentHarness({});
    api.setExecutionPort(null);
    api.scheduleNextDm();
    assert.ok(runtimeMessages.some((message) => message.type === "SEND_NEXT_DM_TO_QUEUE"));
  }

  // 6. A transport failure maps to status 10004 instead of an opaque stop.
  {
    const { api, store } = contentHarness({ work_bot: { id: "b", is_working: true } });
    await api.handleError(new TypeError("Failed to fetch"));
    assert.equal(store.state.work_bot.status_code, 10004);
    assert.equal(store.state.work_bot.is_working, false);
  }
}

/**
 * Stage 2: the diagnostics buffer and the one-shot send that proves the live
 * transport. The rule the tests pin down is that a test send touches nothing a
 * campaign owns — no pool, no history, no counter, no work bot.
 */
/**
 * Reproduces the duplicate observed on the first live send: the handshake is
 * retried every three seconds, so a tab that has just been created leaves two
 * open ports, both answer, and the instruction is delivered twice.
 */
async function testHandshakeDeliversActionOnce() {
  const store = storageMock({ installed_flag: true, schema_version: 1 });
  const openedPorts = [];
  let intervalCallback = null;
  const chrome = {
    storage: { local: store.local },
    runtime: { onInstalled: eventHook(), onMessage: eventHook(), async sendMessage() {} },
    alarms: { onAlarm: eventHook(), async create() {}, async get() {}, async clear() {} },
    cookies: { async get() { return null; } },
    tabs: {
      async get() {}, async create() {}, async remove() {},
      connect() {
        const listeners = [];
        const port = {
          posted: [],
          disconnected: false,
          onMessage: { addListener(fn) { listeners.push(fn); }, removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
          onDisconnect: { addListener() {} },
          postMessage(message) { port.posted.push(message); },
          disconnect() { port.disconnected = true; },
          // Stands in for the content script answering the handshake.
          answer() { for (const fn of [...listeners]) fn({ type: "connect_content_res" }); }
        };
        openedPorts.push(port);
        return port;
      }
    }
  };
  const context = baseContext({
    chrome,
    // Capture the retry callback so the race is driven deterministically.
    setInterval(fn) { intervalCallback = fn; return 1; },
    clearInterval() { intervalCallback = null; },
    async fetch() { return { ok: true, status: 200, async json() { return {}; }, async text() { return "{}"; } }; }
  });
  load(context, "common.js");
  load(context, "background-parity.js");

  const pending = context.__DMH_PARITY_BACKGROUND__.connectToTab(7, "send_test_dm", { username: "target", text: "hi" });
  // background.js `se()` is only a three-second interval: nothing is connected
  // until the tab has had time to load its content script.
  assert.equal(openedPorts.length, 0, "the handshake must not fire immediately");

  intervalCallback();
  assert.equal(openedPorts.length, 1, "the first attempt goes out after the delay");

  // Even so, a tab that answers late can leave a second port open.
  intervalCallback();
  assert.equal(openedPorts.length, 2, "a slow tab still produces a second port");

  // Now both ports answer, which is exactly what happened on the live send.
  openedPorts[0].answer();
  openedPorts[1].answer();
  await pending;

  const actions = openedPorts.flatMap((port) => port.posted.filter((message) => message.type === "send_test_dm"));
  assert.equal(actions.length, 1, "the instruction must be delivered exactly once");
  assert.deepEqual(actions[0].data.username, "target");
  assert.equal(openedPorts[1].disconnected, true, "the superseded port is closed");
  assert.equal(intervalCallback, null, "the retry timer is cleared once a handshake wins");
}

/** The content script refuses a second sending task while one is running. */
async function testDuplicateActionIsDropped() {
  const { api, store } = contentHarness({ diag_enabled: true });
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowTask = () => { started += 1; return gate; };

  const first = api.runExclusive("send_bulk_dm_to_follower", slowTask);
  const second = api.runExclusive("send_bulk_dm_to_follower", slowTask);
  assert.equal(second, null, "a duplicate returns nothing to chain onto");

  release();
  await first;
  assert.equal(started, 1, "only one task ever ran");
  // The diagnostics write is fire-and-forget; let it settle before reading.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    store.state.diag_log.some((entry) => entry.label === "duplicate_action_ignored"),
    "the dropped duplicate is recorded"
  );

  // Once the first task finished, the lane is free again.
  let ranAgain = false;
  await api.runExclusive("send_bulk_dm_to_follower", () => { ranAgain = true; });
  assert.equal(ranAgain, true);
}

/** The "keep this tab open" overlay covers the driven tab, and only that one. */
async function testWorkingTabOverlayRule() {
  const { core } = coreHarness({});
  const working = { is_working: true, is_complete: false };

  assert.equal(core.shouldKeepTabOpen({ tabId: 7, permanentTabId: 7, bot: working }), true,
    "the tab the bot drives is covered");
  assert.equal(core.shouldKeepTabOpen({ tabId: 9, permanentTabId: 7, bot: working }), false,
    "another Instagram tab the person opened themselves is left alone");
  assert.equal(core.shouldKeepTabOpen({ tabId: 7, permanentTabId: null, bot: working }), false,
    "with no pinned tab recorded nothing is covered");
  assert.equal(core.shouldKeepTabOpen({ tabId: 7, permanentTabId: 7, bot: { is_working: false } }), false,
    "a stopped bot releases the tab");
  assert.equal(core.shouldKeepTabOpen({ tabId: 7, permanentTabId: 7, bot: { is_working: true, is_complete: true } }), false,
    "a completed campaign releases the tab");
  assert.equal(core.shouldKeepTabOpen({ tabId: 7, permanentTabId: 7, bot: null, busy: true }), true,
    "a one-shot test send covers the tab while it runs");
  assert.equal(core.shouldKeepTabOpen({ tabId: 7, permanentTabId: 7, bot: null, busy: false }), false,
    "and releases it when the test is done");

  // The mask also has to come down without a port message, for a tab the bot
  // abandoned after the person navigated it somewhere else.
  const { chrome } = contentHarness({});
  assert.equal(chrome.storage.onChanged.listeners.length, 1,
    "the content script watches storage so an abandoned tab uncovers itself");
}

async function testUsernameNormalisation() {
  const { core } = coreHarness({});
  const cases = [
    ["001k.alpha/sliv", "001k.alpha"],
    ["@001k.alpha", "001k.alpha"],
    ["  my_test_account  ", "my_test_account"],
    ["https://www.instagram.com/creator.one/", "creator.one"],
    ["instagram.com/creator.one?hl=uk", "creator.one"],
    ["https://instagram.com/creator.one/reels/", "creator.one"],
    ["", ""],
    ["///", ""]
  ];
  for (const [input, expected] of cases) {
    assert.equal(core.normalizeUsername(input), expected, `normalizeUsername(${JSON.stringify(input)})`);
  }
}

async function testDiagnosticsAndTestSend() {
  // The buffer stays silent until it is switched on, redacts the CSRF token,
  // and never grows past its cap.
  {
    const { core, store } = coreHarness({});
    await core.diagRecord({ kind: "note", label: "ignored" });
    assert.equal(store.state.diag_log, undefined, "nothing is recorded while diagnostics are off");

    await store.local.set({ diag_enabled: true });
    await core.diagRecord({ kind: "http", label: "create_group_thread", detail: { headers: core.redactHeaders({ "X-CSRFToken": "secret-token", "X-IG-App-ID": "936619743392459" }) } });
    assert.equal(store.state.diag_log.length, 1);
    const recorded = JSON.stringify(store.state.diag_log[0]);
    assert.ok(!recorded.includes("secret-token"), "the CSRF token must never reach the log");
    assert.ok(recorded.includes("936619743392459"), "non-secret headers are kept");
    assert.ok(store.state.diag_log[0].ts, "every entry is timestamped");

    for (let i = 0; i < core.DIAG_LIMIT + 25; i += 1) await core.diagRecord({ kind: "note", label: `n${i}` });
    assert.equal(store.state.diag_log.length, core.DIAG_LIMIT, "the ring buffer is capped");
    assert.equal(store.state.diag_log.at(-1).label, `n${core.DIAG_LIMIT + 24}`, "the newest entry survives");
  }

  // A diagnostics log is debug output: it must not travel inside a backup.
  {
    const { core, store } = coreHarness({ schema_version: 1, bot_list: [{ id: "b" }], diag_log: [{ kind: "note" }] });
    const snapshot = await core.exportSnapshot();
    assert.equal(snapshot.data.diag_log, undefined);
    assert.equal(snapshot.data.bot_list.length, 1);
    assert.equal(store.state.diag_log.length, 1, "exporting does not clear the live log");
  }

  // The one-shot send walks the real path and leaves the campaign untouched.
  {
    const campaign = {
      work_bot: { id: "bot", bot_name: "Monitor", is_working: true, is_complete: false, bot_type: 0, dm_num: 3, day_dm_num: 10 },
      monitor_inbox_pool: [{ id: "55", username: "queued" }],
      dm_custom_queue_bot_pool: [{ Username: "queued_csv" }],
      dm_message_history_pool: [],
      dm_user_history_pool: [],
      diag_enabled: true
    };
    const before = JSON.stringify(campaign);
    const { api, store, calls, runtimeMessages } = contentHarness(campaign, {
      respond: (url) => {
        if (url.includes("create_group_thread")) {
          const body = { status: "ok", thread_id: "thread-test", viewer_id: "viewer-test" };
          return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
        }
        return { ok: true, status: 200, async json() { return {}; }, async text() { return "{}"; } };
      }
    });
    // The lookup travels over the port; answer it the way the background would.
    api.setExecutionPort({
      postMessage(message) {
        if (message.type !== "req_user_info") return;
        queueMicrotask(() => api.handlePortMessage({
          type: "req_user_info_resp",
          request_id: message.request_id,
          res: { data: { user: { id: "77", pk: "77", username: "test_target", profile_pic_url: "p.jpg" } }, status: "ok" }
        }));
      }
    });

    const result = await api.sendTestDm({ username: "@test_target", text: "перевірка" });
    assert.equal(result.username, "test_target");
    assert.equal(result.thread_id, "thread-test");
    assert.ok(calls.some((call) => call.url.includes("create_group_thread")), "it uses the real thread endpoint");

    for (const key of ["work_bot", "monitor_inbox_pool", "dm_custom_queue_bot_pool", "dm_message_history_pool", "dm_user_history_pool"]) {
      assert.deepEqual(
        JSON.stringify(store.state[key]),
        JSON.stringify(JSON.parse(before)[key]),
        `${key} must be untouched by a test send`
      );
    }
    assert.ok(!runtimeMessages.some((m) => m.type === "SEND_NEXT_DM_TO_QUEUE"), "a test send schedules nothing");
    assert.ok(store.state.diag_log.some((entry) => entry.label === "test.result"), "the outcome is recorded");
  }

  // A failed test send reports the reason and still changes nothing.
  {
    const { api, store } = contentHarness({ work_bot: { id: "bot", dm_num: 1 } }, {
      respond: () => ({ ok: false, status: 404, async json() { return { status: "fail" }; }, async text() { return '{"status":"fail"}'; } })
    });
    api.setExecutionPort({
      postMessage(message) {
        if (message.type !== "req_user_info") return;
        queueMicrotask(() => api.handlePortMessage({
          type: "req_user_info_resp",
          request_id: message.request_id,
          res: { data: { user: { id: "77", username: "test_target" } }, status: "ok" }
        }));
      }
    });
    const error = await rejection(api.sendTestDm({ username: "test_target", text: "hi" }));
    assert.match(error.message, /не приймає повідомлення/);
    assert.equal(store.state.work_bot.dm_num, 1);
    assert.equal(store.state.work_bot.is_working, undefined, "a failed test must not stop a bot");
  }
}

async function testPageContextParser() {
  const { core } = coreHarness({});
  const html = [
    '["LSD",[],{"token":"LSDvalue"}]',
    '["DTSGInitialData",[],{"token":"NAfTOKEN"}]',
    '["CurrentUserInitialData",[],{"USER_ID":"39046098765","ACCOUNT_ID":"17841438962970762","NAME":"x"}]',
    '["RelayAPIConfigDefaults",[],{"actorID":"17841438962970762"}]',
    '["SiteData",[],{"client_revision":1046744998,"spin_r":1,"spin_b":"trunk","spin_t":99}]'
  ].join("\n");
  const ctx = core.extractInstagramPageContext(html);
  assert.equal(ctx.tokens.lsd, "LSDvalue");
  assert.equal(ctx.tokens.fb_dtsg, "NAfTOKEN");
  assert.equal(ctx.tokens.av, "17841438962970762");
  assert.equal(ctx.tokens.av_source, "RelayAPIConfigDefaults.actorID");
  assert.equal(ctx.tokens.ig_user_id, "39046098765");
  assert.equal(ctx.tokens.account_id, "17841438962970762");
  assert.equal(ctx.tokens.jazoest, "2" + [..."NAfTOKEN"].reduce((sum, char) => sum + char.charCodeAt(0), 0));
  assert.equal(ctx.tokens.rev, 1046744998);
  assert.ok(ctx.module_names.includes("LSD"));
  assert.ok(ctx.harvested.some((item) => item.key === "actorID"));
}

function coreHarness(initialState = {}) {
  const store = storageMock(initialState);
  const context = baseContext({ chrome: { storage: { local: store.local } } });
  load(context, "common.js");
  return { core: context.DMHCore, store };
}

/**
 * Stage 1 safety net: the schema stamp that lets future format changes migrate
 * instead of silently misreading existing pools, and a full-store backup that
 * survives a round trip.
 */
async function testStorageSafety() {
  // An install that predates versioning is stamped without losing its data.
  {
    const { core, store } = coreHarness({ bot_list: [{ id: "b1" }], dm_user_history_pool: [{ id: "9" }] });
    // Objects come from the sandbox realm, so compare fields, not prototypes.
    const result = await core.migrateStorage();
    assert.equal(result.from, 0);
    assert.equal(result.to, 2);
    assert.equal(JSON.stringify(result.applied), "[2]");
    assert.equal(store.state.schema_version, 2);
    assert.equal(store.state.bot_list.length, 1);
    assert.equal(store.state.bot_list[0].prefer_story_reply, false);
    assert.equal(store.state.dm_user_history_pool.length, 1);
    // Running it again is a no-op.
    const again = await core.migrateStorage();
    assert.equal(again.from, 2);
    assert.equal(again.to, 2);
  }

  // A store written by a newer build is refused rather than misread.
  {
    const { core } = coreHarness({ schema_version: 99 });
    const error = await rejection(core.migrateStorage());
    assert.match(error.message, /newer build/);
  }

  // Backup round trip: session-only keys are dropped, everything else returns.
  {
    const { core, store } = coreHarness({
      schema_version: 1,
      bot_list: [{ id: "b1", bot_name: "Monitor" }],
      comments: [{ id: "c1", list_id: "l1", content: "hi" }],
      dm_user_history_pool: [{ id: "7", username: "someone" }],
      permanent_tab_info: { tab_id: 42 }
    });
    const snapshot = await core.exportSnapshot();
    assert.equal(snapshot.format, "dm-hour-backup");
    assert.equal(snapshot.schema_version, 1);
    assert.equal(snapshot.data.permanent_tab_info, undefined, "tab ids must not travel in a backup");
    assert.equal(snapshot.data.bot_list.length, 1);

    store.state.bot_list = [];
    store.state.comments = [];
    delete store.state.dm_user_history_pool;
    const restored = await core.importSnapshot(snapshot);
    assert.equal(restored.keys, 4);
    assert.equal(store.state.bot_list[0].bot_name, "Monitor");
    assert.equal(store.state.comments[0].content, "hi");
    assert.equal(store.state.dm_user_history_pool[0].username, "someone");
    assert.equal(store.state.schema_version, 2);
  }

  // Junk and future backups are rejected before the store is touched.
  {
    const { core, store } = coreHarness({ bot_list: [{ id: "keep" }] });
    assert.match((await rejection(core.importSnapshot({ format: "something-else" }))).message, /не файл резервної копії/);
    assert.match((await rejection(core.importSnapshot({ format: "dm-hour-backup", schema_version: 99, data: {} }))).message, /новішою версією/);
    assert.equal(store.state.bot_list[0].id, "keep", "a rejected import must leave the store untouched");
  }
}

function encodeMqttString(value) {
  const body = new TextEncoder().encode(value);
  return Uint8Array.from([body.length >> 8, body.length & 255, ...body]);
}

function makePublish(topic, payload) {
  const body = Uint8Array.from([...encodeMqttString(topic), ...new TextEncoder().encode(payload)]);
  assert.ok(body.length < 128, "test packet must use one-byte remaining length");
  return Uint8Array.from([0x30, body.length, ...body]);
}

function mqttStrings(connectBody) {
  let offset = 0;
  function read() {
    const length = (connectBody[offset] << 8) | connectBody[offset + 1];
    offset += 2;
    const value = new TextDecoder().decode(connectBody.slice(offset, offset + length));
    offset += length;
    return value;
  }
  const protocol = read();
  const level = connectBody[offset++];
  const flags = connectBody[offset++];
  offset += 2;
  const clientId = read();
  const username = read();
  return { protocol, level, flags, clientId, username };
}

async function testMqttBridge() {
  const sentPackets = [];
  const constructed = [];
  class MockWebSocket {
    static OPEN = 1;
    constructor(url) {
      assert.equal(arguments.length, 1, "IGDMBot parity path must not request an explicit WebSocket subprotocol");
      this.url = url;
      this.readyState = 0;
      constructed.push(this);
      queueMicrotask(() => { this.readyState = MockWebSocket.OPEN; this.onopen(); });
    }
    send(data) {
      const packet = Uint8Array.from(data);
      sentPackets.push(packet);
      const type = packet[0] >> 4;
      if (type === 1) queueMicrotask(() => this.onmessage({ data: Uint8Array.from([0x20, 0x02, 0x00, 0x00]).buffer }));
      if (type === 3) {
        const reply = makePublish("/ig_send_message_response", JSON.stringify({ status_code: 200 }));
        queueMicrotask(() => this.onmessage({ data: reply.buffer }));
      }
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const listeners = [];
  const responses = [];
  const windowObject = {
    addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
    postMessage(data) { responses.push(data); }
  };
  const context = baseContext({ window: windowObject, navigator: { userAgent: "Parity Runtime Test" }, WebSocket: MockWebSocket });
  load(context, "ijsource.js");
  assert.equal(listeners.length, 1);
  const request = {
    type: "INJECT_DISPATCH_DM_REQUEST", request_id: "request-1",
    thread_id: "thread-7", viewer_id: "viewer-7", text: "hello"
  };
  await listeners[0]({ source: windowObject, data: request });
  assert.equal(constructed[0].url, "wss://edge-chat.instagram.com:443/chat");
  assert.equal(responses.at(-1).type, "INJECT_DISPATCH_DM_RESPONSE");
  assert.equal(responses.at(-1).ret, 1);

  const mqtt = context.__DMH_PARITY_MQTT__;
  const connect = mqtt.decodePackets(sentPackets.find((packet) => packet[0] >> 4 === 1))[0];
  const fields = mqttStrings(connect.body);
  assert.equal(fields.protocol, "MQIsdp");
  assert.equal(fields.level, 3);
  assert.equal(fields.flags, 0x82);
  assert.equal(fields.clientId, "mqttwsclient");
  const username = JSON.parse(fields.username);
  assert.equal(username.ct, "cookie_auth");
  assert.equal(username.u, "viewer-7");
  assert.equal(username.aid, 936619743392459);

  const publish = mqtt.decodePackets(sentPackets.find((packet) => packet[0] >> 4 === 3))[0];
  const parsed = mqtt.parsePublish(publish.header, publish.body);
  assert.equal(parsed.topic, "/ig_send_message");
  const payload = JSON.parse(parsed.payload);
  assert.equal(payload.action, "send_item");
  assert.equal(payload.item_type, "text");
  assert.equal(payload.text, "hello");
  assert.equal(payload.thread_id, "thread-7");
  assert.match(payload.device_id, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.equal(payload.mutation_token, payload.client_context - 100000);
}

(async () => {
  await testBackgroundLookup();
  await testContentApiFlows();
  await testMqttBridge();
  await testParityFixes();
  await testStorageSafety();
  await testHandshakeDeliversActionOnce();
  await testDuplicateActionIsDropped();
  await testWorkingTabOverlayRule();
  await testUsernameNormalisation();
  await testDiagnosticsAndTestSend();
  await testPageContextParser();
  process.stdout.write("runtime parity checks: ok\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
