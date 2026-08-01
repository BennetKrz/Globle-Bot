"use strict";

/**
 * Entry point. Brings up the gateway client, the launcher command, and the HTTP
 * server that hosts the Discord Activity.
 *
 * The gateway client exists for three things: opening the activity from
 * `/globle`, posting the finish announcement into a channel, and posting the
 * day's summary there once the date rolls over. Nothing in this process can send
 * a direct message -- see client.js for how that is enforced.
 *
 * With DEV_LOGIN set the server starts on its own, with no Discord credentials
 * at all, so the map can be opened in a browser while it is being worked on.
 */

require("dotenv").config();

const game = require("./game");
const { createApp, listen } = require("./server");

const PORT = Number(process.env.PORT || 3000);
const DEV_LOGIN = process.env.DEV_LOGIN === "1" && process.env.NODE_ENV !== "production";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in the environment (.env). See .env.example.`);
    process.exit(1);
  }
  return value;
}

/**
 * Log in to Discord, unless this is a development run without credentials, in
 * which case the announcement path is simply unavailable.
 *
 * @returns {Promise<import("discord.js").Client|null>}
 */
async function connectToDiscord() {
  if (DEV_LOGIN && !process.env.DISCORD_TOKEN) {
    console.warn("No DISCORD_TOKEN: running the activity server alone, without announcements.");
    return null;
  }
  const { client, start } = require("./client");
  await start(required("DISCORD_TOKEN"));
  console.log(`Globle ready as ${client.user.tag} (timezone: ${game.TZ})`);
  require("./launch").attach(client);
  return client;
}

async function main() {
  const client = await connectToDiscord();
  require("./summary").start(client);

  const app = createApp({
    client,
    applicationId: DEV_LOGIN ? process.env.CLIENT_ID || "dev" : required("CLIENT_ID"),
    clientSecret: DEV_LOGIN ? process.env.CLIENT_SECRET || "dev" : required("CLIENT_SECRET"),
    botToken: process.env.DISCORD_TOKEN || "",
  });

  await listen(app, PORT);
  console.log(`Activity server listening on port ${PORT}`);
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
