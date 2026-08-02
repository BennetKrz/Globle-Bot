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
 *
 * These connections are also what the play clock is measured against: opening
 * one resumes a player's clock and losing the last one pauses it, which is what
 * makes the daily's time the time it was played rather than the time since it
 * was started. The signal is the socket rather than anything the client claims,
 * so a player cannot stop their own clock without actually leaving.
 */

const game = require("./game");
const store = require("./store");

/** Long enough to stay quiet, short enough to beat the usual 60s proxy idle cut. */
const HEARTBEAT_MS = 25000;

/**
 * How long a player may be disconnected before their clock stops.
 *
 * The stream tells the client to retry after three seconds, so a phone changing
 * network drops and returns as a matter of course. Pausing on the drop itself
 * would punch a hole in the timeline for every one of those, and add two
 * segments to it. Coming back inside this window cancels the pause instead;
 * a pause that does happen is backdated to the drop, so the window forgives a
 * flap rather than handing out free time.
 */
const PAUSE_GRACE_MS = 20000;

/**
 * Some proxies withhold a response until a few kilobytes have arrived, which
 * would delay the first roster indefinitely. A comment line of padding is
 * discarded by the client and gets the stream flowing.
 */
const PADDING = `:${" ".repeat(2048)}\n\n`;

/** @type {Set<{res: import("express").Response, userId: string, lang: () => string}>} */
const clients = new Set();

/** Players whose last stream went away and whose pause has not fired yet. */
/** @type {Map<string, NodeJS.Timeout>} */
const pendingPauses = new Map();

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
 * How many streams one player has open.
 *
 * Presence is counted rather than flagged because one player can be two
 * connections: a second tab, a phone beside a desktop, or the old socket of a
 * reconnect that has not been reaped yet. Pausing on the first of those to close
 * would stop a clock the other one is still playing.
 */
function connectionsFor(userId) {
  let open = 0;
  for (const client of clients) if (client.userId === userId) open++;
  return open;
}

/**
 * Stop a player's clock, once it is clear they are not coming straight back.
 * `at` is when they actually went, not when this decides they have gone.
 */
function schedulePause(userId, at) {
  if (connectionsFor(userId) > 0 || pendingPauses.has(userId)) return;
  const timer = setTimeout(async () => {
    pendingPauses.delete(userId);
    if (connectionsFor(userId) > 0) return; // came back while this was queued
    const date = game.today();
    // The roster shows a clock that has stopped as one that has stopped, so the
    // pause is worth a publish of its own.
    if (game.pausePlayer(date, userId, at)) await publish(date);
  }, PAUSE_GRACE_MS);
  timer.unref();
  pendingPauses.set(userId, timer);
}

/** Called on connect: cancel a queued pause, or start the clock up again. */
function markArrived(userId) {
  const waiting = pendingPauses.get(userId);
  if (waiting) {
    // Back inside the grace window, so nothing ever stopped and nothing resumes.
    clearTimeout(waiting);
    pendingPauses.delete(userId);
    return;
  }
  // Their first stream, on a clock some earlier one paused.
  if (connectionsFor(userId) === 1) game.resumePlayer(game.today(), userId);
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
  markArrived(client.userId);

  res.write(PADDING);
  res.write("retry: 3000\n\n");

  // The ping doubles as the clock's proof of life: it leaves a mark on the open
  // segment, and a process that is killed between two of them loses at most the
  // interval between them. See clock.js.
  const heartbeat = setInterval(() => {
    write(client, ": ping\n\n");
    game.markPlayerSeen(game.today(), client.userId);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    if (!drop(client)) return;
    schedulePause(client.userId, Date.now());
    // Someone leaving changes every other viewer's roster, so the departure is
    // itself an event worth publishing.
    publish(game.today());
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

/**
 * Close every stream. Used on shutdown so sockets do not hold the process open.
 *
 * The queued pauses go with them, unfired: the caller is on its way out and is
 * about to stop every clock on the day at once, which is both sooner and more
 * accurate than a timer that would be waiting twenty seconds to do part of it.
 */
function closeAll() {
  for (const timer of pendingPauses.values()) clearTimeout(timer);
  pendingPauses.clear();
  for (const client of [...clients]) drop(client);
}

module.exports = { attach, publish, payloadFor, online, closeAll, HEARTBEAT_MS };
