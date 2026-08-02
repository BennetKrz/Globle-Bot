/**
 * Interface strings.
 *
 * Country names are not here: they arrive already localised from the server,
 * which owns the dataset and its German overrides. This file covers only the
 * chrome around the map.
 */

const STRINGS = {
  en: {
    loading: "Loading today's Globle…",
    connecting: "Connecting to Discord…",
    guessPlaceholder: "Guess a country",
    guessSubmit: "Guess",
    giveUp: "Give up",
    guessesTitle: (n) => `Your guesses (${n})`,
    playersTitle: "Playing today",
    statusGuesses: (n) => `${n} ${n === 1 ? "guess" : "guesses"}`,
    statusWon: (country, n) => `Found ${country} in ${n} ${n === 1 ? "guess" : "guesses"}`,
    statusLost: (country) => `Gave up. It was ${country}`,
    viewTilted: "2.5D",
    viewFlat: "2D",
    languageName: "EN",
    unknownCountry: (input) => `"${input}" is not a country I know.`,
    didYouMean: (country) => `Did you mean ${country}?`,
    duplicate: (country) => `${country} was already guessed.`,
    offline: "Lost the connection to the server.",
    sessionExpired: "Session expired. Reopen the activity.",
    noWebgl: "3D is unavailable here, showing the flat map.",
    launchFailed: "Could not start the activity.",
    guildOnly: "Globle is played in a server, not in a direct message.",
    instanceUnavailable: "Could not confirm which channel this is. Open the activity again.",
    kmAway: (km) => `${km} km`,
    revealHint: "Ctrl-click to reveal the country name",
    menu: "Menu",

    // Hard mode
    hard: "Hard",
    hardLocked: "Hard mode only changes before the first guess.",
    hardBadge: "🕶",
    hardDailyTitle: "Everyone plays the daily on hard: only the closest guess shows its distance.",
    softBadge: "no 🕶",
    softBadgeTitle: "Played with distances showing, so this count does not compare.",

    // Roster
    guessUnit: (n) => (n === 1 ? "guess" : "guesses"),
    playerGaveUp: "🏳️ gave up",
    streak: (days) => `🔥 ${days} day streak`,
    timeTitle: "Time played — this tie was decided on it",
    timeLabel: (time) => `in ${time}`,

    // Practice
    practice: "Practice",
    daily: "Daily",
    practiceNew: "New country",
    practiceStatus: (n) => `Practice · ${n} ${n === 1 ? "guess" : "guesses"}`,
    practiceWon: (country, n) => `Practice · found ${country} in ${n}`,
    practiceLost: (country) => `Practice · it was ${country}`,
  },

  de: {
    loading: "Heutiges Globle wird geladen…",
    connecting: "Verbindung zu Discord…",
    guessPlaceholder: "Land raten",
    guessSubmit: "Raten",
    giveUp: "Aufgeben",
    guessesTitle: (n) => `Deine Tipps (${n})`,
    playersTitle: "Heute dabei",
    statusGuesses: (n) => `${n} ${n === 1 ? "Tipp" : "Tipps"}`,
    statusWon: (country, n) => `${country} in ${n} ${n === 1 ? "Versuch" : "Versuchen"}`,
    statusLost: (country) => `Aufgegeben. Es war ${country}`,
    viewTilted: "2,5D",
    viewFlat: "2D",
    languageName: "DE",
    unknownCountry: (input) => `„${input}“ ist kein Land, das ich kenne.`,
    didYouMean: (country) => `Meintest du ${country}?`,
    duplicate: (country) => `${country} wurde schon geraten.`,
    offline: "Verbindung zum Server verloren.",
    sessionExpired: "Sitzung abgelaufen. Aktivität neu öffnen.",
    noWebgl: "3D ist hier nicht verfügbar, es wird die flache Karte gezeigt.",
    launchFailed: "Aktivität konnte nicht gestartet werden.",
    guildOnly: "Globle wird auf einem Server gespielt, nicht in Direktnachrichten.",
    instanceUnavailable: "Der Kanal ließ sich nicht bestimmen. Aktivität erneut öffnen.",
    kmAway: (km) => `${km} km`,
    revealHint: "Strg+Klick, um den Ländernamen zu sehen",
    menu: "Menü",

    hard: "Schwer",
    hardLocked: "Schwer lässt sich nur vor dem ersten Tipp umstellen.",
    hardBadge: "🕶",
    hardDailyTitle:
      "Das tägliche Spiel ist für alle schwer: nur der nächste Tipp zeigt seine Entfernung.",
    softBadge: "ohne 🕶",
    softBadgeTitle: "Mit sichtbaren Entfernungen gespielt, daher nicht vergleichbar.",

    guessUnit: (n) => (n === 1 ? "Tipp" : "Tipps"),
    playerGaveUp: "🏳️ aufgegeben",
    streak: (days) => `🔥 ${days} Tage Serie`,
    timeTitle: "Spielzeit — dieser Gleichstand wurde damit entschieden",
    timeLabel: (time) => `in ${time}`,

    practice: "Übung",
    daily: "Täglich",
    practiceNew: "Neues Land",
    practiceStatus: (n) => `Übung · ${n} ${n === 1 ? "Tipp" : "Tipps"}`,
    practiceWon: (country, n) => `Übung · ${country} in ${n}`,
    practiceLost: (country) => `Übung · es war ${country}`,
  },
};

let current = "en";

export function setLanguage(lang) {
  current = lang in STRINGS ? lang : "en";
  return current;
}

export const getLanguage = () => current;

/** Look up a string, calling it with `args` when it is a template. */
export function t(key, ...args) {
  const table = STRINGS[current] || STRINGS.en;
  const value = key in table ? table[key] : STRINGS.en[key];
  if (value === undefined) throw new Error(`Missing UI string: ${key}`);
  return typeof value === "function" ? value(...args) : value;
}

/** Thousands-separated kilometres in the active language's grouping. */
export function formatKm(meters) {
  const locale = current === "de" ? "de-DE" : "en-US";
  return Math.round(meters / 1000).toLocaleString(locale);
}

/**
 * A play time as a clock reads it: `m:ss`, or `h:mm:ss` once there is an hour of
 * it. Deliberately not localised, and deliberately the same rendering the server
 * uses in its announcements -- the colons say the same thing in both languages,
 * and a spelled-out duration would not line up in a column.
 *
 * Anything that is not a duration renders as nothing, because the server sends
 * null for a board with no time to show.
 */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
