"use strict";

/**
 * Play time, kept as the stretches a game was actually being played rather than
 * as a number of milliseconds.
 *
 * A daily player's record carries `play`: a series of segments, each a `start`
 * and the `end` that closed it, in the order they happened. At most one is open
 * -- always the last -- and an open segment is one the player is inside right
 * now. The total is added up on demand and never stored, so a segment that
 * turns out to be wrong can be repaired without a running total having already
 * been built on top of it.
 *
 * The clock starts on the first guess that scored, not on opening the activity:
 * a player turning the globe before naming anything has not started playing. It
 * stops on the guess that won, or on the surrender. In between it pauses every
 * time the player closes the activity and resumes when they come back, which is
 * why this is a series and not two timestamps -- what is measured is time spent
 * playing, not time since starting.
 *
 * Nothing here throws, and nothing here trusts what it reads. A state file gets
 * edited by hand, survives crashes, and outlives the code that wrote it, so
 * every function treats `play` as something that may be missing, may be the
 * wrong shape, and may hold a segment nobody ever closed.
 *
 * That last case is why reading splits in two:
 *
 *   `elapsed` is for display, and answers with the best number it can.
 *   `settled` is for ranking, and answers with null unless every segment is
 *   closed and sane -- so a timeline left running loses a tie instead of
 *   winning one with a number that means nothing.
 *
 * Practice games have no `play` and never get one. The clock exists to decide
 * the daily's ties, and a practice game is in no ranking to tie in.
 */

/** Whether one entry is a segment at all. A start is the least it can be. */
function isSegment(segment) {
  return Boolean(segment) && typeof segment === "object" && Number.isFinite(segment.start);
}

function isClosed(segment) {
  return Number.isFinite(segment.end);
}

/** The record's segments, or null when it has none that can be walked. */
function segmentsOf(record) {
  const play = record && record.play;
  return Array.isArray(play) ? play : null;
}

/**
 * The index of the segment that is running, or -1.
 *
 * Only the last segment may be open. An open one anywhere else is left over
 * from something that went wrong, and is deliberately not found here: it is
 * stale rather than live, and counting it to `now` would invent time.
 */
function openIndex(play) {
  const last = play.length - 1;
  const segment = play[last];
  return isSegment(segment) && !isClosed(segment) ? last : -1;
}

/** Whether the game has been started at all, which is to say has been guessed in. */
function started(record) {
  const play = segmentsOf(record);
  return Boolean(play && play.length);
}

/** Whether the clock is running right now. */
function running(record) {
  const play = segmentsOf(record);
  return Boolean(play && openIndex(play) >= 0);
}

/**
 * Start the clock on a game that has not been played yet. Returns false when it
 * was already started, which is every guess after the first.
 */
function start(record, at = Date.now()) {
  if (!record || !Number.isFinite(at)) return false;
  if (!Array.isArray(record.play)) record.play = [];
  if (record.play.length) return false;
  record.play.push({ start: at, end: null, seen: at });
  return true;
}

/**
 * Start counting again after a pause. Returns false when there is nothing to
 * resume: a game with no first guess yet, one that is already over, or one whose
 * clock never stopped.
 */
function resume(record, at = Date.now()) {
  const play = segmentsOf(record);
  if (!play || !play.length || !Number.isFinite(at)) return false;
  if (record.finished) return false;
  if (openIndex(play) >= 0) return false;
  play.push({ start: at, end: null, seen: at });
  return true;
}

/**
 * Stop the running segment at `at`. This is both the pause and the finish: the
 * difference between them is whether anything opens a segment afterwards.
 *
 * `at` is clamped forward to the segment's own start, so a clock the system put
 * back between the two can shorten a segment to nothing but never past it.
 */
function close(record, at = Date.now()) {
  const play = segmentsOf(record);
  if (!play) return false;
  const index = openIndex(play);
  if (index < 0) return false;
  const segment = play[index];
  const end = Number.isFinite(at) ? at : lastMark(segment);
  segment.end = Math.max(segment.start, end);
  delete segment.seen;
  return true;
}

/** The last moment a segment was known to be running: its mark, else its start. */
function lastMark(segment) {
  return Number.isFinite(segment.seen) ? segment.seen : segment.start;
}

/**
 * Note that the running segment is still running.
 *
 * A process that is killed cannot close what it had open, so the open segment
 * carries the last time anybody saw it -- refreshed by the stream's heartbeat
 * and by every guess. `repair` closes at that mark on the next start, which
 * bounds what an unclean exit costs to one heartbeat of one player's time
 * rather than to the rest of their day.
 */
function mark(record, at = Date.now()) {
  const play = segmentsOf(record);
  if (!play || !Number.isFinite(at)) return false;
  const index = openIndex(play);
  if (index < 0) return false;
  if (play[index].seen === at) return false;
  play[index].seen = at;
  return true;
}

/**
 * Put a timeline back into a state the rest of this file can trust: close every
 * segment still open, and drop every entry that is not a segment.
 *
 * Open segments are closed at their own mark rather than at `at`, because this
 * runs when the process that was keeping them open is already gone and the mark
 * is the last thing it managed to say. `at` is only a ceiling, for a mark that
 * somehow points into the future.
 *
 * Returns whether anything changed, so a caller can skip a write.
 */
function repair(record, at = Date.now()) {
  const play = segmentsOf(record);
  if (!play) return false;

  let changed = false;
  for (const segment of play) {
    if (!isSegment(segment) || isClosed(segment)) continue;
    const end = Number.isFinite(at) ? Math.min(lastMark(segment), at) : lastMark(segment);
    segment.end = Math.max(segment.start, end);
    delete segment.seen;
    changed = true;
  }

  const kept = play.filter(isSegment);
  if (kept.length !== play.length) {
    record.play = kept;
    changed = true;
  }
  return changed;
}

/**
 * How long a game has been played, in milliseconds, for something a person
 * reads. Always a number, and never a throw: every segment it cannot make sense
 * of contributes nothing rather than poisoning the total.
 *
 * The running segment counts up to `now`, but only while the game is unfinished
 * and only when it is the last one. A finished game with a segment still open
 * is a timeline that went wrong, and a row on the roster that ticked forever
 * would be the visible half of that.
 */
function elapsed(record, now = Date.now()) {
  const play = segmentsOf(record);
  if (!play) return 0;
  const live = record.finished ? -1 : openIndex(play);

  let total = 0;
  for (let i = 0; i < play.length; i++) {
    const segment = play[i];
    if (!isSegment(segment)) continue;
    const end = isClosed(segment) ? segment.end : i === live ? now : lastMark(segment);
    total += Math.max(0, end - segment.start);
  }
  return total;
}

/**
 * The total a ranking is allowed to use, or null when there is not one.
 *
 * Null for a game that was never played, and null for any timeline this cannot
 * vouch for: an entry that is not a segment, one that never closed, one that
 * closed before it started. Callers sort null last, so an unstopped clock costs
 * its owner the tiebreak instead of handing them a fictitious win.
 */
function settled(record) {
  const play = segmentsOf(record);
  if (!play || !play.length) return null;

  let total = 0;
  for (const segment of play) {
    if (!isSegment(segment) || !isClosed(segment)) return null;
    if (segment.end < segment.start) return null;
    total += segment.end - segment.start;
  }
  return total;
}

/**
 * The number to put in front of a player, or null for nothing to show.
 *
 * A finished game shows what it is ranked on, so a board the ranking rejects
 * shows nothing rather than a time that will not be counted. An unfinished one
 * shows what it has run up so far.
 */
function shown(record, now = Date.now()) {
  if (!record) return null;
  if (record.finished) return settled(record);
  if (!started(record)) return null;
  return elapsed(record, now);
}

/**
 * The ids on a leaderboard whose standing actually turns on the clock: winners
 * sharing their guess count with another winner.
 *
 * A time is only ever the answer to "which of these two was faster", so it is
 * worth putting in front of anyone at all only where there is another row it is
 * being compared against. Everybody else is placed by the count alone, and a
 * duration beside their name would be a number that explains nothing about
 * where they are -- an invitation to race the clock in a game that is not timed.
 *
 * Computed over whichever list is being shown, because the tie that matters is
 * the one the reader can see. The day's summary is per channel, so two players
 * level on guesses in different channels are not tied on either one's board.
 */
function contested(players) {
  const winnersByCount = new Map();
  for (const player of players || []) {
    if (!player || !player.win) continue;
    const level = winnersByCount.get(player.guessCount);
    if (level) level.push(player.userId);
    else winnersByCount.set(player.guessCount, [player.userId]);
  }

  const ids = new Set();
  for (const level of winnersByCount.values()) {
    if (level.length < 2) continue;
    for (const id of level) ids.add(id);
  }
  return ids;
}

/**
 * A duration as a clock reads it: `m:ss`, or `h:mm:ss` once there is an hour of
 * it. Not localised -- the colons say the same thing in both languages, and a
 * spelled-out duration would not line up in a column.
 */
function format(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

module.exports = {
  started,
  running,
  start,
  resume,
  close,
  mark,
  repair,
  elapsed,
  settled,
  shown,
  contested,
  format,
};
