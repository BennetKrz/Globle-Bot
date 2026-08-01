/**
 * The chrome around the map: guess entry with suggestions, the guess list, the
 * live roster, the group streak, and the toggles.
 *
 * This module owns the DOM and nothing else. It never calls the API and never
 * touches the board; it reports what the player did through the handlers passed
 * to `createUi` and redraws from whatever state it is handed. Keeping it that
 * way is what lets main.js stay the only place where the order of operations
 * lives.
 *
 * The roster arrives from two directions -- once with the initial state, then on
 * every push from the stream -- so it is kept here and redrawn on its own. That
 * also lets the panel survive a trip through practice mode, which hides it.
 */

import { t, formatKm, getLanguage } from "./i18n.js";

const MAX_SUGGESTIONS = 8;

/**
 * The proximity bands a roster grid arrives in, in the ramp's colours.
 *
 * A band is as much as the server can say about another player's guess without
 * giving away a distance, and it says it in the emoji the Discord announcement
 * is written with. Drawn as text over the panel, the coldest band's white square
 * reads as a gap rather than as a guess, so the bands are painted from the same
 * ramp colour.js gives the map instead.
 */
const BAND_COLOUR = {
  "🟩": "#2ecc71",
  "🟥": "#b81639",
  "🟧": "#e2532f",
  "🟨": "#f8c94a",
  "⬜": "#f7e6b6",
};

const $ = (id) => document.getElementById(id);

/**
 * @param {object} handlers
 * @param {(country: string) => void} handlers.onGuess
 * @param {() => void} handlers.onGiveUp
 * @param {() => void} handlers.onToggleView
 * @param {() => void} handlers.onToggleLanguage
 * @param {() => void} handlers.onToggleMode
 * @param {() => void} handlers.onToggleHard
 * @param {() => void} handlers.onNewPractice
 * @param {(scope: "self" | "day") => void} handlers.onDevReset
 */
export function createUi(handlers) {
  const elements = {
    app: $("app"),
    status: $("status"),
    streak: $("streak"),
    viewToggle: $("view-toggle"),
    langToggle: $("lang-toggle"),
    modeToggle: $("mode-toggle"),
    hardToggle: $("hard-toggle"),
    hardToggleLabel: $("hard-toggle-label"),
    guesses: $("guesses"),
    guessesTitle: $("guesses-title"),
    guessList: $("guess-list"),
    players: $("players"),
    playersTitle: $("players-title"),
    playerList: $("player-list"),
    input: $("guess-input"),
    suggestions: $("suggestions"),
    submit: $("guess-submit"),
    giveUp: $("giveup"),
    practiceNew: $("practice-new"),
    devReset: $("dev-reset"),
    message: $("message"),
    splash: $("splash"),
    splashText: $("splash-text"),
  };

  /** @type {Array<{name: string, label: string}>} */
  let catalogue = [];
  let matches = [];
  let highlighted = -1;
  let messageTimer = null;

  let selfId = null;
  let mode = "daily";
  let roster = { streak: 0, players: [] };

  // --- Suggestions ----------------------------------------------------------

  function search(query) {
    const needle = fold(query);
    if (!needle) return [];
    const starts = [];
    const contains = [];
    for (const country of catalogue) {
      const label = fold(country.label);
      const name = fold(country.name);
      if (label.startsWith(needle) || name.startsWith(needle)) starts.push(country);
      else if (label.includes(needle) || name.includes(needle)) contains.push(country);
      if (starts.length >= MAX_SUGGESTIONS) break;
    }
    return starts.concat(contains).slice(0, MAX_SUGGESTIONS);
  }

  function renderSuggestions() {
    elements.suggestions.replaceChildren();
    if (!matches.length) {
      elements.suggestions.hidden = true;
      return;
    }
    matches.forEach((country, index) => {
      const item = document.createElement("li");
      item.textContent = country.label;
      item.setAttribute("aria-selected", String(index === highlighted));
      // `mousedown` rather than `click`: the input's blur would close the list
      // before a click ever landed.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        commit(country.name);
      });
      elements.suggestions.appendChild(item);
    });
    elements.suggestions.hidden = false;
  }

  function closeSuggestions() {
    matches = [];
    highlighted = -1;
    elements.suggestions.hidden = true;
    elements.suggestions.replaceChildren();
  }

  function commit(name) {
    elements.input.value = "";
    closeSuggestions();
    handlers.onGuess(name);
  }

  /** Submit whatever the box currently points at: the highlighted row, else the text. */
  function submitCurrent() {
    if (highlighted >= 0 && matches[highlighted]) return commit(matches[highlighted].name);
    if (matches.length === 1) return commit(matches[0].name);
    const typed = elements.input.value.trim();
    if (typed) commit(typed); // the server resolves aliases the catalogue does not list
  }

  elements.input.addEventListener("input", () => {
    matches = search(elements.input.value);
    highlighted = matches.length ? 0 : -1;
    renderSuggestions();
  });

  elements.input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!matches.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      highlighted = (highlighted + step + matches.length) % matches.length;
      renderSuggestions();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitCurrent();
      return;
    }
    if (event.key === "Escape") closeSuggestions();
  });

  elements.input.addEventListener("blur", () => setTimeout(closeSuggestions, 120));
  elements.submit.addEventListener("click", submitCurrent);
  elements.giveUp.addEventListener("click", () => handlers.onGiveUp());
  elements.viewToggle.addEventListener("click", () => handlers.onToggleView());
  elements.langToggle.addEventListener("click", () => handlers.onToggleLanguage());
  elements.modeToggle.addEventListener("click", () => handlers.onToggleMode());
  elements.hardToggle.addEventListener("click", () => handlers.onToggleHard());
  elements.practiceNew.addEventListener("click", () => handlers.onNewPractice());
  // Shift picks the wider reset. One control rather than two, because it is a
  // testing affordance and the topbar is the game's.
  elements.devReset.addEventListener("click", (event) =>
    handlers.onDevReset(event.shiftKey ? "day" : "self")
  );

  // --- Rendering ------------------------------------------------------------

  function renderGuesses(state) {
    elements.guessesTitle.textContent = t("guessesTitle", state.guessCount);
    elements.guessList.replaceChildren();

    // The list is drawn in the order it arrives: the server ranks the board, and
    // on a hard game it is the only party that can, since every row below the
    // closest arrives without its distance.
    for (const guess of state.guesses) {
      const row = document.createElement("li");
      row.className = guess.correct ? "guess correct" : "guess";

      const chip = document.createElement("span");
      chip.className = "chip";
      chip.style.background = guess.colour;

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = guess.label;

      row.append(chip, name);

      if (!guess.correct && guess.proximity !== null) {
        const distance = document.createElement("span");
        distance.className = "distance";
        distance.textContent = t("kmAway", formatKm(guess.proximity));
        row.appendChild(distance);
      }
      elements.guessList.appendChild(row);
    }
    elements.guesses.hidden = state.guesses.length === 0;
  }

  /**
   * How far along one player is, in the terms the viewer is allowed to know.
   *
   * The count and its unit are separate cells because the panel lays its rows
   * out as one grid: apart, they line up down their own columns, so a "Tipp"
   * cannot sit a character to the left of the "Tipps" above it. Giving up has no
   * count and takes both cells.
   *
   * @returns {HTMLElement[]} the cells, in column order
   */
  function scoreOf(player) {
    if (player.finished && !player.win) {
      const gaveUp = document.createElement("span");
      gaveUp.className = "score gave-up";
      gaveUp.textContent = t("playerGaveUp");
      return [gaveUp];
    }
    const count = document.createElement("span");
    count.className = "score count";
    count.textContent = player.guessCount;
    const unit = document.createElement("span");
    unit.className = "score unit";
    unit.textContent = t("guessUnit", player.guessCount);
    return [count, unit];
  }

  /**
   * The roster panel and the streak pill.
   *
   * Only the bands of `player.guesses` are read here, which is all the server
   * sends until both players have finished. Every row places the same cells in
   * the same order, empty grid included, because one missing cell would shift
   * the rest of that row into the columns beside them.
   */
  function renderRoster() {
    const daily = mode === "daily";

    elements.streak.hidden = !daily || roster.streak < 1;
    if (!elements.streak.hidden) elements.streak.textContent = t("streak", roster.streak);

    if (!daily || !roster.players.length) {
      elements.players.hidden = true;
      return;
    }

    elements.playersTitle.textContent = t("playersTitle");
    elements.playerList.replaceChildren();

    for (const player of roster.players) {
      const row = document.createElement("li");
      row.className = "player-row";
      if (player.online) row.classList.add("online");
      if (!player.finished) row.classList.add("playing");
      if (player.userId === selfId) row.classList.add("me");

      const who = document.createElement("span");
      who.className = "who";
      const dot = document.createElement("span");
      dot.className = "dot";
      who.append(dot, document.createTextNode(player.displayName));

      // Two players on the same day can be playing under different rules, so a
      // guess count only compares if the row says which rules produced it.
      if (player.hard) {
        const badge = document.createElement("span");
        badge.className = "hard-badge";
        badge.textContent = t("hardBadge");
        badge.title = t("hardBadgeTitle");
        who.append(badge);
      }

      const grid = document.createElement("span");
      grid.className = "grid";
      for (const guess of player.guesses || []) {
        const cell = document.createElement("i");
        cell.className = "cell";
        cell.style.background = BAND_COLOUR[guess.emoji] || BAND_COLOUR["⬜"];
        grid.append(cell);
      }

      row.append(who, grid, ...scoreOf(player));
      elements.playerList.appendChild(row);
    }
    elements.players.hidden = false;
  }

  function renderStatus(state) {
    const country = state.answer ? state.answer.label : "";
    if (mode === "practice") {
      elements.status.textContent = !state.finished
        ? t("practiceStatus", state.guessCount)
        : state.win
          ? t("practiceWon", country, state.guessCount)
          : t("practiceLost", country);
      return;
    }
    if (!state.finished) {
      elements.status.textContent = t("statusGuesses", state.guessCount);
      return;
    }
    elements.status.textContent = state.win
      ? t("statusWon", country, state.guessCount)
      : t("statusLost", country);
  }

  return {
    /** The country list the suggestion box searches. */
    setCatalogue(countries) {
      catalogue = countries;
    },

    /** Whose row in the roster is the player's own. */
    setSelf(userId) {
      selfId = userId;
    },

    /** Redraw everything that depends on game state. */
    render(state) {
      mode = state.mode || "daily";
      elements.app.classList.toggle("practice", mode === "practice");
      elements.modeToggle.classList.toggle("on", mode === "practice");

      // The roster travels with the daily state, so an initial load and a
      // reconnect both refresh it without waiting for the next push.
      if (mode === "daily" && state.players) {
        roster = { streak: state.streak || 0, players: state.players };
      }

      renderStatus(state);
      renderGuesses(state);
      renderRoster();

      const over = Boolean(state.finished);
      elements.input.disabled = over;
      elements.submit.disabled = over;
      elements.giveUp.hidden = over;
      elements.practiceNew.hidden = mode !== "practice";
      elements.input.placeholder = t("guessPlaceholder");
      elements.submit.textContent = t("guessSubmit");
      elements.giveUp.textContent = t("giveUp");
      elements.practiceNew.textContent = t("practiceNew");
      elements.langToggle.textContent = t("languageName");
      // The toggle is labelled with the mode it switches *to*.
      elements.modeToggle.textContent = mode === "practice" ? t("daily") : t("practice");

      // Hard mode reads as a state rather than a destination, so the label stays
      // put and a switch next to it carries the on/off. It goes dead once the
      // game it applies to has a guess in it, which is the server's rule shown
      // rather than enforced.
      elements.hardToggleLabel.textContent = t("hard");
      elements.hardToggle.classList.toggle("on", Boolean(state.hard));
      elements.hardToggle.setAttribute("aria-pressed", String(Boolean(state.hard)));
      elements.hardToggle.disabled = Boolean(state.hardLocked);
    },

    /** A roster push from the stream. Cheap enough to redraw whole. */
    updateRoster(payload) {
      roster = { streak: payload.streak || 0, players: payload.players || [] };
      renderRoster();
    },

    /** Label the view toggle with the view on screen, as the language pill does. */
    setView(view) {
      elements.viewToggle.textContent = view === "flat" ? t("viewFlat") : t("viewTilted");
    },

    /** Hide the view toggle when only one view exists. */
    hideViewToggle() {
      elements.viewToggle.hidden = true;
    },

    /**
     * Reveal the reset button, on a server that was started with resets enabled.
     *
     * The label stays English in both languages: it is a testing control that
     * happens to sit in the topbar, and translating it would dress it up as one
     * of the game's own.
     */
    showDevReset() {
      elements.devReset.title = "Dev: replay today's daily. Shift-click resets the whole day.";
      elements.devReset.hidden = false;
    },

    /** Put a country in the box without submitting it, for taps on the map. */
    prefill(name, label) {
      elements.input.value = label || name;
      closeSuggestions();
      elements.input.focus();
      elements.input.select();
    },

    /** A transient line above the entry row. */
    message(text, ms = 3200) {
      elements.message.textContent = text;
      elements.message.hidden = false;
      clearTimeout(messageTimer);
      messageTimer = setTimeout(() => {
        elements.message.hidden = true;
      }, ms);
    },

    splash(text) {
      elements.splashText.textContent = text;
    },

    hideSplash() {
      elements.splash.classList.add("hidden");
      setTimeout(() => {
        elements.splash.hidden = true;
      }, 400);
    },

    focusInput() {
      if (!elements.input.disabled) elements.input.focus();
    },
  };
}

/**
 * Fold a string for searching: case, accents and the German digraphs, so that
 * "Oesterreich", "Österreich" and "osterreich" all match the same row.
 */
function fold(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/[ßẞ]/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "");
}

export { fold, getLanguage };
