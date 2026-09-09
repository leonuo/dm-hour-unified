(() => {
  "use strict";

  // Runs in the page's own world at document_start (manifest `world: "MAIN"`),
  // which is the only way to be certain this executes before Instagram's bundle
  // takes its reference to WebSocket. An injected <script src> loads
  // asynchronously and loses that race.
  //
  // Observes only. Forwards nothing until the content script sets
  // data-dmh-capture=1. Early events wait in a queue because the content
  // script loads at document_end.
  const NativeSocket = window.WebSocket;
  if (!NativeSocket || NativeSocket.__dmhWrapped) return;

  const decoder = new TextDecoder();
  const HEX_LIMIT = 16384;
  const TEXT_LIMIT = 16000;
  const QUEUE_LIMIT = 400;
  const SENSITIVE_HEADER = /^(cookie|authorization|x-csrftoken)$/i;
  const INTERESTING = /send_item|ig_send_message|reel_share|story_reply|direct_v2|item_type|create_group_thread|broadcast\//;
  const TELEMETRY = /"events"\s*:\s*\[|ods_web_batch|instagram_web_time_spent|instagram_organic_impression|"name":"perf"/;
  const NOISE_URL = /\.(js|css|png|jpe?g|webp|gif|mp4|m4v|webm|woff2?|svg|ico)(\?|$)|logging_client_events|\/ajax\/bz|\/tr\/|client_event|graphql\/logging|pixel/i;
  const META_HOST = /(^|\.)(instagram\.com|facebook\.com|meta\.com)$/;

  const enabled = () => document.documentElement?.dataset?.dmhCapture === "1";
  const queue = [];

  function emit(entry) {
    queue.push(entry);
    if (queue.length > QUEUE_LIMIT) queue.shift();
    flush();
  }

  function flush() {
    if (!enabled()) return;
    while (queue.length) window.postMessage({ type: "INJECT_CAPTURE", ...queue.shift() }, "*");
  }

  setInterval(flush, 1000);

  function hostOf(url) {
    try { return new URL(String(url), location.href).host; } catch (_error) { return ""; }
  }

  function isMetaUrl(url) {
    return META_HOST.test(hostOf(url));
  }

  function hex(bytes) {
    const shown = Array.from(bytes.slice(0, HEX_LIMIT), (b) => b.toString(16).padStart(2, "0")).join(" ");
    return bytes.length > HEX_LIMIT ? `${shown} … (+${bytes.length - HEX_LIMIT})` : shown;
  }

  function clip(text) {
    if (typeof text !== "string") return null;
    return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}… (+${text.length - TEXT_LIMIT})` : text;
  }

  function readable(text) {
    return typeof text === "string" && /[ -~]{8}/.test(text) ? clip(text) : null;
  }

  function isPing(bytes) {
    return bytes.length === 2 && ((bytes[0] === 0xc0 && bytes[1] === 0x00) || (bytes[0] === 0xd0 && bytes[1] === 0x00));
  }

  function isNoiseText(text) {
    if (!text) return false;
    if (INTERESTING.test(text)) return false;
    return TELEMETRY.test(text);
  }

  function isNoiseUrl(url) {
    return NOISE_URL.test(String(url || ""));
  }

  async function describe(data) {
    if (typeof data === "string") return { encoding: "text", bytes: data.length, text: clip(data) };
    const source = data instanceof ArrayBuffer ? data : data?.buffer;
    if (!source) return { encoding: "unknown" };
    const bytes = new Uint8Array(source);
    const detail = { encoding: "binary", bytes: bytes.length, hex: hex(bytes) };
    if (isPing(bytes)) {
      detail.ping = true;
      return detail;
    }
    for (const format of ["deflate", "deflate-raw", "gzip"]) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        detail.text = clip(decoder.decode(await new Response(stream).arrayBuffer()));
        detail.encoding = format;
        return detail;
      } catch (_error) { /* try the next one */ }
    }
    detail.text = readable(decoder.decode(bytes));
    return detail;
  }

  function reportSocket(direction, url, data) {
    if (!isMetaUrl(url) || isNoiseUrl(url)) return;
    describe(data)
      .then((detail) => {
        if (detail.ping) return;
        if (isNoiseText(detail.text)) return;
        emit({ direction, label: "instagram.frame", url: String(url), detail });
      })
      .catch(() => undefined);
  }

  function redactHeaders(headers) {
    const safe = {};
    if (!headers) return safe;
    const list = headers.forEach
      ? headers
      : Object.entries(headers);
    if (typeof headers.forEach === "function") {
      headers.forEach((value, key) => {
        safe[key] = SENSITIVE_HEADER.test(key) ? "«приховано»" : String(value).slice(0, 500);
      });
      return safe;
    }
    for (const [key, value] of list) {
      safe[key] = SENSITIVE_HEADER.test(key) ? "«приховано»" : String(value).slice(0, 500);
    }
    return safe;
  }

  function bodyPreview(body) {
    if (body == null) return null;
    if (typeof body === "string") return clip(body);
    if (body instanceof URLSearchParams) return clip(body.toString());
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      return clip([...body.keys()].join(","));
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer);
      return { encoding: "binary", bytes: bytes.length, hex: hex(bytes) };
    }
    try { return clip(String(body)); } catch (_error) { return null; }
  }

  function reportHttp(direction, url, detail) {
    if (!url || !isMetaUrl(url) || isNoiseUrl(url)) return;
    const text = typeof detail.body === "string" ? detail.body : detail.body?.text;
    if (isNoiseText(text)) return;
    emit({
      direction,
      label: "instagram.http",
      url: String(url),
      detail
    });
  }

  function Wrapped(url, protocols) {
    emit({ direction: "out", label: "instagram.socket", url: String(url), detail: { protocols: protocols ?? null } });
    const socket = protocols === undefined ? new NativeSocket(url) : new NativeSocket(url, protocols);
    const send = socket.send.bind(socket);
    socket.send = function (data) {
      reportSocket("out", url, data);
      return send(data);
    };
    socket.addEventListener("message", (event) => reportSocket("in", url, event.data));
    return socket;
  }

  Wrapped.prototype = NativeSocket.prototype;
  Wrapped.__dmhWrapped = true;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Wrapped[key] = NativeSocket[key];
  Object.defineProperty(window, "WebSocket", { value: Wrapped, writable: true, configurable: true });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const method = (init?.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();
    const headers = init?.headers || (typeof input !== "string" ? input?.headers : null);
    reportHttp("out", url, {
      method,
      headers: redactHeaders(headers),
      body: bodyPreview(init?.body)
    });
    return nativeFetch(input, init).then((response) => {
      const copy = response.clone();
      copy.text().then((body) => {
        reportHttp("in", copy.url || url, {
          method,
          status: copy.status,
          headers: redactHeaders(copy.headers),
          body: clip(body)
        });
      }).catch(() => undefined);
      return response;
    });
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dmh = { method: String(method || "GET"), url: String(url || "") };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__dmh || {};
    reportHttp("out", meta.url, { method: meta.method, body: bodyPreview(body) });
    this.addEventListener("load", function () {
      let responseBody = null;
      try { responseBody = clip(String(this.responseText || "")); } catch (_error) { responseBody = null; }
      reportHttp("in", meta.url, { method: meta.method, status: this.status, body: responseBody });
    });
    return xhrSend.apply(this, arguments);
  };

  emit({ label: "capture.armed", detail: { href: location.href, at: new Date().toISOString(), hooks: ["websocket", "fetch", "xhr"] } });
})();
