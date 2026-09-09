(() => {
  "use strict";
  const { EVENT, APP, ERROR_DEFAULTS, storage, randomInt, todayKey, uuid, recordsToCsv, exportSnapshot, importSnapshot, normalizeUsername } = DMHCore;
  const $ = (selector) => document.querySelector(selector);
  let state = {}, pendingCsv = null;

  document.addEventListener("DOMContentLoaded", boot);

  async function boot() {
    bind(); await refresh(); showView("dashboard");
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === EVENT.TEST_DM_RESULT) return showTestResult(message.data);
      if (message?.type === EVENT.DUMP_PAGE_CONTEXT_RESULT) return showDumpResult(message.data);
      if ([EVENT.RELOAD_WORK_BOT_HOME_MSG, EVENT.SKIP_CURRENT_USER_RESPONSE].includes(message?.type)) refresh();
    });
  }

  function bind() {
    document.querySelectorAll("nav button").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
    $("#new-bot").addEventListener("click", () => openBotForm());
    $("#cancel-bot").addEventListener("click", () => $("#bot-form").classList.add("hidden"));
    $("#bot-type").addEventListener("change", toggleBotFields);
    $("#bulk-target").addEventListener("change", toggleBotFields);
    $("#bot-form").addEventListener("submit", saveBot);
    $("#recipient-csv").addEventListener("change", loadRecipientCsv);
    $("#list-form").addEventListener("submit", addList);
    document.addEventListener("click", delegatedClick);
    document.querySelectorAll("[data-import]").forEach((input) => input.addEventListener("change", importHistory));
    $("#backup-export").addEventListener("click", () => void exportBackup());
    $("#backup-import").addEventListener("change", importBackup);
    $("#test-form").addEventListener("submit", sendTest);
    $("#dump-page").addEventListener("click", dumpPageTokens);
    $("#diag-toggle").addEventListener("change", async (event) => {
      await storage.set({ diag_enabled: event.target.checked });
      toast(event.target.checked ? "Діагностика увімкнена" : "Діагностика вимкнена");
    });
    $("#capture-toggle").addEventListener("change", async (event) => {
      // Capture needs the diagnostics buffer, so switching it on switches that on too.
      const on = event.target.checked;
      await storage.set(on ? { capture_enabled: true, diag_enabled: true } : { capture_enabled: false });
      $("#diag-toggle").checked = on || $("#diag-toggle").checked;
      toast(on ? "Знімаю трафік — зроби дію в Instagram" : "Знімання вимкнено");
    });
    $("#diag-export").addEventListener("click", () => void exportDiag());
    $("#diag-refresh").addEventListener("click", () => void renderDiagLog());
    $("#diag-clear").addEventListener("click", async () => { await storage.remove("diag_log"); await renderDiagLog(); });
  }

  async function refresh() {
    state = await storage.get(["bot_list", "work_bot", "comment_list", "comments", "dm_message_history_pool", "dm_user_history_pool"]);
    state.bot_list ||= []; state.comment_list ||= []; state.comments ||= [];
    state.dm_message_history_pool ||= []; state.dm_user_history_pool ||= [];
    renderDashboard(); renderBots(); renderLists(); renderHistory(); await renderErrors(); await renderBackupInfo(); await renderDiagLog(); fillListSelects();
  }

  function showView(name) {
    document.querySelectorAll(".view").forEach((view) => view.classList.add("hidden"));
    $(`#view-${name}`).classList.remove("hidden");
  }

  function renderDashboard() {
    const bot = state.work_bot;
    $("#runtime-status").textContent = bot ? bot.is_complete ? "Завершено" : bot.is_working ? "Працює" : "Пауза" : "Не запущено";
    if (!bot) { $("#view-dashboard").innerHTML = '<div class="card">Активного бота немає. Відкрий «Боти» та натисни Start.</div>'; return; }
    const target = bot.bot_type === 0 ? bot.day_dm_num : bot.bulk_dm_target_type === 2 ? "queue" : bot.bulk_limit_max_users_count;
    $("#view-dashboard").innerHTML = `<div class="card"><h2>${escapeHtml(bot.bot_name)}</h2><div>Режим: ${bot.bot_type === 0 ? "DM by Monitor" : "DM by Bulk"}${bot.prefer_story_reply ? " · сторіс → Direct" : ""}</div><div>DM: ${bot.dm_num || 0} / ${target}</div><div>Інтервал: ${bot.range_interval.join("–")} хв</div>${bot.status_code && bot.status_code !== 200 ? `<p class="error">${bot.status_code}: ${escapeHtml(bot.status_data_msg || "")}</p>` : ""}<div class="row"><button data-action="${bot.is_working ? "pause" : "resume"}">${bot.is_working ? "Pause" : "Continue"}</button><button data-action="skip">Skip user</button><button data-action="stop">Stop</button></div></div>`;
  }

  function renderBots() {
    $("#bot-list").innerHTML = state.bot_list.map((bot) => `<div class="bot"><strong>${escapeHtml(bot.bot_name)}</strong><div class="muted">${bot.bot_type === 0 ? "DM by Monitor" : "DM by Bulk"} · ${bot.range_interval.join("–")} хв</div><div class="actions"><button data-start="${bot.id}">Start</button><button data-edit="${bot.id}">Edit</button><button data-delete-bot="${bot.id}">Delete</button></div></div>`).join("") || '<div class="card">Ботів немає.</div>';
  }

  function fillListSelects() {
    const options = state.comment_list.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
    ["#follower-list", "#liker-list", "#bulk-list"].forEach((id) => { $(id).innerHTML = options; });
  }

  function openBotForm(bot = null) {
    pendingCsv = null; $("#recipient-csv").value = ""; $("#csv-status").textContent = "";
    $("#bot-id").value = bot?.id || ""; $("#bot-name").value = bot?.bot_name || ""; $("#bot-type").value = bot?.bot_type ?? 0;
    $("#range-min").value = bot?.range_interval?.[0] ?? 4; $("#range-max").value = bot?.range_interval?.[1] ?? 12;
    $("#group-min").value = bot?.group_range_interval?.[0] ?? 10; $("#group-max").value = bot?.group_range_interval?.[1] ?? 20; $("#group-size").value = bot?.group_message_num ?? 10;
    $("#monitor-followers").checked = bot?.enable_when_get_new_follower_by_monitor ?? true; $("#monitor-likers").checked = bot?.enable_when_get_new_like_by_monitor ?? true;
    $("#monitor-lookback").checked = bot?.enable_skip_day_before_by_monitor ?? true; $("#lookback-days").value = bot?.skip_day_before_by_monitor_num ?? 1;
    $("#daily-min").value = bot?.dm_per_day_by_monitor_nums?.[0] ?? 10; $("#daily-max").value = bot?.dm_per_day_by_monitor_nums?.[1] ?? 20;
    $("#bulk-target").value = bot?.bulk_dm_target_type ?? 0; $("#target-account").value = bot?.bulk_dm_target_type === 2 ? "" : bot?.bulk_dm_target_type_value || "";
    $("#custom-users").value = bot?.bulk_dm_target_type === 2 && bot?.send_message_type !== 1 ? bot.bulk_dm_target_type_value || "" : "";
    if (bot?.send_message_type === 1) { pendingCsv = bot.bulk_dm_target_type_value; $("#csv-status").textContent = `${pendingCsv.length} CSV rows`; }
    $("#bulk-limit").value = bot?.bulk_limit_max_users_count ?? 100; $("#allow-previous").checked = Boolean(bot?.can_dm_to_privious_user);
    $("#prefer-story-reply").checked = Boolean(bot?.prefer_story_reply);
    fillListSelects();
    if (bot) { $("#follower-list").value = bot.new_follower_dm_list_id || ""; $("#liker-list").value = bot.new_like_dm_list_id || ""; $("#bulk-list").value = bot.bulk_dm_list_id || ""; }
    toggleBotFields(); $("#bot-form").classList.remove("hidden");
  }

  function toggleBotFields() {
    const monitor = Number($("#bot-type").value) === 0, custom = Number($("#bulk-target").value) === 2;
    $("#monitor-fields").classList.toggle("hidden", !monitor); $("#bulk-fields").classList.toggle("hidden", monitor);
    $("#custom-users-fields").classList.toggle("hidden", !custom); $("#target-account-label").classList.toggle("hidden", custom);
  }

  async function saveBot(event) {
    event.preventDefault();
    const type = Number($("#bot-type").value), id = $("#bot-id").value || uuid();
    const common = { id, bot_name: $("#bot-name").value.trim(), bot_type: type, range_interval: numbers("#range-min", "#range-max"), group_range_interval: numbers("#group-min", "#group-max"), group_message_num: Number($("#group-size").value), prefer_story_reply: $("#prefer-story-reply").checked };
    let bot;
    if (type === 0) bot = { ...common, enable_when_get_new_follower_by_monitor: $("#monitor-followers").checked, new_follower_dm_list_id: $("#follower-list").value, enable_when_get_new_like_by_monitor: $("#monitor-likers").checked, new_like_dm_list_id: $("#liker-list").value, enable_skip_day_before_by_monitor: $("#monitor-lookback").checked, skip_day_before_by_monitor_num: Number($("#lookback-days").value), dm_per_day_by_monitor_nums: numbers("#daily-min", "#daily-max") };
    else {
      const target = Number($("#bulk-target").value), useCsv = target === 2 && pendingCsv?.length;
      const value = target === 2 ? useCsv ? pendingCsv : normalizeCustom($("#custom-users").value) : $("#target-account").value.trim();
      if (!value || Array.isArray(value) && !value.length) return toast("Заповни одержувачів");
      bot = { ...common, bulk_dm_target_type: target, send_message_type: useCsv ? 1 : 0, bulk_dm_target_type_value: value, bulk_limit_max_users_count: Number($("#bulk-limit").value), bulk_dm_list_id: $("#bulk-list").value, can_dm_to_privious_user: $("#allow-previous").checked };
    }
    const index = state.bot_list.findIndex((item) => item.id === id); index >= 0 ? state.bot_list.splice(index, 1, bot) : state.bot_list.push(bot);
    await storage.set({ bot_list: state.bot_list }); $("#bot-form").classList.add("hidden"); await refresh();
  }

  async function loadRecipientCsv(event) {
    const file = event.target.files?.[0]; pendingCsv = null;
    if (!file) return;
    if (file.size > 10485760) return toast("CSV більший за 10 MiB");
    const rows = parseCsv(await file.text());
    if (!rows.length || !Object.keys(rows[0]).some((key) => key.trim() === "Username")) return toast("CSV повинен містити колонку Username");
    if (rows.length > 10000) return toast("CSV містить більше 10 000 рядків");
    pendingCsv = rows.map((row) => { const exact = Object.keys(row).find((key) => key.trim() === "Username"); return { ...row, Username: String(row[exact] || "").trim() }; }).filter((row) => row.Username);
    $("#csv-status").textContent = `${pendingCsv.length} CSV rows`;
  }

  async function startBot(id) {
    const bot = structuredClone(state.bot_list.find((item) => item.id === id)); if (!bot) return;
    Object.assign(bot, { is_working: true, is_complete: false, dm_num: 0, status_code: 200 });
    const patch = { work_bot: bot, dm_custom_dup_users_history_bot: [], bulk_runtime_state: {} };
    if (bot.bot_type === 0) { bot.day_dm_num = randomInt(...bot.dm_per_day_by_monitor_nums); patch.monitor_store_date = todayKey(); }
    if (bot.bot_type === 1 && bot.bulk_dm_target_type === 2) patch.dm_custom_queue_bot_pool = bot.send_message_type === 1 ? structuredClone(bot.bulk_dm_target_type_value) : normalizeCustom(bot.bulk_dm_target_type_value).split(",");
    await storage.set(patch); await chrome.alarms.clear(APP.ALARM.MONITOR); await chrome.alarms.clear(APP.ALARM.NEXT_DM);
    await chrome.runtime.sendMessage({ type: EVENT.CHECK_TAB_SWITCH_BOT, data: {} }); await refresh(); showView("dashboard");
  }

  async function runtimeAction(action) {
    const bot = await storage.getValue("work_bot"); if (!bot) return;
    if (action === "pause") { bot.is_working = false; await chrome.alarms.clear(APP.ALARM.MONITOR); await chrome.alarms.clear(APP.ALARM.NEXT_DM); await storage.set({ work_bot: bot }); }
    if (action === "resume") { bot.is_working = true; bot.status_code = 200; await storage.set({ work_bot: bot }); await chrome.runtime.sendMessage({ type: EVENT.CHECK_TAB_SWITCH_BOT, data: {} }); }
    if (action === "stop") { await storage.remove(["work_bot", "bulk_runtime_state"]); await chrome.runtime.sendMessage({ type: EVENT.CHECK_TAB_STOP_BOT, data: {} }); }
    if (action === "skip") await chrome.runtime.sendMessage({ type: EVENT.SKIP_CURRENT_USER, data: {} });
    await refresh();
  }

  async function addList(event) {
    event.preventDefault(); const id = uuid();
    state.comment_list.push({ id, name: $("#list-name").value.trim() }); state.comments.push({ id: uuid(), list_id: id, content: $("#list-message").value.trim() });
    await storage.set({ comment_list: state.comment_list, comments: state.comments }); event.target.reset(); await refresh();
  }

  function renderLists() {
    $("#dm-lists").innerHTML = state.comment_list.map((list) => `<div class="card"><strong>${escapeHtml(list.name)}</strong><button data-rename-list="${list.id}">Rename</button>${state.comments.filter((item) => item.list_id === list.id).map((item) => `<p>${escapeHtml(item.content)} <button data-edit-message="${item.id}">Edit</button><button data-delete-message="${item.id}">×</button></p>`).join("")}<button data-add-message="${list.id}">+ Message</button><button data-delete-list="${list.id}">Delete list</button></div>`).join("");
  }

  function renderHistory() {
    const draw = (id, records) => { $(id).innerHTML = `<div class="history">${records.slice().reverse().map((r) => `<div><strong>@${escapeHtml(r.username || "")}</strong>${r.via === "story_reply" ? " · сторіс" : ""} ${escapeHtml(r.text || "")}</div>`).join("") || "Порожньо"}</div>`; };
    draw("#message-history", state.dm_message_history_pool); draw("#user-history", state.dm_user_history_pool);
  }

  async function renderErrors() {
    const keys = Object.keys(ERROR_DEFAULTS), saved = await storage.get(keys.flatMap((code) => [`enable_handle_status_${code}`, `batch_interval_nums_${code}`]));
    $("#error-settings").innerHTML = keys.map((code) => { const d = ERROR_DEFAULTS[code], r = saved[`batch_interval_nums_${code}`] || d.batch_interval_nums; return `<div class="error-row"><label><input data-error-enabled="${code}" type="checkbox" ${saved[`enable_handle_status_${code}`] ? "checked" : ""}> HTTP ${code}</label><div class="grid2"><input data-error-min="${code}" type="number" value="${r[0]}"><input data-error-max="${code}" type="number" value="${r[1]}"></div></div>`; }).join("");
  }

  async function delegatedClick(event) {
    const b = event.target.closest("button"); if (!b) return;
    if (b.dataset.start) return startBot(b.dataset.start);
    if (b.dataset.edit) return openBotForm(state.bot_list.find((x) => x.id === b.dataset.edit));
    if (b.dataset.deleteBot) { state.bot_list = state.bot_list.filter((x) => x.id !== b.dataset.deleteBot); await storage.set({ bot_list: state.bot_list }); return refresh(); }
    if (b.dataset.action) return runtimeAction(b.dataset.action);
    if (b.dataset.deleteList) { state.comment_list = state.comment_list.filter((x) => x.id !== b.dataset.deleteList); state.comments = state.comments.filter((x) => x.list_id !== b.dataset.deleteList); await storage.set({ comment_list: state.comment_list, comments: state.comments }); return refresh(); }
    if (b.dataset.renameList) { const item = state.comment_list.find((x) => x.id === b.dataset.renameList), value = prompt("DM List name", item.name); if (value?.trim()) { item.name = value.trim(); await storage.set({ comment_list: state.comment_list }); await refresh(); } return; }
    if (b.dataset.addMessage) { const value = prompt("Message template"); if (value?.trim()) { state.comments.push({ id: uuid(), list_id: b.dataset.addMessage, content: value.trim() }); await storage.set({ comments: state.comments }); await refresh(); } return; }
    if (b.dataset.editMessage) { const item = state.comments.find((x) => x.id === b.dataset.editMessage), value = prompt("Message template", item.content); if (value?.trim()) { item.content = value.trim(); await storage.set({ comments: state.comments }); await refresh(); } return; }
    if (b.dataset.deleteMessage) { state.comments = state.comments.filter((x) => x.id !== b.dataset.deleteMessage); await storage.set({ comments: state.comments }); return refresh(); }
    if (b.dataset.export) return download(`${b.dataset.export}.csv`, recordsToCsv(state[b.dataset.export] || []));
    if (b.dataset.clear) { await storage.set({ [b.dataset.clear]: [] }); return refresh(); }
  }

  async function importHistory(event) {
    const key = event.target.dataset.import, rows = parseCsv(await event.target.files[0].text());
    await storage.set({ [key]: key === "dm_message_history_pool" ? rows : [...(state[key] || []), ...rows] }); await refresh();
  }

  document.addEventListener("change", async (event) => {
    const code = event.target.dataset.errorEnabled;
    if (code) await storage.set({ [`enable_handle_status_${code}`]: event.target.checked });
    const intervalCode = event.target.dataset.errorMin || event.target.dataset.errorMax;
    if (intervalCode) await storage.set({ [`batch_interval_nums_${intervalCode}`]: [Number(document.querySelector(`[data-error-min="${intervalCode}"]`).value), Number(document.querySelector(`[data-error-max="${intervalCode}"]`).value)] });
  });

  function parseCsv(text) {
    const rows = []; let row = [], cell = "", quoted = false;
    for (let i = 0; i <= text.length; i++) { const c = text[i] ?? "\n"; if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = !quoted; else if (!quoted && c === ",") { row.push(cell); cell = ""; } else if (!quoted && (c === "\n" || c === "\r" && text[i + 1] !== "\n")) { row.push(cell); if (row.some((x) => x !== "")) rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c; }
    const headers = (rows.shift() || []).map((x) => x.replace(/^\uFEFF/, "")); return rows.map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] || ""])));
  }
  function normalizeCustom(value) { return String(value || "").split(/[\r\n,，]+/).map((x) => x.trim()).filter(Boolean).join(","); }
  function numbers(a, b) { const x = Number($(a).value), y = Number($(b).value); return [Math.min(x, y), Math.max(x, y)]; }
  function download(name, text, mime = "text/csv", bom = true) {
    const parts = bom ? ["\uFEFF", text] : [text];
    const url = URL.createObjectURL(new Blob(parts, { type: mime }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  }

  async function sendTest(event) {
    event.preventDefault();
    // A pasted profile link is the common case, so clean it and show the person
    // the exact handle the confirmation is about.
    const username = normalizeUsername($("#test-username").value);
    $("#test-username").value = username;
    const text = $("#test-text").value.trim();
    if (!username || !text) return toast("Заповни username і текст");
    if (!confirm(`Надіслати справжнє повідомлення до @${username}?`)) return;
    $("#test-send").disabled = true;
    $("#test-result").textContent = "Надсилаю…";
    try {
      await chrome.runtime.sendMessage({ type: EVENT.SEND_TEST_DM, data: { username, text, prefer_story_reply: $("#test-story").checked } });
    } catch (error) {
      $("#test-send").disabled = false;
      $("#test-result").textContent = `Не вдалося почати: ${error.message}`;
    }
  }

  function showTestResult(payload) {
    $("#test-send").disabled = false;
    if (!payload?.ok) {
      $("#test-result").textContent = `Помилка: ${payload?.error || "невідома"}`;
    } else if (payload.data?.via === "story_reply") {
      $("#test-result").textContent = `Доставлено через сторіс @${payload.data.username} (mid ${payload.data.message_id || "ok"})`;
    } else {
      const extra = payload.data?.story_fallback ? ` · сторіс: ${payload.data.story_fallback}` : "";
      $("#test-result").textContent = `Доставлено Direct @${payload.data?.username} (тред ${payload.data?.thread_id})${extra}`;
    }
    void renderDiagLog();
  }

  async function dumpPageTokens() {
    $("#dump-page").disabled = true;
    $("#test-result").textContent = "Знімаю токени зі вкладки Instagram… (до 3 с на handshake)";
    try {
      await chrome.runtime.sendMessage({ type: EVENT.DUMP_PAGE_CONTEXT });
    } catch (error) {
      $("#dump-page").disabled = false;
      $("#test-result").textContent = `Не вдалося зняти: ${error.message}`;
    }
  }

  function showDumpResult(payload) {
    $("#dump-page").disabled = false;
    if (!payload?.ok) {
      $("#test-result").textContent = `Токени: ${payload?.error || "невідома помилка"}`;
      return;
    }
    const tokens = payload.data?.tokens || {};
    const stats = payload.data?.stats || {};
    $("#test-result").textContent = `Токени: av=${tokens.av ? "так" : "НІ"} (${tokens.av_source || "—"}) · dtsg=${tokens.fb_dtsg ? "так" : "НІ"} · lsd=${tokens.lsd ? "так" : "НІ"} · модулів ${stats.unique_modules || 0}`;
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    download(`dm-hour-page-context-${stamp}.json`, JSON.stringify(payload.data, null, 2), "application/json", false);
    toast("JSON з токенами збережено");
    void renderDiagLog();
  }

  async function renderDiagLog() {
    const [enabled, log] = await Promise.all([
      storage.getValue("diag_enabled", false),
      storage.getValue("diag_log", [])
    ]);
    $("#diag-toggle").checked = Boolean(enabled);
    $("#capture-toggle").checked = Boolean(await storage.getValue("capture_enabled", false));
    if (!log.length) { $("#diag-log").innerHTML = '<div class="card muted">Журнал порожній.</div>'; return; }
    $("#diag-log").innerHTML = [...log].reverse().map((entry) => {
      const detail = typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail, null, 1);
      const arrow = entry.direction === "out" ? "→" : entry.direction === "in" ? "←" : "•";
      return `<div class="card"><div class="muted">${escapeHtml(entry.ts?.slice(11, 19) || "")} ${arrow} ${escapeHtml(entry.kind || "")} · ${escapeHtml(entry.label || "")}</div><pre>${escapeHtml(detail || "")}</pre></div>`;
    }).join("");
  }

  async function exportDiag() {
    const log = await storage.getValue("diag_log", []);
    if (!log.length) return toast("Журнал порожній");
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    download(`dm-hour-diag-${stamp}.json`, JSON.stringify(log, null, 2), "application/json", false);
  }

  async function exportBackup() {
    const snapshot = await exportSnapshot();
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    download(`dm-hour-backup-${stamp}.json`, JSON.stringify(snapshot, null, 2), "application/json", false);
    toast("\u041A\u043E\u043F\u0456\u044E \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u043E");
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    // Restoring under a running bot would race the content script's own writes.
    if (state.work_bot?.is_working) return toast("\u0421\u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u0437\u0443\u043F\u0438\u043D\u0438 \u0431\u043E\u0442\u0430");
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch (_error) {
      return toast("\u0424\u0430\u0439\u043B \u043D\u0435 \u0447\u0438\u0442\u0430\u0454\u0442\u044C\u0441\u044F \u044F\u043A JSON");
    }
    if (!confirm("\u0412\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F \u0437\u0430\u043C\u0456\u043D\u0438\u0442\u044C \u0443\u0441\u0456 \u043F\u043E\u0442\u043E\u0447\u043D\u0456 \u0434\u0430\u043D\u0456. \u041F\u0440\u043E\u0434\u043E\u0432\u0436\u0438\u0442\u0438?")) return;
    try {
      const result = await importSnapshot(payload);
      await refresh();
      toast(`\u0412\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043E ${result.keys} \u0437\u0430\u043F\u0438\u0441\u0456\u0432`);
    } catch (error) {
      toast(error.message);
    }
  }

  async function renderBackupInfo() {
    const version = await storage.getValue("schema_version", 0);
    const counts = [
      ["\u0431\u043E\u0442\u0456\u0432", state.bot_list.length],
      ["\u0441\u043F\u0438\u0441\u043A\u0456\u0432", state.comment_list.length],
      ["\u043F\u043E\u0432\u0456\u0434\u043E\u043C\u043B\u0435\u043D\u044C", state.comments.length],
      ["\u0432 \u0456\u0441\u0442\u043E\u0440\u0456\u0457", state.dm_message_history_pool.length]
    ].map(([label, value]) => `${value} ${label}`).join(" \u00B7 ");
    $("#backup-info").textContent = `\u0421\u0445\u0435\u043C\u0430 \u0441\u0445\u043E\u0432\u0438\u0449\u0430 v${version || "\u2014"} \u00B7 ${counts}`;
  }
  function toast(message) { const t = $("#toast"); t.textContent = message; t.style.display = "block"; setTimeout(() => t.style.display = "none", 3000); }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
})();
