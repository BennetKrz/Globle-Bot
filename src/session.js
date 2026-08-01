"use strict";

/**
 * Activity sessions.
 *
 * The browser never tells the server who it is. It presents an opaque session
 * token, minted only after the server has exchanged the player's OAuth code and
 * asked Discord who they are, so a request cannot claim another player's id.
 *
 * Sessions live in memory: an activity session is bounded by the player having
 * the iframe open, and a restart just makes the client redo the handshake. Game
 * progress is in the store and survives independently.
 */

const crypto = require("crypto");

/** How long a session token stays valid without being used. */
const TTL_MS = 12 * 60 * 60 * 1000;

/** @type {Map<string, {userId: string, displayName: string, guildId: string|null, channelId: string|null, instanceId: string, locale: string|null, expiresAt: number}>} */
const sessions = new Map();

function create(details) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { ...details, expiresAt: Date.now() + TTL_MS });
  return token;
}

/** The session for a token, or null when it is unknown or expired. */
function get(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + TTL_MS; // sliding window: active players stay signed in
  return session;
}

/** Drop expired sessions. Called on a timer so an idle server does not grow. */
function sweep() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

const sweepTimer = setInterval(sweep, 30 * 60 * 1000);
sweepTimer.unref(); // never hold the process open on our own account

module.exports = { create, get, sweep, TTL_MS };
