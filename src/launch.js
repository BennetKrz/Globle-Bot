"use strict";

/**
 * The one interaction this app handles: `/globle`, which opens the activity.
 *
 * Discord creates a global Entry Point command of its own when Activities are
 * enabled, and that is the launcher most players will use. It is global, though,
 * so it takes up to an hour to propagate and cannot be scoped to one server.
 * `/globle` answers with the same LAUNCH_ACTIVITY response from an ordinary
 * command, which registers to a test server instantly.
 *
 * The game itself is not reachable from chat. Everything a player does happens
 * inside the activity, against the HTTP API in server.js.
 *
 * Globle is a server game: the command is registered for the guild context
 * alone, so Discord does not offer it in a direct message. The guild check below
 * covers the gap between registrations, where a command the app has already
 * narrowed is still installed in its old form on some client.
 */

const { Events, MessageFlags } = require("discord.js");

const store = require("./store");
const globle = require("./globle");
const { t } = require("./i18n");

function langOf(interaction) {
  return store.getLanguage(interaction.user.id) || globle.normalizeLanguage(interaction.locale);
}

/** Start handling command interactions on a logged-in client. */
function attach(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "globle") return;
    if (!interaction.inGuild()) {
      await interaction
        .reply({ content: t(langOf(interaction), "guildOnly"), flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    try {
      await interaction.launchActivity();
    } catch (err) {
      console.error("Could not launch the activity:", err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: t(langOf(interaction), "launchFailed"), flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  });
}

module.exports = { attach };
