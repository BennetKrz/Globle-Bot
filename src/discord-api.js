"use strict";

/**
 * The Discord REST calls the activity's OAuth handshake needs, without going
 * through discord.js (these run on a user's Bearer token, which the gateway
 * client has no concept of).
 */

const API = "https://discord.com/api/v10";

async function call(path, options, what) {
  const res = await fetch(`${API}${path}`, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${what} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Trade the code from `authorize` for an access token. The activity flow sends
 * no redirect_uri, and the body is form-encoded rather than JSON.
 */
async function exchangeCode({ clientId, clientSecret, code }) {
  return call(
    "/oauth2/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
      }),
    },
    "OAuth token exchange"
  );
}

/** Who the access token belongs to. Requires the `identify` scope. */
async function currentUser(accessToken) {
  return call("/users/@me", { headers: { Authorization: `Bearer ${accessToken}` } }, "users/@me");
}

/**
 * The player's guild profile, for their server nickname. Requires
 * `guilds.members.read`; returns null when the scope was not granted rather than
 * failing the handshake over a display name.
 */
async function guildMember(accessToken, guildId) {
  try {
    return await call(
      `/users/@me/guilds/${guildId}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "guild member"
    );
  } catch {
    return null;
  }
}

/** Attempts at the instance lookup, and the wait between them. */
const INSTANCE_ATTEMPTS = 3;
const INSTANCE_RETRY_MS = 350;

/**
 * Where an activity instance is actually running, straight from Discord.
 *
 * The client's own `channelId` is not trustworthy -- the iframe is publicly
 * reachable and the RPC protocol is spoofable -- so both the channel an
 * announcement goes to and the decision to admit the session at all are resolved
 * here instead, on a bot token. `location.kind` is what distinguishes a guild
 * channel ("gc") from a direct or group message ("pc").
 *
 * A browser can reach the handshake before Discord has registered the instance,
 * which answers 404 for a moment. The caller refuses a session it cannot place,
 * so the race is retried here rather than costing a player their game.
 */
async function activityInstance({ botToken, applicationId, instanceId }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(
        `/applications/${applicationId}/activity-instances/${instanceId}`,
        { headers: { Authorization: `Bot ${botToken}` } },
        "activity instance lookup"
      );
    } catch (e) {
      if (attempt >= INSTANCE_ATTEMPTS) throw e;
      await new Promise((resolve) => setTimeout(resolve, INSTANCE_RETRY_MS));
    }
  }
}

/** Discord's own name for a user, preferring their per-guild nickname. */
function displayNameOf(user, member) {
  if (member && member.nick) return member.nick;
  if (user.global_name) return user.global_name;
  return user.username;
}

module.exports = { exchangeCode, currentUser, guildMember, activityInstance, displayNameOf };
