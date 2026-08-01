"use strict";

/**
 * The Discord gateway client, and the DM lockdown that wraps it.
 *
 * Sending a direct message needs no gateway intent, so an empty intent list is
 * not a safeguard. The block has to sit on the paths that create a DM channel.
 * Three layers, from the outside in:
 *
 *   1. `announce.js` is the only module that sends anything, and it refuses any
 *      channel where `isDMBased()` is true.
 *   2. `UserManager#createDM` throws. Every discord.js route to a DM funnels
 *      through it -- `user.send`, `member.send`, `user.createDM`,
 *      `client.users.send`, `client.users.createDM` -- so one override closes
 *      all of them.
 *   3. The raw `POST /users/@me/channels` request throws, which catches code
 *      that reaches past the manager into the REST layer.
 *
 * Layers 2 and 3 reach into discord.js internals on purpose: they are the choke
 * points, and a failing override is better than a silent DM. Re-check them on a
 * discord.js major upgrade.
 */

const { Client, Events, GatewayIntentBits, UserManager, Routes } = require("discord.js");

const DM_BLOCKED = "Direct messages are disabled in this app.";

UserManager.prototype.createDM = function createDM() {
  throw new Error(DM_BLOCKED);
};

const client = new Client({
  // Guilds only: the app reads no message content and receives no DM events.
  intents: [GatewayIntentBits.Guilds],
  // Nothing pings unless a send opts in explicitly. Player-supplied text can
  // then never produce a mention by accident.
  allowedMentions: { parse: [] },
});

const restPost = client.rest.post.bind(client.rest);
client.rest.post = (route, options) => {
  if (String(route) === Routes.userChannels()) throw new Error(DM_BLOCKED);
  return restPost(route, options);
};

/** Log in and resolve once the gateway is ready. */
function start(token) {
  return new Promise((resolve, reject) => {
    client.once(Events.ClientReady, () => resolve(client));
    client.once(Events.Error, reject);
    client.login(token).catch(reject);
  });
}

module.exports = { client, start, DM_BLOCKED };
