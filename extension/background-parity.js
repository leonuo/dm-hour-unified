(() => {
  "use strict";
  const { EVENT, PORT, APP, storage, randomInt, todayKey, uuid } = DMHCore;

  async function seedDefaults() {
    if (await storage.getValue("installed_flag")) return;
    const follower = uuid(), liker = uuid(), bulk = uuid();
    await storage.set({
      installed_flag: true,
      comment_list: [
        { id: follower, name: "Monitor Followers DM list" },
        { id: liker, name: "Monitor Likers DM list" },
        { id: bulk, name: "Bulk DM list" }
      ],
      comments: [
        { id: uuid(), list_id: follower, content: "{{thanks|Thanks|Thank you}{| a lot} for the follow {😄|😘|🥰}{.|!}}" },
        { id: uuid(), list_id: follower, content: "thank you very much for the follow." },
        { id: uuid(), list_id: liker, content: "{{thanks|Thanks|Thank you}{| a lot} for the {like|❤️|🥰} {😄|😘|🥰}{.|!}}" },
        { id: uuid(), list_id: bulk, content: "{Hello|Hi} you {😘|😘}{.|!|}" },
        { id: uuid(), list_id: bulk, content: "Hi <Username>, 😄😄😄" }
      ],
      bot_list: [{
        id: uuid(), bot_name: "Monitor DM Bot", bot_type: 0,
        enable_when_get_new_follower_by_monitor: true,
        new_follower_dm_list_id: follower,
        enable_when_get_new_like_by_monitor: true,
        new_like_dm_list_id: liker,
        enable_skip_day_before_by_monitor: true,
        skip_day_before_by_monitor_num: 1,
        dm_per_day_by_monitor_nums: [10, 20],
        range_interval: [4, 12], group_range_interval: [10, 20], group_message_num: 10
      }],
      dm_message_history_pool: [], dm_user_history_pool: [], monitor_inbox_pool: [],
      dm_404_custom_dup_users_history_bot: [], dm_custom_dup_users_history_bot: []
    });
  }

  async function notify(type = EVENT.RELOAD_WORK_BOT_HOME_MSG, data = {}) {
    try { await chrome.runtime.sendMessage({ type, data }); } catch (_error) {}
  }

  async function permanentTab() {
    const info = await storage.getValue("permanent_tab_info");
    if (info?.tab_id) {
      try {
        const tab = await chrome.tabs.get(info.tab_id);
        if (tab.url?.includes("instagram.com/direct/inbox/")) return tab;
      } catch (_error) {}
    }
    await storage.remove("permanent_tab_info");
    return null;
  }

  async function ensureTab() {
    const old = await permanentTab();
    if (old) return old;
    const tab = await chrome.tabs.create({ url: APP.DIRECT_INBOX_URL, active: false });
    await storage.set({ permanent_tab_info: { tab_id: tab.id } });
    return tab;
  }

  async function stopTab() {
    const tab = await permanentTab();
    if (tab?.id) try { await chrome.tabs.remove(tab.id); } catch (_error) {}
    await storage.remove("permanent_tab_info");
  }

  async function lookup(params = {}) {
    const username = String(params.igname || "").trim();
    const headers = { ...(params.headers || {}), "x-asbd-id": APP.IG_ASBD_ID, "x-ig-app-id": APP.IG_APP_ID };
    const searchRes = await fetch(`https://www.instagram.com/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}`, { method: "GET", headers });
    await DMHCore.diagRecord({ kind: "http", direction: "in", label: "topsearch", detail: { status: searchRes.status, query: username } });
    if (!searchRes.ok) throw apiError(searchRes.status, "topsearch failed");
    const search = await searchRes.json();
    const exact = (search.users || []).find(({ user }) => user?.username?.toLowerCase() === username.toLowerCase());
    const id = exact?.user?.pk || exact?.user?.pk_id || exact?.user?.id;
    if (!id) return { data: {} };
    await new Promise((resolve) => setTimeout(resolve, randomInt(400, 1500)));
    const infoRes = await fetch(`https://www.instagram.com/api/v1/users/${id}/info/?from_module=profile`, {
      method: "GET", headers: { ...headers, "x-ig-www-claim": "0" }
    });
    if (!infoRes.ok) throw apiError(infoRes.status, "user info failed");
    const info = await infoRes.json();
    if (!info.user) return { data: {} };
    if (!info.user.id) info.user.id = info.user.pk;
    return { data: { user: info.user }, status: "ok" };
  }

  function apiError(status, message) {
    const error = new Error(message); error.status = status; error.type = "custom"; return error;
  }

  function bindPort(port) {
    if (port.__dmhBound) return;
    port.__dmhBound = true;
    port.onMessage.addListener((message) => {
      if (message?.type === PORT.USER_INFO_REQUEST) {
        lookup(message.params).then((res) => port.postMessage({ type: PORT.USER_INFO_RESPONSE, request_id: message.request_id, params: message.params, res }))
          .catch((error) => port.postMessage({ type: PORT.USER_INFO_RESPONSE, request_id: message.request_id, params: message.params, error: { type: error.type, code: error.status, message: error.message } }));
      } else if (message?.type === PORT.TEST_RESULT) {
        notify(EVENT.TEST_DM_RESULT, { ok: message.ok, data: message.data, error: message.error }).catch(() => undefined);
      } else if (message?.type === PORT.DUMP_PAGE_CONTEXT_RESP) {
        notify(EVENT.DUMP_PAGE_CONTEXT_RESULT, { ok: message.ok, data: message.data, error: message.error }).catch(() => undefined);
      } else if (message?.type === PORT.MONITOR_DONE) scheduleNext().catch(console.error);
      else if (message?.type === PORT.CHECK_MONITOR_OR_SEND) checkMonitorQueue().catch(console.error);
    });
  }

  function connectToTab(tabId, action, extra) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let timer;
      // Only one handshake may dispatch. The retry runs every three seconds, so
      // a tab that answers late can leave a second port open, and every open
      // port receives CONNECT_RESPONSE — without this flag each of them would
      // post the action, which is how one request became two delivered DMs.
      let settled = false;
      const pending = new Set();
      const close = (port) => { try { port.disconnect(); } catch (_error) { /* already gone */ } };

      const attempt = () => {
        if (settled) return;
        if (Date.now() - start > 30000) {
          clearInterval(timer);
          for (const port of pending) close(port);
          pending.clear();
          reject(new Error("Content port timeout"));
          return;
        }
        let port;
        try { port = chrome.tabs.connect(tabId, { name: "permanent_tab" }); } catch (_error) { return; }
        pending.add(port);
        port.onDisconnect.addListener(() => pending.delete(port));
        port.onMessage.addListener(function ready(message) {
          if (message?.type !== PORT.CONNECT_RESPONSE) return;
          port.onMessage.removeListener(ready);
          if (settled) { close(port); return; }
          settled = true;
          clearInterval(timer);
          pending.delete(port);
          for (const other of pending) close(other);
          pending.clear();
          bindPort(port);
          port.postMessage({ type: action, ...(extra ? { data: extra } : {}) });
          resolve(true);
        });
        port.postMessage({ type: PORT.CONNECT_REQUEST, tab_id: tabId });
      };
      // No immediate attempt: background.js `se()` is nothing but a three-second
      // interval, and that delay is what makes the handshake reliable. A tab
      // created a moment ago has not loaded its content script yet, so
      // connecting straight away produces a port that answers late — right when
      // the retry has already opened a second one. Waiting the first three
      // seconds lets the tab come up, and the first response then arrives long
      // before the next tick.
      timer = setInterval(attempt, 3000);
    });
  }

  /**
   * A tab that stopped answering the handshake is discarded and reopened once,
   * mirroring background.js `se` -> `ge`. Rejecting outright would strand the
   * campaign whenever Instagram replaced the page in the pinned tab.
   */
  async function dispatch(action, extra) {
    const tab = await ensureTab();
    try {
      return await connectToTab(tab.id, action, extra);
    } catch (error) {
      await stopTab();
      const fresh = await ensureTab();
      return connectToTab(fresh.id, action, extra);
    }
  }

  async function resetMonitorDay(bot) {
    const today = todayKey();
    if (await storage.getValue("monitor_store_date") === today) return bot;
    const range = bot.dm_per_day_by_monitor_nums || [10, 20];
    Object.assign(bot, { dm_num: 0, day_dm_num: randomInt(range[0], range[1]), is_complete: false });
    await storage.set({ monitor_store_date: today, work_bot: bot });
    return bot;
  }

  async function scheduleNext() {
    const bot = await storage.getValue("work_bot");
    if (!bot?.is_working || bot.is_complete) return;
    const grouped = bot.dm_num > 0 && Number(bot.group_message_num) > 0 && bot.dm_num % Number(bot.group_message_num) === 0;
    const range = grouped ? bot.group_range_interval : bot.range_interval;
    const wait = randomInt(Number(range[0]) * 60000, Number(range[1]) * 60000);
    await chrome.alarms.create(APP.ALARM.NEXT_DM, { when: Date.now() + wait });
    await notify();
  }

  async function directNext() {
    const bot = await storage.getValue("work_bot");
    if (!bot?.is_working || bot.is_complete) return;
    await dispatch(bot.bot_type === 0 ? PORT.SEND_MONITOR : PORT.SEND_BULK);
  }

  async function checkMonitorQueue() {
    if (await chrome.alarms.get(APP.ALARM.NEXT_DM)) return;
    const bot = await storage.getValue("work_bot");
    const key = DMHCore.poolKey(bot?.account_id, "monitor_inbox_pool");
    if ((await storage.getValue(key, [])).length) await directNext();
  }

  async function startMonitor() {
    await chrome.alarms.create(APP.ALARM.MONITOR, { periodInMinutes: 1 });
    await dispatch(PORT.MONITOR);
  }

  async function skipCurrent() {
    const bot = await storage.getValue("work_bot");
    const queueKey = DMHCore.poolKey(bot?.account_id, "dm_custom_queue_bot_pool");
    const inboxKey = DMHCore.poolKey(bot?.account_id, "monitor_inbox_pool");
    const state = await storage.get(["work_bot", queueKey, inboxKey]);
    const queue = state[queueKey], inbox = state[inboxKey];
    let username;
    if (queue?.length) {
      const item = queue.shift(); username = item?.Username || item?.username || item;
      await storage.set({ [queueKey]: queue });
    } else if (state.work_bot?.bot_type === 0 && inbox?.length) {
      username = inbox.shift()?.username;
      await storage.set({ [inboxKey]: inbox });
    }
    await notify(EVENT.SKIP_CURRENT_USER_RESPONSE, { username });
    return { username };
  }

  /** Migrations run before defaults so a seed never lands on an unmigrated store. */
  async function prepareStorage() {
    const result = await DMHCore.migrateStorage();
    if (result.applied.length) console.log("storage migrated", result);
    await seedDefaults();
  }

  chrome.runtime.onInstalled.addListener(() => prepareStorage().catch(console.error));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === APP.ALARM.MONITOR) {
      storage.getValue("work_bot").then(async (bot) => {
        if (!bot?.is_working || bot.is_complete || bot.bot_type !== 0) return;
        await resetMonitorDay(bot); await dispatch(PORT.MONITOR);
      }).catch(console.error);
    } else if (alarm.name === APP.ALARM.NEXT_DM) directNext().catch(console.error);
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    (async () => {
      switch (message?.type) {
        case EVENT.GET_COOKIE: return (await chrome.cookies.get({ url: message.data.url, name: message.data.name }))?.value;
        case EVENT.CHECK_TAB_IS_OR_NOT_OPEN: return directNext();
        case EVENT.CHECK_TAB_SWITCH_BOT: {
          await stopTab(); const bot = await storage.getValue("work_bot");
          return bot?.bot_type === 0 ? startMonitor() : dispatch(PORT.SEND_BULK);
        }
        case EVENT.CHECK_TAB_STOP_BOT:
          await chrome.alarms.clear(APP.ALARM.MONITOR);
          await chrome.alarms.clear(APP.ALARM.NEXT_DM);
          await stopTab();
          return true;
        case EVENT.START_DM_BY_MONITOR_BOT: return startMonitor();
        case EVENT.START_DM_BY_BULK_BOT: return dispatch(PORT.SEND_BULK);
        case EVENT.SEND_NEXT_DM_TO_QUEUE: return scheduleNext();
        case EVENT.SEND_DIRECTLY_NEXT_DM: return directNext();
        case EVENT.ERROR_CODE_HANDLE_DM: {
          const r = message.data.batch_interval_nums, wait = randomInt(r[0] * 60000, r[1] * 60000);
          await chrome.alarms.create(APP.ALARM.NEXT_DM, { when: Date.now() + wait }); return true;
        }
        case EVENT.SKIP_CURRENT_USER: return skipCurrent();
        // Verification path: it opens the pinned tab like a campaign would, but
        // creates no alarm, so nothing is scheduled after the single send.
        case EVENT.SEND_TEST_DM: return dispatch(PORT.SEND_TEST, message.data || {});
        case EVENT.DUMP_PAGE_CONTEXT: return dispatch(PORT.DUMP_PAGE_CONTEXT);
        default: return undefined;
      }
    })().then(respond).catch((error) => respond({ error: `${error.name}: ${error.message}` }));
    return true;
  });
  if (globalThis.__DMH_TEST__) globalThis.__DMH_PARITY_BACKGROUND__ = { lookup, resetMonitorDay, scheduleNext, prepareStorage, connectToTab };
  prepareStorage().catch(console.error);
})();
