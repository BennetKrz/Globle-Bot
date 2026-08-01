/**
 * What the on-screen keyboard does to the layout, in two custom properties.
 *
 * `--kb` is how much of the frame the keyboard covers, which the HUD pads its
 * bottom row with. `--frame` is the height the board draws at, which only the
 * fallback path below sets.
 *
 * There are two ways to get the first number, and which one is available decides
 * how much of the mess the activity has to clean up after.
 */

/** Below this, the gap is browser chrome sliding about rather than a keyboard. */
const MIN_INSET = 24;

/** Above this share of the frame, the reading is wrong. Padding the entry row off
    the top of the screen is worse than letting the keyboard clip it. */
const MAX_SHARE = 0.6;

/** How long to wait for a frame that never comes back before letting go anyway. */
const RELEASE_TIMEOUT = 800;

/**
 * Publish `--kb`, and `--frame` where it is needed, and keep them current.
 *
 * @param {HTMLElement} [root]
 */
export function trackKeyboard(root = document.documentElement) {
  root.style.setProperty("--kb", "0px");

  let applied = 0;

  /** @param {number} covered  how much of the frame the keyboard sits over */
  function publish(covered) {
    const limit = root.clientHeight * MAX_SHARE;
    const inset = covered > MIN_INSET ? Math.round(Math.min(covered, limit)) : 0;
    if (inset === applied) return;
    applied = inset;
    root.style.setProperty("--kb", `${inset}px`);
  }

  if (takeOverKeyboard(root)) return;
  trackViewport(root, publish);
}

/**
 * The keyboard as an overlay, on browsers that report its geometry.
 *
 * This is the only way to stop the browser scrolling the page to bring the
 * focused input into view. That scroll takes the whole activity with it -- the map
 * slides up behind the keyboard and drops back once the layout settles -- and it
 * is a scroll rather than a resize, so no amount of pinning the canvas reaches it.
 * `overlaysContent` says the page will place things around the keyboard itself,
 * and in return the browser leaves both viewports and the scroll position alone.
 *
 * The height comes from `env(keyboard-inset-height)`, handed to `--kb` as a token
 * rather than read and copied back. The browser keeps it current across the
 * keyboard's whole animation, so nothing depends on an event arriving, and there
 * is no window in which the page has the frame but not yet the measurement. The
 * env variable ships with `overlaysContent`, so the flag holding is enough to
 * know the number will be there.
 *
 * Whether it holds is not up to the activity. `virtual-keyboard` is a policy
 * controlled feature allowlisted to `self`, so an embedder that does not grant it
 * drops the assignment without raising anything. Discord does not grant it, which
 * puts the activity on the fallback path in the client and on this one in a
 * browser tab. Reading the flag back is the only way to tell the two apart.
 *
 * @param {HTMLElement} root
 * @returns {boolean} whether this path took the keyboard
 */
function takeOverKeyboard(root) {
  if (!("virtualKeyboard" in navigator)) return false;
  const keyboard = navigator.virtualKeyboard;
  keyboard.overlaysContent = true;
  if (!keyboard.overlaysContent) return false;
  root.style.setProperty("--kb", "env(keyboard-inset-height, 0px)");
  return true;
}

/**
 * The keyboard as a change in viewport, everywhere else.
 *
 * Two things happen here, because frames answer a keyboard in one of two ways.
 *
 * A frame that only shrinks its *visual* viewport leaves the HUD sitting under
 * the keys, and the gap between the two viewports is how far under.
 *
 * A frame that shrinks for real moves the HUD clear on its own but takes the
 * canvas with it, and a canvas that changes size re-fits the camera out from
 * under the player. `--frame` pins the height the board draws at to whatever it
 * was before the keyboard opened, so the map holds still and the keyboard covers
 * the bottom of it.
 *
 * @param {HTMLElement} root
 * @param {(covered: number) => void} publish
 */
function trackViewport(root, publish) {
  let frozenWidth = 0;
  let frozenHeight = 0;
  let releasing = false;
  let releaseTimer = null;

  function freeze() {
    clearTimeout(releaseTimer);
    releasing = false;
    if (frozenHeight) return; // already holding a height from before the keyboard
    frozenWidth = root.clientWidth;
    frozenHeight = root.clientHeight;
    root.style.setProperty("--frame", `${frozenHeight}px`);
  }

  function thaw() {
    clearTimeout(releaseTimer);
    releasing = false;
    frozenWidth = 0;
    frozenHeight = 0;
    root.style.removeProperty("--frame");
  }

  /**
   * Let go, once there is a frame to let go into.
   *
   * A keyboard retracts over an animation, and a frame that resizes with it fires
   * a resize at every step. Handing the board back mid-retract would re-fit it
   * against each of those in turn, so the height is held until the frame has
   * caught up. On a frame that never shrank, that is true already.
   */
  function release() {
    if (!frozenHeight) return;
    if (root.clientHeight >= frozenHeight) return thaw();
    releasing = true;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(thaw, RELEASE_TIMEOUT);
  }

  // The guess box is the only input on the page, so its focus is the keyboard.
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLInputElement) freeze();
  });
  document.addEventListener("focusout", (event) => {
    if (event.target instanceof HTMLInputElement) release();
  });

  window.addEventListener("resize", () => {
    if (!frozenHeight) return;
    // A rotation or a move between Discord's layouts changes the width, which no
    // keyboard does. The held height belongs to the old frame, so it goes.
    if (root.clientWidth !== frozenWidth) return thaw();
    if (releasing && root.clientHeight >= frozenHeight) thaw();
  });

  const viewport = window.visualViewport;
  if (!viewport) return;

  function measure() {
    // `window.innerHeight` is no use here: on Android it follows the visual
    // viewport and shrinks along with it. `clientHeight` is the layout viewport,
    // which is the fixed side of the comparison. The visible strip starts at
    // `offsetTop` -- iOS offsets rather than shrinks -- and runs for `height`;
    // the rest of the layout viewport is under the keyboard.
    publish(root.clientHeight - viewport.height - viewport.offsetTop);
  }

  viewport.addEventListener("resize", measure);
  viewport.addEventListener("scroll", measure);
  measure();
}
