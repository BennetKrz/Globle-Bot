"use strict";

/**
 * Registers the app's commands with Discord.
 *
 *   node deploy-commands.js
 *
 * Set GUILD_ID in .env to register instantly to a single test server. Leave it
 * unset to register globally, which can take up to an hour to propagate.
 *
 * There is one command, and it only opens the activity. The game is played
 * inside the activity, so nothing else needs a chat entry point.
 *
 * Every command is registered for guild install and the guild context alone.
 * Globle is a shared board -- a roster, a group streak, a channel announcement --
 * so a game outside a server has nobody to share it with. Discord hides a
 * guild-only command everywhere else, which is the first of the two gates; the
 * second is the activity handshake in server.js, which refuses an instance that
 * is not running in a guild channel.
 */

require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  ApplicationIntegrationType,
  InteractionContextType,
} = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("globle")
    .setDescription("Open the Globle map")
    .setDescriptionLocalization("de", "Die Globle-Karte öffnen")
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild),
].map((c) => c.toJSON());

/**
 * The Entry Point command, which is what launches the Activity from Discord's
 * app launcher.
 *
 * Enabling Activities in the Developer Portal creates this command
 * automatically, and a global bulk overwrite that omits it is rejected: Discord
 * refuses to delete an app's Entry Point command as a side effect of updating
 * everything else. So the global registration has to include it, and the
 * guild-scoped one must not: an Entry Point command can only be global.
 *
 * `type: 4` is PRIMARY_ENTRY_POINT and `handler: 2` is DISCORD_LAUNCH_ACTIVITY,
 * which makes Discord open the activity and post its own follow-up message
 * without the app handling the interaction.
 *
 * `integration_types: [0]` is guild install only and `contexts: [0]` is the
 * guild context only, so the activity shelf offers Globle in a server and
 * nowhere else. The Developer Portal's own default for this command is every
 * install type and every context, so re-running this script is what narrows it.
 */
const ENTRY_POINT_COMMAND = {
  name: "globle-activity",
  description: "Launch the Globle map",
  description_localizations: { de: "Die Globle-Karte öffnen" },
  type: 4,
  handler: 2,
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
};

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN and/or CLIENT_ID in .env. See .env.example.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

/**
 * `contexts` and `integration_types` describe where a command may be installed
 * and invoked, which only a global command has a choice about. A guild command
 * exists in one server and is unreachable outside it, so the fields are dropped
 * rather than sent to a route that does not take them.
 */
function forGuild(command) {
  const { contexts, integration_types: integrationTypes, ...fields } = command;
  return fields;
}

(async () => {
  try {
    if (guildId) {
      const body = commands.map(forGuild);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      console.log(`Registered ${commands.length} guild command(s) to ${guildId}.`);
      console.log("The Activity launcher entry is global; run without GUILD_ID to register it.");
    } else {
      const body = [...commands, ENTRY_POINT_COMMAND];
      await rest.put(Routes.applicationCommands(clientId), { body });
      console.log(`Registered ${body.length} global commands (may take up to ~1h to appear).`);
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
    process.exit(1);
  }
})();
