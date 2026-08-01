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
    duplicate: (country) => `${country} was already guessed.`,
    offline: "Lost the connection to the server.",
    sessionExpired: "Session expired. Reopen the activity.",
    noWebgl: "3D is unavailable here, showing the flat map.",
    launchFailed: "Could not start the activity.",
    guildOnly: "Globle is played in a server, not in a direct message.",
    instanceUnavailable: "Could not confirm which channel this is. Open the activity again.",
    kmAway: (km) => `${km} km`,
    revealHint: "Click to reveal the country name",

    // Hard mode
    hard: "Hard",
    hardLocked: "Hard mode only changes before the first guess.",
    hardBadge: "🕶",
    hardBadgeTitle: "Playing hard mode",

    // Roster
    guessUnit: (n) => (n === 1 ? "guess" : "guesses"),
    playerGaveUp: "🏳️ gave up",
    streak: (days) => `🔥 ${days} day streak`,

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
    duplicate: (country) => `${country} wurde schon geraten.`,
    offline: "Verbindung zum Server verloren.",
    sessionExpired: "Sitzung abgelaufen. Aktivität neu öffnen.",
    noWebgl: "3D ist hier nicht verfügbar, es wird die flache Karte gezeigt.",
    launchFailed: "Aktivität konnte nicht gestartet werden.",
    guildOnly: "Globle wird auf einem Server gespielt, nicht in Direktnachrichten.",
    instanceUnavailable: "Der Kanal ließ sich nicht bestimmen. Aktivität erneut öffnen.",
    kmAway: (km) => `${km} km`,
    revealHint: "Klicken, um den Ländernamen zu sehen",

    hard: "Schwer",
    hardLocked: "Schwer lässt sich nur vor dem ersten Tipp umstellen.",
    hardBadge: "🕶",
    hardBadgeTitle: "Spielt im schweren Modus",

    guessUnit: (n) => (n === 1 ? "Tipp" : "Tipps"),
    playerGaveUp: "🏳️ aufgegeben",
    streak: (days) => `🔥 ${days} Tage Serie`,

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
