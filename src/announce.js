"use strict";

/**
 * Channel announcements: the only place in this app that sends a Discord message
 * on its own initiative.
 *
 * The app never direct-messages anyone. Outbound DMs require no gateway intent,
 * so trimming the intent list cannot prevent them -- the guarantee has to come
 * from the code. Two rules hold it up:
 *
 *   1. Nothing here ever turns a user id into a send target. Every send resolves
 *      a *channel* id, and `sendToChannel` refuses any channel that is DM-based.
 *   2. This module owns the only `.send(...)` call, so a new feature cannot
 *      acquire the ability to DM without editing this file.
 *
 * Announcements are also spoiler-free by construction: they carry the finisher's
 * emoji grid, guess count and mode, never the country, so they are safe to post
 * in a channel where others have not played yet.
 *
 * Announcements are text only. No image is attached, so the message reads the
 * same on a phone, in a client with images turned off and through a screen
 * reader.
 */

const { escapeMarkdown } = require("discord.js");

const { t } = require("./i18n");
const globle = require("./globle");

/** Discord renders `<@id>` as a mention, and pings the user if allowed_mentions permits it. */
function mention(userId) {
  return `<@${userId}>`;
}

/**
 * Whether an id can be mentioned.
 *
 * Not every player id is a Discord snowflake: a DEV_LOGIN session invents one,
 * and so does a hand-written state fixture. Discord validates allowed_mentions
 * against the snowflake format and rejects the whole message over one bad entry,
 * which `sendToChannel` then swallows, so such a player is written out by name
 * instead of being mentioned.
 */
const SNOWFLAKE = /^\d{17,20}$/;
function mentionable(userId) {
  return SNOWFLAKE.test(userId);
}

/** How a player is named: mentioned when Discord can, written out when it cannot. */
function nameOf(player) {
  return mentionable(player.userId) ? mention(player.userId) : escapeMarkdown(player.displayName);
}

/**
 * Post to a guild channel. Returns false when the target is unusable (gone, DM-based,
 * or the bot lacks Send Messages) instead of throwing, since an announcement failing
 * must never fail the player's game.
 */
async function sendToChannel(client, channelId, payload) {
  if (!channelId) return false;
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (e) {
    console.error(`Announcement: channel ${channelId} not fetchable: ${e.message}`);
    return false;
  }
  if (!channel || typeof channel.send !== "function") return false;
  if (channel.isDMBased()) {
    console.error(`Announcement: refusing to post to DM-based channel ${channelId}`);
    return false;
  }
  try {
    await channel.send(payload);
    return true;
  } catch (e) {
    console.error(`Announcement: could not post to ${channelId}: ${e.message}`);
    return false;
  }
}

/**
 * Announce that a player finished today's game.
 *
 * One finisher, one message. Nothing about the rest of the day appears here --
 * no other players, no group streak. Those belong to the day rather than to this
 * player, and the summary is where the day gets described.
 *
 * @param {import("discord.js").Client} client
 * @param {object} opts
 * @param {string} opts.channelId  guild channel to post in
 * @param {object} opts.player     the finisher (userId, win, guessCount, guesses, hard)
 * @param {string} opts.lang
 */
async function announceFinish(client, { channelId, player, lang }) {
  const turns = `${player.guessCount} ${t(lang, "guessUnit", player.guessCount)}`;
  const grid = player.guesses.map((g) => g.emoji).join("");

  const lines = [
    player.win
      ? t(lang, "announceWin", nameOf(player), turns)
      : t(lang, "announceGaveUp", nameOf(player), turns),
  ];
  // The mode is what the run is worth, so a hard run says so.
  if (player.hard) lines.push(t(lang, "announceHard"));
  if (grid) lines.push(grid);

  return sendToChannel(client, channelId, {
    content: lines.join("\n"),
    // Without this the mention renders as a name but never pings. Listing the id
    // instead of parse:["users"] keeps the ping to exactly this player.
    allowedMentions: { users: [player.userId].filter(mentionable) },
  });
}

// --- The day's summary ------------------------------------------------------

/**
 * Discord rejects a message over 2000 characters. The summary is built to sit
 * under this instead, so a busy day loses its emoji grids rather than its post.
 */
const SUMMARY_LIMIT = 1900;

/** Rows a summary lists before it stops naming players. */
const SUMMARY_ROWS = 20;

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * The day, written out in the language the summary is posted in.
 *
 * Formatted in UTC although the date belongs to the group's zone: the string is
 * already the right day, and formatting it in a zone behind UTC would move it to
 * the one before.
 */
function dayLabel(date, lang) {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(lang, {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * One player's row.
 *
 * Names are escaped: a display name is whatever its owner typed, and an
 * unescaped `**` in one would take the rest of the message with it.
 */
function summaryRow(player, place, lang, grids) {
  const hard = player.hard ? " 🕶" : "";
  const who = `${escapeMarkdown(player.displayName)}${hard}`;
  if (player.win) {
    const grid = grids ? ` ${player.guesses.map((g) => g.emoji).join("")}` : "";
    return `${MEDALS[place] || "🔹"} ${who} **${player.guessCount}**${grid}`;
  }
  if (player.finished) return `🏳️ ${t(lang, "summaryGaveUp", who, player.guessCount)}`;
  return `⏳ ${t(lang, "summaryUnfinished", who, player.guessCount)}`;
}

/**
 * The day's results, as the lines of one message.
 *
 * This is the only message that names the country. It goes out after the date
 * has rolled over, so there is no game left for it to spoil, and it is what the
 * finish announcements of that day were deliberately withholding.
 *
 * Players arrive in `store.playersOn` order: winners by guess count, then
 * give-ups, then whoever was still playing when the day ended.
 */
function summaryLines({ date, answer, players, streak, lang }) {
  const winners = players.filter((p) => p.win);
  const listed = players.slice(0, SUMMARY_ROWS);

  const build = (grids) => {
    const lines = [
      t(lang, "summaryTitle", dayLabel(date, lang)),
      t(lang, "summaryAnswer", globle.flagEmoji(answer), globle.displayName(answer, lang)),
      "",
    ];
    let place = 0;
    for (const player of listed) {
      lines.push(summaryRow(player, player.win ? place++ : 0, lang, grids));
    }
    if (players.length > listed.length) {
      lines.push(t(lang, "summaryMore", players.length - listed.length));
    }
    lines.push("");
    if (winners.length) lines.push(t(lang, "announceStreak", streak));
    else {
      lines.push(t(lang, "summaryNobodyWon"));
      // groupStreak already stepped back past this day, so what it counted is
      // the run this day broke. A zero-length run is not worth mourning.
      if (streak > 0) lines.push(t(lang, "summaryStreakEnded", streak));
    }
    return lines;
  };

  const withGrids = build(true);
  return withGrids.join("\n").length <= SUMMARY_LIMIT ? withGrids : build(false);
}

/**
 * Post the summary of a finished day into one channel.
 *
 * Players are named in plain text, never mentioned: this lands at midnight, and
 * a ping at midnight is not a summary, it is an alarm clock.
 *
 * @param {import("discord.js").Client} client
 * @param {object} opts
 * @param {string} opts.channelId  guild channel to post in
 * @param {string} opts.date       the day being summarised, YYYY-MM-DD
 * @param {string} opts.answer     that day's country, as the dataset's English NAME
 * @param {Array<object>} opts.players  everyone who played it, in roster order
 * @param {number} opts.streak     the group streak as of that day
 * @param {string} opts.lang
 */
async function announceDailySummary(client, { channelId, date, answer, players, streak, lang }) {
  return sendToChannel(client, channelId, {
    content: summaryLines({ date, answer, players, streak, lang }).join("\n"),
    allowedMentions: { parse: [] },
  });
}

module.exports = { announceFinish, announceDailySummary, summaryLines, mention, sendToChannel };
