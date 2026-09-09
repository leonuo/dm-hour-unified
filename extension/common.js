(() => {
  "use strict";

  const EVENT = Object.freeze({
    GET_COOKIE: "GET_COOKIE",
    RELOAD_WORK_BOT_HOME_MSG: "RELOAD_WORK_BOT_HOME_MSG",
    CHECK_TAB_IS_OR_NOT_OPEN: "CHECK_TAB_IS_OR_NOT_OPEN",
    CHECK_TAB_SWITCH_BOT: "CHECK_TAB_SWITCH_BOT",
    CHECK_TAB_STOP_BOT: "CHECK_TAB_STOP_BOT",
    START_DM_BY_MONITOR_BOT: "START_DM_BY_MONITOR_BOT",
    START_DM_BY_BULK_BOT: "START_DM_BY_BULK_BOT",
    SEND_NEXT_DM_TO_QUEUE: "SEND_NEXT_DM_TO_QUEUE",
    SEND_DIRECTLY_NEXT_DM: "SEND_DIRECTLY_NEXT_DM",
    SKIP_CURRENT_USER: "SKIP_CURRENT_USER",
    SKIP_CURRENT_USER_RESPONSE: "SKIP_CURRENT_USER_RESPONSE",
    ERROR_CODE_HANDLE_DM: "ERROR_CODE_HANDLE_DM",
    SEND_TEST_DM: "SEND_TEST_DM",
    TEST_DM_RESULT: "TEST_DM_RESULT",
    DUMP_PAGE_CONTEXT: "DUMP_PAGE_CONTEXT",
    DUMP_PAGE_CONTEXT_RESULT: "DUMP_PAGE_CONTEXT_RESULT"
  });

  const PORT = Object.freeze({
    CONNECT_REQUEST: "connect_content_req",
    CONNECT_RESPONSE: "connect_content_res",
    MONITOR: "monitor_new_follower",
    SEND_MONITOR: "send_dm_to_new_follower",
    SEND_BULK: "send_bulk_dm_to_follower",
    MONITOR_DONE: "monitor_dm_new_follower_resp",
    CHECK_MONITOR_OR_SEND: "checkMonitorAlarmOrSendDM",
    USER_INFO_REQUEST: "req_user_info",
    USER_INFO_RESPONSE: "req_user_info_resp",
    SEND_TEST: "send_test_dm",
    TEST_RESULT: "send_test_dm_resp",
    DUMP_PAGE_CONTEXT: "dump_page_context",
    DUMP_PAGE_CONTEXT_RESP: "dump_page_context_resp"
  });

  const APP = Object.freeze({
    IG_APP_ID: "936619743392459",
    IG_ASBD_ID: "129477",
    DIRECT_INBOX_URL: "https://www.instagram.com/direct/inbox/",
    QUERY_HASH: Object.freeze({
      followed_by: "37479f2b8209594dde7facb0d904896a",
      follows: "58712303d941c6855d4e888c5f0cd22f"
    }),
    ALARM: Object.freeze({
      MONITOR: "polling_monitor_schedule",
      NEXT_DM: "next_dm_schedule"
    }),
    STORY: Object.freeze({
      REPLY_NAME: "IGDirectStoryShareReplyMutation",
      REPLY_DOC: "26536543495958378"
    })
  });

  const ERROR_DEFAULTS = Object.freeze({
    "401": { tip: "401", enable_handle_status: false, batch_interval_nums: [20, 30] },
    "403": { tip: "403", enable_handle_status: false, batch_interval_nums: [20, 30] },
    "429": { tip: "429", enable_handle_status: false, batch_interval_nums: [20, 30] },
    "500": { tip: "500", enable_handle_status: false, batch_interval_nums: [5, 10] },
    "400": { tip: "400", enable_handle_status: false, batch_interval_nums: [20, 30] },
    "503": { tip: "503", enable_handle_status: false, batch_interval_nums: [20, 30] }
  });

  /**
   * Non-HTTP bot statuses and their exact IGDMBot 1.6.4 operator messages.
   * The source raises these from Content.js `setworkBotStatus`.
   */
  const STATUS = Object.freeze({
    LOGGED_OUT: 302,
    UNKNOWN: 10001,
    EMPTY_DM_LIST: 10002,
    NETWORK: 10004
  });

  const STATUS_MESSAGE = Object.freeze({
    302: "Please log in to your Instagram account again, come back, and click Continue button to start working.",
    10001: "Something went wrong, you can click Continue button to start working.",
    10002: "The DM list for the robot is empty.",
    10004: "Network error. Please check your internet connection."
  });

  function statusError(code, message) {
    const error = new Error(message ?? STATUS_MESSAGE[code] ?? "Bot stopped");
    error.status = code;
    return error;
  }

  /**
   * Instagram answers a logged-out session with an HTML document instead of
   * JSON. IGDMBot detects that as status 302 and asks the operator to sign in.
   */
  function isLoggedOutBody(body) {
    return typeof body === "string" && body.includes("html");
  }

  const storage = Object.freeze({
    async get(keys) {
      return chrome.storage.local.get(keys);
    },
    async getValue(key, fallback = undefined) {
      const result = await chrome.storage.local.get([key]);
      return result[key] === undefined ? fallback : result[key];
    },
    async set(value) {
      await chrome.storage.local.set(value);
    },
    async remove(keys) {
      await chrome.storage.local.remove(keys);
    }
  });

  /**
   * Storage schema version. Bump it together with an entry in MIGRATIONS, so an
   * install that already holds campaign history is upgraded instead of being
   * silently misread by code that expects a newer shape.
   */
  const SCHEMA_VERSION = 2;

  /** version -> async (storage) => void. Version 1 is the original layout. */
  const MIGRATIONS = Object.freeze({
    2: async (store) => {
      const bots = await store.getValue("bot_list", []);
      const patch = {};
      let botsChanged = false;
      for (const bot of bots) {
        if (!Object.prototype.hasOwnProperty.call(bot, "prefer_story_reply")) {
          bot.prefer_story_reply = false;
          botsChanged = true;
        }
      }
      if (botsChanged) patch.bot_list = bots;
      const work = await store.getValue("work_bot");
      if (work && !Object.prototype.hasOwnProperty.call(work, "prefer_story_reply")) {
        work.prefer_story_reply = false;
        patch.work_bot = work;
      }
      if (Object.keys(patch).length) await store.set(patch);
    }
  });

  /**
   * Keys that describe this browser session only and never travel in a backup:
   * a tab id is meaningless elsewhere, and the diagnostics log is disposable
   * debug output with its own export.
   */
  const VOLATILE_KEYS = Object.freeze(["permanent_tab_info", "diag_log"]);

  const BACKUP_FORMAT = "dm-hour-backup";

  async function migrateStorage() {
    const current = Number(await storage.getValue("schema_version", 0)) || 0;
    if (current === SCHEMA_VERSION) return { from: current, to: current, applied: [] };
    if (current > SCHEMA_VERSION) {
      throw new Error(`Storage was written by a newer build (v${current} > v${SCHEMA_VERSION})`);
    }
    const applied = [];
    for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
      const step = MIGRATIONS[version];
      if (step) { await step(storage); applied.push(version); }
    }
    await storage.set({ schema_version: SCHEMA_VERSION });
    return { from: current, to: SCHEMA_VERSION, applied };
  }

  /** Everything the extension knows, as one portable object. */
  async function exportSnapshot() {
    const state = await chrome.storage.local.get(null);
    for (const key of VOLATILE_KEYS) delete state[key];
    return {
      format: BACKUP_FORMAT,
      schema_version: Number(state.schema_version ?? SCHEMA_VERSION),
      exported_at: new Date().toISOString(),
      data: state
    };
  }

  /**
   * Replaces the whole store with a snapshot. Refuses anything that is not a
   * recognisable backup, or one written by a newer schema than this build can
   * read — restoring such a file would corrupt the pools it cannot interpret.
   */
  async function importSnapshot(payload) {
    if (!payload || payload.format !== BACKUP_FORMAT || !payload.data || typeof payload.data !== "object") {
      throw new Error("Це не файл резервної копії DM Hour");
    }
    const version = Number(payload.schema_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Копія зроблена новішою версією (v${version} > v${SCHEMA_VERSION})`);
    }
    const incoming = { ...payload.data };
    for (const key of VOLATILE_KEYS) delete incoming[key];
    await chrome.storage.local.clear();
    await chrome.storage.local.set(incoming);
    const result = await migrateStorage();
    return { keys: Object.keys(incoming).length, migrated: result };
  }

  /**
   * Diagnostics ring buffer. Off by default: when it is on, every HTTP exchange
   * and every raw MQTT frame is kept so a failed live send can be explained
   * from evidence instead of guesswork. Capped, and never stores the CSRF token.
   */
  const DIAG_LIMIT = 300;
  const DIAG_REDACTED = "«приховано»";
  const SENSITIVE_HEADERS = Object.freeze(["x-csrftoken", "cookie", "authorization"]);

  function redactHeaders(headers) {
    const safe = {};
    for (const [key, value] of Object.entries(headers || {})) {
      safe[key] = SENSITIVE_HEADERS.includes(key.toLowerCase()) ? DIAG_REDACTED : value;
    }
    return safe;
  }

  function truncate(value, limit = 4000) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    if (typeof text !== "string") return "";
    return text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit})` : text;
  }

  async function diagEnabled() {
    return Boolean(await storage.getValue("diag_enabled", false));
  }

  async function diagRecord(entry) {
    if (!(await diagEnabled())) return;
    const log = await storage.getValue("diag_log", []);
    log.push({ ts: new Date().toISOString(), ...entry });
    if (log.length > DIAG_LIMIT) log.splice(0, log.length - DIAG_LIMIT);
    await storage.set({ diag_log: log });
  }

  /** Hex dump of an MQTT frame, so the wire format can be compared byte by byte. */
  function hexDump(bytes, limit = 512) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const shown = Array.from(view.slice(0, limit), (b) => b.toString(16).padStart(2, "0")).join(" ");
    return view.length > limit ? `${shown} … (+${view.length - limit} байт)` : shown;
  }

  /**
   * Accepts what a person actually has in the clipboard — a profile URL, a
   * pasted path, an @handle — and returns the bare username. Instagram handles
   * only ever contain letters, digits, dots and underscores, so anything from
   * the first other character onwards is address, not name.
   */
  function normalizeUsername(value) {
    let text = String(value ?? "").trim();
    if (!text) return "";
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");   // protocol
    text = text.replace(/^(?:www\.)?instagram\.com\//i, ""); // host
    text = text.split(/[?#]/)[0];                            // query, fragment
    text = text.replace(/^@/, "");
    const match = text.match(/[A-Za-z0-9._]+/);
    return match ? match[0] : "";
  }

  /**
   * Whether this tab is the one the bot is driving and should therefore be
   * covered by the "keep this tab open" overlay. Content.js `addLeaveAlert`
   * makes the same comparison before it sets `isKeepingTab`.
   */
  function shouldKeepTabOpen({ tabId, permanentTabId, bot, busy }) {
    if (!tabId || !permanentTabId || tabId !== permanentTabId) return false;
    if (busy) return true;
    return Boolean(bot?.is_working && !bot?.is_complete);
  }

  function randomInt(minimum, maximum) {
    const min = Math.ceil(Number(minimum));
    const max = Math.floor(Number(maximum));
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  function todayKey(now = new Date()) {
    return [now.getFullYear(), now.getMonth() + 1, now.getDate()].join("-");
  }

  function uuid() {
    return crypto.randomUUID();
  }

  class SpintaxError extends Error {}

  function renderSpintax(source) {
    const text = String(source ?? "");
    function parse(start, nested) {
      const alternatives = [""];
      let index = start;
      while (index < text.length) {
        const char = text[index];
        if (char === "\\") {
          index += 1;
          alternatives[alternatives.length - 1] += text[index] ?? "";
        } else if (char === "{") {
          const child = parse(index + 1, true);
          alternatives[alternatives.length - 1] += child.value;
          index = child.index;
        } else if (char === "|" && nested) {
          alternatives.push("");
        } else if (char === "}" && nested) {
          return {
            value: alternatives[randomInt(0, alternatives.length - 1)],
            index
          };
        } else if (char === "}") {
          throw new SpintaxError(`Unexpected } at position ${index}`);
        } else {
          alternatives[alternatives.length - 1] += char;
        }
        index += 1;
      }
      if (nested) throw new SpintaxError(`Unclosed { at position ${start - 1}`);
      return { value: alternatives[0], index };
    }
    return parse(0, false).value;
  }

  /**
   * IGDMBot wraps `<Username>` and CSV-header substitution in independent
   * try/catch blocks: a bad placeholder degrades the message, it never aborts
   * the campaign. Mirrored here.
   */
  function replacePlaceholders(template, user, csvRow) {
    let result = String(template ?? "");
    try {
      if (user?.username) result = result.replaceAll("<Username>", String(user.username));
    } catch (_error) { /* keep the unsubstituted text, as the source does */ }
    try {
      if (csvRow && typeof csvRow === "object") {
        for (const [key, rawValue] of Object.entries(csvRow)) {
          result = result.replaceAll(`<${key}>`, rawValue == null ? "" : String(rawValue));
        }
      }
    } catch (_error) { /* same */ }
    return result;
  }

  function messagesForList(comments, listId) {
    return (comments || []).filter((item) => item.list_id === listId);
  }

  function prepareMessage(comments, listId, user, csvRow) {
    const candidates = messagesForList(comments, listId);
    if (!candidates.length) throw statusError(STATUS.EMPTY_DM_LIST);
    const selected = String(candidates[randomInt(0, candidates.length - 1)].content ?? "").trim();
    if (!selected) throw statusError(STATUS.EMPTY_DM_LIST);
    // A malformed Spintax expression must not end the run: fall back to the
    // literal template, which is what the operator typed.
    let rendered;
    try {
      rendered = renderSpintax(selected);
    } catch (error) {
      if (!(error instanceof SpintaxError)) throw error;
      rendered = selected;
    }
    return replacePlaceholders(rendered, user, csvRow);
  }

  function csvEscape(value) {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  const PAGE_TOKEN_KEYS = Object.freeze([
    "actorID", "ACCOUNT_ID", "USER_ID", "token", "fbid", "fb_dtsg", "lsd",
    "csrf_token", "ig_user_id", "instagramUserId", "POLARIS_IG_USER_ID",
    "interop_messaging_user_fbid", "eimu", "appId", "app_id", "spin_r", "spin_b", "spin_t",
    "haste_session", "hsi", "rev", "server_revision", "client_revision", "pk",
    "ds_user_id", "viewerId", "viewer_id", "userId", "user_id", "instagramUserFbid",
    "messenger_fbid", "av", "async_get_token"
  ]);
  const PAGE_TOKEN_KEY_RE = new RegExp(`^(${PAGE_TOKEN_KEYS.join("|")})$`, "i");
  const SECRET_KEY_RE = /sessionid|session_id|password|cookie|authorization/i;

  function sliceJsonObject(source, start) {
    let depth = 0, inStr = false, escape = false;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (inStr) {
        if (escape) escape = false;
        else if (char === "\\") escape = true;
        else if (char === "\"") inStr = false;
        continue;
      }
      if (char === "\"") inStr = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return null;
  }

  function extractDefineModules(source) {
    const modules = {};
    const names = [];
    let index = 0;
    while (index < source.length) {
      const start = source.indexOf('["', index);
      if (start < 0) break;
      const head = source.slice(start, start + 240).match(/^\["([A-Za-z0-9_./]+)",\s*\[[^\]]*\]\s*,\s*/);
      if (!head || source[start + head[0].length] !== "{") {
        index = start + 2;
        continue;
      }
      const name = head[1];
      const objStart = start + head[0].length;
      const raw = sliceJsonObject(source, objStart);
      names.push(name);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (modules[name] === undefined) modules[name] = parsed;
        } catch (_error) { /* skip malformed define() payload */ }
        index = objStart + raw.length;
      } else index = start + 2;
    }
    return { modules, names };
  }

  function harvestKeys(value, bag, depth = 0, path = "$") {
    if (depth > 8 || bag.length > 500 || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 40).forEach((item, i) => harvestKeys(item, bag, depth + 1, `${path}[${i}]`));
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) continue;
      if (PAGE_TOKEN_KEY_RE.test(key) && ["string", "number", "boolean"].includes(typeof nested)) {
        bag.push({ key, value: nested, path: `${path}.${key}` });
      }
      if (nested && typeof nested === "object") harvestKeys(nested, bag, depth + 1, `${path}.${key}`);
    }
  }

  function firstHarvest(bag, key) {
    const hit = bag.find((item) => item.key.toLowerCase() === key.toLowerCase());
    return hit ? hit.value : null;
  }

  function jazoestFrom(token) {
    if (!token) return null;
    let sum = 0;
    for (let i = 0; i < token.length; i += 1) sum += token.charCodeAt(i);
    return `2${sum}`;
  }

  function compactModule(value) {
    try {
      const raw = JSON.stringify(value);
      if (raw.length <= 8000) return value;
      return { _truncated: true, bytes: raw.length, keys: Object.keys(value || {}) };
    } catch (_error) {
      return { _unserializable: true };
    }
  }

  /**
   * Pull every Facebook/Instagram `define(["Name",[],{...}])` blob and every
   * well-known identity/token key out of a page HTML/script bundle. The result
   * is the evidence pack for GraphQL `av` / `fb_dtsg` / `lsd`, not a guess from
   * `ds_user_id`.
   */
  function extractInstagramPageContext(source) {
    const text = String(source || "");
    const { modules, names } = extractDefineModules(text);
    const harvested = [];
    for (const [name, body] of Object.entries(modules)) harvestKeys(body, harvested, 0, name);
    const dtsgModule = modules.DTSGInitialData || modules.DTSGInitData || {};
    const lsdModule = modules.LSD || {};
    const userModule = modules.CurrentUserInitialData || {};
    const relay = modules.RelayAPIConfigDefaults || {};
    const site = modules.SiteData || {};
    const dtsg = dtsgModule.token || null;
    const lsd = lsdModule.token || firstHarvest(harvested, "lsd") || null;
    const av = relay.actorID || firstHarvest(harvested, "actorID") || userModule.ACCOUNT_ID || firstHarvest(harvested, "ACCOUNT_ID") || null;
    const ig_user_id = userModule.USER_ID || firstHarvest(harvested, "USER_ID") || firstHarvest(harvested, "ig_user_id") || null;
    const tokens = {
      fb_dtsg: dtsg,
      lsd,
      av: av ? String(av) : null,
      av_source: relay.actorID ? "RelayAPIConfigDefaults.actorID" : firstHarvest(harvested, "actorID") ? "harvest.actorID" : userModule.ACCOUNT_ID ? "CurrentUserInitialData.ACCOUNT_ID" : null,
      ig_user_id: ig_user_id ? String(ig_user_id) : null,
      account_id: userModule.ACCOUNT_ID ? String(userModule.ACCOUNT_ID) : null,
      jazoest: jazoestFrom(dtsg),
      async_get_token: dtsgModule.async_get_token || null,
      spin_r: site.spin_r || firstHarvest(harvested, "spin_r"),
      spin_b: site.spin_b || firstHarvest(harvested, "spin_b"),
      spin_t: site.spin_t || firstHarvest(harvested, "spin_t"),
      haste_session: site.haste_session || firstHarvest(harvested, "haste_session"),
      hsi: firstHarvest(harvested, "hsi"),
      rev: site.client_revision || site.server_revision || firstHarvest(harvested, "client_revision") || firstHarvest(harvested, "rev"),
      push_phase: site.push_phase || null
    };
    if (!tokens.fb_dtsg && modules.DTSGInitData?.token) tokens.fb_dtsg = modules.DTSGInitData.token;
    if (!tokens.jazoest) tokens.jazoest = jazoestFrom(tokens.fb_dtsg);
    const compact = {};
    for (const [name, body] of Object.entries(modules)) compact[name] = compactModule(body);
    return {
      stats: {
        bytes: text.length,
        module_count: names.length,
        unique_modules: Object.keys(modules).length,
        harvested: harvested.length
      },
      module_names: names,
      modules: compact,
      harvested,
      tokens
    };
  }

  function recordsToCsv(records) {
    if (!records?.length) return "";
    const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
    return [
      headers.map(csvEscape).join(","),
      ...records.map((record) => headers.map((key) => csvEscape(record[key])).join(","))
    ].join("\r\n");
  }

  globalThis.DMHCore = Object.freeze({
    EVENT,
    PORT,
    APP,
    ERROR_DEFAULTS,
    SCHEMA_VERSION,
    MIGRATIONS,
    BACKUP_FORMAT,
    VOLATILE_KEYS,
    migrateStorage,
    exportSnapshot,
    importSnapshot,
    DIAG_LIMIT,
    diagEnabled,
    diagRecord,
    redactHeaders,
    truncate,
    hexDump,
    STATUS,
    STATUS_MESSAGE,
    statusError,
    isLoggedOutBody,
    storage,
    randomInt,
    todayKey,
    uuid,
    SpintaxError,
    renderSpintax,
    replacePlaceholders,
    messagesForList,
    normalizeUsername,
    shouldKeepTabOpen,
    prepareMessage,
    recordsToCsv,
    extractInstagramPageContext
  });
})();
