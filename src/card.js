"use strict";

/**
 * The result card: the emoji grid, drawn.
 *
 * The finish announcement carries this image in place of a row of emoji, and it
 * holds the same information for the same reason. One chip per guess in its
 * proximity colour, the guess count, the group's streak. No country is named
 * and no country is placed, so a card posted into a channel spoils nothing for
 * a player who has not finished.
 *
 * Chip colours come from colour.js, so the card and the board agree on what a
 * given distance looks like.
 */

const colour = require("./colour");
const { t } = require("./i18n");

const FONT = "Inter";

let graphics = null;

/**
 * The canvas binding and the face it draws with, loaded on the first card.
 *
 * Both are deferred because both can fail on a host: @napi-rs/canvas resolves a
 * prebuilt binary per platform, and the runtime image carries no fonts of its
 * own, so the typeface travels as a dependency. Throwing here costs an
 * announcement its picture, which is what the caller falls back from. Loading
 * at require time would instead cost the process its start.
 */
function loadGraphics() {
  if (graphics) return graphics;
  const canvas = require("@napi-rs/canvas");
  const file = require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
  if (!canvas.GlobalFonts.registerFromPath(file, FONT)) {
    throw new Error(`could not register ${FONT} from ${file}`);
  }
  graphics = canvas;
  return graphics;
}

// --- Layout -----------------------------------------------------------------

const WIDTH = 1100;
const PAD = 64;
const INNER = WIDTH - PAD * 2;

const BG_TOP = "#1b1d21";
const BG_BOTTOM = "#101114";
const TEXT = "#f2f3f5";
const MUTED = "#9aa1ab";
const CHIP_WIN_RING = "rgba(255,255,255,0.85)";

// The streak is warm because it belongs to the same scale as the chips beneath
// it. Hard mode is cool for the opposite reason: it says nothing about distance.
const STREAK_TONE = { ink: "#f2903c", fill: "rgba(226,83,47,0.16)", line: "rgba(226,83,47,0.55)" };
const HARD_TONE = { ink: "#c3ccd9", fill: "rgba(154,178,214,0.14)", line: "rgba(154,178,214,0.45)" };

/**
 * Chip size for a game of `n` guesses, chosen so even a long game stays about
 * three rows tall and the card keeps its shape in the message list.
 */
function chipMetrics(n) {
  const steps = [
    [8, 108, 18],
    [18, 76, 14],
    [36, 52, 10],
    [81, 30, 6],
  ];
  for (const [limit, size, gap] of steps) {
    if (n <= limit) return { size, gap };
  }
  return { size: 22, gap: 4 };
}

const font = (size, weight) => `${weight} ${size}px ${FONT}`;

/** The day, in the language the announcement is written in. */
function formatDate(date, lang) {
  if (!date) return "";
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return date;
  return new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
}

/** Shrink a heading until it fits the card, so a long language cannot overflow it. */
function fitText(ctx, text, size, weight, maxWidth) {
  let current = size;
  ctx.font = font(current, weight);
  while (ctx.measureText(text).width > maxWidth && current > 28) {
    current -= 2;
    ctx.font = font(current, weight);
  }
  return current;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// --- Drawing ----------------------------------------------------------------

/** The wordmark and the day it belongs to. */
function drawHeader(ctx, y, subtitle) {
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = TEXT;
  ctx.font = font(38, 800);
  ctx.fillText("GLOBLE", PAD, y);
  const width = ctx.measureText("GLOBLE").width;
  ctx.fillStyle = MUTED;
  ctx.font = font(24, 500);
  ctx.fillText(subtitle, PAD + width + 18, y);
}

/**
 * A pill badge ending at `right`.
 *
 * @returns {number} the width it took, so badges can be laid out from the card's
 * right edge inwards whether or not the one beside them is there
 */
function drawBadge(ctx, right, y, label, tone) {
  ctx.font = font(20, 700);
  const width = ctx.measureText(label).width + 44;
  const height = 44;
  const x = right - width;
  roundRect(ctx, x, y - height + 12, width, height, height / 2);
  ctx.fillStyle = tone.fill;
  ctx.fill();
  ctx.strokeStyle = tone.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = tone.ink;
  ctx.fillText(label, x + 22, y - 2);
  return width;
}

/**
 * The guesses, in the order they were made, wrapped to the card width.
 * @returns {number} the height the grid took
 */
function drawChips(ctx, y, chips, { size, gap }) {
  const perRow = Math.max(1, Math.floor((INNER + gap) / (size + gap)));
  chips.forEach((chip, index) => {
    const x = PAD + (index % perRow) * (size + gap);
    const top = y + Math.floor(index / perRow) * (size + gap);
    roundRect(ctx, x, top, size, size, Math.max(4, size * 0.22));
    ctx.fillStyle = chip.colour;
    ctx.fill();
    if (chip.correct) {
      ctx.strokeStyle = CHIP_WIN_RING;
      ctx.lineWidth = Math.max(2, size * 0.07);
      ctx.stroke();
    }
  });
  const rows = Math.ceil(chips.length / perRow);
  return rows * size + Math.max(0, rows - 1) * gap;
}

/**
 * Draw one finished game.
 *
 * @param {object} game
 * @param {Array<{proximity: number, correct: boolean}>} game.guesses
 * @param {boolean} game.win
 * @param {number} game.guessCount
 * @param {string} game.displayName
 * @param {string} game.date     YYYY-MM-DD
 * @param {number} game.streak   days the group has run; hidden below two
 * @param {boolean} game.hard    the game was played on hard
 * @param {string} game.lang
 * @returns {Promise<Buffer>} PNG
 */
async function renderCard({ guesses, win, guessCount, displayName, date, streak = 0, hard = false, lang }) {
  const { createCanvas } = loadGraphics();

  const chips = await Promise.all(
    guesses.map(async (guess) => ({
      correct: Boolean(guess.correct),
      colour: await colour.colourForGuess(guess),
    }))
  );

  const turns = `${guessCount} ${t(lang, "guessUnit", guessCount)}`;
  const headline = win ? t(lang, "cardWin", turns) : t(lang, "cardGaveUp", turns);
  const metrics = chipMetrics(chips.length);

  // The card is measured before it is drawn, because its height depends on how
  // many rows the guesses wrapped into.
  const measure = createCanvas(WIDTH, 10).getContext("2d");
  const perRow = Math.max(1, Math.floor((INNER + metrics.gap) / (metrics.size + metrics.gap)));
  const rows = Math.ceil(chips.length / perRow);
  const chipsHeight = rows ? rows * metrics.size + (rows - 1) * metrics.gap : 0;
  const headlineSize = fitText(measure, headline, 64, 800, INNER);

  const chipsTop = 150;
  const headlineBaseline = chipsTop + chipsHeight + (chipsHeight ? 96 : 30);
  const bylineBaseline = headlineBaseline + 46;
  const height = bylineBaseline + 60;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  const background = ctx.createLinearGradient(0, 0, WIDTH * 0.4, height);
  background.addColorStop(0, BG_TOP);
  background.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, height);

  drawHeader(ctx, 90, formatDate(date, lang));

  let right = WIDTH - PAD;
  // Same threshold as the announcement's streak line: a one day run is not one.
  if (streak > 1) right -= drawBadge(ctx, right, 90, t(lang, "cardStreak", streak), STREAK_TONE) + 10;
  if (hard) drawBadge(ctx, right, 90, t(lang, "cardHard"), HARD_TONE);

  if (chipsHeight) drawChips(ctx, chipsTop, chips, metrics);

  ctx.fillStyle = TEXT;
  ctx.font = font(headlineSize, 800);
  ctx.fillText(headline, PAD, headlineBaseline);

  ctx.fillStyle = MUTED;
  ctx.font = font(28, 500);
  ctx.fillText(displayName, PAD, bylineBaseline);

  return canvas.toBuffer("image/png");
}

module.exports = { renderCard };
