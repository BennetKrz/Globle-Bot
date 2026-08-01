"use strict";

/**
 * The strings this process puts in a Discord message.
 *
 * Everything the player reads inside the activity is the client's own
 * `client/src/i18n.js`. What is left here is the channel announcement and the
 * one interaction reply, so the two files do not overlap.
 *
 * Country names are in neither: those live with the geometry in globle.js, keyed
 * by the dataset's canonical English NAME.
 *
 * A key missing from a language falls back to English rather than rendering
 * blank, so adding a key does not require translating it in the same commit.
 */

const { normalizeLanguage } = require("./globle");

const STRINGS = {
  en: {
    guessUnit: (n) => (n === 1 ? "guess" : "guesses"),
    announceWin: (mention, turns) => `🌍 ${mention} got today's Globle in **${turns}**!`,
    announceGaveUp: (mention, turns) => `🏳️ ${mention} gave up on today's Globle after ${turns}.`,
    announceStreak: (days) => `🔥 The group is on a **${days} day** streak.`,
    launchFailed: "⚠️ Couldn't open the Globle map here.",
    guildOnly: "🌍 Globle is played in a server, not in a direct message.",
    announceHard: "🕶 On hard mode.",
    summaryTitle: (day) => `📅 **Globle · ${day}**`,
    summaryAnswer: (flag, country) => `${flag} The answer was **${country}**.`,
    summaryGaveUp: (who, count) => `${who} gave up (${count})`,
    summaryUnfinished: (who, count) => `${who} never finished (${count})`,
    summaryNobodyWon: "💀 Nobody found it.",
    summaryStreakEnded: (days) => `💔 The **${days} day** streak ends here.`,
    summaryMore: (n) => `…and ${n} more.`,
    cardWin: (turns) => `Found it in ${turns}`,
    cardGaveUp: (turns) => `Gave up after ${turns}`,
    cardStreak: (days) => `${days} DAY STREAK`,
    cardHard: "HARD",
  },

  de: {
    guessUnit: (n) => (n === 1 ? "Versuch" : "Versuchen"),
    announceWin: (mention, turns) => `🌍 ${mention} hat das heutige Globle in **${turns}** geschafft!`,
    announceGaveUp: (mention, turns) => `🏳️ ${mention} hat das heutige Globle nach ${turns} aufgegeben.`,
    announceStreak: (days) => `🔥 Die Gruppe ist auf einer **${days}-Tage**-Serie.`,
    launchFailed: "⚠️ Die Globle-Karte lässt sich hier nicht öffnen.",
    guildOnly: "🌍 Globle wird auf einem Server gespielt, nicht in Direktnachrichten.",
    announceHard: "🕶 Im schweren Modus.",
    summaryTitle: (day) => `📅 **Globle · ${day}**`,
    summaryAnswer: (flag, country) => `${flag} Die Lösung war **${country}**.`,
    summaryGaveUp: (who, count) => `${who} hat aufgegeben (${count})`,
    summaryUnfinished: (who, count) => `${who} hat nicht beendet (${count})`,
    summaryNobodyWon: "💀 Niemand hat es gefunden.",
    summaryStreakEnded: (days) => `💔 Die **${days}-Tage**-Serie endet hier.`,
    summaryMore: (n) => `…und ${n} weitere.`,
    cardWin: (turns) => `In ${turns} gefunden`,
    cardGaveUp: (turns) => `Nach ${turns} aufgegeben`,
    cardStreak: (days) => `${days} TAGE SERIE`,
    cardHard: "SCHWER",
  },
};

/**
 * Look up a string, calling it with `args` when it is a template. Unknown keys
 * throw rather than rendering "undefined" into a message a player would see.
 */
function t(lang, key, ...args) {
  const table = STRINGS[normalizeLanguage(lang)] || STRINGS.en;
  const value = key in table ? table[key] : STRINGS.en[key];
  if (value === undefined) throw new Error(`Missing i18n key: ${key}`);
  return typeof value === "function" ? value(...args) : value;
}

module.exports = { t };
