/**
 * The flat 2D map.
 *
 * A plain canvas fallback for frames where WebGL is unavailable. It draws the
 * same countries in the same projection and the same colours as the board, so a
 * player who lands here is playing the same game with less scenery.
 *
 * It carries no three.js, which is also what makes it a safe fallback: if the
 * board fails, this path has nothing in common with what failed.
 */

import { geoEquirectangular, geoGraticule10, geoPath, geoContains } from "d3-geo";

// The board's palette, so a player who lands here sees the same map in the same
// colours with less scenery.
const BACKDROP = "#04141f";
const OCEAN = "#159cab";
const GRATICULE = "rgba(216, 255, 250, 0.12)";
const LAND_UNGUESSED = "#8aab5e";
const LAND_ELIMINATED = "#7a7d73";
const BORDER_INK = "#221c14";
const COAST_LIP = "rgba(230, 255, 250, 0.6)";
const LAND_SHADOW = "rgba(4, 42, 61, 0.45)";
const HOVER_TINT = "rgba(255, 246, 226, 0.14)";
const LABEL = "#f6ecd8";
const LABEL_HALO = "rgba(0,0,0,0.8)";

/**
 * The shelf of shallow water every coast stands in, widest band first. The 2.5D
 * board carries the same three colours, drawn into its water texture.
 */
const SHORE = [
  ["#2fbcc2", 24],
  ["#5fdad2", 11],
  ["#e6fffa", 3],
];

const MIN_ZOOM = 1;
const MAX_ZOOM = 12;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{name: string, label: string, geometry: object}>} countries
 */
export function createFlatMap(canvas, countries) {
  const ctx = canvas.getContext("2d");
  const projection = geoEquirectangular();
  const path = geoPath(projection, ctx);

  // A country magnified to the size floor laps over whatever it borders, so it
  // is drawn after its neighbours instead of under them. Nothing else here
  // depends on the order, and the sort is stable, so the rest keep theirs.
  const features = countries
    .map((country) => ({
      name: country.name,
      label: country.label,
      magnified: Boolean(country.magnified),
      feature: { type: "Feature", properties: {}, geometry: country.geometry },
    }))
    .sort((a, b) => Number(a.magnified) - Number(b.magnified));

  let colours = new Map();
  let labelled = new Set();
  let finished = false;
  let zoom = 1;
  let centre = [0, 0]; // longitude, latitude at the middle of the view
  let hoverHandler = null;
  let selectHandler = null;
  let hovered = null;

  function fit() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fit the whole world, then scale up and re-centre for the current zoom.
    projection.scale(1).translate([0, 0]);
    const base = Math.min(width / (2 * Math.PI), height / Math.PI);
    projection.scale(base * zoom);
    const [cx, cy] = projection(centre);
    projection.translate([width / 2 - cx, height / 2 - cy]);
  }

  function draw() {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    // What a country nobody named is filled with. Once the game is over that is
    // every country left, and the map drains to grey around the guesses.
    const land = finished ? LAND_ELIMINATED : LAND_UNGUESSED;

    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, width, height);

    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.fillStyle = OCEAN;
    ctx.fill();

    ctx.beginPath();
    path(geoGraticule10());
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = GRATICULE;
    ctx.stroke();

    // Every landmass as one path, filled once, so the shadow lands on water
    // rather than on the next country drawn. Same depth cue the 2.5D board gets
    // from its plates. The edge is hard, the way a printed board's is: a blur
    // this size would be a full-screen gaussian on every pan, and this path runs
    // on the machines that could least afford one.
    ctx.save();
    ctx.beginPath();
    for (const entry of features) path(entry.feature);

    // The shelf of shallow water every coast stands in. A stroke is centred on
    // the line it follows, so half of every band falls inland, where the fills
    // below cover it. Drawn before the land so the land's shadow falls across the
    // shelf rather than the shelf painting over the shadow.
    ctx.lineJoin = "round";
    for (const [colour, width] of SHORE) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
    }

    ctx.shadowColor = LAND_SHADOW;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = land;
    ctx.fill();
    ctx.restore();

    // A hovered country warms a shade and takes a lighter outline: the same two
    // cues the 2.5D board gives, minus the lift it has no room for.
    for (const entry of features) {
      ctx.beginPath();
      path(entry.feature);
      ctx.fillStyle = colours.get(entry.name) || land;
      ctx.fill();
      if (entry.name === hovered) {
        ctx.fillStyle = HOVER_TINT;
        ctx.fill();
      }
      ctx.lineWidth = entry.name === hovered ? 1.8 : 0.7;
      ctx.strokeStyle = entry.name === hovered ? COAST_LIP : BORDER_INK;
      ctx.stroke();
    }

    // Uppercase and spaced out, the way a printed map sets a territory name.
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.letterSpacing = "1px";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = LABEL_HALO;
    ctx.fillStyle = LABEL;
    for (const entry of features) {
      if (!labelled.has(entry.name)) continue;
      const point = path.centroid(entry.feature);
      if (!Number.isFinite(point[0])) continue;
      const text = entry.label.toUpperCase();
      ctx.strokeText(text, point[0], point[1]);
      ctx.fillText(text, point[0], point[1]);
    }
  }

  function render() {
    fit();
    draw();
  }

  /**
   * The country under a screen point, via the projection's inverse. Walked back
   * to front, so where a magnified country covers its neighbour the answer is
   * the one the player can see.
   */
  function at(event) {
    const rect = canvas.getBoundingClientRect();
    const lonlat = projection.invert([event.clientX - rect.left, event.clientY - rect.top]);
    if (!lonlat) return null;
    for (let i = features.length - 1; i >= 0; i--) {
      if (geoContains(features[i].feature, lonlat)) return features[i].name;
    }
    return null;
  }

  // --- Pan and zoom ---------------------------------------------------------

  let dragging = null;

  canvas.addEventListener("pointerdown", (event) => {
    dragging = { x: event.clientX, y: event.clientY, at: performance.now(), moved: 0 };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (dragging) {
      const dx = event.clientX - dragging.x;
      const dy = event.clientY - dragging.y;
      dragging.moved += Math.hypot(dx, dy);
      dragging.x = event.clientX;
      dragging.y = event.clientY;

      // Convert the pixel drag into a change of the centre coordinate.
      const rect = canvas.getBoundingClientRect();
      const before = projection.invert([rect.width / 2, rect.height / 2]);
      const after = projection.invert([rect.width / 2 - dx, rect.height / 2 - dy]);
      if (before && after) {
        centre = [
          wrapLongitude(centre[0] + (after[0] - before[0])),
          clamp(centre[1] + (after[1] - before[1]), -85, 85),
        ];
      }
      render();
      return;
    }

    if (event.pointerType === "touch") return;
    const name = at(event);
    if (name === hovered) return;
    hovered = name;
    if (hoverHandler) {
      const entry = features.find((f) => f.name === name);
      hoverHandler(entry ? entry.label : null, name);
    }
    draw();
  });

  canvas.addEventListener("pointerup", (event) => {
    const drag = dragging;
    dragging = null;
    if (!drag || !selectHandler) return;
    if (drag.moved > 6 || performance.now() - drag.at > 450) return;
    const name = at(event);
    if (name) selectHandler(name);
  });

  canvas.addEventListener("pointercancel", () => {
    dragging = null;
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      zoom = clamp(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), MIN_ZOOM, MAX_ZOOM);
      render();
    },
    { passive: false }
  );

  render();

  return {
    resize: render,

    paint(nextColours, nextLabelled, nextFinished = false) {
      colours = nextColours;
      labelled = nextLabelled;
      finished = nextFinished;
      draw();
    },

    // The flat map is the 2D view; there is nothing to switch to.
    setView() {},
    getView: () => "flat",

    onHover(handler) {
      hoverHandler = handler;
    },

    onSelect(handler) {
      selectHandler = handler;
    },

    dispose() {},
  };
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function wrapLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
