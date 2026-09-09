const tokenInput = document.getElementById("token");
tokenInput.value = localStorage.getItem("dmhToken") || "";

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (tokenInput.value) headers["X-DM-Hour-Token"] = tokenInput.value;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function refresh() {
  localStorage.setItem("dmhToken", tokenInput.value);
  const health = document.getElementById("health");
  try {
    const payload = await request("/api/health");
    health.textContent = `${payload.service} ${payload.version}`;
    health.className = "pill ok";
    const status = await request("/api/status");
    if (status.emergency_stop) {
      health.textContent += " · STOP";
      health.className = "pill err";
    }
    renderCampaigns(status.campaigns || []);
    const history = await request("/api/history?limit=20");
    document.getElementById("history").textContent = JSON.stringify(history.items, null, 2);
  } catch (error) {
    health.textContent = error.message;
    health.className = "pill err";
  }
}

function renderCampaigns(campaigns) {
  const body = document.getElementById("campaigns");
  body.innerHTML = "";
  for (const campaign of campaigns) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${campaign.id}</td>
      <td>${escapeHtml(campaign.name)}</td>
      <td>${campaign.mode}</td>
      <td>${campaign.transport}</td>
      <td>${campaign.status}</td>
      <td>${campaign.queued || 0}</td>
      <td>${campaign.sent || 0}</td>
      <td>${(campaign.failed || 0) + "/" + (campaign.skipped || 0)}</td>
      <td class="row-actions"></td>
    `;
    const actions = row.querySelector(".row-actions");
    for (const [label, action, extra] of [
      ["Start", "start"],
      ["Pause", "pause"],
      ["Resume", "resume"],
      ["Resend", "resend"],
    ]) {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = label;
      button.addEventListener("click", async () => {
        await request(`/api/campaigns/${campaign.id}/${action}`, {
          method: "POST",
          body: JSON.stringify(extra || {}),
        });
        await refresh();
      });
      actions.appendChild(button);
    }
    body.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("stop").addEventListener("click", async () => {
  await request("/api/emergency-stop", { method: "POST", body: JSON.stringify({ enabled: true }) });
  await refresh();
});
document.getElementById("clear-stop").addEventListener("click", async () => {
  await request("/api/emergency-stop", { method: "POST", body: JSON.stringify({ enabled: false }) });
  await refresh();
});
tokenInput.addEventListener("change", refresh);
refresh();
setInterval(refresh, 5000);
