/**
 * The game API client.
 *
 * Requests go to a relative path so Discord's proxy resolves them against the
 * activity's own origin; an absolute URL to the backend would be refused by the
 * iframe's content security policy. The `/.proxy/` prefix is the form every
 * Discord client has understood, including the ones that predate plain `/api`.
 *
 * The session token is a bearer header rather than a cookie: cookies inside the
 * activity iframe need `SameSite=None; Partitioned` and are easy to lose. That
 * choice is also why the roster stream is read through `fetch` rather than
 * `EventSource`, which cannot set a header.
 */

const BASE = "/.proxy/api";

let sessionToken = null;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 304) return null;
  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

/** Exchange the OAuth code for a session. Everything else needs this first. */
export async function openSession({ code, instanceId }) {
  const result = await request("/token", {
    method: "POST",
    body: { code, instance_id: instanceId },
  });
  sessionToken = result.session;
  return result;
}

/**
 * Start a session without Discord, for opening the activity in a plain browser
 * while working on the map. The server only answers this when it was started
 * with DEV_LOGIN enabled, so a deployed instance rejects it. Each tab becomes
 * its own player, which is how the roster can be watched from one machine.
 */
export async function openDevSession() {
  const result = await request("/dev-session", { method: "POST" });
  sessionToken = result.session;
  return result;
}

export const getGeometry = (lang) => request(`/geometry?lang=${encodeURIComponent(lang)}`);
export const getCountries = () => request("/countries");
export const getState = (mode) => request(`/state?mode=${mode}`);
export const getStats = () => request("/stats");

export const submitGuess = (country, mode) =>
  request("/guess", { method: "POST", body: { country, mode } });
export const giveUp = (mode) => request("/giveup", { method: "POST", body: { mode } });
export const newPractice = () => request("/practice/new", { method: "POST" });
export const setLanguage = (language) => request("/language", { method: "POST", body: { language } });
export const setHard = (hard, mode) => request("/hard", { method: "POST", body: { hard, mode } });

/**
 * Erase today's daily and start it over. `scope` is "self" or "day".
 *
 * The server only answers this when it was started with DEV_RESET enabled, and
 * says so in the session handshake, so the button is on screen exactly when the
 * route is there to serve it.
 */
export const devReset = (scope) => request("/dev-reset", { method: "POST", body: { scope } });

// --- The roster stream ------------------------------------------------------

/** Reconnect delay after n consecutive failures, capped so a dead server is not hammered. */
const backoff = (n) => Math.min(1000 * 2 ** n, 15000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold a server-sent-events connection open for as long as the activity is on
 * screen, reconnecting when it drops.
 *
 * The server pushes a roster on every change and a comment line every 25s so the
 * connection never looks idle. Losing it is ordinary -- a phone sleeping, a
 * network roaming -- so it is retried rather than reported.
 *
 * A rejected session is the one failure worth giving up on. It means the server
 * restarted and this token will never work again, so retrying it would poll
 * forever; `onExpired` is the signal to re-handshake instead.
 *
 * @param {object} handlers
 * @param {(name: string, data: object) => void} handlers.onEvent
 * @param {(connected: boolean) => void} [handlers.onStatus]
 * @param {() => void} [handlers.onExpired]
 * @returns {() => void} stop and close
 */
export function openStream({ onEvent, onStatus, onExpired }) {
  let stopped = false;
  let controller = null;
  let failures = 0;

  (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${BASE}/events`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
          signal: controller.signal,
        });
        if (res.status === 401) {
          stopped = true;
          onStatus?.(false);
          onExpired?.();
          return;
        }
        if (!res.ok || !res.body) throw new ApiError(res.status, null);
        failures = 0;
        onStatus?.(true);
        await consume(res.body, onEvent);
      } catch {
        // The abort on teardown lands here too; the loop condition catches it.
      }
      onStatus?.(false);
      if (stopped) return;
      await sleep(backoff(failures++));
    }
  })();

  return () => {
    stopped = true;
    controller?.abort();
  };
}

/** Read frames off the stream until it ends. */
async function consume(body, onEvent) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      dispatch(buffer.slice(0, split), onEvent);
      buffer = buffer.slice(split + 2);
    }
  }
}

/** Turn one `event:`/`data:` frame into a handler call. Comment lines carry nothing. */
function dispatch(frame, onEvent) {
  let name = "message";
  const data = [];
  for (const raw of frame.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return;
  try {
    onEvent(name, JSON.parse(data.join("\n")));
  } catch (error) {
    console.error("Unreadable roster frame:", error);
  }
}
