/**
 * A floor on how small a country may draw.
 *
 * Tuvalu is twenty-six square kilometres. Projected onto the board it is a
 * fraction of a pixel across at every zoom the camera allows, which leaves it
 * invisible and unpointable, and two dozen other micro-states and island nations
 * are in the same position. Every polygon of such a country is scaled up about
 * its own centre until it covers the floor's area, so the outline and the
 * position survive and the country becomes a target.
 *
 * The scale runs on longitude and latitude rather than on projected coordinates.
 * The board's equirectangular projection is linear and equal on both axes, so a
 * uniform scale in degrees is a uniform scale on the board, and the flat map
 * fallback inherits the same countries without knowing any of this happened.
 *
 * Magnifying a country pushes it over its neighbours: an enlarged Vatican covers
 * a piece of Rome, and its boundary no longer coincides with the hole Italy was
 * digitised with, so the two are drawn as coastlines rather than as a shared
 * seam. Both are the price of a hit area. `magnified` marks the countries it
 * happened to, so the board can draw them over the plates they now overlap.
 */

/**
 * The floor, in degrees: a magnified polygon ends up with the area of a circle
 * of this radius.
 *
 * Half a degree is a little over a quarter of a board unit -- enough to read as
 * a dot at the opening framing and to be an easy target once the camera is in,
 * small enough that a magnified Malta stops short of Sicily.
 */
const MIN_RADIUS = 0.5;

/**
 * Lift every country that draws smaller than the floor.
 *
 * @param {Array<{name: string, label: string, geometry: object}>} countries
 * @returns {Array<{name: string, label: string, geometry: object, magnified?: boolean}>}
 */
export function enforceMinimumSize(countries) {
  return countries.map((country) => {
    const geometry = magnify(country.geometry);
    return geometry ? { ...country, geometry, magnified: true } : country;
  });
}

/**
 * A country's geometry with every polygon raised to the floor, or null when it
 * is already big enough.
 *
 * Whether a country qualifies is decided on its largest polygon alone, and on
 * that polygon's extent rather than its area: an outline already long in one
 * direction can be seen and pointed at along that direction, and fattening it
 * would gain nothing while costing it the borders it shares with its
 * neighbours. That also keeps the smaller islands of a large country at their
 * true size, where they are scenery rather than the only way to reach the
 * country.
 */
function magnify(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  let largest = null;
  let largestArea = -1;
  for (const [outer] of polygons) {
    const area = Math.abs(shoelace(outer));
    if (area > largestArea) {
      largestArea = area;
      largest = outer;
    }
  }
  if (!largest || halfExtent(largest) >= MIN_RADIUS) return null;

  const magnified = polygons.map(([outer]) => [marker(outer)]);
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: magnified[0] }
    : { type: "MultiPolygon", coordinates: magnified };
}

/**
 * One polygon as a marker: its outer ring scaled about its own centre until a
 * circle of the floor radius would have the same area.
 *
 * Holes are dropped. A lagoon inside an atoll is not information at the size the
 * atoll is being drawn at, and a hole in a marker is a hole in its hit area.
 */
function marker(outer) {
  const area = Math.abs(shoelace(outer)) / 2;
  const factor = area > 0 ? MIN_RADIUS / Math.sqrt(area / Math.PI) : 0;
  if (!(factor > 1)) return outer;

  const [cx, cy] = centreOf(outer);
  return withinRange(outer.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]));
}

/**
 * Nudge a magnified ring back inside the coordinate range.
 *
 * Tuvalu sits a degree short of the antimeridian and magnifying it walks its
 * eastern edge past 180, where the projection would carry it off the side of the
 * board and the flat map would tear it in half. The whole ring is translated by
 * the overflow rather than clamped, so the marker keeps its shape and moves by
 * less than its own width.
 */
function withinRange(ring) {
  let shiftX = 0;
  let shiftY = 0;
  for (const [x, y] of ring) {
    shiftX = clampShift(shiftX, x, 180);
    shiftY = clampShift(shiftY, y, 90);
  }
  if (!shiftX && !shiftY) return ring;
  return ring.map(([x, y]) => [x + shiftX, y + shiftY]);
}

/** The shift so far, widened to whatever it takes to bring `value` into range. */
function clampShift(shift, value, limit) {
  if (value > limit) return Math.min(shift, limit - value);
  if (value < -limit) return Math.max(shift, -limit - value);
  return shift;
}

/** Twice the signed area of a ring. */
function shoelace(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum;
}

/** Half the longer side of a ring's bounding box. */
function halfExtent(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY) / 2;
}

/**
 * A ring's centre of area, which is where the magnification is anchored so the
 * marker sits on the country rather than drifting toward its busiest coast. A
 * ring too thin to have an area falls back to the mean of its vertices.
 */
function centreOf(ring) {
  const area = shoelace(ring) / 2;
  if (Math.abs(area) > 1e-12) {
    let x = 0;
    let y = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      x += (ring[i][0] + ring[i + 1][0]) * cross;
      y += (ring[i][1] + ring[i + 1][1]) * cross;
    }
    return [x / (6 * area), y / (6 * area)];
  }

  let x = 0;
  let y = 0;
  for (const point of ring) {
    x += point[0];
    y += point[1];
  }
  return [x / ring.length, y / ring.length];
}
