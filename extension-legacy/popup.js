const defaults = {
  backendUrl: "http://127.0.0.1:8765",
  apiToken: "",
  armed: false,
  lastResult: null
};

const byId = (id) => document.getElementById(id);

async function load() {
  const config = await chrome.storage.local.get(defaults);
  byId("backendUrl").value = config.backendUrl;
  byId("apiToken").value = config.apiToken;
  byId("armed").checked = config.armed;
  if (config.lastResult) byId("result").textContent = JSON.stringify(config.lastResult, null, 2);
  await health();
}

async function request(path, options = {}) {
  const config = await chrome.storage.local.get(defaults);
  const headers = { "Content-Type": "application/json" };
  if (config.apiToken) headers["X-DM-Hour-Token"] = config.apiToken;
  const response = await fetch(`${config.backendUrl}${path}`, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function health() {
  const element = byId("connection");
  try {
    const payload = await request("/api/health");
    element.textContent = `Підключено: ${payload.service} ${payload.version}`;
    element.className = "status ok";
  } catch (error) {
    element.textContent = `Немає з’єднання: ${error.message}`;
    element.className = "status error";
  }
}

byId("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    backendUrl: byId("backendUrl").value.replace(/\/$/, ""),
    apiToken: byId("apiToken").value,
    armed: byId("armed").checked
  });
  await health();
});

byId("poll").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "DMH_POLL_NOW" });
  byId("result").textContent = JSON.stringify(response, null, 2);
});

byId("stop").addEventListener("click", async () => {
  await request("/api/emergency-stop", {
    method: "POST",
    body: JSON.stringify({ enabled: true })
  });
  await chrome.storage.local.set({ armed: false });
  byId("armed").checked = false;
  byId("result").textContent = "Emergency stop увімкнено.";
});

load();

