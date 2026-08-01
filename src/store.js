"use strict";

/**
 * Tiny JSON-file store for per-user games.
 *
 * Shape:
 * {
 *   byDate: {
 *     "2026-06-05": {
 *       answerIndex: 196,
 *       summaryPosted: bool,
 *       players: {
 *         "<userId>": {
 *           userId, displayName, guesses: [{ name, proximity, emoji, correct }],
 *           finished: bool, win: bool, guessCount, finishedAt, hard: bool,
 *           channelId: string | undefined
 *         }
 *       }
 *     }
 *   },
 *   users: {
 *     "<userId>": {
 *       language: "en" | "de",
 *       hard: bool,
 *       practice: { answerIndex, guesses, finished, win, guessCount, hard }
 *     }
 *   }
 * }
 *
 * Every game carries its own `hard`, because the mode is fixed at the moment its
 * first guess lands and a later change must not reach a game already played. The
 * flag beside the language is only the value a new game starts with.
 *
 * Guesses store the dataset's canonical English country NAME, never a localised
 * label, so a player switching language keeps their history.
 *
 * A practice game sits beside the language choice rather than under a date. It
 * belongs to no day, so nothing that reads `byDate` -- the live roster, the
 * day's results, the group streak -- can ever pick one up.
 */

const fs = require("fs");
const path = require("path");

/**
 * Where to persist the writable game state. On ephemeral hosts (Railway, Fly,
 * containers) this MUST live on a persistent volume, not the app directory,
 * or it resets on every deploy. Resolution order:
 *   1. STATE_FILE                      - explicit full path
 *   2. RAILWAY_VOLUME_MOUNT_PATH/...   - auto-detected Railway volume
 *   3. <project>/data/state.json       - local default (dev)
 */
function resolveStateFile() {
  if (process.env.STATE_FILE) return path.resolve(process.env.STATE_FILE);
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "state.json");
  }
  return path.join(__dirname, "..", "data", "state.json");
}

const FILE = resolveStateFile();

let state = { byDate: {}, users: {} };

function load() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true }); // ensure the dir (e.g. volume mount) exists
  } catch (e) {
    console.error("Could not create state directory:", e.message);
  }
  try {
    state = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!state.byDate) state.byDate = {};
    if (!state.users) state.users = {}; // added after the first release; older files lack it
  } catch {
    state = { byDate: {}, users: {} };
  }
  console.log(`Globle state file: ${FILE}`);
}
load();

let saveTimer = null;
function save() {
  // Debounced atomic write.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error("Failed to save state:", e);
    }
  }, 250);
}

/** The stored day, or null. Reading a date never brings it into existence. */
function peekDay(date) {
  return state.byDate[date] || null;
}

/** The stored day, created on demand. Only callers that are about to write use this. */
function getDay(date) {
  if (!state.byDate[date]) state.byDate[date] = { answerIndex: null, players: {} };
  return state.byDate[date];
}

function getAnswerIndex(date) {
  const day = peekDay(date);
  return day ? day.answerIndex : null;
}

function setAnswerIndex(date, index) {
  getDay(date).answerIndex = index;
  save();
}

function getPlayer(date, userId) {
  return peekDay(date)?.players[userId] || null;
}

function getOrCreatePlayer(date, userId, displayName) {
  const day = getDay(date);
  if (!day.players[userId]) {
    day.players[userId] = {
      userId,
      displayName,
      guesses: [],
      finished: false,
      win: false,
      guessCount: 0,
      finishedAt: null,
      hard: getHardDefault(userId),
    };
  } else if (displayName) {
    day.players[userId].displayName = displayName; // keep name fresh
  }
  save();
  return day.players[userId];
}

/**
 * Everyone who has touched a date, finished or not.
 *
 * Sorted the way the roster reads: finishers first (winners by guess count,
 * then the order they finished in), and players still going after them, furthest
 * along first.
 */
function playersOn(date) {
  const day = peekDay(date);
  if (!day) return [];
  return Object.values(day.players).sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished) {
      if (a.win !== b.win) return a.win ? -1 : 1;
      if (a.guessCount !== b.guessCount) return a.guessCount - b.guessCount;
      return (a.finishedAt || 0) - (b.finishedAt || 0);
    }
    if (a.guessCount !== b.guessCount) return b.guessCount - a.guessCount;
    return a.displayName.localeCompare(b.displayName);
  });
}

/** All finished players for a date, sorted: winners first (fewest guesses), then give-ups. */
function finishedPlayers(date) {
  return playersOn(date).filter((p) => p.finished);
}

/**
 * Remember which channel a player played a date from.
 *
 * The finish announcement takes its channel from the live session. The day's
 * summary is posted after midnight, when no session is left to ask, so the
 * channel has to outlive the games that were played in it.
 */
function setPlayerChannel(date, userId, channelId) {
  const player = getPlayer(date, userId);
  if (!player || !channelId || player.channelId === channelId) return;
  player.channelId = channelId;
  save();
}

/** The distinct channels a date was played from. */
function channelsOn(date) {
  const day = peekDay(date);
  if (!day) return [];
  return [...new Set(Object.values(day.players).map((p) => p.channelId).filter(Boolean))];
}

/**
 * Whether a date's summary has already gone out. The flag is stored with the day
 * rather than held in memory, so a restart after midnight does not post it twice.
 */
function summaryPosted(date) {
  return Boolean(peekDay(date)?.summaryPosted);
}

function markSummaryPosted(date) {
  const day = peekDay(date);
  if (!day) return;
  day.summaryPosted = true;
  save();
}

/** Whether anyone solved a date. This is what the group streak counts. */
function hasWinner(date) {
  const day = peekDay(date);
  if (!day) return false;
  return Object.values(day.players).some((p) => p.win);
}

/**
 * Erase one player's record for a date. Returns false when they had none.
 *
 * The day and everyone else on it survive, including the answer index: the same
 * country is still the day's answer, so replaying is replaying today's puzzle.
 */
function resetPlayer(date, userId) {
  const day = peekDay(date);
  if (!day || !day.players[userId]) return false;
  delete day.players[userId];
  save();
  return true;
}

/**
 * Erase a whole date: every player on it, and the answer index with them.
 *
 * Dropping the index costs one refetch from globle-game.com, which is what makes
 * this a reset of the day rather than of its scoreboard.
 */
function resetDay(date) {
  if (!state.byDate[date]) return false;
  delete state.byDate[date];
  save();
  return true;
}

/** Per-user lifetime stats across all stored dates. Practice games are not counted. */
function userStats(userId) {
  let played = 0;
  let wins = 0;
  let totalGuessesOnWins = 0;
  let best = null;
  for (const day of Object.values(state.byDate)) {
    const p = day.players[userId];
    if (!p || !p.finished) continue;
    played++;
    if (p.win) {
      wins++;
      totalGuessesOnWins += p.guessCount;
      if (best === null || p.guessCount < best) best = p.guessCount;
    }
  }
  return {
    played,
    wins,
    winRate: played ? Math.round((wins / played) * 100) : 0,
    avgGuesses: wins ? (totalGuessesOnWins / wins).toFixed(1) : null,
    best,
  };
}

function getUser(userId) {
  if (!state.users[userId]) state.users[userId] = {};
  return state.users[userId];
}

/**
 * The language a user explicitly chose, or null when they never chose one.
 * A null result means the caller should fall back to the Discord client locale.
 */
function getLanguage(userId) {
  return state.users[userId]?.language || null;
}

function setLanguage(userId, language) {
  getUser(userId).language = language;
  save();
}

/**
 * The mode a user's next game starts in.
 *
 * Hard mode locks once a game has a guess in it, so without a remembered choice
 * a player would have to reach for the toggle before every daily, and lose the
 * mode outright by guessing first.
 */
function getHardDefault(userId) {
  return state.users[userId]?.hard === true;
}

function setHardDefault(userId, hard) {
  getUser(userId).hard = Boolean(hard);
  save();
}

/** The user's practice game, or null when they have not started one. */
function getPractice(userId) {
  return state.users[userId]?.practice || null;
}

function setPractice(userId, practice) {
  getUser(userId).practice = practice;
  save();
  return practice;
}

function touch() {
  save();
}

module.exports = {
  getAnswerIndex,
  setAnswerIndex,
  getPlayer,
  getOrCreatePlayer,
  playersOn,
  finishedPlayers,
  hasWinner,
  setPlayerChannel,
  channelsOn,
  summaryPosted,
  markSummaryPosted,
  resetPlayer,
  resetDay,
  userStats,
  getLanguage,
  setLanguage,
  getHardDefault,
  setHardDefault,
  getPractice,
  setPractice,
  touch,
};
