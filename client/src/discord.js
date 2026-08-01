/**
 * The Discord handshake.
 *
 * Order matters and every step is required: the SDK must be ready before it
 * answers commands, `authorize` produces a code that only the server can
 * exchange (the client secret never reaches the browser), and `authenticate`
 * hands the resulting token back to the Discord client, which is what lets the
 * activity call scoped commands afterwards.
 *
 * The access token is used for `authenticate` and nothing else. Calls to this
 * app's own API carry the opaque session token instead, so the API's notion of
 * who a request belongs to comes from the server's own lookup rather than from
 * anything the browser could substitute.
 */

import { DiscordSDK } from "@discord/embedded-app-sdk";
import { openSession, openDevSession } from "./api.js";

/**
 * `identify` names the player and reveals their Discord language,
 * `guilds.members.read` gets their server nickname, and
 * `applications.commands` is deliberately absent, though the SDK's own samples
 * request it. It installs commands into a guild, so asking for it turns the
 * player's consent screen into an install prompt with a server picker that only
 * a member holding Manage Server can answer. This app's commands are registered
 * with the bot token, so no player is ever the one granting them..
 */
const SCOPES = ["identify", "guilds.members.read""];

/**
 * Run the full handshake.
 *
 * @param {string} clientId  the application id
 * @returns {Promise<{sdk: import("@discord/embedded-app-sdk").DiscordSDK, session: object}>}
 */
export async function connect(clientId) {
  // The SDK constructor throws unless Discord's own query parameters are
  // present, so opening the page in a plain browser cannot go through the real
  // handshake. That path exists to develop the map without Discord in the way,
  // and the server refuses it unless it was started for development.
  if (!new URLSearchParams(location.search).has("frame_id")) {
    console.warn("No Discord frame detected: starting a development session.");
    return { sdk: null, session: await openDevSession() };
  }

  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: SCOPES,
  });

  const session = await openSession({ code, instanceId: sdk.instanceId });

  const auth = await sdk.commands.authenticate({ access_token: session.accessToken });
  if (auth == null) throw new Error("Discord rejected the authenticate command");

  return { sdk, session };
}

/** Watch the frame's layout mode so the board re-fits when Discord resizes it. */
export function onLayoutChange(sdk, handler) {
  if (!sdk) return () => {}; // development session: there is no frame to track
  const listener = () => handler();
  sdk.subscribe("ACTIVITY_LAYOUT_MODE_UPDATE", listener);
  return () => sdk.unsubscribe("ACTIVITY_LAYOUT_MODE_UPDATE", listener);
}
