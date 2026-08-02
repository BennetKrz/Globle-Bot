"use strict";

/**
 * HTTP server for the Discord Activity: it serves the built client, the game
 * API the client talks to, and the live roster stream.
 *
 * Three things shape the design:
 *
 *   - Discord serves the activity from `https://<app id>.discordsays.com` and
 *     reverse-proxies it to this server, so every request arrives cross-origin
 *     from the browser's point of view. Cookies inside that iframe need
 *     `SameSite=None; Partitioned` to survive, so the session is a bearer token
 *     instead. Nothing here reads or sets a cookie.
 *   - The proxy has served activities under both `/api/...` and `/.proxy/api/...`
 *     over its lifetime. The router is mounted at both paths so the client works
 *     regardless of which form a given Discord client sends.
 *   - Every route that changes the day publishes the new roster before it
 *     answers, so the player who acted and everyone watching update together.
 *
 * The mystery country is never in a response body until the player has finished,
 * and no country another player guessed is in a roster until both have.
 */

const path = require("path");
const express = require("express");

const globle = require("./globle");
const store = require("./store");
const game = require("./game");
const geometry = require("./geometry");
const session = require("./session");
const events = require("./events");
const discordApi = require("./discord-api");
const { announceFinish } = require("./announce");

const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");

/** Which game a request is about. Anything unrecognised is the daily. */
function modeOf(value) {
  return value === "practice" ? "practice" : "daily";
}

/**
 * Whether the daily may be erased on request.
 *
 * A flag of its own rather than DEV_LOGIN's: one lets a browser in without
 * Discord, the other throws away progress that is real.
 *
 * Unlike DEV_LOGIN this is not also gated on NODE_ENV, because the image sets
 * NODE_ENV=production and testing an announcement means testing it in Discord,
 * which means testing it in that image. The flag is the whole gate, and an
 * instance running with it lets any player in the channel wipe the day.
 */
const DEV_RESET = process.env.DEV_RESET === "1";

/**
 * @param {object} deps
 * @param {import("discord.js").Client} deps.client  logged-in gateway client, for announcements
 * @param {string} deps.applicationId
 * @param {string} deps.clientSecret
 * @param {string} deps.botToken
 */
function createApp({ client, applicationId, clientSecret, botToken }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  const api = express.Router();

  // --- Auth -----------------------------------------------------------------

  /**
   * Complete the activity handshake.
   *
   * The client sends the code from `authorize` plus its instance id. The server
   * exchanges the code, asks Discord who the player is, and asks Discord where
   * the instance is running. Only then does it mint a session. The client's own
   * claims about its identity or channel are never used.
   */
  api.post("/token", async (req, res) => {
    const { code, instance_id: instanceId } = req.body || {};
    if (typeof code !== "string" || !code) return res.status(400).json({ error: "missing_code" });
    if (typeof instanceId !== "string" || !instanceId) {
      return res.status(400).json({ error: "missing_instance_id" });
    }

    let accessToken;
    try {
      const token = await discordApi.exchangeCode({ clientId: applicationId, clientSecret, code });
      accessToken = token.access_token;
    } catch (e) {
      console.error("Token exchange failed:", e.message);
      return res.status(401).json({ error: "token_exchange_failed" });
    }

    let user;
    try {
      user = await discordApi.currentUser(accessToken);
    } catch (e) {
      console.error("Could not identify player:", e.message);
      return res.status(401).json({ error: "identify_failed" });
    }

    // Where this instance really is, and whether it may run at all. Globle is a
    // server game: the roster, the group streak and the announcement all belong
    // to a channel, so a `pc` location -- a direct message or a group DM -- is
    // refused rather than merely left with nothing to announce into.
    //
    // Discord's own lookup is the authority here. The command and the activity
    // are both registered for the guild context alone, but registration is a
    // client-side filter on a public URL, and this is the gate that does not
    // depend on what the browser sends.
    let guildId = null;
    let channelId = null;
    try {
      const instance = await discordApi.activityInstance({ botToken, applicationId, instanceId });
      if (instance.location?.kind !== "gc" || !instance.location.guild_id) {
        console.log(`Refused instance ${instanceId}: ${instance.location?.kind} is not a guild.`);
        return res.status(403).json({ error: "guild_only" });
      }
      guildId = instance.location.guild_id;
      channelId = instance.location.channel_id || null;
    } catch (e) {
      // Fail closed. A lookup that errored says nothing about where the instance
      // is running, and the cost of guessing wrong in the permissive direction
      // is a game in a DM. The player can reopen the activity.
      console.error("Activity instance lookup failed:", e.message);
      return res.status(503).json({ error: "instance_unavailable" });
    }

    const member = guildId ? await discordApi.guildMember(accessToken, guildId) : null;
    const displayName = discordApi.displayNameOf(user, member);

    const token = session.create({
      userId: user.id,
      displayName,
      guildId,
      channelId,
      instanceId,
      locale: user.locale || null,
    });

    return res.json({
      session: token,
      // Handed back only so the client can complete `authenticate` with the
      // Discord client. This app's own API is authorised by `session`, never
      // by this token.
      accessToken,
      user: { id: user.id, displayName },
      language: languageFor(user.id, user.locale),
      languages: globle.LANGUAGES,
      canAnnounce: channelId !== null,
      canReset: DEV_RESET,
    });
  });

  /**
   * A session with no Discord behind it, so the map can be opened in a plain
   * browser during development.
   *
   * This route only exists when DEV_LOGIN is set and NODE_ENV is not
   * production: it hands out a session to anyone who asks, which is exactly
   * what must never be reachable on a deployed instance. It also gets no
   * channel, so it cannot post an announcement.
   */
  if (process.env.DEV_LOGIN === "1" && process.env.NODE_ENV !== "production") {
    console.warn("DEV_LOGIN is on: /api/dev-session will hand out sessions without Discord.");
    api.post("/dev-session", (req, res) => {
      // A distinct id per tab, so two browser windows appear as two players and
      // the roster can be watched updating.
      const userId = `dev-${Math.random().toString(36).slice(2, 8)}`;
      const token = session.create({
        userId,
        displayName: `Dev ${userId.slice(4)}`,
        guildId: null,
        channelId: null,
        instanceId: "dev",
        locale: process.env.DEV_LOCALE || "en",
      });
      res.json({
        session: token,
        accessToken: null,
        user: { id: userId, displayName: `Dev ${userId.slice(4)}` },
        language: languageFor(userId, process.env.DEV_LOCALE || "en"),
        languages: globle.LANGUAGES,
        canAnnounce: false,
        canReset: DEV_RESET,
      });
    });
  }

  /** Resolve the session on the Authorization header, or answer 401. */
  function authenticate(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const found = session.get(token);
    if (!found) return res.status(401).json({ error: "no_session" });
    req.session = found;
    next();
  }

  /**
   * The language to answer in: the player's stored choice, else their Discord
   * locale. The detected locale is never written to the store, so a player who
   * later switches their Discord language follows along.
   */
  function languageFor(userId, locale) {
    return store.getLanguage(userId) || globle.normalizeLanguage(locale);
  }

  function langOf(req) {
    return languageFor(req.session.userId, req.session.locale);
  }

  // --- Static game data -----------------------------------------------------

  api.get("/geometry", (req, res) => {
    const { body, etag } = geometry.payload(req.query.lang);
    res.set("ETag", etag);
    res.set("Cache-Control", "public, max-age=3600");
    if (req.get("if-none-match") === etag) return res.status(304).end();
    res.type("application/json").send(body);
  });

  api.get("/countries", authenticate, (req, res) => {
    const lang = langOf(req);
    res.json({
      lang,
      countries: globle.FEATURES.map((f) => ({
        name: f.properties.NAME,
        label: globle.displayName(f.properties.NAME, lang),
      })),
    });
  });

  // --- Gameplay -------------------------------------------------------------

  /**
   * The player's own game plus, for the daily, what everyone else is doing.
   *
   * The roster travels with the state rather than on its own route so a client
   * that reconnects mid-game gets both in one answer, in the same shape the
   * stream will send from then on.
   */
  async function stateFor(req, mode) {
    const lang = langOf(req);
    if (mode === "practice") return game.practiceState(req.session.userId, lang);

    const date = game.today();
    const state = await game.viewState(date, req.session.userId, req.session.displayName, lang);
    // Where this player is playing from, kept with the day so the summary can be
    // posted after midnight, when the session that knew the channel is gone.
    store.setPlayerChannel(date, req.session.userId, req.session.channelId);
    state.streak = game.groupStreak(date);
    state.players = await game.roster(date, lang, {
      revealBoards: state.finished,
      online: events.online(),
    });
    return state;
  }

  api.get("/state", authenticate, async (req, res, next) => {
    try {
      res.json(await stateFor(req, modeOf(req.query.mode)));
    } catch (e) {
      next(e);
    }
  });

  api.post("/guess", authenticate, async (req, res, next) => {
    try {
      const raw = req.body?.country;
      if (typeof raw !== "string" || !raw.trim()) {
        return res.status(400).json({ error: "missing_country" });
      }
      const mode = modeOf(req.body?.mode);
      const lang = langOf(req);
      const date = game.today();

      const outcome =
        mode === "practice"
          ? game.submitPracticeGuess(req.session.userId, raw)
          : await game.submitGuess(date, req.session.userId, req.session.displayName, raw);

      if (outcome.status === game.GUESS.UNKNOWN_COUNTRY) {
        return res.status(404).json({
          error: "unknown_country",
          input: raw,
          // The nearest spelling, when one is close enough to be worth asking
          // about. Shaped like the duplicate reply below: the canonical name the
          // day is scored against, and the label to put the question in.
          suggestion: outcome.suggestion
            ? {
                country: outcome.suggestion,
                label: globle.displayName(outcome.suggestion, lang),
              }
            : null,
        });
      }
      if (outcome.status === game.GUESS.DUPLICATE) {
        return res.status(409).json({
          error: "duplicate",
          country: outcome.country,
          label: globle.displayName(outcome.country, lang),
        });
      }

      if (mode === "daily") {
        if (outcome.status === game.GUESS.WON) await announce(req, date, lang);
        await events.publish(date);
      }

      res.json({
        status: outcome.status,
        guess: outcome.guess
          ? await game.describeGuess(outcome.guess, lang, outcome.showDistance)
          : null,
        state: await stateFor(req, mode),
      });
    } catch (e) {
      next(e);
    }
  });

  api.post("/giveup", authenticate, async (req, res, next) => {
    try {
      const mode = modeOf(req.body?.mode);
      const lang = langOf(req);

      if (mode === "practice") {
        game.giveUpPractice(req.session.userId);
        return res.json({ state: await stateFor(req, mode) });
      }

      const date = game.today();
      const ended = game.giveUp(date, req.session.userId, req.session.displayName);
      if (ended) await announce(req, date, lang);
      await events.publish(date);
      res.json({ state: await stateFor(req, mode) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Switch the player's practice game between hard and normal.
   *
   * The daily has no mode to set -- it is hard for everyone -- so it answers 409
   * rather than quietly doing nothing. A practice game that already has a guess
   * in it answers 409 too: the mode is settled by the first guess, so a player
   * cannot turn off the hiding and read back every distance the game had been
   * keeping from them. The choice carries into the games created after this one.
   */
  api.post("/hard", authenticate, async (req, res, next) => {
    try {
      if (modeOf(req.body?.mode) !== "practice") {
        return res.status(409).json({ error: "daily_is_hard" });
      }
      const changed = game.setPracticeHard(req.session.userId, Boolean(req.body?.hard));
      if (!changed) return res.status(409).json({ error: "game_started" });

      res.json({ state: await stateFor(req, "practice") });
    } catch (e) {
      next(e);
    }
  });

  /** Abandon the current practice country and roll a new one. */
  api.post("/practice/new", authenticate, async (req, res, next) => {
    try {
      game.startPractice(req.session.userId);
      res.json({ state: await stateFor(req, "practice") });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Throw today's daily away so it can be played again.
   *
   * Everything that happens once per day -- the win, the give-up, the
   * announcement, the streak -- is otherwise testable once and then not again
   * until midnight. This route exists so that testing it does not mean editing
   * the state file by hand.
   *
   * `scope: "day"` clears the whole date, every player and the answer index with
   * it; anything else clears only the caller. The player is recreated by the
   * state read that follows, so the reply is an empty board rather than nothing.
   */
  if (DEV_RESET) {
    console.warn("DEV_RESET is on: any player can erase the day via /api/dev-reset.");
    api.post("/dev-reset", authenticate, async (req, res, next) => {
      try {
        const date = game.today();
        const scope = req.body?.scope === "day" ? "day" : "self";
        if (scope === "day") store.resetDay(date);
        else store.resetPlayer(date, req.session.userId);
        console.warn(`Dev reset (${scope}) of ${date} by ${req.session.userId}`);

        // Read the state before publishing: it recreates the caller's empty
        // board, so the roster that goes out already has their row back.
        const state = await stateFor(req, "daily");
        await events.publish(date);
        res.json({ scope, date, state });
      } catch (e) {
        next(e);
      }
    });
  }

  /**
   * The live roster.
   *
   * The language is resolved on every publish rather than captured here, so
   * switching language mid-game relabels the stream without reconnecting it.
   */
  api.get("/events", authenticate, (req, res) => {
    events.attach(req, res, {
      userId: req.session.userId,
      lang: () => languageFor(req.session.userId, req.session.locale),
    });
  });

  api.get("/stats", authenticate, (req, res) => {
    res.json(store.userStats(req.session.userId));
  });

  api.post("/language", authenticate, async (req, res, next) => {
    try {
      const chosen = String(req.body?.language || "");
      if (!globle.LANGUAGES.includes(chosen)) {
        return res.status(400).json({ error: "unsupported_language", languages: globle.LANGUAGES });
      }
      store.setLanguage(req.session.userId, chosen);
      // This viewer's roster is now in the wrong language; a publish reissues it.
      await events.publish(game.today());
      res.json({ language: chosen });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Post the finish announcement for the channel this instance is running in.
   * `channelId` came from Discord's own instance lookup, and is null for a
   * private-channel session, so there is nothing here that could become a DM.
   */
  async function announce(req, date, lang) {
    if (!req.session.channelId) return;
    const player = store.getPlayer(date, req.session.userId);
    if (!player) return;
    await announceFinish(client, { channelId: req.session.channelId, player, lang });
  }

  // --- Wiring ---------------------------------------------------------------

  api.use((err, req, res, _next) => {
    console.error(`API error on ${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: "server_error" });
  });

  // Both prefixes reach the same router: see the note at the top of the file.
  app.use("/api", api);
  app.use("/.proxy/api", api);

  // The built client. `index.html` must not be cached, because the proxy strips
  // cache headers only for HTML and the asset filenames are content-hashed.
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: "1y", etag: true }));
  app.get(/.*/, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(CLIENT_DIST, "index.html"), (err) => {
      if (err) res.status(503).type("text/plain").send("Activity client is not built yet.");
    });
  });

  return app;
}

/** Start listening. Resolves once the port is bound. */
function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => resolve(server));
    server.on("error", reject);
  });
}

module.exports = { createApp, listen, CLIENT_DIST };
