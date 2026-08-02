"use strict";

/**
 * The invisible emoji that gives the daily summary its columns.
 *
 * Discord renders message text in a proportional font, so padding a row with
 * spaces aligns nothing: `Alice` and `Bartholomew` are different widths and a
 * space is narrower than either. The summary gets around this because the only
 * variable-width run in a row is the guess grid, and every emoji in a message
 * body renders at the same width. A gap of "three more guesses" is therefore
 * exactly three emoji wide -- a whole number, with no font metrics involved.
 *
 * Filling that gap needs a character that is one emoji wide and shows nothing.
 * No Unicode codepoint qualifies: U+200B has zero width, U+2003 and U+200A are
 * text-width and font-dependent, U+2800 is about one character wide. The only
 * thing guaranteed to occupy exactly one emoji is an emoji, so this uploads a
 * fully transparent one and pads with that.
 *
 * It is an *application* emoji rather than a guild emoji. Application emojis
 * belong to the bot, work in every server it is in, and need no Use External
 * Emoji permission, so alignment does not depend on how a guild is configured.
 *
 * Everything here is best-effort. If the emoji cannot be listed or created the
 * summary still posts, just without its columns -- see `padding` returning "".
 */

const API = "https://discord.com/api/v10";

/**
 * A 128x128 fully transparent PNG, 143 bytes, inlined so no asset file has to
 * survive the Docker build. Regenerate with zlib if it ever needs to change;
 * every byte of the image data is zero, which is what makes it this small.
 */
const BLANK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAVklEQVR42u3BMQEAAADCoPVPbQwf" +
  "oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAOBvAI8AAYr5gj4AAAAASUVORK5CYII=";

/**
 * Kept short on purpose. The name is repeated inside every pad reference, and
 * `<:pad:1234567890123456789>` is 26 characters of message budget for one
 * invisible column -- a longer name buys nothing and costs it on every gap.
 */
const PAD_NAME = "pad";

/** The `<:name:id>` reference, once resolved. Null until then, and after a failure. */
let mention = null;

async function call(path, options, what) {
  const res = await fetch(`${API}${path}`, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${what} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

function authorized(botToken, extra) {
  return { headers: { Authorization: `Bot ${botToken}`, ...extra } };
}

/**
 * Find the pad emoji, uploading it the first time.
 *
 * Discord answers the list endpoint with `{ items: [...] }` rather than a bare
 * array, unlike the guild emoji route.
 *
 * Safe to call on every boot: the lookup comes first, so a restart reuses the
 * emoji already uploaded instead of adding another. A name collision is the only
 * identity there is, which is why nothing else may be named `pad`.
 *
 * @returns {Promise<string|null>} the `<:name:id>` reference, or null if unavailable
 */
async function ensurePadEmoji({ botToken, applicationId }) {
  if (!botToken || !applicationId) return null;
  const path = `/applications/${applicationId}/emojis`;
  try {
    const listed = await call(path, authorized(botToken), "application emoji list");
    const found = (listed.items || []).find((e) => e.name === PAD_NAME);
    const emoji =
      found ||
      (await call(
        path,
        {
          method: "POST",
          ...authorized(botToken, { "Content-Type": "application/json" }),
          body: JSON.stringify({ name: PAD_NAME, image: `data:image/png;base64,${BLANK_PNG}` }),
        },
        "application emoji upload"
      ));
    mention = `<:${emoji.name}:${emoji.id}>`;
    console.log(`Summary alignment ready (${found ? "found" : "uploaded"} ${mention}).`);
    return mention;
  } catch (e) {
    // Not worth failing a boot over. Summaries lose their columns, nothing else.
    console.error(`Summary alignment unavailable, rows will be ragged: ${e.message}`);
    mention = null;
    return null;
  }
}

/**
 * `n` emoji-widths of nothing, or "" when the pad emoji never resolved.
 *
 * Callers must treat "" as "no alignment is possible" rather than an error: it
 * is what makes a summary posted before `ensurePadEmoji` ran still read fine.
 */
function padding(n) {
  if (!mention || n <= 0) return "";
  return mention.repeat(n);
}

/** Test seam: set or clear the reference without talking to Discord. */
function setPadEmoji(value) {
  mention = value || null;
}

module.exports = { ensurePadEmoji, padding, setPadEmoji, PAD_NAME };
