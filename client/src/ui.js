/**
 * The chrome around the map: guess entry, the guess list, the live roster, the
 * group streak, and the toggles.
 *
 * The box does not complete what is typed into it. Naming a country from a
 * shape is the game, and a list that fills in "Kirgisistan" from "kir" plays
 * that part for the player. What is typed goes to the server as typed; it owns
 * the names in both languages and resolves aliases the client never sees.
 *
 * A name that resolves to nothing comes back with the country it was probably
 * meant to be, and the message bubble says so. It only says so: the spelling is
 * never filled in, pressed in or entered on the player's behalf, because the box
 * that will not finish a name for them must not finish one for them here either.
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

import { t, formatKm, formatDuration } from "./i18n.js";

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

/** The channels of a `#rgb`, `#rrggbb` or `rgb(...)` fill, or null. */
function channels(fill) {
  const functional = /rgba?\(([^)]+)\)/.exec(fill);
  if (functional) return functional[1].split(/[,\s/]+/).slice(0, 3).map(Number);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(fill.trim());
  if (!hex) return null;
  const pairs = hex[1].length === 3 ? [...hex[1]].map((c) => c + c) : hex[1].match(/../g);
  return pairs.map((pair) => parseInt(pair, 16));
}

/**
 * Black or white for text sitting on a fill, whichever that fill can carry.
 *
 * Neither ink works the whole way down the ramp: a country code in black
 * disappears into crimson and one in white disappears into sand. The choice is
 * made per square rather than per band because a revealed run is painted in the
 * map's own fills, which are a continuum and not the five colours a live run
 * uses -- there is no band to have decided this for in advance.
 *
 * 0.179 is where a colour contrasts equally with black and with white, from the
 * sRGB relative luminance the contrast ratio is defined on, and the two inks are
 * the pure ones rather than anything softer off the palette. Both facts are load
 * bearing: the worst colour on the ramp clears 4.5:1 against pure black or white
 * picked at that crossover and does not clear it against any other pair, and the
 * code is 9px, which is where 4.5:1 stops being a formality.
 */
function inkOn(fill) {
  const rgb = channels(fill || "");
  if (!rgb || rgb.some(Number.isNaN)) return "#000";
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#000" : "#fff";
}

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
    topbar: $("topbar"),
    bottombar: $("bottombar"),
    status: $("status"),
    streak: $("streak"),
    viewToggle: $("view-toggle"),
    langToggle: $("lang-toggle"),
    modeToggle: $("mode-toggle"),
    hardToggle: $("hard-toggle"),
    hardToggleLabel: $("hard-toggle-label"),
    guesses: $("guesses"),
    guessesTitle: $("guesses-title"),
    guessesClose: $("guesses-close"),
    guessList: $("guess-list"),
    players: $("players"),
    playersTitle: $("players-title"),
    playersClose: $("players-close"),
    playerNames: $("player-names"),
    playerRuns: $("player-runs"),
    playerRunRows: $("player-runs-rows"),
    playerScores: $("player-scores"),
    input: $("guess-input"),
    submit: $("guess-submit"),
    giveUp: $("giveup"),
    practiceNew: $("practice-new"),
    devReset: $("dev-reset"),
    menuWrap: $("menu-wrap"),
    menuToggle: $("menu-toggle"),
    menu: $("menu"),
    menuGuesses: $("menu-guesses"),
    menuPlayers: $("menu-players"),
    menuSettings: $("menu-settings"),
    menuActions: $("menu-actions"),
    message: $("message"),
    cellTip: $("cell-tip"),
    splash: $("splash"),
    splashText: $("splash-text"),
  };

  let messageTimer = null;
  let tipTimer = null;

  let selfId = null;
  let mode = "daily";
  let roster = { streak: 0, players: [] };
  let guessCount = 0;

  // --- Messages -------------------------------------------------------------

  function showMessage(ms) {
    elements.message.hidden = false;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      elements.message.hidden = true;
    }, ms);
  }

  // --- Guess entry ----------------------------------------------------------

  /** Send the box as typed. The server resolves names in either language. */
  function submitTyped() {
    const typed = elements.input.value.trim();
    if (!typed) return;
    elements.input.value = "";
    handlers.onGuess(typed);
  }

  elements.input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitTyped();
  });

  elements.submit.addEventListener("click", submitTyped);
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

  // --- Compact layout -------------------------------------------------------

  /*
   * A phone in portrait -- or the activity in picture-in-picture -- has no room
   * for a status line, four toggles and a give-up button on one row, and the two
   * panels between them leave the map a strip down the middle. So on a narrow
   * frame all of it goes behind one button: the controls move into a dropdown,
   * and the panels become sheets that dropdown opens.
   *
   * Moved, not duplicated. Every listener above is bound to the node itself, and
   * so is every `hidden` and `disabled` the game sets, so a control carries all
   * of it across the move and nothing else in this file has to ask which layout
   * is on screen. It also means there is one give-up button rather than two, and
   * no way for the pair to disagree about whether the game is over.
   *
   * The query is the stylesheet's, spelled the same way: the class set here is
   * what its compact rules hang off, so the two cannot part company.
   */
  const NARROW = window.matchMedia("(max-width: 560px), (max-height: 420px)");

  /** The topbar's controls, in the order it wants them back. */
  const barOrder = [
    elements.hardToggle,
    elements.devReset,
    elements.modeToggle,
    elements.viewToggle,
    elements.langToggle,
  ];

  /* The same controls read top to bottom instead of left to right, which is a
     different order: the reset is a testing affordance and goes to the bottom of
     the list rather than into the middle of the game's own settings. */
  const menuOrder = [
    elements.modeToggle,
    elements.hardToggle,
    elements.viewToggle,
    elements.langToggle,
    elements.devReset,
  ];

  const menuGroups = [...elements.menu.querySelectorAll(".menu-group")];

  let compact = false;

  /*
   * The guess list rests open on a narrow frame. It is the game's own feedback --
   * the same list a wide frame keeps permanently on screen -- so a press on the
   * map or the guess box leaves it alone, unlike a menu or a modal. What closes it
   * is the player asking for the map, through the ✕ in its heading or its menu
   * row, and `guessesDismissed` is that having happened; re-opening it clears the
   * flag. The players sheet is a deliberate detour with no resting state of its
   * own, so it is a plain open/closed that falls back to the guess list.
   */
  let guessesDismissed = false;
  let playersOpen = false;

  const menuIsOpen = () => !elements.menu.hidden;

  function setMenuOpen(open) {
    const on = open && compact;
    elements.menu.hidden = !on;
    elements.menuToggle.setAttribute("aria-expanded", String(on));
  }

  /**
   * Bring the two sheets in line with the flags above.
   *
   * The two share a grid cell at this width, so the players sheet covers the
   * guess list while it is up and the list comes back once it is gone. The guess
   * list shows whenever it has not been dismissed and has something to show, so it
   * returns on its own after the first guess and after the roster is closed. The
   * row that opens each sheet reads as pressed while that sheet is on screen.
   */
  function syncPanels() {
    const guessesOn = compact && !guessesDismissed && !playersOpen && !elements.guesses.hidden;
    const playersOn = compact && playersOpen && !elements.players.hidden;
    elements.guesses.classList.toggle("open", guessesOn);
    elements.players.classList.toggle("open", playersOn);
    elements.menuGuesses.setAttribute("aria-pressed", String(guessesOn));
    elements.menuPlayers.setAttribute("aria-pressed", String(playersOn));
  }

  /** The guess list's menu row: put it away when it is up, bring it back when not. */
  function toggleGuesses() {
    if (!guessesDismissed && !playersOpen) {
      guessesDismissed = true;
    } else {
      guessesDismissed = false;
      playersOpen = false;
    }
    syncPanels();
  }

  /** The players sheet's menu row: a plain toggle over the resting guess list. */
  function togglePlayers() {
    playersOpen = !playersOpen;
    syncPanels();
  }

  /**
   * Bring the menu in line with what the game is showing.
   *
   * A row is there when the thing it stands for is: the two panel rows follow
   * their panels, and every moved control carries the `hidden` the game set on
   * it. A group left with nothing in it goes as well, and the divider is put on
   * the groups that follow one that survived, so the menu never opens with a
   * line above nothing.
   */
  function syncMenu() {
    elements.menuToggle.setAttribute("aria-label", t("menu"));
    elements.guessesClose.setAttribute("aria-label", t("close"));
    elements.playersClose.setAttribute("aria-label", t("close"));
    elements.menuGuesses.hidden = elements.guesses.hidden;
    elements.menuGuesses.textContent = t("guessesTitle", guessCount);
    elements.menuPlayers.hidden = elements.players.hidden;
    elements.menuPlayers.textContent = t("playersTitle");

    // A sheet the game takes away drops what stood behind it. The players sheet
    // has no resting state of its own, so it simply closes. The guess list's
    // dismissal belongs to the run it was made in: an emptied list -- a new
    // practice round, a reset -- clears it, so the first guess of the next round
    // brings the list back on its own rather than staying dismissed from before.
    if (playersOpen && elements.players.hidden) playersOpen = false;
    if (elements.guesses.hidden) guessesDismissed = false;

    let above = false;
    for (const group of menuGroups) {
      const filled = [...group.children].some((row) => !row.hidden);
      group.hidden = !filled;
      group.classList.toggle("divided", filled && above);
      above = above || filled;
    }
    syncPanels();
  }

  /** Put the controls wherever this frame has room for them. */
  function applyLayout() {
    compact = NARROW.matches;
    elements.app.classList.toggle("compact", compact);
    elements.menuWrap.hidden = !compact;

    if (compact) {
      elements.menuSettings.append(...menuOrder);
      elements.menuActions.append(elements.giveUp, elements.practiceNew);
    } else {
      // Back in front of the menu button, which is the topbar's last child.
      for (const control of barOrder) elements.topbar.insertBefore(control, elements.menuWrap);
      elements.bottombar.append(elements.giveUp, elements.practiceNew);
      setMenuOpen(false);
    }
    syncMenu();
  }

  elements.menuToggle.addEventListener("click", () => setMenuOpen(!menuIsOpen()));
  elements.menuGuesses.addEventListener("click", toggleGuesses);
  elements.menuPlayers.addEventListener("click", togglePlayers);

  // Each sheet carries its own close in its heading, shown only on a narrow
  // frame where the sheet is over the map. Closing the guess list is the player
  // asking for the map; closing the roster falls back to the resting guess list.
  elements.guessesClose.addEventListener("click", () => {
    guessesDismissed = true;
    syncPanels();
  });
  elements.playersClose.addEventListener("click", () => {
    playersOpen = false;
    syncPanels();
  });

  // Every row in here either changes the screen or opens a panel over it, so the
  // menu steps aside once one is pressed. A disabled row fires nothing and
  // leaves it up, which is the answer to a press that did nothing.
  elements.menu.addEventListener("click", (event) => {
    if (event.target.closest("button")) setMenuOpen(false);
  });

  /**
   * A press anywhere else puts the menu away.
   *
   * The menu is a layer over the game, so a press outside it was meant for what
   * is underneath. The sheets it opens are left where they are: the guess list
   * rests open over the map on purpose, so a press on the map or the guess box
   * must not take it down. A sheet is closed from its own heading or its menu row.
   */
  document.addEventListener("pointerdown", (event) => {
    if (elements.menuWrap.contains(event.target)) return;
    setMenuOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (menuIsOpen()) return setMenuOpen(false);
    if (playersOpen) {
      playersOpen = false;
      return syncPanels();
    }
    if (compact && !guessesDismissed && !elements.guesses.hidden) {
      guessesDismissed = true;
      syncPanels();
    }
  });

  NARROW.addEventListener("change", applyLayout);
  applyLayout();

  // --- The roster tooltip ---------------------------------------------------

  /*
   * A revealed square is 19px wide and says "DE". This is where it says Germany.
   *
   * One element, reused, rather than a tooltip per square: a finished day is a
   * few hundred squares and all but one of those tooltips would be a hidden node
   * nobody ever looks at.
   *
   * Not the `title` attribute, which is what this replaces. `title` waits about
   * half a second, draws in the OS's colours rather than the panel's, and on a
   * touch screen never appears at all -- and the activity is played on phones as
   * much as anywhere, where the two letters would otherwise be the whole story.
   */

  function hideTip() {
    clearTimeout(tipTimer);
    elements.cellTip.hidden = true;
  }

  /**
   * Put the tip over a square, or under it when there is no room above.
   *
   * Measured after the text is in, because the width it clamps against is the
   * width of this country's name and not of the last one's. Both axes are held
   * inside the viewport: a square at the edge of a narrow frame would otherwise
   * hang a long name off the side of the screen.
   */
  function showTip(cell) {
    const text = cell.dataset.tip;
    if (!text) return;

    const tip = elements.cellTip;
    tip.textContent = text;
    tip.hidden = false;

    const at = cell.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const gap = 6;
    const edge = 8;
    const left = at.left + at.width / 2 - box.width / 2;
    const above = at.top - box.height - gap;

    tip.style.left = `${Math.round(Math.max(edge, Math.min(left, window.innerWidth - box.width - edge)))}px`;
    tip.style.top = `${Math.round(above >= edge ? above : at.bottom + gap)}px`;
  }

  const namedCell = (event) => event.target.closest?.(".cell.named");

  elements.playerRuns.addEventListener("pointerover", (event) => {
    const cell = namedCell(event);
    if (cell) showTip(cell);
  });

  elements.playerRuns.addEventListener("pointerout", (event) => {
    if (!event.relatedTarget?.closest?.(".cell.named")) hideTip();
  });

  // Touch has no hover to leave, so a tapped tip takes itself down. Long enough
  // to read a country and a distance, short enough not to sit over the panel.
  elements.playerRuns.addEventListener("pointerdown", (event) => {
    const cell = namedCell(event);
    if (!cell) return hideTip();
    showTip(cell);
    if (event.pointerType === "touch") {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(hideTip, 2600);
    }
  });

  // The tip is placed from where its square was, so anything that moves the
  // square invalidates it. Scrolling the runs is the common one.
  elements.playerRuns.addEventListener("scroll", hideTip, { passive: true });

  // --- Rendering ------------------------------------------------------------

  function renderGuesses(state) {
    guessCount = state.guessCount;
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
   * The time a row was placed by, or the empty string for the rows that were not
   * placed by one.
   *
   * Which rows those are is the server's call, and it sends `elapsedMs` on no
   * others: a time is the answer to "which of these two was faster", so it
   * appears between two winners level on guesses and nowhere else. Everywhere
   * else it would be a number the standing does not depend on, and a game that
   * is not raced would start being raced.
   */
  function timeTextOf(player) {
    return formatDuration(player.elapsedMs);
  }

  /**
   * How far along one player is, in the terms the viewer is allowed to know.
   *
   * The count, its unit and the time are separate cells because the scores lay
   * out as one grid: apart, they line up down their own columns, so a "Tipp"
   * cannot sit a character to the left of the "Tipps" above it. Giving up has no
   * count and takes the whole row.
   *
   * The time cell is placed whether or not it has anything in it. A stack that
   * skipped it on some rows would let the next row's count fall into the column
   * it left empty, and the alignment the three columns exist for would go with
   * it.
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

    const time = document.createElement("span");
    time.className = "score time";
    time.textContent = timeTextOf(player);
    if (time.textContent) time.title = t("timeTitle");
    return [count, unit, time];
  }

  /** The same score as one string, for the row a screen reader reads. */
  function scoreTextOf(player) {
    if (player.finished && !player.win) return t("playerGaveUp");
    const score = `${player.guessCount} ${t("guessUnit", player.guessCount)}`;
    const time = timeTextOf(player);
    return time ? `${score} ${t("timeLabel", time)}` : score;
  }

  /**
   * What a revealed square says when it is pointed at: the country spelled out,
   * and how far off it was.
   *
   * The winning square gives the name alone. Its distance is zero by definition
   * and "Germany, 0 km" reads as a near miss rather than as the answer.
   */
  function guessTitleOf(guess) {
    if (guess.correct || guess.proximity === null) return guess.label;
    return `${guess.label} · ${t("kmAway", formatKm(guess.proximity))}`;
  }

  /**
   * The countries behind a revealed run, as one string for a screen reader.
   *
   * The runs are `aria-hidden`, being a stack of decorative squares, so a
   * revealed row would otherwise be countries nobody reading the panel aloud
   * could reach. They go on the name instead, where the rest of the row already
   * is. An unrevealed row has none and adds nothing.
   */
  function revealedTextOf(player) {
    const named = (player.guesses || []).filter((guess) => guess.label);
    return named.map((guess) => guess.label).join(", ");
  }

  /**
   * The roster panel and the streak pill.
   *
   * A guess in `player.guesses` arrives as a bare band while it is nobody's
   * business which country it was, and with its country attached once it is: the
   * server sends the names only for a finished board, and only to a viewer who
   * has finished themselves. So the two kinds of square are drawn from what
   * arrived rather than from a flag, and a row opens up the moment it is allowed
   * to without the panel being told that it has.
   *
   * A player contributes one row to each of the three stacks -- name, run, score
   * -- and always contributes it, empty run included, because a stack that
   * skipped a player would put every row below it against the wrong name.
   *
   * The name list is the roster as far as a screen reader is concerned: it
   * carries the count and the revealed countries as a label, and the two visual
   * stacks are hidden from it.
   */
  function renderRoster() {
    const daily = mode === "daily";

    // The redraw below replaces every square, including whichever one the tip is
    // currently naming, so it comes down first rather than being left pointing
    // at a node that no longer exists.
    hideTip();

    elements.streak.hidden = !daily || roster.streak < 1;
    if (!elements.streak.hidden) elements.streak.textContent = t("streak", roster.streak);

    if (!daily || !roster.players.length) {
      elements.players.hidden = true;
      return;
    }

    // Hard is the daily's rule rather than anyone's choice, so the panel says it
    // once, over the whole roster, instead of once per name. Said per row it was
    // a badge that could never be absent -- a column of 🕶 that distinguished
    // nobody from anybody, spending width the names were short of.
    //
    // Read off the rows rather than assumed, so the heading cannot claim a rule
    // the day is not actually being played under.
    // A revealed square is a two-letter code rather than a 12px block, so a run
    // of them is close to twice as wide and a nine-guess day would arrive with
    // its first six already scrolled off the end. The panel is allowed more of
    // the frame once it is carrying names, and goes back to its usual width for
    // a day still being played. Still a cap and still a scroller underneath it:
    // a long enough run overflows at any width, and the newest end is the one
    // worth landing on.
    const anyRevealed = roster.players.some((player) =>
      (player.guesses || []).some((guess) => guess.label)
    );
    elements.players.classList.toggle("revealed", anyRevealed);

    const allHard = roster.players.every((player) => player.hard);
    elements.playersTitle.replaceChildren(document.createTextNode(t("playersTitle")));
    if (allHard) {
      const rule = document.createElement("span");
      rule.className = "mode-badge";
      rule.title = t("hardDailyTitle");
      // The heading has no `aria-label`, so it is read from its contents and the
      // glyph would be read out as "sunglasses" ahead of the word that means it.
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = t("hardBadge");
      rule.append(glyph, ` ${t("hard")}`);
      elements.playersTitle.append(rule);
    }

    // A push redraws the whole roster, so where the runs had been scrolled to is
    // taken down first and put back after. A player who had not scrolled stays
    // at the newest end as it grows; one who had gone looking through the older
    // squares is left where they were.
    const runs = elements.playerRuns;
    const wasAtEnd = runs.scrollWidth - runs.clientWidth - runs.scrollLeft <= 1;
    const previous = runs.scrollLeft;

    elements.playerNames.replaceChildren();
    elements.playerRunRows.replaceChildren();
    elements.playerScores.replaceChildren();

    for (const player of roster.players) {
      const who = document.createElement("li");
      if (player.online) who.classList.add("online");
      if (!player.finished) who.classList.add("playing");
      if (player.userId === selfId) who.classList.add("me");
      // A narrow panel still cuts a long name off, so the whole one stays here.
      who.title = player.displayName;
      // An `aria-label` replaces the whole row rather than adding to it, so
      // everything the row shows has to be said again here -- the badge below
      // included, which is otherwise a mark only a sighted player ever gets.
      who.setAttribute(
        "aria-label",
        [
          `${player.displayName}: ${scoreTextOf(player)}`,
          player.hard ? "" : t("softBadgeTitle"),
          revealedTextOf(player),
        ]
          .filter(Boolean)
          .join(". ")
      );

      const dot = document.createElement("span");
      dot.className = "dot";
      who.append(dot, document.createTextNode(player.displayName));

      // A row is marked when it broke the day's rule, not when it kept it. Only a
      // record written before the daily became hard-only can be soft now, and it
      // is repaired the moment that player next opens the activity -- but until
      // then its guess count was scored with the distances on screen and does not
      // compare with the rest of the panel, which is worth the width to say.
      if (!player.hard) {
        const badge = document.createElement("span");
        badge.className = "soft-badge";
        badge.textContent = t("softBadge");
        badge.title = t("softBadgeTitle");
        who.append(badge);
      }

      const run = document.createElement("div");
      run.className = "run";
      for (const guess of player.guesses || []) {
        const cell = document.createElement("i");
        cell.className = "cell";
        // A revealed guess arrives with its country attached, and is painted in
        // the map's own fill rather than in one of the five bands. The viewer has
        // finished, so the exact shade is theirs to have, and a run carrying the
        // continuum instead of the steps reads at a glance as one that is open.
        if (guess.label) {
          cell.classList.add("named");
          cell.style.background = guess.colour;
          cell.style.color = inkOn(guess.colour);
          cell.textContent = guess.code;
          cell.dataset.tip = guessTitleOf(guess);
        } else {
          cell.style.background = BAND_COLOUR[guess.emoji] || BAND_COLOUR["⬜"];
        }
        run.append(cell);
      }

      elements.playerNames.appendChild(who);
      elements.playerRunRows.appendChild(run);
      elements.playerScores.append(...scoreOf(player));
    }
    elements.players.hidden = false;

    runs.scrollLeft = wasAtEnd ? runs.scrollWidth : previous;
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
      // rather than enforced. The daily has no switch at all: it is hard for
      // everyone, and a control that only ever reads "on" invites a press.
      elements.hardToggle.hidden = mode !== "practice";
      elements.hardToggleLabel.textContent = t("hard");
      elements.hardToggle.classList.toggle("on", Boolean(state.hard));
      elements.hardToggle.setAttribute("aria-pressed", String(Boolean(state.hard)));
      elements.hardToggle.disabled = Boolean(state.hardLocked);

      // Last, because the menu is a reading of everything above it: which
      // controls this state left on screen is what decides which rows it has.
      syncMenu();
    },

    /** A roster push from the stream. Cheap enough to redraw whole. */
    updateRoster(payload) {
      roster = { streak: payload.streak || 0, players: payload.players || [] };
      renderRoster();
      syncMenu();
    },

    /** Label the view toggle with the view on screen, as the language pill does. */
    setView(view) {
      elements.viewToggle.textContent = view === "flat" ? t("viewFlat") : t("viewTilted");
    },

    /** Hide the view toggle when only one view exists. */
    hideViewToggle() {
      elements.viewToggle.hidden = true;
      syncMenu();
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
      syncMenu();
    },

    /** A transient line above the entry row. */
    message(text, ms = 3200) {
      elements.message.classList.remove("suggestion");
      elements.message.textContent = text;
      showMessage(ms);
    },

    /**
     * The same line, followed by the country a misspelling probably meant.
     *
     * The name is said, never entered. Nothing here writes into the box or
     * guesses on a press: the country is the answer the player is giving, and it
     * stays typed by them down to the last letter. All this does is spell it.
     *
     * It lingers longer than an ordinary message because it is read and then
     * typed out, which takes longer than reading alone.
     *
     * @param {string} text      what was not recognised
     * @param {string} question  the "did you mean", already carrying the country's label
     */
    suggest(text, question, ms = 6000) {
      const line = document.createElement("span");
      line.className = "message-text";
      line.textContent = text;

      const asked = document.createElement("span");
      asked.className = "message-question";
      asked.textContent = question;

      elements.message.replaceChildren(line, asked);
      elements.message.classList.add("suggestion");
      showMessage(ms);
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
