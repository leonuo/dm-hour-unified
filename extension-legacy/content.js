const IG_APP_ID = "936619743392459";
const IG_ASBD_ID = "129477";
const bridgeToken = crypto.randomUUID();
const pendingMqttRequests = new Map();
let bridgeReadyResolve;
const bridgeReady = new Promise((resolve) => {
  bridgeReadyResolve = resolve;
});

injectMqttBridge();

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.bridge_token !== bridgeToken) return;
  if (data.type === "DMH_MQTT_BRIDGE_READY") {
    bridgeReadyResolve();
    return;
  }
  if (data.type !== "INJECT_DISPATCH_DM_RESPONSE" || !data.request_id) return;
  const pending = pendingMqttRequests.get(data.request_id);
  if (!pending) return;
  pendingMqttRequests.delete(data.request_id);
  clearTimeout(pending.timeout);
  pending.resolve(data);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DMH_EXECUTE_WEB_MQTT_JOB") {
    executeWebMqttJob(message.job, message.session)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          success: false,
          http_status: error.httpStatus || null,
          error: `${error.name}: ${error.message}`
        });
      });
    return true;
  }
});

function injectMqttBridge() {
  if (document.documentElement.dataset.dmhMqttBridgeInjected === "1") return;
  document.documentElement.dataset.dmhMqttBridgeInjected = "1";
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("ijsource.js");
  script.dataset.dmhBridgeToken = bridgeToken;
  script.onload = () => script.remove();
  script.onerror = () => {
    document.documentElement.dataset.dmhMqttBridgeInjected = "0";
  };
  (document.head || document.documentElement).appendChild(script);
}

async function executeWebMqttJob(job, session) {
  if (!session?.ds_user_id || !session?.csrftoken) {
    throw new Error("Chrome Instagram cookie session is incomplete");
  }
  if (!job?.username || !job?.message) {
    throw new Error("Job username or message is missing");
  }
  const user = await resolveInstagramUser(job, session.csrftoken);
  const thread = await createGroupThread(user.id, session.csrftoken);
  const viewerId = String(thread.viewer_id || session.ds_user_id);
  if (!thread.thread_id || !viewerId) {
    throw new Error("create_group_thread response is missing thread_id or viewer_id");
  }
  const mqttResponse = await dispatchMqtt({
    thread_id: String(thread.thread_id),
    viewer_id: viewerId,
    user,
    text: job.message
  });
  const statusCode = Number(mqttResponse.status_code || 0) || null;
  return {
    success: mqttResponse.ret === 1 && statusCode === 200,
    http_status: statusCode,
    error: mqttResponse.ret === 1 ? null : mqttResponse.error || "MQTT send rejected"
  };
}

async function resolveInstagramUser(job, csrfToken) {
  const variables = job.variables || {};
  const providedId = variables.instagram_user_id || variables.user_id;
  if (providedId) return { id: String(providedId), username: job.username };

  const headers = instagramHeaders(csrfToken);
  const searchUrl = new URL("https://www.instagram.com/web/search/topsearch/");
  searchUrl.searchParams.set("context", "blended");
  searchUrl.searchParams.set("query", job.username);
  const searchResponse = await fetch(searchUrl, {
    method: "GET",
    credentials: "include",
    headers
  });
  if (!searchResponse.ok) throw httpError(searchResponse.status, "Instagram topsearch failed");
  const search = await searchResponse.json();
  const exact = (search.users || []).find(({ user }) =>
    user?.username?.toLowerCase() === String(job.username).toLowerCase()
  );
  const userId = exact?.user?.pk || exact?.user?.pk_id || exact?.user?.id;
  if (!userId) throw httpError(404, `Instagram user @${job.username} was not found`);

  await delay(400 + Math.floor(Math.random() * 1101));
  const infoUrl = `https://www.instagram.com/api/v1/users/${encodeURIComponent(userId)}/info/?from_module=profile`;
  const infoResponse = await fetch(infoUrl, {
    method: "GET",
    credentials: "include",
    headers: { ...headers, "x-ig-www-claim": "0" }
  });
  if (!infoResponse.ok) throw httpError(infoResponse.status, "Instagram user info request failed");
  const info = await infoResponse.json();
  if (!info?.user) throw httpError(404, `Instagram user @${job.username} has no user payload`);
  return {
    id: String(info.user.id || info.user.pk),
    username: info.user.username || job.username,
    profile_img: info.user.profile_pic_url || null
  };
}

async function createGroupThread(userId, csrfToken) {
  const response = await fetch(
    "https://i.instagram.com/api/v1/direct_v2/create_group_thread/",
    {
      method: "POST",
      credentials: "include",
      headers: instagramHeaders(csrfToken),
      body: new URLSearchParams({ recipient_users: JSON.stringify([String(userId)]) })
    }
  );
  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    throw httpError(response.status, "create_group_thread returned a non-JSON response");
  }
  if (!response.ok || payload?.status !== "ok") {
    throw httpError(response.status, payload?.message || "create_group_thread failed");
  }
  return payload;
}

async function dispatchMqtt(payload) {
  await promiseWithTimeout(bridgeReady, 5000, "Injected MQTT bridge did not initialize");
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pendingMqttRequests.delete(requestId);
      reject(new Error("MQTT response timed out"));
    }, 20000);
    pendingMqttRequests.set(requestId, { resolve, reject, timeout });
    window.postMessage({
      type: "INJECT_DISPATCH_DM_REQUEST",
      bridge_token: bridgeToken,
      request_id: requestId,
      ...payload
    }, location.origin);
  });
}

function instagramHeaders(csrfToken) {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-CSRFToken": csrfToken,
    "x-requested-with": "XMLHttpRequest",
    "x-instagram-ajax": "1",
    "x-asbd-id": IG_ASBD_ID,
    "X-IG-App-ID": IG_APP_ID
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.httpStatus = status;
  return error;
}

function promiseWithTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))
  ]);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
