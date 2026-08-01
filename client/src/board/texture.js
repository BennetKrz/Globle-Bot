/**
 * The board's surfaces, drawn procedurally.
 *
 * Every texture is generated into a canvas at startup, so the bundle carries no
 * image files and the activity makes no asset request its content policy could
 * refuse.
 *
 * The sea is one non-repeating texture the size of the whole water plane. That
 * is what lets it carry cartography rather than just material: it is drawn in
 * board coordinates, so a meridian lands on its meridian and the shelf lands on
 * its coast. The plane reaches past the map on every side and the texture
 * dissolves into the backdrop across that margin, which is what leaves the world
 * floating instead of sitting on a rectangle.
 */

import { CanvasTexture, SRGBColorSpace } from "three";

import { BOARD_HEIGHT, BOARD_WIDTH, project } from "./build.js";

const SEA_WIDTH = 2048;
const SEA_HEIGHT = 1024;

/** A canvas of uniform random grey: one octave of value noise. */
function noiseTile(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const value = Math.random() * 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Wash octaves of value noise over the target in soft light, coarsest first.
 *
 * Coarse octaves upscale through the canvas's own filtering into cloudy
 * mottling; an octave near the target's resolution reads as tooth. Soft light
 * keeps every octave centred on the base colour instead of greying it out.
 */
function mottle(ctx, width, height, octaves) {
  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  for (const { cells, alpha } of octaves) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(noiseTile(cells[0], cells[1]), 0, 0, width, height);
  }
  ctx.restore();
}

function canvasOf(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toTexture(canvas) {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Meridians and parallels, with the equator picked out and the tropics dashed. */
function graticule(ctx, line, toX, toY) {
  ctx.save();
  ctx.strokeStyle = line;

  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let lon = -160; lon <= 160; lon += 20) {
    ctx.moveTo(toX(lon), 0);
    ctx.lineTo(toX(lon), SEA_HEIGHT);
  }
  for (let lat = -80; lat <= 80; lat += 20) {
    if (lat === 0) continue;
    ctx.moveTo(0, toY(lat));
    ctx.lineTo(SEA_WIDTH, toY(lat));
  }
  ctx.stroke();

  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, toY(0));
  ctx.lineTo(SEA_WIDTH, toY(0));
  ctx.stroke();

  ctx.setLineDash([16, 14]);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const lat of [23.44, -23.44, 66.56, -66.56]) {
    ctx.moveTo(0, toY(lat));
    ctx.lineTo(SEA_WIDTH, toY(lat));
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * The shelf of shallow water every coast stands in: a wide band of turquoise, a
 * brighter one inside it, and a line of foam against the land.
 *
 * The bands are strokes on the coastline rather than a blurred silhouette. A
 * stroke holds one flat colour out to a fixed width and then stops, which is
 * what makes the water read as a drawn shelf; a blur wide enough to cover the
 * same ground reads as a glow around the continents instead. Each band still
 * takes a small blur, but only enough to keep its outer edge from crawling.
 *
 * Widest first, so each band covers the inside of the one before it. A stroke is
 * centred on the line it follows, so half of every band falls inland, where the
 * country plates cover it.
 *
 * The segments arrive unordered and each is stroked as its own two-point
 * subpath, so the caps are the only thing joining one to the next. Round is the
 * cap that does it without leaving a notch on the outside of a bend.
 */
function shoreBands(ctx, segments, bands, toPoint) {
  const coast = new Path2D();
  for (let i = 0; i < segments.length; i += 4) {
    const from = toPoint([segments[i], segments[i + 1]]);
    const to = toPoint([segments[i + 2], segments[i + 3]]);
    coast.moveTo(from[0], from[1]);
    coast.lineTo(to[0], to[1]);
  }

  ctx.save();
  ctx.lineCap = "round";
  for (const { colour, width, blur } of bands) {
    ctx.filter = `blur(${blur}px)`;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.stroke(coast);
  }
  ctx.restore();
}

/**
 * Dissolve the outer margin into the backdrop.
 *
 * Four bands rather than one radial fade, so the map keeps its full water on
 * every side and only the margin goes. The last stop is the backdrop's own
 * colour, which is what makes the plane's edge impossible to find.
 */
function dissolve(ctx, backdrop, marginX, marginY) {
  const bands = [
    [0, 0, 0, marginY, SEA_WIDTH, marginY],
    [0, SEA_HEIGHT, 0, SEA_HEIGHT - marginY, SEA_WIDTH, marginY],
    [0, 0, marginX, 0, marginX, SEA_HEIGHT],
    [SEA_WIDTH, 0, SEA_WIDTH - marginX, 0, marginX, SEA_HEIGHT],
  ];

  for (const [x0, y0, x1, y1, w, h] of bands) {
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    gradient.addColorStop(0, backdrop);
    gradient.addColorStop(0.45, hexToRgba(backdrop, 0.55));
    gradient.addColorStop(1, hexToRgba(backdrop, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), w, h);
  }
}

function hexToRgba(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * The water, in map coordinates.
 *
 * @param {object} options
 * @param {number} options.margin  board units of water past the map on each side
 * @param {number[]} options.coast  coastline as `[x1, y1, x2, y2, …]` in board space
 * @param {{sea: string, mid: string, deep: string, shelf: string, shallow: string,
 *   foam: string, line: string, backdrop: string}} options.colours
 * @returns {CanvasTexture}
 */
export function seaTexture({ margin, coast, colours }) {
  const width = BOARD_WIDTH + margin * 2;
  const height = BOARD_HEIGHT + margin * 2;
  const toPoint = ([x, y]) => [
    ((x + width / 2) / width) * SEA_WIDTH,
    ((height / 2 - y) / height) * SEA_HEIGHT,
  ];
  const toX = (lon) => toPoint(project([lon, 0]))[0];
  const toY = (lat) => toPoint(project([0, lat]))[1];

  const canvas = canvasOf(SEA_WIDTH, SEA_HEIGHT);
  const ctx = canvas.getContext("2d");

  // Open water holds one colour across the map and only turns deep as it runs
  // out past the edges. Grading it from the middle instead would read as a
  // spotlight on the equator, and it would fight the shelf for the job of saying
  // where the water gets shallow.
  const depth = ctx.createRadialGradient(
    SEA_WIDTH / 2,
    SEA_HEIGHT / 2,
    SEA_HEIGHT * 0.1,
    SEA_WIDTH / 2,
    SEA_HEIGHT / 2,
    SEA_WIDTH * 0.7
  );
  depth.addColorStop(0, colours.sea);
  depth.addColorStop(0.6, colours.sea);
  depth.addColorStop(0.84, colours.mid);
  depth.addColorStop(1, colours.deep);
  ctx.fillStyle = depth;
  ctx.fillRect(0, 0, SEA_WIDTH, SEA_HEIGHT);

  // Lighter than the mottling a realistic sea would take. The water carries a
  // saturated flat colour, and noise heavy enough to read as surface detail
  // takes the saturation back out of it.
  mottle(ctx, SEA_WIDTH, SEA_HEIGHT, [
    { cells: [6, 3], alpha: 0.14 },
    { cells: [22, 11], alpha: 0.1 },
    { cells: [90, 45], alpha: 0.07 },
  ]);

  graticule(ctx, colours.line, toX, toY);
  shoreBands(
    ctx,
    coast,
    [
      { colour: colours.shelf, width: 50, blur: 4 },
      { colour: colours.shallow, width: 22, blur: 2.5 },
      { colour: colours.foam, width: 6, blur: 1 },
    ],
    toPoint
  );
  dissolve(
    ctx,
    colours.backdrop,
    (margin / width) * SEA_WIDTH * 1.15,
    (margin / height) * SEA_HEIGHT * 1.15
  );

  return toTexture(canvas);
}

/**
 * What sits behind everything: one soft pool of light the world floats in.
 *
 * Stretched over the frame rather than fitted to it, so the shape of the pool
 * follows the shape Discord gives the activity.
 *
 * Three stops rather than two. A straight fade from a saturated centre to a near
 * black corner passes through grey on the way, and the middle of that fade is
 * most of the frame.
 *
 * @param {string} inner
 * @param {string} mid
 * @param {string} outer
 * @returns {CanvasTexture}
 */
export function backdropTexture(inner, mid, outer) {
  const size = 512;
  const canvas = canvasOf(size, size);
  const ctx = canvas.getContext("2d");

  const glow = ctx.createRadialGradient(size / 2, size * 0.44, 0, size / 2, size * 0.44, size * 0.72);
  glow.addColorStop(0, inner);
  glow.addColorStop(0.48, mid);
  glow.addColorStop(1, outer);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  return toTexture(canvas);
}
