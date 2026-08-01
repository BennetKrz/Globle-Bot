"use strict";

/**
 * The day's closing summary, posted once the date has rolled over.
 *
 * A tick that asks "is yesterday done and unposted?" rather than a timer aimed
 * at midnight. The process can be restarted, redeployed or suspended across the
 * rollover, and all three lose a timer while none of them change the answer to
 * that question. The day carries the flag in the store, so a restart a minute
 * later finds the work already done instead of doing it again.
 *
 * Only the previous day is ever considered. A bot that was down for a week comes
 * back to one summary, not seven.
 */

const game = require("./game");
const store = require("./store");
const globle = require("./globle");
const { announceDailySummary } = require("./announce");

const TICK_MS = 60 * 1000;

/**
 * The language a channel's summary is written in: whichever its players chose
 * most, English when they never chose. One message serves the channel, so a
 * mixed channel is a vote rather than a per-player render.
 */
function channelLanguage(players) {
  const counts = new Map();
  for (const player of players) {
    const lang = store.getLanguage(player.userId);
    if (lang) counts.set(lang, (counts.get(lang) || 0) + 1);
  }
  let best = globle.DEFAULT_LANGUAGE;
  let top = 0;
  for (const [lang, n] of counts) {
    if (n > top) {
      best = lang;
      top = n;
    }
  }
  return best;
}

/**
 * Summarise a finished day into every channel it was played from.
 *
 * The day is marked only after all of its channels have been tried, and a throw
 * on the way there leaves it unmarked, so a failed answer fetch is retried on
 * the next tick instead of costing the day its summary.
 *
 * @returns {Promise<boolean>} false when nobody played the day in a channel
 */
async function postSummary(client, date) {
  const channels = store.channelsOn(date);
  if (!channels.length) return false;

  const answer = await game.getAnswer(date);
  const streak = game.groupStreak(date);
  const players = store.playersOn(date);

  for (const channelId of channels) {
    const inChannel = players.filter((p) => p.channelId === channelId);
    await announceDailySummary(client, {
      channelId,
      date,
      answer: answer.properties.NAME,
      players: inChannel,
      streak,
      lang: channelLanguage(inChannel),
    });
  }
  store.markSummaryPosted(date);
  return true;
}

/** Whether the previous day is owed a summary, and post it if it is. */
async function check(client) {
  const date = game.previousDay(game.today());
  if (store.summaryPosted(date)) return;
  try {
    await postSummary(client, date);
  } catch (e) {
    console.error(`Daily summary for ${date} failed, retrying: ${e.message}`);
  }
}

/**
 * Watch for the day rolling over. Returns a function that stops watching.
 *
 * Without a gateway client there is nowhere to post, so this does nothing at
 * all: a development run of the server alone starts no timer.
 */
function start(client) {
  if (!client) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return; // a slow fetch must not overlap the next minute
    running = true;
    try {
      await check(client);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

module.exports = { start, postSummary, channelLanguage };
