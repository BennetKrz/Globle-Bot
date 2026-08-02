/**
 * Activity entry point: the order in which everything comes up, and the only
 * place that knows about all four of Discord, the API, the roster stream and the
 * board.
 *
 * Startup runs the Discord handshake first, because the session it produces
 * decides the player's language, and the language decides which labels the
 * geometry is fetched with. The stream opens last, once there is something on
 * screen for it to update.
 *
 * Two games share the whole screen. `mode` is the only thing that distinguishes
 * them here: it rides along on every call and decides which state comes back.
 * Practice never has a roster, which is why the panel empties itself rather than
 * needing to be cleared.
 */

import "./style.css";

import * as api from "./api.js";
import { connect, onLayoutChange } from "./discord.js";
import { createBoard } from "./board/index.js";
import { trackKeyboard } from "./keyboard.js";
import { createUi } from "./ui.js";
import { setLanguage as setUiLanguage, t } from "./i18n.js";

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

const canvas = document.getElementById("board");
const app = document.getElementById("app");

let board = null;
let ui = null;
let state = null;
let language = "en";
let mode = "daily";
let closeStream = null;

/** Canonical country name -> its label in the active language. */
const catalogueByName = new Map();

function setCatalogue(countries) {
  catalogueByName.clear();
  for (const country of countries) catalogueByName.set(country.name, country);
}

/** The board's fill for every country the player has revealed. */
function coloursFor(current) {
  const colours = new Map();
  for (const guess of current.guesses) colours.set(guess.name, guess.colour);
  // The answer is only present once the game is over, so this cannot leak it.
  if (current.answer) colours.set(current.answer.name, current.answer.colour);
  return colours;
}

/** Only revealed countries are labelled; 197 names at once is unreadable. */
function labelsFor(current) {
  const names = new Set(current.guesses.map((g) => g.name));
  if (current.answer) names.add(current.answer.name);
  return names;
}

function apply(next) {
  state = next;
  ui.render(state);
  // A finished game greys every country still on the board: the ones nobody
  // named are out of play, and the guesses that scored keep their colour.
  board.paint(coloursFor(state), labelsFor(state), state.finished);
}

async function guess(country) {
  try {
    const result = await api.submitGuess(country, mode);
    apply(result.state);
  } catch (error) {
    // A name the server could not resolve usually came back with the country it
    // was probably meant to be. It is named and nothing more: the guess is the
    // player's to type, so the spelling is spelled out rather than filled in.
    if (error.status === 404) {
      const suggestion = error.body?.suggestion;
      if (!suggestion) return ui.message(t("unknownCountry", country));
      return ui.suggest(t("unknownCountry", country), t("didYouMean", suggestion.label));
    }
    if (error.status === 409) return ui.message(t("duplicate", error.body.label || country));
    if (error.status === 401) return ui.message(t("sessionExpired"));
    console.error("Guess failed:", error);
    ui.message(t("offline"));
  }
}

async function giveUp() {
  try {
    const result = await api.giveUp(mode);
    apply(result.state);
  } catch (error) {
    console.error("Give up failed:", error);
    ui.message(t("offline"));
  }
}

/**
 * Switch between the daily and a practice country.
 *
 * Nothing is torn down: the board keeps its geometry and camera, and only the
 * fills change, so the switch reads as the same map with a different game on it.
 */
async function toggleMode() {
  const next = mode === "practice" ? "daily" : "practice";
  try {
    const fresh = await api.getState(next);
    mode = next;
    apply(fresh);
    ui.focusInput();
  } catch (error) {
    console.error("Could not switch mode:", error);
    ui.message(t("offline"));
  }
}

/**
 * Switch the current practice game between hard and normal.
 *
 * The daily is hard by rule and hides the toggle, so this only ever runs on
 * practice. The server owns the rule that a started game keeps its mode, so a
 * 409 is the expected answer to a late press rather than a fault.
 */
async function toggleHard() {
  if (mode !== "practice") return;
  try {
    const result = await api.setHard(!state.hard, mode);
    apply(result.state);
  } catch (error) {
    if (error.status === 409) return ui.message(t("hardLocked"));
    console.error("Could not switch hard mode:", error);
    ui.message(t("offline"));
  }
}

/**
 * Throw today's daily away and start it over.
 *
 * Only reachable on a server started with DEV_RESET, which is what the session
 * handshake's `canReset` reports. The mode switches to the daily on the way, so
 * a reset pressed from practice lands on the board it just cleared.
 *
 * @param {"self" | "day"} scope  the caller's own board, or every board on the date
 */
async function devReset(scope) {
  try {
    const result = await api.devReset(scope);
    mode = "daily";
    apply(result.state);
    ui.message(scope === "day" ? `Reset ${result.date} for everyone` : `Reset ${result.date}`);
    ui.focusInput();
  } catch (error) {
    console.error("Reset failed:", error);
    ui.message(t("offline"));
  }
}

/** Abandon the current practice country for a new one. */
async function newPractice() {
  try {
    const result = await api.newPractice();
    mode = "practice";
    apply(result.state);
    ui.focusInput();
  } catch (error) {
    console.error("Could not start a new practice country:", error);
    ui.message(t("offline"));
  }
}

/**
 * Switch language.
 *
 * The server owns country names, so the geometry and the whole game state are
 * re-fetched rather than translated in place. Guesses are stored under their
 * canonical English names, so nothing is lost in the swap. The stream relabels
 * itself: the server resolves the language on every push.
 */
async function toggleLanguage() {
  const next = language === "de" ? "en" : "de";
  try {
    await api.setLanguage(next);
  } catch (error) {
    console.error("Could not save the language:", error);
    return ui.message(t("offline"));
  }
  language = setUiLanguage(next);

  const [geometry, catalogue, fresh] = await Promise.all([
    api.getGeometry(language),
    api.getCountries(),
    api.getState(mode),
  ]);

  const previousView = board.getView();
  board.dispose();
  const created = createBoard(canvas, app, geometry.countries);
  board = created.board;
  wireBoard();
  board.setView(previousView);
  setCatalogue(catalogue.countries);
  ui.setView(board.getView());
  apply(fresh);
}

function wireBoard() {
  // Naming a country from its shape is the daily's whole question, so the daily
  // never answers it: a tap there does nothing. Practice will answer it, and
  // says the name over the map rather than into the box, so looking a country up
  // stays a look rather than half a guess.
  //
  // Even in practice it takes asking twice over -- Ctrl-click, or a long press
  // on touch. A plain tap is how the map is grabbed and panned, and an answer
  // that falls out of an ordinary click is one the player reads by accident
  // rather than asks for.
  board.onSelect((name, { modified } = {}) => {
    if (mode !== "practice" || !modified) return;
    const entry = catalogueByName.get(name);
    ui.message(entry ? entry.label : name, 2400);
  });
  // Hovering says only that the name is a tap away, and only where a tap says
  // anything. Sweeping the pointer across the map would otherwise read the
  // answer off it.
  board.onHover((label) => {
    if (label && mode === "practice") ui.message(t("revealHint"), 1200);
  });
}

function toggleView() {
  board.setView(board.getView() === "flat" ? "tilted" : "flat");
  ui.setView(board.getView());
}

async function start() {
  trackKeyboard();

  ui = createUi({
    onGuess: guess,
    onGiveUp: giveUp,
    onToggleView: toggleView,
    onToggleLanguage: toggleLanguage,
    onToggleMode: toggleMode,
    onToggleHard: toggleHard,
    onNewPractice: newPractice,
    onDevReset: devReset,
  });

  ui.splash(t("connecting"));

  const { sdk, session } = await connect(CLIENT_ID);
  language = setUiLanguage(session.language);
  ui.setSelf(session.user.id);
  if (session.canReset) ui.showDevReset();
  ui.splash(t("loading"));

  const [geometry, catalogue, initial] = await Promise.all([
    api.getGeometry(language),
    api.getCountries(),
    api.getState(mode),
  ]);

  const created = createBoard(canvas, app, geometry.countries);
  board = created.board;
  wireBoard();

  setCatalogue(catalogue.countries);
  if (created.degraded) {
    ui.hideViewToggle();
    ui.message(t("noWebgl"), 5000);
  } else {
    ui.setView(board.getView());
  }

  apply(initial);
  ui.hideSplash();
  ui.focusInput();

  // The roster from here on is pushed, not polled. Opening it after the first
  // paint means a slow stream never delays the map.
  closeStream = api.openStream({
    onEvent: (name, payload) => {
      if (name === "roster") ui.updateRoster(payload);
    },
    onExpired: () => ui.message(t("sessionExpired"), 10000),
  });
  window.addEventListener("pagehide", () => closeStream?.());

  // Discord resizes the frame when the player moves the activity between
  // focused, grid and picture-in-picture.
  window.addEventListener("resize", () => board.resize());
  onLayoutChange(sdk, () => board.resize());
}

/**
 * What the splash reads when startup did not finish.
 *
 * The server refuses the handshake outside a guild channel, and that is a rule
 * rather than a fault, so it gets a sentence of its own instead of the generic
 * failure with an error code appended.
 */
function startupMessage(error) {
  if (error.status === 403 && error.body?.error === "guild_only") return t("guildOnly");
  if (error.status === 503 && error.body?.error === "instance_unavailable") {
    return t("instanceUnavailable");
  }
  return `${t("launchFailed")} ${error.message || ""}`.trim();
}

start().catch((error) => {
  console.error("Activity failed to start:", error);
  const splash = document.getElementById("splash-text");
  if (splash) splash.textContent = startupMessage(error);
});
