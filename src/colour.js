"use strict";

/**
 * Globle's proximity colour ramp, in one place so the map and the API shade a
 * guess identically: sand through gold and orange to crimson, on a square-root
 * scale over [MAX_DISTANCE, 0], with the answer in green.
 *
 * The server resolves every colour and sends hex/rgb strings to the client.
 * That keeps the scale definition single-sourced and keeps d3 out of the
 * browser bundle.
 *
 * d3 v7 is ESM-only, so it loads through a cached dynamic import.
 */

const globle = require("./globle");

/** The answer's fill, matching the real game's green. */
const ANSWER_COLOUR = "#2ecc71";

/**
 * The ramp's stops, coldest guess first.
 *
 * Print palettes in the `OrRd` family open on an almost-white cream and spend
 * their middle in dusty apricot, and both go grey against saturated turquoise
 * water. These stops hold their chroma the whole way down, so a far guess reads
 * as warm sand rather than as a highlight, and two cold guesses stay apart at the
 * end of the ramp where most of the game is played.
 *
 * The scale interpolates them as a B-spline, so the ramp passes near each stop
 * rather than through it and no stop shows up as a band of its own.
 */
const RAMP = ["#f7e6b6", "#f8c94a", "#f2903c", "#e2532f", "#b81639", "#7e0b2c"];

let scalePromise = null;

/**
 * @returns {Promise<(proximityMeters: number) => string>} css colour for a distance
 */
function proximityScale() {
  if (!scalePromise) {
    scalePromise = Promise.all([import("d3-scale"), import("d3-interpolate")]).then(
      ([scale, interpolate]) =>
        scale.scaleSequentialSqrt(interpolate.interpolateRgbBasis(RAMP)).domain([globle.MAX_DISTANCE, 0])
    );
  }
  return scalePromise;
}

/** The fill for one guess: green when it is the answer, otherwise by proximity. */
async function colourForGuess(guess) {
  if (guess.correct) return ANSWER_COLOUR;
  const scale = await proximityScale();
  return scale(guess.proximity);
}

module.exports = { colourForGuess, ANSWER_COLOUR };
