"use strict";

/**
 * Core Globle engine.
 *
 * This module reproduces, in Node, exactly what the official globle-game.com
 * client does to obtain and score the daily mystery country:
 *
 *  1. The daily answer is an AES-encrypted country index served by the game's
 *     backend at  GET https://globle-game.com/answer?day=YYYY-MM-DD&list=197
 *     We decrypt it with the same CryptoJS-style passphrase the client uses,
 *     yielding an index into the 197-country dataset (data/country_data.json).
 *
 *  2. Proximity between a guess and the answer is the minimum great-circle
 *     distance between their polygon border points (port of the game's
 *     distance.ts), in metres.
 *
 *  3. A guess is coloured by that proximity using the same emoji bands the
 *     game uses for its shareable results (port of colour.ts).
 *
 * Countries carry a display name per supported language while keeping the
 * dataset's English NAME as their identity: stored games and the answer index
 * stay language-independent, so switching language relabels past guesses
 * instead of invalidating them. Names in every supported language resolve on
 * input regardless of the active language.
 */

const crypto = require("crypto");
const https = require("https");
const path = require("path");

// --- Static data ------------------------------------------------------------

const countryData = require(path.join(__dirname, "..", "data", "country_data.json"));
const alternateNames = require(path.join(__dirname, "..", "data", "alternate_names.json"));
const germanNames = require(path.join(__dirname, "..", "data", "german_names.json"));

/** @type {Array<any>} GeoJSON features; index aligns with the server's answer index. */
const FEATURES = countryData.features;

// --- Answer fetch + decryption ---------------------------------------------

// Passphrase baked into the official client bundle (CryptoJS AES, passphrase mode).
const ANSWER_KEY = "ee53e68c3074206a002bf01333b047d5";
const ANSWER_HOST = "globle-game.com";

/**
 * OpenSSL EVP_BytesToKey (MD5): how CryptoJS derives key+IV from a passphrase
 * for "Salted__"-prefixed ciphertext. Produces 32-byte key + 16-byte IV.
 */
function deriveKeyAndIv(passphrase, salt) {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  const pass = Buffer.from(passphrase, "binary");
  while (derived.length < 48) {
    block = crypto.createHash("md5").update(Buffer.concat([block, pass, salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  return { key: derived.slice(0, 32), iv: derived.slice(32, 48) };
}

/** Decrypt a CryptoJS-AES (passphrase mode) base64 string. */
function decryptAnswer(cipherB64, passphrase) {
  const raw = Buffer.from(cipherB64, "base64");
  if (raw.slice(0, 8).toString("binary") !== "Salted__") {
    throw new Error("Unexpected ciphertext (missing salt header)");
  }
  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);
  const { key, iv } = deriveKeyAndIv(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "GlobleDiscordBot/1.0", Accept: "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Server returned HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("Could not parse server response as JSON"));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Request to globle-game.com timed out")));
  });
}

/**
 * Fetch + decrypt the official daily answer index for a given YYYY-MM-DD date.
 * @returns {Promise<number>} index into FEATURES
 */
async function fetchAnswerIndex(dateStr) {
  const url = `https://${ANSWER_HOST}/answer?day=${dateStr}&list=${FEATURES.length}`;
  const json = await httpsGetJson(url);
  if (!json || !json.answer) throw new Error("No answer field in server response");
  const indexStr = decryptAnswer(json.answer, ANSWER_KEY);
  const index = parseInt(indexStr, 10);
  if (Number.isNaN(index) || index < 0 || index >= FEATURES.length) {
    throw new Error("Decrypted answer index is invalid");
  }
  return index;
}

/** YYYY-MM-DD date string in the given IANA timezone (default UTC). */
function todayStr(timeZone = "UTC") {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// --- Distance (port of the game's distance.ts) ------------------------------

const EARTH_RADIUS = 6378137; // metres; matches spherical-geometry-js default
const MAX_DISTANCE = 15000000; // metres; colour scale ceiling (from colour.ts)

function greatCircle(lng1, lat1, lng2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Border points [lng, lat] of a feature's outer ring(s). */
function polygonPoints(feature) {
  const g = feature.geometry;
  if (g.type === "Polygon") return g.coordinates[0];
  if (g.type === "MultiPolygon") {
    let points = [];
    for (const polygon of g.coordinates) points = points.concat(polygon[0]);
    return points;
  }
  throw new Error("Unsupported geometry type: " + g.type);
}

// Enclave pairs the game hardcodes to 0 (their polygons don't share vertices).
const ZERO_PAIRS = new Set([
  "South Africa|Lesotho",
  "Lesotho|South Africa",
  "Italy|Vatican",
  "Vatican|Italy",
  "Italy|San Marino",
  "San Marino|Italy",
]);

/** Minimum great-circle distance (metres) between two countries' borders. */
function polygonDistance(a, b) {
  const key = `${a.properties.NAME}|${b.properties.NAME}`;
  if (ZERO_PAIRS.has(key)) return 0;
  const pts1 = polygonPoints(a);
  const pts2 = polygonPoints(b);
  let min = EARTH_RADIUS * Math.PI; // half circumference
  for (let i = 0; i < pts1.length; i++) {
    const p1 = pts1[i];
    for (let j = 0; j < pts2.length; j++) {
      const p2 = pts2[j];
      const d = greatCircle(p1[0], p1[1], p2[0], p2[1]);
      if (d < min) min = d;
    }
  }
  return min;
}

// --- Colour (port of the game's colour.ts getColourEmoji) -------------------

function proximityEmoji(proximityMeters, isCorrect) {
  if (isCorrect) return "🟩";
  const scale = proximityMeters / MAX_DISTANCE;
  if (scale < 0.1) return "🟥";
  if (scale < 0.25) return "🟧";
  if (scale < 0.5) return "🟨";
  return "⬜";
}

// --- Country name matching --------------------------------------------------

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
/**
 * German keyboards are frequently unavailable, so umlauts get typed out as
 * digraphs. Stripping diacritics alone turns "Türkei" into "turkei", which
 * never matches a typed "Tuerkei"; expanding first yields that second form.
 */
function expandUmlauts(s) {
  return s
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/[ßẞ]/g, "ss");
}
/** Lowercase, diacritic-free, punctuation -> single spaces. */
function normalize(s) {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
/** Lowercase, diacritic-free, all non-alphanumerics removed (e.g. "U.S.A." -> "usa"). */
function compact(s) {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Two-tier lookup: exact normalized first, then punctuation-insensitive "compact".
// Both tiers hold the diacritic-stripped and the umlaut-expanded spelling.
const NAME_LOOKUP = new Map();
const COMPACT_LOOKUP = new Map();
/**
 * The subset of the compact tier that is a name somebody would type in full,
 * which is the only thing worth measuring a misspelling against. Abbreviations
 * and codes resolve a country without being a spelling of it: "indo", "mald" and
 * "sril" sit one letter from half a dozen real names, and every typo they catch
 * is a tie that buries the name the player was aiming at.
 */
const FUZZY_SPELLINGS = new Map();
function addLookup(name, feature, { fuzzy = true } = {}) {
  if (!name) return;
  for (const variant of [name, expandUmlauts(name)]) {
    const n = normalize(variant);
    if (n && !NAME_LOOKUP.has(n)) NAME_LOOKUP.set(n, feature);
    const c = compact(variant);
    if (c && !COMPACT_LOOKUP.has(c)) COMPACT_LOOKUP.set(c, feature);
    if (fuzzy && c && !FUZZY_SPELLINGS.has(c)) FUZZY_SPELLINGS.set(c, feature);
  }
}
/**
 * The dataset's ISO_A2_EH for the United Kingdom is "GA", which is Gabon's code,
 * and its ISO_A2 is the "-99" no-data marker. Registered as-is, "ga" resolves to
 * whichever country is indexed first. Correcting the pair by hand keeps two-letter
 * lookups working ("us", "de", "gb") instead of dropping them wholesale.
 */
const ISO_OVERRIDES = { "United Kingdom": ["GB"] };

/** The usable two-letter codes for a feature; "-99" and other junk values are dropped. */
function isoCodes(properties) {
  const override = ISO_OVERRIDES[properties.NAME];
  if (override) return override;
  return [properties.ISO_A2, properties.ISO_A2_EH].filter((c) => /^[A-Z]{2}$/.test(String(c)));
}

for (const f of FEATURES) {
  const p = f.properties;
  addLookup(p.NAME, f);
  addLookup(p.NAME_LONG, f);
  addLookup(p.FORMAL_EN, f);
  addLookup(p.BRK_NAME, f);
  addLookup(p.ABBREV, f, { fuzzy: false }); // "U.S.A." -> compact "usa", "U.K." -> "uk"
  addLookup(p.POSTAL, f, { fuzzy: false });
  for (const code of isoCodes(p)) addLookup(code, f, { fuzzy: false });
}
// Aliases. The data is inconsistent about which of {real, alternative} is the
// dataset's canonical NAME, so resolve whichever side matches and alias both.
for (const list of Object.values(alternateNames)) {
  for (const { real, alternative } of list) {
    const target = NAME_LOOKUP.get(normalize(real)) || NAME_LOOKUP.get(normalize(alternative));
    if (target) {
      addLookup(real, target);
      addLookup(alternative, target);
    }
  }
}

/** Resolve a user-typed country name in any supported language to a feature, or null. */
function findCountry(input) {
  if (!input) return null;
  for (const variant of [input, expandUmlauts(input)]) {
    const hit = NAME_LOOKUP.get(normalize(variant)) || COMPACT_LOOKUP.get(compact(variant));
    if (hit) return hit;
  }
  return null;
}

// --- "Did you mean …?" ------------------------------------------------------

/**
 * What a spelling that resolved to nothing most likely meant.
 *
 * The box in the activity deliberately does not complete what is typed into it:
 * naming the country is the game, and a list that fills in "Kirgisistan" from
 * "kir" plays that part for the player. A name that is one keystroke wrong is a
 * different thing -- the player already knows which country they mean -- so it
 * is measured against every registered spelling and offered back as a question.
 *
 * Distance is measured on the compacted spelling, so spaces and hyphens are
 * never counted as mistakes ("Guinea Bissau" and "Guinea-Bissau" are the same
 * word here) and a typo inside a two-word name is still one error.
 */

/** Shortest name worth measuring against: below it, ISO codes and abbreviations dominate. */
const FUZZY_MIN_LENGTH = 4;

/**
 * How many single-character errors a name of this length may carry and still be
 * offered. Short names are held to one because at two nearly every four-letter
 * country is a neighbour of every other ("Chad", "Chile", "China").
 */
function fuzzyTolerance(length) {
  if (length < 6) return 1;
  if (length < 10) return 2;
  return 3;
}

/**
 * Optimal string alignment distance, abandoned once every alignment still in
 * flight is worse than `max` (reported as `max + 1`).
 *
 * Adjacent transpositions cost one rather than two, which is what puts
 * "Brasilein" a single error away from "Brasilien" -- the most common way a
 * name typed at speed comes out wrong.
 */
function editDistance(a, b, max) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  if (!n) return m;
  if (!m) return n;

  let twoBack = new Array(m + 1).fill(0);
  let previous = new Array(m + 1);
  let current = new Array(m + 1);
  for (let j = 0; j <= m; j++) previous[j] = j;

  for (let i = 1; i <= n; i++) {
    current[0] = i;
    let best = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, twoBack[j - 2] + 1);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    const spare = twoBack;
    twoBack = previous;
    previous = current;
    current = spare;
  }
  return previous[m];
}

/**
 * Every spelling long enough to be worth a comparison, built on first use
 * because names go on being registered until this module finishes loading.
 * @type {Array<[string, object]> | null}
 */
let FUZZY_INDEX = null;
function fuzzyIndex() {
  if (!FUZZY_INDEX) {
    FUZZY_INDEX = [];
    for (const [name, feature] of FUZZY_SPELLINGS) {
      if (name.length >= FUZZY_MIN_LENGTH) FUZZY_INDEX.push([name, feature]);
    }
  }
  return FUZZY_INDEX;
}

/**
 * The country a misspelling probably meant, or null when nothing is close
 * enough to ask about.
 *
 * Candidates are the spellings of every language at once, so a German typo
 * finds a German name and an English one an English name without either being
 * told which language is being played, and an alias is as good a target as a
 * canonical name ("Elfenbeinkueste", "Holland", "Zaire").
 *
 * Two countries the same distance away are separated by their first letter,
 * which is the one a typo almost never lands on: it is what tells "Nambia" from
 * Gambia and Zambia. If that leaves them level too the answer is null, because a
 * coin flip dressed up as a question is worse than saying nothing.
 *
 * @param {string} input  what the player typed
 * @returns {string|null} the dataset's canonical English NAME
 */
function suggestCountry(input) {
  if (!input) return null;
  const typed = [...new Set([compact(input), compact(expandUmlauts(input))])].filter(
    (s) => s.length >= FUZZY_MIN_LENGTH - 1
  );
  if (!typed.length) return null;

  let best = null;
  let bestDistance = Infinity;
  let bestInitial = false; // whether the leader starts the way the typing does
  let ambiguous = false;

  for (const [name, feature] of fuzzyIndex()) {
    for (const spelling of typed) {
      // Nothing worse than the leader is worth finishing, but an equal score is:
      // it is what makes two countries ambiguous rather than a race between them.
      const limit = Math.min(fuzzyTolerance(Math.min(spelling.length, name.length)), bestDistance);
      const distance = editDistance(spelling, name, limit);
      if (distance > limit) continue;
      const initial = spelling[0] === name[0];

      if (distance < bestDistance || (distance === bestDistance && initial && !bestInitial)) {
        bestDistance = distance;
        bestInitial = initial;
        best = feature;
        ambiguous = false;
      } else if (feature !== best && distance === bestDistance && initial === bestInitial) {
        ambiguous = true;
      }
    }
  }

  if (!best || ambiguous) return null;
  return best.properties.NAME;
}

// Exact-NAME -> feature map, for resolving the canonical names stored in a game.
const FEATURE_BY_NAME = new Map(FEATURES.map((f) => [f.properties.NAME, f]));

// --- Display languages ------------------------------------------------------

const LANGUAGES = ["en", "de"];
const DEFAULT_LANGUAGE = "en";

/**
 * Map a Discord locale ("de", "de-DE", …) to a supported language, falling back
 * to English for anything unsupported.
 */
function normalizeLanguage(locale) {
  const tag = String(locale || "").toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.includes(tag) ? tag : DEFAULT_LANGUAGE;
}

// Canonical English NAME -> German label. The dataset's own NAME_DE covers all
// 197 countries; german_names.json only corrects the values that are wrong
// (NAME_DE for Georgia is "Abchasien") or too long for a map label.
const GERMAN_BY_NAME = new Map();
for (const f of FEATURES) {
  const p = f.properties;
  const de = germanNames.overrides[p.NAME] || p.NAME_DE;
  if (de) GERMAN_BY_NAME.set(p.NAME, de);
}

// Register every German spelling so a guess resolves whatever the active
// language is: the dataset's NAME_DE, the override, and the hand-written aliases.
for (const f of FEATURES) {
  addLookup(f.properties.NAME_DE, f);
  addLookup(GERMAN_BY_NAME.get(f.properties.NAME), f);
}
for (const [alias, canonical] of Object.entries(germanNames.aliases)) {
  const target = FEATURE_BY_NAME.get(canonical);
  if (target) addLookup(alias, target);
  else console.warn(`german_names.json: alias "${alias}" points at unknown country "${canonical}"`);
}

/**
 * The label for a country in the given language. Takes the dataset's canonical
 * English NAME (what games store) and returns what a player should read.
 */
function displayName(name, lang = DEFAULT_LANGUAGE) {
  if (normalizeLanguage(lang) === "de") return GERMAN_BY_NAME.get(name) || name;
  return name;
}

/**
 * The two-letter code for a canonical English NAME, or "" for a country the
 * dataset gives none. Two characters is the only label for a country that fits
 * where a name does not, which is what the roster's squares have room for.
 */
function isoCode(name) {
  const feature = FEATURE_BY_NAME.get(name);
  if (!feature) return "";
  return isoCodes(feature.properties)[0] || "";
}

/**
 * The flag emoji for a canonical English NAME, or "" for a country the dataset
 * gives no usable ISO code. A flag is two regional indicators, which is the code
 * with each letter shifted into that block.
 *
 * For Discord messages only. Discord renders them through Twemoji, so a flag
 * arrives as a flag there; the activity is an ordinary web page, and on Windows
 * the system emoji font has no flag glyphs at all.
 */
function flagEmoji(name) {
  const code = isoCode(name);
  if (!code) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

module.exports = {
  FEATURES,
  fetchAnswerIndex,
  todayStr,
  polygonDistance,
  proximityEmoji,
  findCountry,
  suggestCountry,
  displayName,
  isoCode,
  flagEmoji,
  normalizeLanguage,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  MAX_DISTANCE,
};
