/**
 * Board selection.
 *
 * The 2.5D board is the intended experience; the flat canvas map is what runs
 * when WebGL is missing or the board fails to start. Both expose the same
 * surface, so nothing above this module knows which one it is talking to.
 */

import { createFlatMap } from "./flat.js";
import { assertNoDatelineCrossing } from "./build.js";
import { enforceMinimumSize } from "./minsize.js";
import { createScene, webglAvailable } from "./scene.js";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} labelHost
 * @param {Array<{name: string, label: string, geometry: object}>} countries
 * @returns {{board: object, degraded: boolean}}
 */
export function createBoard(canvas, labelHost, countries) {
  // Both boards draw and pick against the same countries, so the size floor is
  // applied once here rather than by each of them.
  const sized = enforceMinimumSize(countries);

  const crossers = assertNoDatelineCrossing(sized);
  if (crossers.length) {
    // Not fatal: such a polygon draws as a band across the map, which reads as a
    // rendering fault unless the data is named as the cause.
    console.warn(`Countries crossing the antimeridian will render as bands: ${crossers.join(", ")}`);
  }

  if (webglAvailable()) {
    try {
      return { board: createScene(canvas, labelHost, sized), degraded: false };
    } catch (error) {
      console.error("The 2.5D board failed to start, falling back to the flat map:", error);
    }
  }
  return { board: createFlatMap(canvas, sized), degraded: true };
}
