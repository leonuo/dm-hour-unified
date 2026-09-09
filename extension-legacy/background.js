const DEFAULT_SETTINGS = {
  backendUrl: "http://127.0.0.1:8765",
  apiToken: "",
  armed: false
};

let busy = false;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(existing);
  chrome.alarms.create("dmh-poll", { periodInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dmh-poll") pollForJob();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DMH_POLL_NOW") {
    pollForJob().then(sendResponse);
    return true;
  }
});

async function settings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

async function api(path, options = {}) {
  const config = await settings();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (config.apiToken) headers["X-DM-Hour-Token"] = config.apiToken;
  const response = await fetch(`${config.backendUrl}${path}`, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function getCookie(name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: "https://www.instagram.com", name }, (cookie) => {
      resolve(cookie?.value || null);
    });
  });
}

async function getChromeInstagramSession() {
  const [dsUserId, csrfToken] = await Promise.all([
    getCookie("ds_user_id"),
    getCookie("csrftoken")
  ]);
  if (!dsUserId || !csrfToken) {
    throw new Error("Instagram Chrome session is missing ds_user_id or csrftoken");
  }
  return { ds_user_id: dsUserId, csrftoken: csrfToken };
}

async function getInstagramTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  if (!tabs.length) {
    throw new Error("Open an authenticated https://www.instagram.com tab first");
  }
  return tabs.find((tab) => tab.active) || tabs[0];
}

async function pollForJob() {
  if (busy) return { busy: true };
  const config = await settings();
  if (!config.armed) return { armed: false };
  busy = true;
  try {
    // Validate the current Chrome session before claiming a persistent queue job.
    const [session, tab] = await Promise.all([
      getChromeInstagramSession(),
      getInstagramTab()
    ]);
    const { job } = await api("/api/jobs/next?transport=web_mqtt");
    if (!job) return { job: null };

    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, {
        type: "DMH_EXECUTE_WEB_MQTT_JOB",
        job,
        session
      });
      if (!result) throw new Error("Instagram content script returned no result");
    } catch (error) {
      result = { success: false, error: `${error.name}: ${error.message}` };
    }

    await api(`/api/jobs/${job.id}/result`, {
      method: "POST",
      body: JSON.stringify(result)
    });
    await chrome.storage.local.set({
      lastResult: {
        jobId: job.id,
        username: job.username,
        success: Boolean(result.success),
        http_status: result.http_status || null,
        error: result.error || null,
        at: new Date().toISOString()
      }
    });
    return { job: { id: job.id, username: job.username }, result };
  } catch (error) {
    const safeError = `${error.name}: ${error.message}`;
    await chrome.storage.local.set({
      lastResult: { success: false, error: safeError, at: new Date().toISOString() }
    });
    return { error: safeError };
  } finally {
    busy = false;
  }
}
