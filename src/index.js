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
const store = require("./store");
const events = require("./events");
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
  const token = required("DISCORD_TOKEN");
  await start(token);
  console.log(`Globle ready as ${client.user.tag} (timezone: ${game.TZ})`);
  require("./launch").attach(client);
  // The daily summary aligns its columns with an emoji that has to exist before
  // it can be used. Awaited so the first summary of a fresh deploy already has
  // it, but never fatal: a failure costs the columns, not the announcements.
  await require("./emoji").ensurePadEmoji({
    botToken: token,
    applicationId: client.application?.id || process.env.CLIENT_ID,
  });
  return client;
}

/**
 * Stop on the signals a container stops with.
 *
 * A redeploy in the middle of the evening catches players mid-game, and their
 * clocks are running when it lands. Closing them here stops them at the moment
 * they really stopped; store.js repairs what a hard kill leaves behind, at the
 * cost of a heartbeat, so this is the path that loses nothing.
 *
 * Everything in it is best-effort and none of it may keep the process alive:
 * the timer is the promise that this exits whether or not the sockets agree.
 */
function stopOn(signals, server) {
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down.`);
    try {
      events.closeAll();
      game.endDay(game.today());
      store.flush();
    } catch (e) {
      console.error("Shutdown cleanup failed:", e);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  for (const signal of signals) process.on(signal, () => stop(signal));
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

  const server = await listen(app, PORT);
  stopOn(["SIGTERM", "SIGINT"], server);
  console.log(`Activity server listening on port ${PORT}`);
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
