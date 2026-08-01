"use strict";

/**
 * The live roster stream.
 *
 * Every open activity holds one server-sent-events connection. Whenever the
 * day's state changes -- a guess, a give-up, someone opening or closing the
 * activity -- each connection is handed the roster as that viewer is allowed to
 * see it.
 *
 * The filter is the point. Everyone gets everyone's emoji grid, which names no
 * country and so gives nothing away; the countries under a finished board unlock
 * only once the viewer has finished too.
 *
 * Payloads are built per (language, unlocked) pair and reused across the
 * connections that share one, so a publish costs a couple of renders rather than
 * one per viewer.
 */

const game = require("./game");
const store = require("./store");

/** Long enough to stay quiet, short enough to beat the usual 60s proxy idle cut. */
const HEARTBEAT_MS = 25000;

/**
 * Some proxies withhold a response until a few kilobytes have arrived, which
 * would delay the first roster indefinitely. A comment line of padding is
 * discarded by the client and gets the stream flowing.
 */
const PADDING = `:${" ".repeat(2048)}\n\n`;

/** @type {Set<{res: import("express").Response, userId: string, lang: () => string}>} */
const clients = new Set();

function write(client, chunk) {
  try {
    client.res.write(chunk);
  } catch {
    drop(client); // the socket went away between the check and the write
  }
}

function drop(client) {
  if (!clients.delete(client)) return false;
  try {
    client.res.end();
  } catch {
    // already closed
  }
  return true;
}

/** User ids with the activity open right now. */
function online() {
  return new Set([...clients].map((c) => c.userId));
}

/**
 * Open a stream for one session. Resolves nothing: the response stays open until
 * the client goes away.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {{userId: string, lang: () => string}} ctx
 */
function attach(req, res, ctx) {
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx-family proxies buffer text/* by default, which defeats streaming.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const client = { res, userId: ctx.userId, lang: ctx.lang };
  clients.add(client);

  res.write(PADDING);
  res.write("retry: 3000\n\n");

  const heartbeat = setInterval(() => write(client, ": ping\n\n"), HEARTBEAT_MS);
  heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    // Someone leaving changes every other viewer's roster, so the departure is
    // itself an event worth publishing.
    if (drop(client)) publish(game.today());
  };
  req.on("close", close);
  res.on("error", close);

  // The joiner needs a roster immediately, and everyone else needs the new
  // presence dot, so one publish covers both.
  publish(game.today());
}

/**
 * The roster payload for one viewer tier.
 *
 * @param {string} date
 * @param {string} lang
 * @param {boolean} unlocked  the viewer has finished and may see finished boards in full
 */
async function payloadFor(date, lang, unlocked) {
  return {
    date,
    streak: game.groupStreak(date),
    players: await game.roster(date, lang, { revealBoards: unlocked, online: online() }),
  };
}

/**
 * Push the current roster to every open stream.
 *
 * Failures are swallowed: a broken pipe on one viewer must not fail the guess
 * that triggered the publish.
 */
async function publish(date) {
  if (!clients.size) return;
  const cache = new Map();

  await Promise.all(
    [...clients].map(async (client) => {
      const lang = client.lang();
      const unlocked = Boolean(store.getPlayer(date, client.userId)?.finished);
      const key = `${lang}|${unlocked}`;
      if (!cache.has(key)) cache.set(key, payloadFor(date, lang, unlocked));
      const payload = await cache.get(key);
      write(client, `event: roster\ndata: ${JSON.stringify(payload)}\n\n`);
    })
  ).catch((e) => console.error("Roster publish failed:", e));
}

/** Close every stream. Used on shutdown so sockets do not hold the process open. */
function closeAll() {
  for (const client of [...clients]) drop(client);
}

module.exports = { attach, publish, payloadFor, online, closeAll, HEARTBEAT_MS };
