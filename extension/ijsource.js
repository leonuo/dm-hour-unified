(() => {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const payloadDeviceId = crypto.randomUUID().toUpperCase();

  /**
   * The bridge runs in the page realm and has no chrome.* access, so raw frames
   * are handed to the content script, which decides whether to store them.
   */
  let diagRequestId = null;
  function diag(direction, label, detail) {
    window.postMessage({
      type: "INJECT_DIAG",
      request_id: diagRequestId,
      direction,
      label,
      detail
    }, "*");
  }
  function frameHex(bytes, limit = 512) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const shown = Array.from(view.slice(0, limit), (b) => b.toString(16).padStart(2, "0")).join(" ");
    return view.length > limit ? `${shown} … (+${view.length - limit})` : shown;
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const request = event.data;
    if (!request || request.type !== "INJECT_DISPATCH_DM_REQUEST") return;
    if (!request.request_id) return;
    diagRequestId = request.request_id;

    try {
      const response = await sendDirectText(request);
      const statusCode = Number(response.status_code || 0) || null;
      window.postMessage({
        type: "INJECT_DISPATCH_DM_RESPONSE",
        request_id: request.request_id,
        ret: statusCode === 200 ? 1 : 0,
        status_code: statusCode,
        error_code: response.payload?.error_code || null,
        error: response.message || null
      }, "*");
    } catch (error) {
      window.postMessage({
        type: "INJECT_DISPATCH_DM_RESPONSE",
        request_id: request.request_id,
        ret: 0,
        status_code: Number(error.statusCode || 0) || null,
        error: `${error.name}: ${error.message}`
      }, "*");
    }
  });

  async function sendDirectText({ thread_id, viewer_id, text, item_type = "text", reel_share = null }) {
    if (!thread_id || !viewer_id || typeof text !== "string") {
      throw new Error("MQTT request is missing thread_id, viewer_id or text");
    }
    const clientContext = randomContext();
    const userName = JSON.stringify({
      u: String(viewer_id),
      s: randomContext(),
      cp: 1,
      ecp: 0,
      chat_on: true,
      fg: true,
      d: crypto.randomUUID(),
      ct: "cookie_auth",
      mqtt_sid: "",
      aid: 936619743392459,
      st: [],
      pm: [],
      dc: "",
      no_auto_fg: true,
      asi: { "Accept-Language": "en" },
      a: navigator.userAgent
    });
    // `item_type` selects the Direct item. `text` is the default; `reel_share`
    // is the story-reply item, carrying the target reel/media ids so the
    // message attaches to the story rather than opening a plain thread. The
    // default literal stays `"text"` so the verified contract is unchanged; a
    // reel_share request overrides it after the object is built.
    const payload = {
      client_context: clientContext,
      device_id: payloadDeviceId,
      action: "send_item",
      item_type: "text",
      mutation_token: clientContext - 100000,
      text,
      thread_id: String(thread_id)
    };
    if (item_type === "reel_share" && reel_share) {
      payload.item_type = "reel_share";
      payload.reel_share = reel_share;
    }
    const client = new MinimalMqttClient(
      "wss://edge-chat.instagram.com:443/chat",
      "mqttwsclient"
    );
    diag("out", "mqtt.username", userName);
    await client.connect(userName);
    try {
      const responsePromise = client.nextPublish(15000);
      diag("out", "mqtt.publish", { topic: "/ig_send_message", payload });
      client.publish("/ig_send_message", JSON.stringify(payload));
      const response = await responsePromise;
      diag("in", "mqtt.response", { topic: response.topic, payload: response.payload });
      return JSON.parse(response.payload);
    } finally {
      client.disconnect();
    }
  }

  function randomContext() {
    return Math.random() * Number.MAX_SAFE_INTEGER;
  }

  class MinimalMqttClient {
    constructor(url, clientId) {
      this.url = url;
      this.clientId = clientId;
      this.socket = null;
      this.publishWaiters = [];
      this.pingTimer = null;
    }

    connect(userName) {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(this.url);
        this.socket = socket;
        socket.binaryType = "arraybuffer";
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("MQTT connection timed out"));
        }, 15000);

        socket.onopen = () => {
          const packet = buildConnectPacket(this.clientId, userName, 10);
          diag("out", "mqtt.frame.connect", frameHex(packet));
          socket.send(packet);
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("MQTT WebSocket connection failed"));
        };
        socket.onclose = () => {
          clearInterval(this.pingTimer);
          this.rejectPublishWaiters(new Error("MQTT WebSocket closed"));
        };
        socket.onmessage = (event) => {
          const bytes = new Uint8Array(event.data);
          diag("in", "mqtt.frame", frameHex(bytes));
          for (const packet of decodePackets(bytes)) {
            const type = packet.header >> 4;
            if (type === 2) {
              clearTimeout(timeout);
              const returnCode = packet.body[1];
              if (returnCode === 0) {
                this.pingTimer = setInterval(() => {
                  if (socket.readyState === WebSocket.OPEN) socket.send(Uint8Array.of(0xc0, 0x00));
                }, 10000);
                resolve();
              } else {
                const error = new Error(`MQTT CONNACK rejected with code ${returnCode}`);
                error.statusCode = returnCode;
                reject(error);
              }
            } else if (type === 3) {
              const parsed = parsePublish(packet.header, packet.body);
              const waiter = this.publishWaiters.shift();
              if (waiter) waiter.resolve(parsed);
            }
          }
        };
      });
    }

    publish(topic, payload) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("MQTT socket is not connected");
      }
      const packet = buildPublishPacket(topic, payload);
      diag("out", "mqtt.frame.publish", frameHex(packet));
      this.socket.send(packet);
    }

    nextPublish(timeoutMs) {
      return new Promise((resolve, reject) => {
        let entry;
        const timeout = setTimeout(() => {
          const index = this.publishWaiters.indexOf(entry);
          if (index >= 0) this.publishWaiters.splice(index, 1);
          reject(new Error("MQTT publish response timed out"));
        }, timeoutMs);
        entry = {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject
        };
        this.publishWaiters.push(entry);
      });
    }

    rejectPublishWaiters(error) {
      for (const waiter of this.publishWaiters.splice(0)) waiter.reject(error);
    }

    disconnect() {
      clearInterval(this.pingTimer);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(Uint8Array.of(0xe0, 0x00));
        this.socket.close();
      }
    }
  }

  function buildConnectPacket(clientId, userName, keepAlive) {
    // mqttVersion: 3 in IGDMBot 1.6.4 maps to MQTT 3.1 (MQIsdp / level 3).
    const variableHeader = concatBytes(
      mqttString("MQIsdp"),
      Uint8Array.of(3, 0x82, (keepAlive >> 8) & 0xff, keepAlive & 0xff)
    );
    const payload = concatBytes(mqttString(clientId), mqttString(userName));
    return mqttPacket(0x10, concatBytes(variableHeader, payload));
  }

  function buildPublishPacket(topic, payload) {
    return mqttPacket(0x30, concatBytes(mqttString(topic), encoder.encode(payload)));
  }

  function mqttPacket(header, body) {
    return concatBytes(Uint8Array.of(header), encodeRemainingLength(body.length), body);
  }

  function mqttString(value) {
    const bytes = encoder.encode(String(value));
    if (bytes.length > 65535) throw new Error("MQTT string is too long");
    return concatBytes(Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes);
  }

  function encodeRemainingLength(value) {
    const bytes = [];
    do {
      let digit = value % 128;
      value = Math.floor(value / 128);
      if (value > 0) digit |= 0x80;
      bytes.push(digit);
    } while (value > 0);
    return Uint8Array.from(bytes);
  }

  function decodePackets(bytes) {
    const packets = [];
    let offset = 0;
    while (offset < bytes.length) {
      const header = bytes[offset++];
      let multiplier = 1;
      let remaining = 0;
      let digit;
      do {
        if (offset >= bytes.length) throw new Error("Malformed MQTT remaining length");
        digit = bytes[offset++];
        remaining += (digit & 127) * multiplier;
        multiplier *= 128;
        if (multiplier > 128 ** 4) throw new Error("Malformed MQTT packet");
      } while ((digit & 128) !== 0);
      if (offset + remaining > bytes.length) throw new Error("Truncated MQTT packet");
      packets.push({ header, body: bytes.slice(offset, offset + remaining) });
      offset += remaining;
    }
    return packets;
  }

  function parsePublish(header, body) {
    if (body.length < 2) throw new Error("Malformed MQTT PUBLISH packet");
    const topicLength = (body[0] << 8) | body[1];
    let offset = 2;
    const topic = decoder.decode(body.slice(offset, offset + topicLength));
    offset += topicLength;
    const qos = (header >> 1) & 0x03;
    if (qos > 0) offset += 2;
    return { topic, payload: decoder.decode(body.slice(offset)) };
  }

  function concatBytes(...parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
  if (globalThis.__DMH_TEST__) globalThis.__DMH_PARITY_MQTT__ = {
    buildConnectPacket,
    buildPublishPacket,
    decodePackets,
    parsePublish,
    payloadDeviceId
  };
})();
