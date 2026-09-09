(() => {
  "use strict";
  const {
    EVENT, PORT, APP, STATUS, storage, randomInt, uuid,
    prepareMessage, messagesForList, normalizeUsername, shouldKeepTabOpen, statusError, isLoggedOutBody,
    diagRecord, redactHeaders, truncate, extractInstagramPageContext
  } = DMHCore;
  let executionPort = null;
  let session = null;
  /** Name of the sending task currently running, or null. */
  let inFlight = null;
  /** This tab's own id, learned from the background during the handshake. */
  let permanentTabId = null;
  const userRequests = new Map();
  const mqttRequests = new Map();

  // Diagnostic only: exposes what manifest.json Chrome is actually running for
  // this install, on the DOM where a page-context check can read it. Content
  // scripts do have `chrome.runtime.getManifest()`; a page script does not, so
  // this is the only way to settle "is the reload stale" without guessing.
  try {
    document.documentElement.dataset.dmhManifest = JSON.stringify(
      chrome.runtime.getManifest().content_scripts.map((cs) => ({ js: cs.js, world: cs.world, run_at: cs.run_at }))
    );
  } catch (_error) { /* diagnostic only */ }

  injectBridge();

  chrome.runtime.onConnect.addListener((port) => {
    executionPort = port;
    // IGDMBot drops its port reference on disconnect (background.js `se`), so a
    // dead MV3 service worker never leaves a stale port behind. Without this the
    // next postMessage throws "Attempting to use a disconnected port".
    port.onDisconnect.addListener(() => {
      if (executionPort === port) executionPort = null;
    });
    port.onMessage.addListener((message) => handlePortMessage(message, port));
  });

  /**
   * Second line of defence against a duplicated action. The background retries
   * its handshake, so the same instruction can arrive on two ports; a send that
   * ran twice would put two identical DMs in someone's inbox. Only one sending
   * task may be in flight at a time — a duplicate is dropped, and recorded.
   */
  function runExclusive(label, task) {
    if (inFlight) {
      void diagRecord({ kind: "note", label: "duplicate_action_ignored", detail: { requested: label, running: inFlight } });
      return null;
    }
    inFlight = label;
    void refreshWorkingOverlay();
    return Promise.resolve().then(task).finally(() => {
      inFlight = null;
      void refreshWorkingOverlay();
    });
  }

  function handlePortMessage(message, port) {
    if (message?.type === PORT.CONNECT_REQUEST) {
      port.postMessage({ type: PORT.CONNECT_RESPONSE });
      permanentTabId = message.tab_id ?? permanentTabId;
      void refreshWorkingOverlay();
    } else if (message?.type === PORT.MONITOR) {
      monitorInbox().catch(handleError);
    } else if (message?.type === PORT.SEND_MONITOR) {
      runExclusive(PORT.SEND_MONITOR, sendMonitor)?.catch(handleError);
    } else if (message?.type === PORT.SEND_BULK) {
      runExclusive(PORT.SEND_BULK, sendBulk)?.catch(handleError);
    } else if (message?.type === PORT.SEND_TEST) {
      // Verification only: never routed through handleError, because a failed
      // test must not stop or alter a configured campaign. A dropped duplicate
      // stays silent — the first run answers the popup.
      runExclusive(PORT.SEND_TEST, () => sendTestDm(message.data || {}))
        ?.then((data) => port.postMessage({ type: PORT.TEST_RESULT, ok: true, data }))
        .catch((error) => port.postMessage({ type: PORT.TEST_RESULT, ok: false, error: error.message }));
    } else if (message?.type === PORT.DUMP_PAGE_CONTEXT) {
      Promise.resolve().then(dumpPageContext)
        .then((data) => port.postMessage({ type: PORT.DUMP_PAGE_CONTEXT_RESP, ok: true, data }))
        .catch((error) => port.postMessage({ type: PORT.DUMP_PAGE_CONTEXT_RESP, ok: false, error: error.message }));
    } else if (message?.type === PORT.USER_INFO_RESPONSE) {
      const pending = userRequests.get(message.request_id);
      if (!pending) return;
      userRequests.delete(message.request_id);
      if (message.error) {
        pending.reject(Object.assign(new Error(message.error.message), message.error, { lookup: true }));
      } else pending.resolve(message.res);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    // Frames observed on Instagram's own edge-chat socket. This is how the wire
    // format of a message type we have not implemented gets established from
    // evidence: switch capture on, perform the action by hand, read the frame.
    if (event.data?.type === "INJECT_CAPTURE") {
      void diagRecord({
        kind: "capture",
        direction: event.data.direction || null,
        label: event.data.label || "instagram.frame",
        url: event.data.url || null,
        detail: event.data.detail || {}
      });
      return;
    }
    // Raw MQTT frames from the page bridge, which cannot reach chrome.storage.
    if (event.data?.type === "INJECT_DIAG") {
      void diagRecord({ kind: "mqtt", direction: event.data.direction, label: event.data.label, detail: event.data.detail });
      return;
    }
    if (event.data?.type !== "INJECT_DISPATCH_DM_RESPONSE") return;
    const pending = mqttRequests.get(event.data.request_id);
    if (!pending) return;
    mqttRequests.delete(event.data.request_id);
    clearTimeout(pending.timeout);
    pending.resolve(event.data);
  });

  const OVERLAY_ID = "dm-hour-working-mask";

  /**
   * The working tab is covered and labelled, the way IGDMBot dims its own tab
   * with "IG DM Bot is working, please keep this tab open." Without it the bot
   * silently opens an Instagram tab and the operator has no idea which of their
   * tabs must stay open — closing it stops the campaign mid-run.
   */
  function showWorkingOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    const mask = document.createElement("div");
    mask.id = OVERLAY_ID;
    Object.assign(mask.style, {
      position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.88)", zIndex: "9999", pointerEvents: "auto",
      display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
      color: "#ffffff", textAlign: "center",
      font: "500 32px/36px system-ui, -apple-system, sans-serif"
    });

    const icon = document.createElement("img");
    icon.src = chrome.runtime.getURL("icons/logo_128.png");
    icon.width = 64;
    icon.alt = "";
    Object.assign(icon.style, { height: "auto", marginBottom: "24px", borderRadius: "12px" });

    const title = document.createElement("p");
    title.style.margin = "0";
    title.textContent = "DM Hour працює.";

    const hint = document.createElement("p");
    hint.style.margin = "8px 0 0";
    hint.textContent = "Не закривай цю вкладку.";

    mask.append(icon, title, hint);
    (document.body || document.documentElement).appendChild(mask);
    window.onbeforeunload = () => "Are you sure to leave this page";
  }

  function hideWorkingOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
    window.onbeforeunload = null;
  }

  /** Recomputed whenever the tab's role or the bot's state can have changed. */
  async function refreshWorkingOverlay() {
    if (!permanentTabId) return;
    const state = await storage.get(["permanent_tab_info", "work_bot"]);
    const keep = shouldKeepTabOpen({
      tabId: permanentTabId,
      permanentTabId: state.permanent_tab_info?.tab_id,
      bot: state.work_bot,
      busy: Boolean(inFlight)
    });
    if (keep) showWorkingOverlay(); else hideWorkingOverlay();
  }

  // The overlay must also come down without a port message. If this tab is
  // navigated away the background abandons it and pins a fresh one, and no
  // instruction ever reaches this one again — the mask would otherwise stay up
  // forever on a tab the bot no longer uses.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.permanent_tab_info || changes.work_bot) void refreshWorkingOverlay();
    if (changes.capture_enabled) applyCaptureFlag(changes.capture_enabled.newValue);
  });

  /**
   * The page-realm hook checks this attribute before forwarding anything, so
   * edge-chat traffic costs nothing while capture is off.
   */
  function applyCaptureFlag(on) {
    if (on) document.documentElement.dataset.dmhCapture = "1";
    else delete document.documentElement.dataset.dmhCapture;
  }

  void storage.getValue("capture_enabled", false).then(applyCaptureFlag);

  function injectBridge() {
    if (document.documentElement.dataset.dmhParityBridge === "1") return;
    document.documentElement.dataset.dmhParityBridge = "1";
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("ijsource.js");
    script.onload = () => script.remove();
    (document.body || document.documentElement).appendChild(script);
  }

  async function readSession() {
    const get = (name) => chrome.runtime.sendMessage({ type: EVENT.GET_COOKIE, data: { url: "https://www.instagram.com", name } });
    const [dsUserId, csrfToken] = await Promise.all([get("ds_user_id"), get("csrftoken")]);
    if (!dsUserId || !csrfToken) throw statusError(STATUS.LOGGED_OUT);
    session = { ds_user_id: dsUserId, csrftoken: csrfToken };
    return session;
  }

  async function getSession() {
    return session ?? readSession();
  }

  /**
   * IGDMBot re-reads ds_user_id and csrftoken at every campaign entry point
   * (`startMonitor` / `startSendDM`) rather than caching them for the lifetime
   * of the tab, so a rotated csrftoken can never poison a whole run.
   */
  async function beginRun() {
    return readSession();
  }

  function dropSession() {
    session = null;
  }

  function headers(csrfToken) {
    return {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": csrfToken,
      "x-requested-with": "XMLHttpRequest",
      "x-instagram-ajax": "1"
    };
  }

  async function workBot() {
    return storage.getValue("work_bot");
  }

  async function updateBot(patch) {
    const bot = await workBot();
    if (!bot) return null;
    Object.assign(bot, patch);
    await storage.set({ work_bot: bot });
    await notify();
    // A bot that just stopped or completed must not leave the tab covered.
    void refreshWorkingOverlay();
    return bot;
  }

  async function notify() {
    try { await chrome.runtime.sendMessage({ type: EVENT.RELOAD_WORK_BOT_HOME_MSG, data: {} }); } catch (_error) {}
  }

  /**
   * IGDMBot validates the DM lists before it touches a recipient
   * (`sendDMLogic`, `sendBulkDMLogic`, `retriveFollowers`) and stops the bot
   * with status 10002 when a list it is about to use is empty — rather than
   * discovering it mid-send, after a thread has already been created.
   */
  async function assertDmListsReady(bot) {
    const comments = await storage.getValue("comments", []);
    const required = [];
    if (bot.bot_type === 0) {
      if (bot.enable_when_get_new_follower_by_monitor) required.push(bot.new_follower_dm_list_id);
      if (bot.enable_when_get_new_like_by_monitor) required.push(bot.new_like_dm_list_id);
    } else {
      required.push(bot.bulk_dm_list_id);
    }
    for (const listId of required) {
      if (!messagesForList(comments, listId).length) throw statusError(STATUS.EMPTY_DM_LIST);
    }
  }

  async function monitorInbox() {
    const bot = await workBot();
    if (!bot?.is_working || bot.is_complete || bot.bot_type !== 0) return;
    const auth = await beginRun();
    const response = await fetch("https://i.instagram.com/api/v1/news/inbox/", {
      method: "POST",
      credentials: "include",
      headers: { ...headers(auth.csrftoken), "x-asbd-id": APP.IG_ASBD_ID, "X-IG-App-ID": APP.IG_APP_ID }
    });
    const rawInbox = await response.text();
    await diagRecord({ kind: "http", direction: "in", label: "news/inbox", detail: { status: response.status, body: truncate(rawInbox, 1500) } });
    if (!response.ok) throw apiError(response.status, "news inbox failed");
    let payload;
    try { payload = JSON.parse(rawInbox); } catch (_error) { throw statusError(isLoggedOutBody(rawInbox) ? STATUS.LOGGED_OUT : STATUS.UNKNOWN); }
    if (payload.status !== "ok") throw apiError(response.status, payload.message || "news inbox rejected");
    let stories = payload.new_stories || [];
    if (bot.enable_skip_day_before_by_monitor && Number(bot.skip_day_before_by_monitor_num) > 0) {
      const after = Date.now() / 1000 - 86400 * Number(bot.skip_day_before_by_monitor_num);
      stories = stories.filter((story) => Number(story.args?.timestamp || 0) > after);
    }
    const pool = await storage.getValue("monitor_inbox_pool", []);
    const known = new Set(pool.map((user) => String(user.id)));
    for (const story of stories) {
      let type;
      if (story.type === 3 && story.story_type === 101 && bot.enable_when_get_new_follower_by_monitor) type = 0;
      if (story.type === 1 && story.story_type === 768 && bot.enable_when_get_new_like_by_monitor) type = 1;
      const args = story.args;
      if (type === undefined || !args?.profile_id || known.has(String(args.profile_id))) continue;
      pool.push({ id: String(args.profile_id), username: args.profile_name, profile_img: args.profile_image, type, timestamp: args.timestamp });
      known.add(String(args.profile_id));
    }
    await storage.set({ monitor_inbox_pool: pool });
    executionPort?.postMessage({ type: PORT.CHECK_MONITOR_OR_SEND });
  }

  async function sendMonitor() {
    const bot = await workBot();
    if (!bot?.is_working || bot.is_complete || bot.bot_type !== 0) return;
    if (Number(bot.dm_num || 0) >= Number(bot.day_dm_num || 0)) return;
    await beginRun();
    await assertDmListsReady(bot);
    const pool = await storage.getValue("monitor_inbox_pool", []);
    const history = await storage.getValue("dm_user_history_pool", []);
    let user;
    while (pool.length && !user) {
      const candidate = pool.pop();
      if (!history.some((item) => String(item.id) === String(candidate.id))) user = candidate;
    }
    await storage.set({ monitor_inbox_pool: pool });
    if (!user) return;
    const listId = user.type === 0 ? bot.new_follower_dm_list_id : bot.new_like_dm_list_id;
    await sendRecipientMaybeStory(user, listId);
  }

  async function requestUser(username, csvRow, goDup = true) {
    const auth = await getSession();
    const requestId = uuid();
    if (!executionPort) throw statusError(STATUS.UNKNOWN);
    return new Promise((resolve, reject) => {
      userRequests.set(requestId, { resolve, reject });
      executionPort.postMessage({
        type: PORT.USER_INFO_REQUEST,
        request_id: requestId,
        params: { igname: username, custom_user: csvRow, go_dup_flag: goDup, headers: headers(auth.csrftoken) }
      });
      setTimeout(() => {
        if (!userRequests.has(requestId)) return;
        userRequests.delete(requestId);
        reject(new Error("User lookup timed out"));
      }, 20000);
    });
  }

  async function sendBulk() {
    const bot = await workBot();
    if (!bot?.is_working || bot.is_complete || bot.bot_type !== 1) return;
    await beginRun();
    await assertDmListsReady(bot);
    if (bot.bulk_dm_target_type === 2) return sendCustom(bot);
    if (Number(bot.dm_num || 0) >= Number(bot.bulk_limit_max_users_count)) {
      await updateBot({ is_complete: true }); return;
    }
    let runtime = await storage.getValue("bulk_runtime_state", {});
    if (!runtime.target_id) {
      const found = await requestUser(bot.bulk_dm_target_type_value);
      const user = found?.data?.user;
      if (!user) return unavailable(bot.bulk_dm_target_type_value);
      runtime = { target_id: String(user.id || user.pk), edges: [], cursor: "", has_next_page: true };
    }
    if (!runtime.edges?.length && runtime.has_next_page !== false) runtime = await fetchGraphPage(bot, runtime);
    const history = await storage.getValue("dm_user_history_pool", []);
    // `handleDMbyBulkEdges` skips an edge when its username is in the 404 pool
    // OR its id is already in the DM history — both checks, in that order.
    const missing = await storage.getValue("dm_404_custom_dup_users_history_bot", []);
    let user;
    while (runtime.edges?.length && !user) {
      const node = runtime.edges.shift()?.node;
      if (!node) continue;
      if (missing.some((item) => item.username === node.username)) continue;
      if (!history.some((item) => String(item.id) === String(node.id))) {
        user = { id: String(node.id), username: node.username, profile_img: node.profile_pic_url, type: 2, timestamp: Date.now() };
      }
    }
    await storage.set({ bulk_runtime_state: runtime });
    if (user) return sendRecipientMaybeStory(user, bot.bulk_dm_list_id);
    if (runtime.has_next_page) {
      setTimeout(() => sendBulk().catch(handleError), randomInt(3000, 6000));
    } else await updateBot({ is_complete: true });
  }

  async function fetchGraphPage(bot, runtime) {
    const auth = await getSession();
    const followers = bot.bulk_dm_target_type === 0;
    const variables = { id: runtime.target_id, after: runtime.cursor || "", first: 50 };
    const url = new URL("https://www.instagram.com/graphql/query/");
    url.searchParams.set("query_hash", followers ? APP.QUERY_HASH.followed_by : APP.QUERY_HASH.follows);
    url.searchParams.set("variables", JSON.stringify(variables));
    const response = await fetch(url, { method: "GET", credentials: "include", headers: headers(auth.csrftoken) });
    if (!response.ok) throw apiError(response.status, "GraphQL request failed");
    // A signed-out session is answered with an HTML document, not JSON. IGDMBot
    // reports that as status 302 with a "log in again" message instead of
    // failing with an opaque parse error.
    const raw = await response.text();
    await diagRecord({ kind: "http", direction: "in", label: "graphql", detail: { status: response.status, query_hash: url.searchParams.get("query_hash"), body: truncate(raw, 1500) } });
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      if (isLoggedOutBody(raw)) throw statusError(STATUS.LOGGED_OUT);
      throw statusError(STATUS.UNKNOWN);
    }
    if (isLoggedOutBody(payload)) throw statusError(STATUS.LOGGED_OUT);
    const connection = followers ? payload?.data?.user?.edge_followed_by : payload?.data?.user?.edge_follow;
    if (!connection) throw statusError(STATUS.UNKNOWN);
    return {
      target_id: runtime.target_id,
      edges: connection.edges || [],
      cursor: connection.page_info?.end_cursor || "",
      has_next_page: Boolean(connection.page_info?.has_next_page)
    };
  }

  async function sendCustom(bot) {
    const queue = await storage.getValue("dm_custom_queue_bot_pool", []);
    const prior = await storage.getValue("dm_user_history_pool", []);
    const runDup = await storage.getValue("dm_custom_dup_users_history_bot", []);
    const missing = await storage.getValue("dm_404_custom_dup_users_history_bot", []);
    while (queue.length) {
      const row = queue[0];
      const username = String(typeof row === "object" ? row.Username : row).trim();
      if (!username || missing.some((x) => x.username === username) || runDup.some((x) => x.username === username) || (!bot.can_dm_to_privious_user && prior.some((x) => x.username === username))) {
        queue.shift(); await storage.set({ dm_custom_queue_bot_pool: queue }); continue;
      }
      const found = await requestUser(username, typeof row === "object" ? row : undefined, !bot.can_dm_to_privious_user);
      const data = found?.data?.user;
      if (!data) return unavailable(username);
      const user = { id: String(data.id || data.pk), username: data.username, profile_img: data.profile_pic_url, type: 2, timestamp: Date.now() };
      runDup.push(user); await storage.set({ dm_custom_dup_users_history_bot: runDup });
      return sendRecipientMaybeStory(user, bot.bulk_dm_list_id, typeof row === "object" ? row : undefined, !bot.can_dm_to_privious_user);
    }
    await updateBot({ is_complete: true });
  }

  async function isDuplicateRecipient(username, goDup = true) {
    if (goDup) {
      const history = await storage.getValue("dm_user_history_pool", []);
      if (history.some((item) => item.username === username)) return true;
    }
    const missing = await storage.getValue("dm_404_custom_dup_users_history_bot", []);
    return missing.some((item) => item.username === username);
  }

  /**
   * Thread creation. Returns the parsed payload, or null when the recipient is
   * unreachable in the way the source treats as "skip and move on".
   */
  async function createThread(user) {
    const auth = await getSession();
    const requestHeaders = { ...headers(auth.csrftoken), "x-asbd-id": APP.IG_ASBD_ID, "X-IG-App-ID": APP.IG_APP_ID };
    const url = "https://i.instagram.com/api/v1/direct_v2/create_group_thread/";
    const body = new URLSearchParams({ recipient_users: JSON.stringify([String(user.id)]) });
    await diagRecord({ kind: "http", direction: "out", label: "create_group_thread", detail: { url, method: "POST", headers: redactHeaders(requestHeaders), body: body.toString() } });
    const response = await fetch(url, { method: "POST", credentials: "include", headers: requestHeaders, body });
    const raw = await response.text();
    await diagRecord({ kind: "http", direction: "in", label: "create_group_thread", detail: { status: response.status, body: truncate(raw) } });
    let payload;
    try { payload = JSON.parse(raw); } catch (_error) { throw apiError(response.status, "create_group_thread returned non-JSON"); }
    if (!response.ok || payload.status !== "ok") {
      if (response.status === 404 || (response.status === 403 && payload.status_code === "403" && payload.message === "This may be due to their app version or other settings.")) return null;
      throw apiError(response.status, payload.message || "create_group_thread failed");
    }
    return payload;
  }

  function pageSourceBundle() {
    const parts = [];
    try {
      for (const script of document.scripts || []) {
        if (script.textContent) parts.push(script.textContent);
      }
    } catch (_error) { /* isolated world still sees inline scripts */ }
    parts.push(document.documentElement?.innerHTML || "");
    return parts.join("\n");
  }

  function collectPageContext() {
    return extractInstagramPageContext(pageSourceBundle());
  }

  function readWebTokens() {
    return collectPageContext().tokens || {};
  }

  async function dumpPageContext() {
    const context = collectPageContext();
    await diagRecord({
      kind: "note",
      label: "page.context",
      detail: {
        href: location.href,
        stats: context.stats,
        tokens: context.tokens,
        module_names: context.module_names,
        harvested: context.harvested
      }
    });
    return {
      href: location.href,
      at: new Date().toISOString(),
      ...context
    };
  }

  function pickStoryFromReel(payload, userId) {
    const reel = payload?.reel;
    if (!reel || reel.can_reply === false) return null;
    const items = Array.isArray(reel.items) ? reel.items : [];
    const now = Math.floor(Date.now() / 1000);
    const live = items.filter((item) => !item.expiring_at || Number(item.expiring_at) > now);
    const chosen = (live.length ? live : items).at(-1);
    const mediaId = chosen?.pk || String(chosen?.id || "").split("_")[0];
    if (!mediaId) return null;
    return {
      media_id: String(mediaId),
      reel_id: String(reel.id || reel.user?.pk || userId)
    };
  }

  async function findActiveStory(userId) {
    const auth = await getSession();
    const url = `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/story/`;
    const requestHeaders = { ...headers(auth.csrftoken), "x-asbd-id": APP.IG_ASBD_ID, "X-IG-App-ID": APP.IG_APP_ID };
    await diagRecord({ kind: "http", direction: "out", label: "story.lookup", detail: { url, method: "GET" } });
    const response = await fetch(url, { method: "GET", credentials: "include", headers: requestHeaders });
    const raw = await response.text();
    await diagRecord({ kind: "http", direction: "in", label: "story.lookup", detail: { status: response.status, body: truncate(raw, 1500) } });
    if (isLoggedOutBody(raw)) throw statusError(STATUS.LOGGED_OUT);
    let payload;
    try { payload = JSON.parse(raw); } catch (_error) { return null; }
    return pickStoryFromReel(payload, userId);
  }

  async function postStoryReply(user, text, story, tokens) {
    const auth = await getSession();
    const offlineId = `${Date.now()}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
    const body = new URLSearchParams({
      av: String(tokens.av),
      __d: "www",
      __user: "0",
      __a: "1",
      __comet_req: "7",
      fb_dtsg: tokens.fb_dtsg,
      jazoest: tokens.jazoest || "",
      lsd: tokens.lsd,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: APP.STORY.REPLY_NAME,
      server_timestamps: "true",
      variables: JSON.stringify({
        send_data: {
          forwarded_from_thread_id: null,
          is_forwarded_from_own_message: null,
          offline_threading_id: offlineId,
          recipient_users: JSON.stringify([String(user.id)]),
          thread_id: null
        },
        data: {
          is_shh_mode: false,
          media_id: story.media_id,
          reaction_emoji: null,
          reel_id: story.reel_id,
          sampled: false,
          share_client_context: offlineId,
          text: { sensitive_string_value: String(text) }
        }
      }),
      doc_id: APP.STORY.REPLY_DOC
    });
    const requestHeaders = {
      ...headers(auth.csrftoken),
      "x-asbd-id": APP.IG_ASBD_ID,
      "X-IG-App-ID": APP.IG_APP_ID,
      "x-fb-friendly-name": APP.STORY.REPLY_NAME,
      "x-fb-lsd": tokens.lsd
    };
    const url = "https://www.instagram.com/api/graphql";
    await diagRecord({ kind: "http", direction: "out", label: APP.STORY.REPLY_NAME, detail: { url, method: "POST", body: truncate(body.toString(), 1500) } });
    const response = await fetch(url, { method: "POST", credentials: "include", headers: requestHeaders, body });
    const raw = await response.text();
    await diagRecord({ kind: "http", direction: "in", label: APP.STORY.REPLY_NAME, detail: { status: response.status, body: truncate(raw, 1500) } });
    if (isLoggedOutBody(raw)) throw statusError(STATUS.LOGGED_OUT);
    let payload;
    try { payload = JSON.parse(raw); } catch (_error) { throw apiError(response.status, "story reply returned non-JSON"); }
    const result = payload?.data?.direct_story_share_reply_with_slide_message_response;
    if (result?.message_id || result?.id) {
      return { ok: true, via: "story_reply", media_id: story.media_id, message_id: result.message_id || result.id };
    }
    return { ok: false, reason: payload?.errors?.[0]?.message || "story_send_rejected" };
  }

  async function trySendStoryReply(user, text) {
    try {
      const tokens = readWebTokens();
      if (!tokens.fb_dtsg || !tokens.lsd || !tokens.av) {
        return { ok: false, reason: "web_tokens_missing" };
      }
      const story = await findActiveStory(String(user.id));
      if (!story?.media_id) return { ok: false, reason: "no_story" };
      return await postStoryReply(user, text, story, tokens);
    } catch (error) {
      if (error?.status === STATUS.LOGGED_OUT) throw error;
      await diagRecord({ kind: "note", label: "story.error", detail: { message: error.message, status: error.status || null } });
      return { ok: false, reason: error.message || "story_error" };
    }
  }

  async function sendRecipientMaybeStory(user, listId, csvRow, goDup = true) {
    const comments = await storage.getValue("comments", []);
    const text = prepareMessage(comments, listId, user, csvRow);
    if (await isDuplicateRecipient(user.username, goDup)) return fastNext();
    const bot = await workBot();
    if (bot?.prefer_story_reply) {
      const story = await trySendStoryReply(user, text);
      if (story?.ok) return recordSuccess(user, text, { via: "story_reply", media_id: story.media_id, message_id: story.message_id });
      await diagRecord({ kind: "note", label: "story.fallback_direct", detail: { username: user.username, reason: story?.reason || "unknown" } });
    }
    return sendRecipient(user, listId, csvRow, goDup, text);
  }

  async function sendRecipient(user, listId, csvRow, goDup = true, preparedText) {
    const comments = await storage.getValue("comments", []);
    const text = preparedText ?? prepareMessage(comments, listId, user, csvRow);
    const payload = await createThread(user);
    if (!payload) return unavailable(user.username);
    // `sendMessageToIJSource` re-checks the history and 404 pools between thread
    // creation and the MQTT publish — the last guard against messaging someone
    // twice when a pool changed while this run was in flight.
    if (await isDuplicateRecipient(user.username, goDup)) return fastNext();
    const result = await dispatchMqtt({ thread_id: payload.thread_id, viewer_id: payload.viewer_id, user, text });
    if (result.ret === 1) return recordSuccess(user, text);
    if (result.status_code === 403 && result.error_code === 1545120) return fastNext();
    throw apiError(result.status_code || 0, "Send DM Error");
  }

  /**
   * One-shot send for verifying the live transport. It walks the exact same
   * lookup -> create_group_thread -> MQTT path as a campaign, and deliberately
   * touches no pool, history, counter, work bot or alarm: nothing here may
   * disturb a configured campaign, and a failure must leave no residue.
   */
  async function sendTestDm({ username, text, prefer_story_reply = false }) {
    const name = normalizeUsername(username);
    const message = String(text || "").trim();
    if (!name) throw new Error("Вкажи username отримувача");
    if (!message) throw new Error("Вкажи текст повідомлення");
    await beginRun();
    await diagRecord({ kind: "note", label: "test.start", detail: { username: name, prefer_story_reply: Boolean(prefer_story_reply) } });
    const found = await requestUser(name);
    const data = found?.data?.user;
    if (!data) throw new Error(`Акаунт @${name} не знайдено`);
    const user = { id: String(data.id || data.pk), username: data.username, profile_img: data.profile_pic_url, type: 2, timestamp: Date.now() };
    let storyFallback = null;
    if (prefer_story_reply) {
      const story = await trySendStoryReply(user, message);
      await diagRecord({ kind: "note", label: "test.story", detail: story });
      if (story?.ok) {
        return { username: user.username, via: "story_reply", message_id: story.message_id, media_id: story.media_id };
      }
      storyFallback = story?.reason || "unknown";
    }
    const payload = await createThread(user);
    if (!payload) throw new Error(`@${name} не приймає повідомлення (404/403)`);
    const result = await dispatchMqtt({ thread_id: payload.thread_id, viewer_id: payload.viewer_id, user, text: message });
    await diagRecord({ kind: "note", label: "test.result", detail: result });
    if (result.ret !== 1) {
      throw new Error(`Не доставлено: status ${result.status_code ?? "?"}${result.error_code ? `, error ${result.error_code}` : ""}`);
    }
    return { username: user.username, thread_id: payload.thread_id, via: "direct", story_fallback: storyFallback };
  }

  function dispatchMqtt(data) {
    const requestId = uuid();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { mqttRequests.delete(requestId); reject(new Error("MQTT response timed out")); }, 20000);
      mqttRequests.set(requestId, { resolve, reject, timeout });
      window.postMessage({ type: "INJECT_DISPATCH_DM_REQUEST", request_id: requestId, ...data, debug: false }, "*");
    });
  }

  async function recordSuccess(user, text, extra = {}) {
    const state = await storage.get(["work_bot", "dm_message_history_pool", "dm_user_history_pool", "dm_custom_queue_bot_pool"]);
    const record = { ...user, text, st_time: Date.now(), via: extra.via || "direct", ...extra };
    const messages = state.dm_message_history_pool || [], users = state.dm_user_history_pool || [];
    messages.push(record); users.push(record);
    const queue = state.dm_custom_queue_bot_pool || [];
    if (state.work_bot?.bot_type === 1 && state.work_bot.bulk_dm_target_type === 2 && queue.length) queue.shift();
    const bot = state.work_bot; bot.dm_num = Number(bot.dm_num || 0) + 1;
    if (bot.bot_type === 0 && bot.dm_num >= Number(bot.day_dm_num)) bot.is_complete = true;
    if (bot.bot_type === 1 && bot.bulk_dm_target_type !== 2 && bot.dm_num >= Number(bot.bulk_limit_max_users_count)) bot.is_complete = true;
    if (bot.bot_type === 1 && bot.bulk_dm_target_type === 2 && queue.length === 0) bot.is_complete = true;
    await storage.set({ work_bot: bot, dm_message_history_pool: messages, dm_user_history_pool: users, dm_custom_queue_bot_pool: queue });
    await notify();
    if (!bot.is_complete) scheduleNextDm();
  }

  /**
   * `DMtoNextUserAlarm`: ask the background to schedule the next DM over the
   * port, and fall back to a runtime message when the port is gone. Without the
   * fallback a service worker that was recycled mid-send leaves the campaign
   * with no pending alarm — it stops silently and never resumes.
   */
  function scheduleNextDm() {
    try {
      if (!executionPort) throw new Error("port is closed");
      executionPort.postMessage({ type: PORT.MONITOR_DONE });
    } catch (_error) {
      chrome.runtime.sendMessage({ type: EVENT.SEND_NEXT_DM_TO_QUEUE, data: {} }).catch(() => undefined);
    }
  }

  /**
   * `handle404Username`: record the unreachable username and move on after the
   * fast-skip delay. It deliberately does NOT touch the custom queue — the
   * queue advances only on a delivered DM, and this username is filtered out on
   * the next pass by the 404 pool. Shifting here would silently drop an
   * unrelated CSV row whenever a Monitor recipient turned out to be 404.
   */
  async function unavailable(username) {
    const missing = await storage.getValue("dm_404_custom_dup_users_history_bot", []);
    if (!missing.some((item) => item.username === username)) missing.push({ username, st_time: Date.now() });
    await storage.set({ dm_404_custom_dup_users_history_bot: missing });
    return fastNext();
  }

  function fastNext() {
    setTimeout(() => chrome.runtime.sendMessage({ type: EVENT.SEND_DIRECTLY_NEXT_DM, data: {} }), randomInt(10000, 30000));
  }

  function apiError(status, message) { const error = new Error(message); error.status = status; return error; }

  async function handleError(error) {
    // `getUserInfoResp` maps a transport-level failure to status 10004 before
    // anything else; only HTTP statuses reach the error-code settings.
    // Compare by name, not `instanceof`: a fetch rejection raised in another
    // realm (the injected bridge, or a test sandbox) is still a TypeError.
    if (error?.name === "TypeError") {
      await updateBot({ status_code: STATUS.NETWORK, status_data_msg: DMHCore.STATUS_MESSAGE[STATUS.NETWORK], is_working: false });
      return;
    }
    const status = Number(error.status || 0);
    // A rejected session must not be reused by the next run.
    if ([401, 403, STATUS.LOGGED_OUT].includes(status)) dropSession();
    const key = String(status);
    const defaults = DMHCore.ERROR_DEFAULTS[key];
    if (defaults && error.lookup) {
      const saved = await storage.get([`enable_handle_status_${key}`, `batch_interval_nums_${key}`]);
      if (saved[`enable_handle_status_${key}`]) {
        await chrome.runtime.sendMessage({ type: EVENT.ERROR_CODE_HANDLE_DM, data: { batch_interval_nums: saved[`batch_interval_nums_${key}`] || defaults.batch_interval_nums } });
        return;
      }
    }
    await updateBot({ status_code: status || 10001, status_data_msg: error.message, is_working: false });
  }
  if (globalThis.__DMH_TEST__) globalThis.__DMH_PARITY_CONTENT__ = {
    monitorInbox,
    fetchGraphPage,
    sendRecipient,
    sendRecipientMaybeStory,
    trySendStoryReply,
    findActiveStory,
    collectPageContext,
    dumpPageContext,
    sendTestDm,
    createThread,
    handlePortMessage,
    runExclusive,
    showWorkingOverlay,
    hideWorkingOverlay,
    refreshWorkingOverlay,
    setPermanentTabId(value) { permanentTabId = value; },
    sendBulk,
    sendCustom,
    assertDmListsReady,
    isDuplicateRecipient,
    unavailable,
    scheduleNextDm,
    handleError,
    headers,
    setSession(value) { session = value; },
    setExecutionPort(value) { executionPort = value; }
  };
})();
