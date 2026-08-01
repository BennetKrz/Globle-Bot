/**
 * Turning the country dataset into board geometry.
 *
 * The world is an equirectangular projection, which lands the whole dataset in a
 * fixed box centred on the origin, so camera distances and plate heights can be
 * constants rather than derived from the data.
 *
 * The dataset is pre-split at the antimeridian -- no ring spans more than 180
 * degrees of longitude -- so no polygon needs cutting before projection.
 * Rebuilding the data from a different Natural Earth release could change that,
 * which is what `assertNoDatelineCrossing` watches for.
 */

import { geoEquirectangular } from "d3-geo";
import { BufferGeometry, Float32BufferAttribute, Shape, ShapeGeometry, ExtrudeGeometry } from "three";

/** Board extent in world units. Equirectangular is exactly 2:1. */
export const BOARD_WIDTH = 200;
export const BOARD_HEIGHT = 100;

/**
 * How far a country plate stands above the ocean. Deep enough that the walls
 * carry their own light at world zoom: the plates read as cut pieces standing on
 * the water rather than as paint on it.
 */
export const PLATE_HEIGHT = 1.6;

/** ExtrudeGeometry's own tag for the side walls; the caps are group 0. */
const SIDE_GROUP = 1;

/**
 * The light the side walls are shaded against, in the geometry's own frame:
 * shapes are built in a y-up plane and laid flat by the scene, so here the
 * extrusion runs along +z and north is +y. Walls of a straight extrusion are
 * vertical, so only the direction across the map matters -- a light off the
 * board's north-west shoulder, which is the corner the plates' shadow runs away
 * from.
 */
const LIGHT = [-0.72, 0.69];

/**
 * The two ends of the wall ramp, as multipliers on the country's own colour.
 *
 * Splitting them by temperature rather than by brightness alone is what makes a
 * flat fill read as a lit solid: the sunward wall keeps the cap's colour and
 * warms it a shade, the wall turned away cools toward the turquoise bouncing off
 * the sea. The lit end runs just past 1.0, so a wall square-on to the light comes
 * up brighter than its own cap instead of merely matching it.
 */
const WALL_LIT = [1.06, 0.99, 0.86];
const WALL_SHADE = [0.28, 0.46, 0.68];

/**
 * The wall ramp is stepped, not continuous: four fixed tones with a narrow blend
 * at each boundary.
 *
 * A straight extrusion gives every facet one constant normal, so a stepped ramp
 * lands each wall wholly inside one tone and a country reads as a piece cut and
 * painted rather than as a smoothly lit solid. The blend exists only so the
 * boundary between two tones resolves instead of stair-stepping along a coast.
 */
const WALL_TONES = [0, 0.36, 0.72, 1];
const TONE_BLEND = 0.07;

/** How much darker the foot of a wall is than its top edge. */
const CONTACT = 0.55;

const projection = geoEquirectangular().fitSize([BOARD_WIDTH, BOARD_HEIGHT], { type: "Sphere" });

/**
 * Project a coordinate into board space.
 *
 * Two adjustments to what d3 returns: the origin moves to the centre of the
 * board, and the vertical axis is flipped, because d3 counts pixels downward
 * while the board's shapes are built in a y-up plane before being laid flat.
 */
export function project([lon, lat]) {
  const point = projection([lon, lat]);
  if (!point) return null;
  return [point[0] - BOARD_WIDTH / 2, -(point[1] - BOARD_HEIGHT / 2)];
}

/** Twice the signed area. Positive means counter-clockwise in a y-up plane. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum;
}

/**
 * three.js derives face normals from winding: a clockwise contour extrudes with
 * its cap pointing away from the camera and disappears. Every projected ring is
 * normalised here -- outer contours counter-clockwise, holes clockwise -- so the
 * source data's winding convention stops mattering.
 */
function orient(ring, wantCounterClockwise) {
  const isCounterClockwise = signedArea(ring) > 0;
  return isCounterClockwise === wantCounterClockwise ? ring : ring.slice().reverse();
}

function projectRing(ring) {
  const projected = [];
  for (const coord of ring) {
    const point = project(coord);
    if (point) projected.push(point);
  }
  return projected;
}

/** Every polygon of a feature as `[outerRing, ...holeRings]`, already projected. */
function projectedPolygons(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const result = [];
  for (const polygon of polygons) {
    const rings = polygon.map(projectRing).filter((ring) => ring.length >= 4);
    if (rings.length) result.push(rings);
  }
  return result;
}

/** A three.js Shape for one projected polygon, holes included. */
function toShape([outer, ...holes]) {
  const shape = new Shape();
  const contour = orient(outer, true);
  shape.moveTo(contour[0][0], contour[0][1]);
  for (let i = 1; i < contour.length; i++) shape.lineTo(contour[i][0], contour[i][1]);
  shape.closePath();

  for (const hole of holes) {
    const path = new Shape();
    const ring = orient(hole, false);
    path.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) path.lineTo(ring[i][0], ring[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

/**
 * Bake a directional shade into an extrusion's side walls.
 *
 * The scene has no lights, because a cap must render as exactly the colour the
 * proximity ramp produced. Walls carry no such meaning, and an unshaded wall at
 * a shallow camera angle reads as a printed outline rather than a solid plate.
 * So the walls get a vertex colour their material multiplies by -- one fixed
 * light, plus a darkening toward the plate's foot -- and the cap material
 * ignores the attribute entirely.
 *
 * The multiply happens in linear space, which is where a coloured light belongs,
 * so the warm and cool ends of the ramp behave like light rather than like a
 * wash over the fill.
 */
function shadeWalls(geometry) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const shades = new Float32Array(position.count * 3).fill(1);

  for (const group of geometry.groups) {
    if (group.materialIndex !== SIDE_GROUP) continue;
    for (let i = group.start; i < group.start + group.count; i++) {
      const lambert = toTone(Math.max(0, normal.getX(i) * LIGHT[0] + normal.getY(i) * LIGHT[1]));
      const foot = CONTACT + (1 - CONTACT) * (position.getZ(i) / PLATE_HEIGHT);
      for (let channel = 0; channel < 3; channel++) {
        const lit = WALL_SHADE[channel] + (WALL_LIT[channel] - WALL_SHADE[channel]) * lambert;
        shades[i * 3 + channel] = lit * foot;
      }
    }
  }

  geometry.setAttribute("color", new Float32BufferAttribute(shades, 3));
}

/**
 * Snap a lambert term onto the wall tones.
 *
 * The term is scaled across the gaps between tones and the step is placed in the
 * middle of each gap, so every tone occupies an equal slice of the light and the
 * darkest and brightest walls still land on the ends of the ramp.
 */
function toTone(lambert) {
  const gaps = WALL_TONES.length - 1;
  const scaled = lambert * gaps;
  const index = Math.min(gaps - 1, Math.floor(scaled));
  const edge = smoothstep(scaled - index, 0.5 - TONE_BLEND, 0.5 + TONE_BLEND);
  return WALL_TONES[index] + (WALL_TONES[index + 1] - WALL_TONES[index]) * edge;
}

function smoothstep(value, from, to) {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/**
 * Build the geometry for every country.
 *
 * Bevels are deliberately off. On outlines this coarse a bevel eats into small
 * islands until they vanish, and it multiplies the triangle count for an effect
 * the shaded side walls already provide.
 *
 * @param {Array<{name: string, label: string, geometry: object, magnified?: boolean}>} countries
 * @param {{flat?: boolean}} options  flat builds caps only, for the 2D view
 * @returns {Array<{name: string, label: string, geometry: import("three").BufferGeometry, centre: [number, number], area: number, magnified: boolean}>}
 */
export function buildCountryGeometries(countries, { flat = false } = {}) {
  return countries.map((country) => {
    const polygons = projectedPolygons(country.geometry);
    const shapes = polygons.map(toShape);

    const geometry = flat
      ? new ShapeGeometry(shapes)
      : new ExtrudeGeometry(shapes, { depth: PLATE_HEIGHT, bevelEnabled: false, curveSegments: 1 });

    if (!flat) shadeWalls(geometry);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return {
      name: country.name,
      label: country.label,
      geometry,
      centre: labelAnchor(polygons),
      area: Math.abs(polygons.reduce((sum, [outer]) => sum + signedArea(outer), 0)) / 2,
      magnified: Boolean(country.magnified),
    };
  });
}

/**
 * Where a country's label belongs: the centre of its largest polygon rather
 * than the centre of all of them, so an island chain does not label the open
 * water between its members.
 */
function labelAnchor(polygons) {
  let best = null;
  let bestArea = -1;
  for (const [outer] of polygons) {
    const area = Math.abs(signedArea(outer));
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  }
  if (!best) return [0, 0];
  let x = 0;
  let y = 0;
  for (const point of best) {
    x += point[0];
    y += point[1];
  }
  return [x / best.length, y / best.length];
}

/**
 * Country lookup by board position.
 *
 * Picking runs against the flat outlines, not against the plates. A ray fired
 * at the extrusions hits whichever wall stands in front of the rest, so a
 * raised plate swallows every small neighbour behind it: hovering Senegal puts
 * a wall across Gambia and Gambia becomes unreachable. A point tested against
 * the outlines takes no notice of height, so what a plate is doing cannot
 * change what is under the cursor.
 *
 * Polygons are ordered smallest first, so an enclave wins over the country it
 * sits in even where that country was digitised without a hole cut for it.
 *
 * @param {Array<{name: string, geometry: object}>} countries
 * @returns {(x: number, y: number, tolerance?: number) => string | null} board
 *   coordinates to country name, where `tolerance` is how far off a small
 *   country the point may land and still count
 */
export function buildPicker(countries) {
  const shapes = [];
  for (const country of countries) {
    for (const [outer, ...holes] of projectedPolygons(country.geometry)) {
      shapes.push({
        name: country.name,
        outer,
        holes,
        bounds: boundsOf(outer),
        area: Math.abs(signedArea(outer)) / 2,
      });
    }
  }
  shapes.sort((a, b) => a.area - b.area);

  return function pickAt(x, y, tolerance = 0) {
    for (const shape of shapes) {
      const [minX, minY, maxX, maxY] = shape.bounds;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (!insideRing(shape.outer, x, y)) continue;
      if (shape.holes.some((hole) => insideRing(hole, x, y))) continue;
      return shape.name;
    }
    return tolerance > 0 ? nearestSmall(shapes, x, y, tolerance) : null;
  };
}

/**
 * How large a country can be before it stops being helped past a near miss, in
 * board units squared: roughly the area of Cyprus.
 *
 * Anything above this can be hit squarely at any zoom, and pulling the pointer
 * onto one would take it off the water it was actually over.
 */
const NEAR_MISS_LIMIT = 2;

/**
 * The small country nearest a point that landed on nothing.
 *
 * Even at the size floor a micro-state is a handful of pixels across, and a
 * pointer that comes down beside one reads as a dead map rather than as a near
 * miss. Shapes are ordered smallest first, so the walk stops as soon as they
 * stop being small.
 */
function nearestSmall(shapes, x, y, tolerance) {
  let best = null;
  let bestDistance = tolerance;
  for (const shape of shapes) {
    if (shape.area > NEAR_MISS_LIMIT) break;
    const [minX, minY, maxX, maxY] = shape.bounds;
    if (x < minX - tolerance || x > maxX + tolerance) continue;
    if (y < minY - tolerance || y > maxY + tolerance) continue;
    const distance = distanceToRing(shape.outer, x, y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = shape.name;
    }
  }
  return best;
}

/** How far a point outside a ring is from its nearest edge. */
function distanceToRing(ring, x, y) {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    // Where the point projects onto the edge, held to the edge's own ends.
    const along = length > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
    const distance = Math.hypot(x - (ax + dx * along), y - (ay + dy * along));
    if (distance < best) best = distance;
  }
  return best;
}

function boundsOf(ring) {
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
  return [minX, minY, maxX, maxY];
}

/**
 * Crossing number: an odd count of edges between the point and the far side of
 * the board along +x puts the point inside the ring.
 */
function insideRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The shadow the plates cast on the water, as one geometry.
 *
 * Not the outlines moved across the sea. A moved copy covers only the ground the
 * footprint ends on, which leaves the water it started from lit and the plate
 * hovering over its own shadow, and anything narrower than the drop -- every
 * island the size floor produced -- lands clear of its shadow altogether. Built
 * here instead is the whole strip the footprint passes over: both ends of the
 * drop, and a quad along every edge covering the ground between them. A shadow
 * then starts at the coast that casts it.
 *
 * The pieces overlap, and the scene is what makes that free: it stencils the
 * mesh so a pixel takes the shadow once however many pieces reach it. The
 * alternative is unioning several thousand rings into one polygon at startup.
 *
 * The near end of the drop only ever falls under a plate, where the depth buffer
 * hides it; it is carried so a plate lifted by a hover reveals its own contact
 * shadow rather than bare water. One mesh serves every country, since the shadow
 * carries no per-country state and open water is the only surface it can reach.
 *
 * @param {Array<{name: string, geometry: object}>} countries
 * @param {number} distance  how far the shadow falls, in board units
 */
export function buildShadowGeometry(countries, distance) {
  const shapes = [];
  const rings = [];
  for (const country of countries) {
    for (const polygon of projectedPolygons(country.geometry)) {
      shapes.push(toShape(polygon));
      for (const ring of polygon) rings.push(ring);
    }
  }

  // Straight away from the light the walls are shaded against, so a plate drops
  // its shadow out of the same side it turns its dark wall to.
  const scale = distance / Math.hypot(LIGHT[0], LIGHT[1]);
  const dropX = -LIGHT[0] * scale;
  const dropY = -LIGHT[1] * scale;

  const footprint = new ShapeGeometry(shapes).toNonIndexed();
  const caps = footprint.getAttribute("position").array;
  footprint.dispose();

  let edges = 0;
  for (const ring of rings) edges += ring.length - 1;

  // Both ends of the drop, then six vertices per edge. Everything lies in the
  // shape plane, so the array's zeroed z is already right and the copies below
  // write only the two flat axes.
  const positions = new Float32Array(caps.length * 2 + edges * 18);
  positions.set(caps, 0);
  for (let i = 0; i < caps.length; i += 3) {
    positions[caps.length + i] = caps[i] + dropX;
    positions[caps.length + i + 1] = caps[i + 1] + dropY;
  }

  let at = caps.length * 2;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      at = writeQuad(positions, at, ring[i], ring[i + 1], dropX, dropY);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return geometry;
}

/**
 * One edge and the ground it drags across, as two triangles.
 *
 * An edge is walked in whichever direction its ring runs and a hole runs against
 * its outer, so half of these come out facing away. The shadow's material draws
 * both faces rather than the winding being fixed up here.
 */
function writeQuad(out, at, [ax, ay], [bx, by], dropX, dropY) {
  const xs = [ax, bx, bx + dropX, ax, bx + dropX, ax + dropX];
  const ys = [ay, by, by + dropY, ay, by + dropY, ay + dropY];
  for (let i = 0; i < xs.length; i++) {
    out[at + i * 3] = xs[i];
    out[at + i * 3 + 1] = ys[i];
  }
  return at + xs.length * 3;
}

/**
 * An edge's identity, independent of which end it was walked from. Four decimals
 * is a fifth of a board unit at the coarsest, well under the resolution of the
 * source coordinates, so two countries that were digitised against the same
 * boundary hash to the same key.
 */
function edgeKey(a, b) {
  const first = `${a[0].toFixed(4)},${a[1].toFixed(4)}`;
  const second = `${b[0].toFixed(4)},${b[1].toFixed(4)}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

/**
 * Every border edge, split by whether a second country claims it.
 *
 * A coastline is an edge nobody else walked, and it is drawn as the bright lip
 * where a plate meets the water; an inland border is an edge two countries share,
 * drawn as a dark seam between two plates. Splitting them is what stops a
 * continent from reading as a mesh of equal lines and lets its silhouette carry.
 *
 * Edges are also deduplicated, so a shared boundary exists once and lifts as one
 * piece when either of its owners is raised. Both owners are recorded for that
 * reason.
 *
 * Drawn from the source rings rather than from the extruded meshes: the edges of
 * an extrusion include its triangulation and its vertical walls, which would
 * scribble over the caps.
 *
 * @returns {{coast: Border, interior: Border}} where a `Border` is
 *   `{segments: number[], byCountry: Map<string, number[]>}`: a flat
 *   `[x1, y1, x2, y2, …]` list in board space, and the segment indices each
 *   country owns.
 */
export function buildBorders(countries) {
  const edges = new Map();
  for (const country of countries) {
    for (const rings of projectedPolygons(country.geometry)) {
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const key = edgeKey(ring[i], ring[i + 1]);
          let edge = edges.get(key);
          if (!edge) {
            edge = { coords: [ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]], owners: new Set() };
            edges.set(key, edge);
          }
          edge.owners.add(country.name);
        }
      }
    }
  }

  const coast = { segments: [], byCountry: new Map() };
  const interior = { segments: [], byCountry: new Map() };

  for (const edge of edges.values()) {
    const border = edge.owners.size > 1 ? interior : coast;
    const index = border.segments.length / 4;
    border.segments.push(...edge.coords);
    for (const owner of edge.owners) {
      const owned = border.byCountry.get(owner);
      if (owned) owned.push(index);
      else border.byCountry.set(owner, [index]);
    }
  }

  return { coast, interior };
}

/**
 * Guard against a dataset whose polygons cross the antimeridian. Such a ring
 * projects into a band straight across the map, which is obvious on screen but
 * easy to misread as a rendering bug.
 *
 * @returns {string[]} names of offending countries, empty when the data is fine
 */
export function assertNoDatelineCrossing(countries) {
  const offenders = [];
  for (const country of countries) {
    const polygons =
      country.geometry.type === "Polygon" ? [country.geometry.coordinates] : country.geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        let min = Infinity;
        let max = -Infinity;
        for (const [lon] of ring) {
          if (lon < min) min = lon;
          if (lon > max) max = lon;
        }
        if (max - min > 180) offenders.push(country.name);
      }
    }
  }
  return [...new Set(offenders)];
}
