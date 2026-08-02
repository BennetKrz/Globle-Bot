"use strict";

/**
 * Game logic, with no knowledge of Discord or HTTP.
 *
 * Everything that decides what happens in a game lives here: fetching the day's
 * answer, scoring a guess, ending a game, and producing the state a player is
 * allowed to see.
 *
 * Two games share all of it. The daily is one answer for everyone, keyed by
 * date, and feeds the roster, the announcements and the group streak. A practice
 * game is a random country belonging to one player, recorded nowhere near a date
 * so it cannot reach any of those.
 *
 * The answer never leaves this module until the player has finished. `viewState`
 * omits it while a game is in progress, which is the only reason a browser can
 * be trusted with the rest of the state.
 *
 * Hard mode withholds the numbers. A hard board still carries its colours and
 * its ranking, but only the closest guess sends the distance it scored, and the
 * withholding happens here rather than in the client for the same reason: what
 * the browser never receives, it cannot show.
 *
 * The daily is always hard, so every board on a date was played under the same
 * rules and its guess counts compare. Practice is where the mode is a choice.
 */

const crypto = require("crypto");

const globle = require("./globle");
const store = require("./store");
const colour = require("./colour");
const clock = require("./clock");

const TZ = process.env.GLOBLE_TZ || "Europe/Berlin";

/** The date string whose answer is currently live, for every player. */
function today() {
  return globle.todayStr(TZ);
}

/** The calendar day before a YYYY-MM-DD string. */
function previousDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/**
 * How many days running the group has solved the daily.
 *
 * A day counts once any player has won it, so one person carries the whole
 * group. Today is excluded while it is still unsolved: an unfinished day has not
 * broken the streak, it just has not extended it yet.
 */
function groupStreak(date = today()) {
  let cursor = store.hasWinner(date) ? date : previousDay(date);
  let streak = 0;
  while (store.hasWinner(cursor)) {
    streak++;
    cursor = previousDay(cursor);
  }
  return streak;
}

/**
 * The answer feature for a date, fetched once and then served from the store.
 * @returns {Promise<object>} GeoJSON feature
 */
async function getAnswer(date) {
  let index = store.getAnswerIndex(date);
  if (index === null || index === undefined) {
    index = await globle.fetchAnswerIndex(date);
    store.setAnswerIndex(date, index);
  }
  return globle.FEATURES[index];
}

/**
 * A player's daily record, always on hard.
 *
 * New records are created hard by the store. The flag is asserted again here
 * because records written before the daily became hard-only are still in the
 * state file, and a day half on each set of rules would have guess counts that
 * do not compare.
 */
function getOrCreatePlayer(date, userId, displayName) {
  const player = store.getOrCreatePlayer(date, userId, displayName);
  if (!player.hard) {
    player.hard = true;
    store.touch();
  }
  return player;
}

/** Outcome codes returned to callers instead of thrown errors, so both layers can localise. */
const GUESS = {
  OK: "ok",
  WON: "won",
  UNKNOWN_COUNTRY: "unknown_country",
  DUPLICATE: "duplicate",
  ALREADY_FINISHED: "already_finished",
};

/**
 * Score one guess against an answer and append it to a game record.
 *
 * The record is anything carrying `guesses`, `finished`, `win` and `guessCount`,
 * which is both a daily player and a practice game.
 *
 * @returns {{status: string, guess?: object, country?: string, suggestion?: string|null}}
 */
function applyGuess(record, answer, rawInput) {
  if (record.finished) return { status: GUESS.ALREADY_FINISHED };

  const feature = globle.findCountry(rawInput);
  // A name that resolved to nothing is usually a name that was mistyped, so the
  // outcome carries the country it was probably reaching for. Nothing is scored
  // on it: the correction travels back to the player as a question.
  if (!feature) {
    return { status: GUESS.UNKNOWN_COUNTRY, suggestion: globle.suggestCountry(rawInput) };
  }

  const name = feature.properties.NAME;
  if (record.guesses.some((g) => g.name === name)) {
    return { status: GUESS.DUPLICATE, country: name };
  }

  const correct = name === answer.properties.NAME;
  const proximity = correct ? 0 : globle.polygonDistance(feature, answer);

  const guess = {
    name,
    proximity,
    emoji: globle.proximityEmoji(proximity, correct),
    correct,
  };
  record.guesses.push(guess);
  record.guessCount = record.guesses.length;

  if (correct) {
    record.finished = true;
    record.win = true;
    record.finishedAt = Date.now();
  }

  return {
    status: correct ? GUESS.WON : GUESS.OK,
    guess,
    country: name,
    showDistance: showsDistance(record, guess),
  };
}

// --- Hard mode --------------------------------------------------------------

/**
 * Whether a record's guesses may all carry the distance they scored.
 *
 * A finished game always may: hiding distances from a player who already knows
 * the answer protects nothing, and it would leave a hard board unreadable next
 * to everyone else's.
 */
function revealsProximity(record) {
  return !record.hard || record.finished;
}

/** Metres from the answer to the nearest border guessed so far, or null before the first guess. */
function closestProximity(record) {
  if (!record.guesses.length) return null;
  return Math.min(...record.guesses.map((g) => g.proximity));
}

/**
 * Whether one guess may carry its distance.
 *
 * The single number a hard game gives back is the closest border reached so far,
 * and it rides on the guess that reached it rather than above the board, so that
 * row reads like any other row and the rest read like it minus the kilometres.
 */
function showsDistance(record, guess) {
  return revealsProximity(record) || guess.proximity === closestProximity(record);
}

/**
 * The order a board is read in: the win first, then by distance.
 *
 * Ranking is what makes a hard board playable without its numbers, so it is
 * settled here rather than in the client, which cannot sort what it is not sent.
 * Neighbours of the answer also score 0 km, so the win has to outrank distance
 * rather than tie with it. The record's own order is left alone: the emoji grid
 * on the result card is chronological.
 */
function rankGuesses(guesses) {
  return [...guesses].sort(
    (a, b) => Number(b.correct) - Number(a.correct) || a.proximity - b.proximity
  );
}

/** Whether a game is still early enough to change mode: an empty board, and not over. */
function canSetHard(record) {
  return !record.finished && record.guesses.length === 0;
}

/**
 * Switch a game between hard and normal. Returns false once the game has started.
 *
 * The lock is what makes the mode mean anything. A game that could be switched
 * mid-play would hand back every distance it had been withholding, so the choice
 * belongs to the board before the first guess lands on it.
 */
function setHard(record, hard) {
  if (!canSetHard(record)) return false;
  record.hard = Boolean(hard);
  return true;
}

/**
 * One guess, shaped for a client: localised label plus its resolved fill colour.
 *
 * Without `showDistance` the guess keeps everything except its metres, which is
 * the only thing a hard board withholds.
 *
 * `code` is the same country in two characters. The player's own board has room
 * to spell a country out; a roster row is a strip of 12px squares and has room
 * for nothing else, so the short form travels with the long one and each side
 * uses the one that fits.
 */
async function describeGuess(guess, lang, showDistance = true) {
  return {
    name: guess.name,
    label: globle.displayName(guess.name, lang),
    code: globle.isoCode(guess.name),
    proximity: showDistance ? guess.proximity : null,
    emoji: guess.emoji,
    correct: !!guess.correct,
    colour: await colour.colourForGuess(guess),
  };
}

/**
 * Everything a player may see about one game of their own.
 *
 * While the game is in progress `answer` is null: the mystery country is not
 * sent to the client at all, so a player reading network traffic learns nothing.
 */
async function describeGame(record, answerFeature, lang, extra = {}) {
  const guesses = await Promise.all(
    rankGuesses(record.guesses).map((g) => describeGuess(g, lang, showsDistance(record, g)))
  );

  let answer = null;
  if (record.finished) {
    const name = answerFeature.properties.NAME;
    answer = { name, label: globle.displayName(name, lang), colour: colour.ANSWER_COLOUR };
  }

  return {
    lang,
    finished: record.finished,
    win: record.win,
    guessCount: record.guessCount,
    guesses,
    answer,
    hard: Boolean(record.hard),
    hardLocked: !canSetHard(record),
    ...extra,
  };
}

// --- The daily --------------------------------------------------------------

/** Score one guess in the daily and record it. */
async function submitGuess(date, userId, displayName, rawInput) {
  const player = getOrCreatePlayer(date, userId, displayName);
  const answer = await getAnswer(date);
  const outcome = applyGuess(player, answer, rawInput);

  // The clock runs from the first guess that scored to the one that ends the
  // game. A name that was rejected -- unknown, or already on the board -- moved
  // nothing, so it neither starts the clock nor counts as having been seen.
  if (outcome.status === GUESS.OK || outcome.status === GUESS.WON) {
    const at = Date.now();
    clock.start(player, at);
    clock.mark(player, at); // a guess is the strongest proof of presence there is
    if (player.finished) clock.close(player, player.finishedAt);
  }

  store.touch();
  return outcome;
}

/** End a daily game as a loss. Returns false when it had already ended. */
function giveUp(date, userId, displayName) {
  const player = getOrCreatePlayer(date, userId, displayName);
  if (player.finished) return false;
  player.finished = true;
  player.win = false;
  player.finishedAt = Date.now();
  // Surrendering stops the clock like winning does. A player who gave up without
  // ever guessing has no clock to stop, and this quietly does nothing.
  clock.close(player, player.finishedAt);
  store.touch();
  return true;
}

// --- The clock --------------------------------------------------------------

/**
 * The three things presence does to a player's clock.
 *
 * Each takes the date because the caller is the roster stream, which only ever
 * knows about today, while the record being written belongs to whichever day it
 * was opened on. Each is a no-op on a player who has not started or has already
 * finished: a clock is only running between those two points, and there is no
 * other state for these to reach.
 *
 * The moment is passed in rather than read here, so a pause can be backdated to
 * when the player actually went away rather than to when it was noticed.
 */
function pausePlayer(date, userId, at = Date.now()) {
  const player = store.getPlayer(date, userId);
  if (!player || player.finished) return false;
  if (!clock.close(player, at)) return false;
  store.touch();
  return true;
}

function resumePlayer(date, userId, at = Date.now()) {
  const player = store.getPlayer(date, userId);
  if (!player || player.finished) return false;
  if (!clock.resume(player, at)) return false;
  store.touch();
  return true;
}

function markPlayerSeen(date, userId, at = Date.now()) {
  const player = store.getPlayer(date, userId);
  if (!player || player.finished) return false;
  if (!clock.mark(player, at)) return false;
  store.touch();
  return true;
}

/**
 * Stop every clock still running on a date.
 *
 * A day that has rolled over has no live game left in it, so a segment still
 * open belongs to a player who was mid-game when midnight arrived and is now
 * playing a different day. Also the last thing the process does on its way out,
 * where it closes at the moment it really stopped rather than leaving the mark
 * on disk to be repaired on the next start.
 */
function endDay(date, at = Date.now()) {
  let changed = false;
  for (const player of store.playersOn(date)) {
    if (clock.close(player, at)) changed = true;
  }
  if (changed) store.touch();
  return changed;
}

async function viewState(date, userId, displayName, lang) {
  const player = getOrCreatePlayer(date, userId, displayName);
  const answer = player.finished ? await getAnswer(date) : null;
  // Locked whatever the board looks like: hard is the daily's rule, not a
  // setting an empty board is still waiting on.
  return describeGame(player, answer, lang, { mode: "daily", date, hardLocked: true });
}

/**
 * Everyone playing today, in the shape the activity's roster renders.
 *
 * Every row carries an emoji grid, in progress or not, so the roster shows the
 * day unfolding rather than only its results. A square says which proximity band
 * a guess landed in and nothing else; without the country under it, a grid full
 * of red points at no part of the map, so the live ones are safe to hand out.
 *
 * `revealBoards` upgrades a finished player's grid to their full guesses --
 * names, codes, distances and fills -- and it is set only for a viewer who has
 * finished themselves, because the winning row names the answer. The line is
 * drawn here rather than in the client, which cannot hide what it was sent.
 *
 * Two orders meet in a row, and they are not the same one. The rows arrive
 * ranked, from `store.playersOn`: winners by guess count, ties between them by
 * the clock, then the give-ups, then whoever is still going. Within a row the
 * squares stay in the order they were played in, unlike a board's own ranking --
 * the squares are how the day went, and a run read left to right is the story
 * of someone closing in.
 *
 * @param {object} opts
 * @param {boolean} opts.revealBoards  the viewer has finished and may see full boards
 * @param {Set<string>} [opts.online]  user ids with the activity open right now
 */
async function roster(date, lang, { revealBoards = false, online = new Set() } = {}) {
  const players = store.playersOn(date);
  // Whose row the clock is actually deciding. Everyone else's time is left off
  // the payload entirely rather than sent and hidden: the client cannot show
  // what it was never given, and this is the one place the rule has to live.
  const tied = clock.contested(players);

  return Promise.all(
    players.map(async (p) => ({
      userId: p.userId,
      displayName: p.displayName,
      online: online.has(p.userId),
      finished: p.finished,
      win: p.win,
      hard: Boolean(p.hard),
      guessCount: p.guessCount,
      finishedAt: p.finishedAt,
      // The time, on the rows a tie is being broken on and nowhere else. Null
      // everywhere else, including a tied row whose timeline the ranking
      // refused, so a duration on the panel is always the one that put the name
      // beside it where it is. Nothing about a duration points at a country, so
      // the rows that do carry one are safe to send to every viewer.
      elapsedMs: tied.has(p.userId) ? clock.settled(p) : null,
      guesses:
        revealBoards && p.finished
          ? await Promise.all(p.guesses.map((g) => describeGuess(g, lang)))
          : p.guesses.map((g) => ({ emoji: g.emoji })),
    }))
  );
}

// --- Practice ---------------------------------------------------------------

/**
 * A fresh practice game on a random country.
 *
 * `crypto.randomInt` rather than `Math.random`: the same process serves the
 * daily, and a predictable sequence here would be one more thing to reason about.
 */
function startPractice(userId) {
  return store.setPractice(userId, {
    answerIndex: crypto.randomInt(globle.FEATURES.length),
    guesses: [],
    finished: false,
    win: false,
    guessCount: 0,
    finishedAt: null,
    hard: store.getHardDefault(userId),
  });
}

function getOrStartPractice(userId) {
  return store.getPractice(userId) || startPractice(userId);
}

function practiceAnswer(practice) {
  return globle.FEATURES[practice.answerIndex];
}

function submitPracticeGuess(userId, rawInput) {
  const practice = getOrStartPractice(userId);
  const outcome = applyGuess(practice, practiceAnswer(practice), rawInput);
  store.touch();
  return outcome;
}

function giveUpPractice(userId) {
  const practice = getOrStartPractice(userId);
  if (practice.finished) return false;
  practice.finished = true;
  practice.win = false;
  practice.finishedAt = Date.now();
  store.touch();
  return true;
}

/** Set the mode of a practice game, and of the games created after it. */
function setPracticeHard(userId, hard) {
  const practice = getOrStartPractice(userId);
  if (!setHard(practice, hard)) return false;
  store.setHardDefault(userId, hard);
  store.touch();
  return true;
}

function practiceState(userId, lang) {
  const practice = getOrStartPractice(userId);
  return describeGame(practice, practiceAnswer(practice), lang, { mode: "practice" });
}

module.exports = {
  GUESS,
  TZ,
  today,
  previousDay,
  groupStreak,
  getAnswer,
  getOrCreatePlayer,
  submitGuess,
  giveUp,
  pausePlayer,
  resumePlayer,
  markPlayerSeen,
  endDay,
  viewState,
  roster,
  describeGuess,
  startPractice,
  submitPracticeGuess,
  giveUpPractice,
  setPracticeHard,
  practiceState,
};
