"use strict";

/**
 * The country geometry the activity's map is built from.
 *
 * The official dataset is already coarse -- 197 features, 12471 coordinate pairs
 * -- so the browser gets all of it rather than a decimated copy, and the map is
 * drawn from the same polygons the distance scoring uses. Stripped of the ~55
 * unused properties per feature and rounded to a resolution the map cannot show,
 * the payload compresses to well under 100 kB.
 *
 * Built once at startup and served as an immutable, cacheable body.
 */

const crypto = require("crypto");
const globle = require("./globle");

/**
 * Three decimals is ~110 m at the equator, far below one screen pixel at world
 * zoom, and cuts the payload by roughly half.
 */
const PRECISION = 3;

function roundRing(ring) {
  const factor = 10 ** PRECISION;
  return ring.map(([lon, lat]) => [
    Math.round(lon * factor) / factor,
    Math.round(lat * factor) / factor,
  ]);
}

function roundGeometry(geometry) {
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: geometry.coordinates.map(roundRing) };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((polygon) => polygon.map(roundRing)),
    };
  }
  throw new Error(`Unsupported geometry type: ${geometry.type}`);
}

/**
 * @param {string} lang
 * @returns {{countries: Array<{name: string, label: string, geometry: object}>}}
 *   `name` is the canonical English identity used by the API; `label` is what
 *   the map prints.
 */
function build(lang) {
  return {
    countries: globle.FEATURES.map((feature) => ({
      name: feature.properties.NAME,
      label: globle.displayName(feature.properties.NAME, lang),
      geometry: roundGeometry(feature.geometry),
    })),
  };
}

// One payload per language, built on first request and then reused.
const cache = new Map();

/** The geometry payload plus an ETag, so repeat loads are 304s. */
function payload(lang) {
  const key = globle.normalizeLanguage(lang);
  if (!cache.has(key)) {
    const body = JSON.stringify(build(key));
    const etag = `"${crypto.createHash("sha1").update(body).digest("base64url")}"`;
    cache.set(key, { body, etag });
  }
  return cache.get(key);
}

module.exports = { payload, PRECISION };
