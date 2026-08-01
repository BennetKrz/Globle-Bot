/**
 * The 2.5D board.
 *
 * A world map whose countries are extruded into low plates standing in open
 * water, viewed from a shallow tilt. The same scene serves the flat 2D view: the
 * camera swings to straight overhead, rather than a second renderer existing to
 * draw the same thing.
 *
 * Colour fidelity drives the material choices. In Globle the fill *is* the
 * score, so a cap must render as exactly the colour the proximity ramp produced.
 * Every material here is unlit `MeshBasicMaterial` and the scene has no lights:
 * nothing sits between the assigned hex and the pixel. Depth is drawn instead of
 * lit -- the shadow the plates drop on the sea, the warm-to-cool ramp baked into
 * their side walls, the shelf of shallow water around every coast, and the bright
 * lip along each coastline.
 */

import {
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NotEqualStencilFunc,
  PerspectiveCamera,
  PlaneGeometry,
  ReplaceStencilOp,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  PLATE_HEIGHT,
  buildBorders,
  buildCountryGeometries,
  buildPicker,
  buildShadowGeometry,
} from "./build.js";
import { backdropTexture, seaTexture } from "./texture.js";

/**
 * Board palette. Cold water against warm ground, so the two halves of the
 * picture never compete: the proximity ramp runs sand to crimson, and every cool
 * tone here belongs to the sea.
 *
 * The water is pitched as a tropical shelf rather than as open blue ocean. Four
 * saturated steps run from a near-white foam line at the coast out through bright
 * shallows and turquoise open water to a deep blue at the margin. Unlit materials
 * cannot shade a flat plane, so the water's own colours are what carry its depth.
 *
 * Unclaimed land is a moss olive rather than a warm parchment. The ramp owns
 * every warm tone on the board, and a guess must never be mistakable for land
 * that was there all along. Its hue also sits well clear of the answer's green,
 * which is the one other colour on the board that is not on the ramp.
 *
 * A finished game repaints that land in the same olive drained of its chroma.
 * The country is still land and still the same shape, it is just out of play, so
 * the colour moves off the saturated axis rather than to a different hue.
 */
const SEA = "#159cab";
const SEA_MID = "#0d6684";
const SEA_DEEP = "#0a3d61";
const SEA_SHELF = "#35c6c4";
const SEA_SHALLOW = "#7ceadb";
const SEA_FOAM = "#e6fffa";
const SEA_LINE = "rgba(216, 255, 250, 0.13)";
const BACKDROP_INNER = "#0f4c66";
const BACKDROP_MID = "#072c42";
const BACKDROP_OUTER = "#04141f";
const LAND_UNGUESSED = "#8aab5e";
const LAND_ELIMINATED = "#7a7d73";
const COAST_LIP = "#e6fffa";
const BORDER_INK = "#2b2318";
const PLATE_SHADOW = "#042a3d";

/** Water past the map on every side, for the sea to dissolve into the backdrop across. */
const SEA_MARGIN = 14;

const OCEAN_Y = 0;
const CAP_Y = OCEAN_Y + PLATE_HEIGHT;
const LINE_Y = CAP_Y + 0.02; // sit just proud of the caps

/**
 * How far the plates' shadow falls, in board units, and how dark it lands.
 *
 * The direction belongs to the light the side walls are shaded against, so a
 * plate is bright on the side its shadow runs away from. Against the plate
 * height, the distance puts that light about 40 degrees up: low enough that the
 * shadow carries the height at a shallow camera angle, high enough that a
 * country does not trail a shadow its own size.
 */
const SHADOW_DROP = PLATE_HEIGHT * 1.2;
const SHADOW_ALPHA = 0.42;

/**
 * What hovering a country does: lift it off the water and warm its fill a
 * shade. Both are small on purpose -- the lift has to read as a piece picked up
 * rather than as a jump, and the tint has to be visible without moving the fill
 * far enough to be misread as a different score.
 */
const HOVER_LIFT = PLATE_HEIGHT * 0.34;
const HOVER_TINT = 0.11;
const HOVER_MS = 130;
const HOVER_WHITE = new Color("#fff6e2");

/**
 * How far off a small country the pointer may land and still find it, in pixels.
 *
 * A country at the size floor is a few pixels of target at the opening framing,
 * which is smaller than the pointer itself. The slop is what makes an island in
 * open water something to aim at rather than something to hunt for, and it only
 * applies where nothing was hit outright.
 */
const PICK_SLOP = 8;

/**
 * Camera framing per view. Phi is the polar angle: 0 is straight overhead. The
 * azimuth is not a view setting: the camera is fixed square-on to the map, so a
 * view only chooses how far off overhead it sits.
 *
 * The distance is not fixed -- it is computed from the frame's aspect ratio so
 * the whole world fits whatever shape Discord gives the activity. A view may
 * scale that fit distance with `zoom`, trading the guarantee that everything
 * fits for a closer opening shot; omitting it frames the whole world.
 */
const VIEWS = {
  // Phi is 16 degrees off overhead: shallow enough that the board still reads as
  // a map, steep enough that the plates keep their thickness.
  tilted: { phi: 0.279, zoom: 0.75 },
  flat: { phi: 0.0005 },
};

/**
 * Narrow enough to keep the perspective close to a map photographed from above:
 * a wide lens at this tilt splays the near edge and the world stops reading as
 * flat.
 */
const FIELD_OF_VIEW = 28;

/** Breathing room around the world once it fits. */
const FIT_MARGIN = 1.02;

const VIEW_TRANSITION_MS = 550;

/**
 * What the board is allowed to cost.
 *
 * A map nobody is touching is a still picture, so the frame loop stops once the
 * camera, the hover and the view transition have all come to rest, and anything
 * that changes the picture starts it again. The rest of these trim the frames
 * that do get drawn.
 *
 * The ceiling on the frame rate stops a 144 Hz panel drawing the same pan twice
 * as often as a 60 Hz one for no visible gain. The coarser buffer applies only
 * while the camera is sustained in motion and is dropped the moment it stops, so
 * the settled picture, which is the one anyone actually looks at, is always the
 * full-resolution one.
 */
const MAX_FPS = 60;
const MIN_FRAME_MS = 1000 / (MAX_FPS + 2); // tolerance, or a 60 Hz panel drops every second frame
const FULL_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2); // past 2x costs fill rate for nothing
const MOVING_PIXEL_RATIO = Math.min(FULL_PIXEL_RATIO, 1.25);
const SUSTAINED_MOTION_MS = 120;

/**
 * Multisampling and a 2x buffer solve the same edges, and the board is mostly
 * full-screen ocean, so paying for both is paying twice over every pixel of it.
 */
const ANTIALIAS = FULL_PIXEL_RATIO < 2;

/**
 * Create the board.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} labelHost  element the country labels are layered into
 * @param {Array<{name: string, label: string, geometry: object}>} countries
 */
export function createScene(canvas, labelHost, countries) {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: ANTIALIAS,
    alpha: false,
    // The shadow masks itself with the stencil buffer, which a context does not
    // carry unless it is asked for.
    stencil: true,
    // Nothing here needs a discrete GPU, and the activity often runs alongside a
    // game that does.
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(FULL_PIXEL_RATIO);
  renderer.setClearColor(BACKDROP_OUTER, 1);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "label-layer";
  labelHost.appendChild(labelRenderer.domElement);

  const scene = new Scene();
  scene.background = backdropTexture(BACKDROP_INNER, BACKDROP_MID, BACKDROP_OUTER);
  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, 1, 4000);

  // --- Frame scheduling -----------------------------------------------------
  //
  // Sits above everything that uses it: a control, a repaint and a resize all
  // have to be able to ask for a frame.

  let running = true;
  /** The pending animation frame, or null when the board is at rest. */
  let frame = null;
  /** Timestamp of the last frame the loop acted on. Zeroed when it comes to rest. */
  let lastTick = 0;
  /** The picture has changed since it was last drawn. */
  let dirty = true;
  /** When the current run of camera motion began, or 0 while the camera is still. */
  let movingSince = 0;
  let pixelRatio = FULL_PIXEL_RATIO;

  /** Ask for a frame. Safe to call from anywhere; a no-op if one is already due. */
  function invalidate() {
    if (running && frame === null) frame = requestAnimationFrame(tick);
  }

  /** Mark the picture stale and ask for the frame that will redraw it. */
  function repaint() {
    dirty = true;
    invalidate();
  }

  function setPixelRatio(value) {
    if (value === pixelRatio) return;
    pixelRatio = value;
    renderer.setPixelRatio(value); // resizes the drawing buffer to match
    // The border materials are left alone: their line width is in CSS pixels,
    // and the resolution they divide by is the CSS one, which has not moved.
    dirty = true;
  }

  /**
   * How far back the camera has to sit for the whole world to fit at this tilt
   * and this frame shape.
   *
   * Two constraints, whichever is tighter: the map's width against the
   * horizontal field of view, and its tilt-foreshortened depth against the
   * vertical one. Both then get the near edge's head start added back, because
   * tilting swings the closest edge toward the camera, where it projects larger
   * than the centre does.
   */
  function fitRadius(phi) {
    const halfV = (FIELD_OF_VIEW / 2) * (Math.PI / 180);
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const halfWidth = (BOARD_WIDTH + SEA_MARGIN) / 2;
    const halfDepth = (BOARD_HEIGHT + SEA_MARGIN) / 2;

    const nearEdge = halfDepth * Math.sin(phi);
    const forWidth = halfWidth / Math.tan(halfH) + nearEdge;
    const forDepth = (halfDepth * Math.cos(phi)) / Math.tan(halfV) + nearEdge;
    return Math.max(forWidth, forDepth) * FIT_MARGIN;
  }

  // Also the shelf the water is drawn around, so it is built before the sea.
  const borders = buildBorders(countries);

  const sea = seaTexture({
    margin: SEA_MARGIN,
    coast: borders.coast.segments,
    colours: {
      sea: SEA,
      mid: SEA_MID,
      deep: SEA_DEEP,
      shelf: SEA_SHELF,
      shallow: SEA_SHALLOW,
      foam: SEA_FOAM,
      line: SEA_LINE,
      backdrop: BACKDROP_OUTER,
    },
  });
  // The graticule is a hairline seen at a grazing angle across the far half of
  // the map, which is exactly the case mipmaps alone smear into nothing.
  sea.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ocean = new Mesh(
    new PlaneGeometry(BOARD_WIDTH + SEA_MARGIN * 2, BOARD_HEIGHT + SEA_MARGIN * 2),
    new MeshBasicMaterial({ map: sea })
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = OCEAN_Y;
  scene.add(ocean);

  // The plates' shadow, cast on the water. At this tilt the extrusion is nearly
  // edge-on, so the shadow is what actually carries the height. It sits just
  // above the sea and writes no depth, so plates and borders stay untouched.
  //
  // Its geometry is the strip a footprint sweeps as it drops, built from pieces
  // that overlap, and the stencil is what holds that to one depth of shadow: the
  // first fragment to reach a pixel takes it and marks it, and the pieces behind
  // it are discarded rather than blended over the top.
  const shadow = new Mesh(
    buildShadowGeometry(countries, SHADOW_DROP),
    new MeshBasicMaterial({
      color: PLATE_SHADOW,
      side: DoubleSide,
      transparent: true,
      opacity: SHADOW_ALPHA,
      depthWrite: false,
      stencilWrite: true,
      stencilFunc: NotEqualStencilFunc,
      stencilRef: 1,
      stencilZPass: ReplaceStencilOp,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = OCEAN_Y + 0.05;
  scene.add(shadow);

  // --- Countries ------------------------------------------------------------

  const built = buildCountryGeometries(countries);
  const coast = createBorder(borders.coast, {
    ink: COAST_LIP,
    width: 2.1,
    opacity: 0.62,
  });
  const interior = createBorder(borders.interior, {
    ink: BORDER_INK,
    width: 1.1,
    opacity: 0.5,
  });
  scene.add(coast.object, interior.object);

  const byName = new Map();

  for (const country of built) {
    // A country magnified to the size floor laps over whatever it borders, and
    // its cap lands coplanar with the neighbour's. The depth offset settles that
    // in the marker's favour: it is worth nothing if the plate it overlaps draws
    // on top of it. One unit is the smallest depth difference the buffer can
    // resolve, which is enough to break the tie and far too little to reach the
    // borders sitting above the caps.
    const overlap = country.magnified
      ? { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }
      : null;
    const cap = new MeshBasicMaterial({ color: LAND_UNGUESSED, side: DoubleSide, ...overlap });
    // Both materials are handed the same colour. Only the walls read the shade
    // baked into the geometry's vertex colours, which is what keeps a cap exactly
    // the hex the ramp produced while its walls still turn away from the light.
    const side = new MeshBasicMaterial({
      color: LAND_UNGUESSED,
      side: DoubleSide,
      vertexColors: true,
      ...overlap,
    });
    // ExtrudeGeometry emits a cap group and a wall group per shape, tagged
    // material index 0 and 1, so a country with 35 islands still needs only
    // these two materials and the caps stay separable from the walls.
    const mesh = new Mesh(country.geometry, [cap, side]);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = OCEAN_Y;
    scene.add(mesh);

    byName.set(country.name, {
      mesh,
      cap,
      side,
      label: country.label,
      area: country.area,
      centre: country.centre,
      marker: null,
      base: new Color(LAND_UNGUESSED),
      coast: borders.coast.byCountry.get(country.name) || [],
      interior: borders.interior.byCountry.get(country.name) || [],
      lift: 0,
      raised: false,
    });
  }

  // --- Camera and controls --------------------------------------------------

  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false; // pan across the map, not across the screen
  controls.minDistance = 28;
  controls.maxDistance = 900;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  // The board is a map, not a globe: the only camera angles are the two views.
  // Orbiting it leaves the world at an arbitrary azimuth that neither view
  // corrects, and the labels and the plate walls both read as upright only from
  // square-on. The right button drives rotation by default, so it is unbound as
  // well or a right-drag would still orbit.
  controls.enableRotate = false;
  controls.mouseButtons.RIGHT = null;

  let view = "tilted";
  let transition = null;

  function applyView(config, { instant = false, recentre = false } = {}) {
    const radius = fitRadius(config.phi) * (config.zoom ?? 1);
    // Where the camera ends up pointing. A recentred swing goes back to the
    // middle of the map, so the fit distance frames the world rather than
    // whatever corner the player had panned to.
    const focus = recentre ? new Vector3(0, 0, 0) : controls.target.clone();
    const destination = positionFor(focus, radius, config.phi);

    const finish = () => {
      controls.enabled = true;
      controls.update();
    };

    if (instant) {
      controls.target.copy(focus);
      camera.position.copy(destination);
      finish();
      repaint();
      return;
    }

    controls.enabled = false;
    transition = {
      from: camera.position.clone(),
      to: destination,
      panFrom: controls.target.clone(),
      panTo: focus,
      startedAt: performance.now(),
      finish,
    };
    repaint();
  }

  /** Square-on and south of the focus, `phi` off overhead. */
  function positionFor(target, radius, phi) {
    return new Vector3(
      target.x,
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi)
    );
  }

  /** Stop the world from being dragged out of the frame. */
  function clampTarget() {
    controls.target.x = clamp(controls.target.x, -BOARD_WIDTH / 2, BOARD_WIDTH / 2);
    controls.target.z = clamp(controls.target.z, -BOARD_HEIGHT / 2, BOARD_HEIGHT / 2);
    controls.target.y = 0;
  }

  // --- Hover ----------------------------------------------------------------

  /**
   * Countries part-way between resting and raised. Emptied as each one arrives,
   * so a still board costs nothing per frame.
   */
  const animating = new Set();
  const tint = new Color();
  let hovered = null;

  /** Where a country's fill sits right now: its own colour, warmed by the hover. */
  function applyTint(entry) {
    tint.copy(entry.base).lerp(HOVER_WHITE, HOVER_TINT * smooth(entry.lift));
    entry.cap.color.copy(tint);
    entry.side.color.copy(tint);
  }

  /**
   * Move a country to where its current hover progress puts it.
   *
   * Its outline travels with it. Leaving the lines behind would cut a dark seam
   * across the raised wall, since a border sits at exactly the plate's edge and
   * would end up drawn part-way down it.
   */
  function applyLift(entry) {
    const height = smooth(entry.lift) * HOVER_LIFT;
    entry.mesh.position.y = OCEAN_Y + height;
    coast.lift(entry.coast, height);
    interior.lift(entry.interior, height);
  }

  function setHovered(name) {
    if (name === hovered) return;
    const leaving = hovered ? byName.get(hovered) : null;
    const entering = name ? byName.get(name) : null;
    hovered = name;

    if (leaving) {
      leaving.raised = false;
      animating.add(leaving);
    }
    if (entering) {
      entering.raised = true;
      animating.add(entering);
    }
    invalidate();
  }

  function advanceHover(delta) {
    // A backgrounded tab hands back one enormous frame; without the clamp the
    // hover would snap rather than travel.
    const step = Math.min(delta, 120) / HOVER_MS;
    for (const entry of animating) {
      const target = entry.raised ? 1 : 0;
      entry.lift = entry.raised ? Math.min(1, entry.lift + step) : Math.max(0, entry.lift - step);
      applyTint(entry);
      applyLift(entry);
      if (entry.lift === target) animating.delete(entry);
    }
    coast.flush();
    interior.flush();
  }

  // --- Interaction ----------------------------------------------------------

  const pickAt = buildPicker(countries);
  const aim = new Vector3();
  let hoverHandler = null;
  let selectHandler = null;

  /**
   * The country under a screen point.
   *
   * The cursor is dropped onto a horizontal plane and the resulting board
   * coordinate is looked up in the outlines, rather than a ray being fired at
   * the plates. Nothing here reads a plate's height, which is the point: the
   * lift a hover applies cannot then decide what the next hover finds.
   *
   * Two planes, in order. The caps are what the board mostly shows and they all
   * sit at one height, so a point that lands on a cap is on exactly the country
   * drawn under the cursor. What is left over is the coastal walls, a band of
   * pixels along every shore facing the camera; a point that found no cap is
   * dropped again to the waterline, where a wall stands on the country it
   * belongs to.
   *
   * Only once both planes have come up empty is the slop allowed to reach for a
   * small country nearby, so a hit on something the player can actually see is
   * never given away to a marker beside it.
   */
  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Unprojecting to the far plane and subtracting the eye gives the direction
    // the cursor points into the world.
    aim.set(x, y, 1).unproject(camera).sub(camera.position);
    if (aim.y > -1e-6) return null; // level with the board or aimed above it

    return onPlane(CAP_Y) ?? onPlane(OCEAN_Y) ?? onPlane(CAP_Y, PICK_SLOP);
  }

  /**
   * Where the aim meets a horizontal plane, as a country name. Shapes are built
   * in a y-up plane and laid flat by a quarter turn about x, so the board's
   * second axis is the negated world z.
   *
   * The slop is given in pixels and converted here, because how much board a
   * pixel covers depends on how far away the plane was met -- a fixed distance
   * in board units would be a generous target at the world view and no help at
   * all zoomed in, which is the case it exists for.
   */
  function onPlane(height, slop = 0) {
    const distance = (height - camera.position.y) / aim.y;
    return pickAt(
      camera.position.x + aim.x * distance,
      -(camera.position.z + aim.z * distance),
      slop * unitsPerPixel(distance)
    );
  }

  /**
   * How much board one pixel covers where the aim has travelled `distance` along
   * itself. The frustum's height at a depth is what sets the scale, and `aim`
   * is not a unit vector, so the depth is its length times the distance.
   */
  function unitsPerPixel(distance) {
    const pixels = canvas.clientHeight || window.innerHeight;
    return (2 * Math.tan((FIELD_OF_VIEW / 2) * (Math.PI / 180)) * aim.length() * distance) / pixels;
  }

  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return; // no hover state exists on touch
    const name = pick(event);
    if (name === hovered) return;
    setHovered(name);
    if (hoverHandler) hoverHandler(name ? byName.get(name)?.label ?? null : null, name);
  });
  canvas.addEventListener("pointerleave", () => {
    setHovered(null);
    if (hoverHandler) hoverHandler(null, null);
  });

  // A tap counts as a selection only when it did not become a drag, so panning
  // the map never picks a country.
  let pressed = null;
  canvas.addEventListener("pointerdown", (event) => {
    pressed = { x: event.clientX, y: event.clientY, at: performance.now() };
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!pressed || !selectHandler) return;
    const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
    const elapsed = performance.now() - pressed.at;
    pressed = null;
    if (moved > 6 || elapsed > 450) return;
    const name = pick(event);
    if (name) selectHandler(name);
  });
  canvas.addEventListener("pointercancel", () => {
    pressed = null;
  });

  // --- Frame loop -----------------------------------------------------------

  // The controls handle their own pointer events and move the camera without
  // asking, so this is what wakes a resting board when the player grabs it.
  controls.addEventListener("change", repaint);

  function tick(now) {
    frame = null;
    if (!running) return;
    if (now - lastTick < MIN_FRAME_MS) {
      frame = requestAnimationFrame(tick);
      return;
    }
    // A board that has been at rest has no previous frame to measure from, and
    // a backgrounded tab hands back one enormous gap; either would make the
    // hover snap rather than travel.
    const delta = lastTick ? now - lastTick : MIN_FRAME_MS;
    lastTick = now;

    let moving = false;
    if (transition) {
      const progress = Math.min(1, (now - transition.startedAt) / VIEW_TRANSITION_MS);
      const eased = easeInOut(progress);
      camera.position.lerpVectors(transition.from, transition.to, eased);
      // The look-at point travels with the camera, so a recentring swing pans
      // and tilts as one move instead of snapping the map sideways on arrival.
      controls.target.lerpVectors(transition.panFrom, transition.panTo, eased);
      camera.lookAt(controls.target);
      if (progress === 1) {
        transition.finish();
        transition = null;
      }
      moving = true;
      dirty = true;
    } else {
      clampTarget();
      // True for as long as the damping still has somewhere to carry the camera,
      // which is what keeps the loop alive after the player lets go.
      if (controls.update()) {
        moving = true;
        dirty = true;
      }
    }

    if (animating.size) {
      advanceHover(delta);
      dirty = true;
    }

    // Only the camera earns the coarser buffer. A hover moves a plate a couple
    // of pixels and is over in a tenth of a second, which is not worth resizing
    // the drawing buffer twice for.
    if (moving) {
      if (!movingSince) movingSince = now;
      if (now - movingSince > SUSTAINED_MOTION_MS) setPixelRatio(MOVING_PIXEL_RATIO);
    } else {
      movingSince = 0;
      setPixelRatio(FULL_PIXEL_RATIO);
    }

    if (dirty) {
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
      dirty = false;
    }

    if (moving || animating.size) invalidate();
    else lastTick = 0;
  }
  invalidate();

  let fittedWidth = 0;
  let fittedHeight = 0;

  /**
   * Re-fit for the current frame.
   *
   * A resize here means Discord moved the activity between focused, grid and
   * picture-in-picture, or a phone rotated -- the aspect ratio can change
   * drastically. The camera is re-fitted rather than left where it was, because
   * a map cropped in half after a layout change is worse than a lost zoom.
   *
   * Re-fitting throws away wherever the player had panned to, so it only happens
   * on a frame that really changed size. Discord and the browser both fire resize
   * for things that leave the canvas alone, and each one of those would otherwise
   * snap the map back to its default framing.
   */
  function resize() {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    if (width === fittedWidth && height === fittedHeight) return;
    fittedWidth = width;
    fittedHeight = height;
    renderer.setSize(width, height, false);
    labelRenderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    coast.material.resolution.set(width, height);
    interior.material.resolution.set(width, height);
    if (!transition) applyView(VIEWS[view], { instant: true });
    repaint();
  }
  resize();

  // --- Public surface -------------------------------------------------------

  return {
    resize,

    /**
     * Repaint the board.
     *
     * @param {Map<string, string>} colours  country name -> css colour; a country
     *   with no entry falls back to land, which is grey once the game is over
     * @param {Set<string>} labelled  countries whose name is printed on the map
     * @param {boolean} finished  the game has ended, so nothing else can be guessed
     */
    paint(colours, labelled, finished = false) {
      const land = finished ? LAND_ELIMINATED : LAND_UNGUESSED;
      for (const [name, entry] of byName) {
        entry.base.set(colours.get(name) || land);
        applyTint(entry);

        const wants = labelled.has(name);
        if (wants && !entry.marker) {
          entry.marker = makeLabel(entry.label, entry.centre);
          entry.mesh.add(entry.marker);
        } else if (!wants && entry.marker) {
          entry.mesh.remove(entry.marker);
          entry.marker.element.remove();
          entry.marker = null;
        }
      }
      repaint();
    },

    /**
     * Switch between the tilted board and the straight-down flat map.
     *
     * The swing also pans back to the middle of the map: switching view is the
     * one control that reframes the board, so it doubles as the way out of a
     * pan that has lost the world off the edge of the frame.
     */
    setView(next) {
      if (next === view || !VIEWS[next]) return;
      view = next;
      applyView(VIEWS[next], { recentre: true });
    },

    getView: () => view,

    /** Called with (label, countryName) as the pointer moves over the map. */
    onHover(handler) {
      hoverHandler = handler;
    },

    /** Called with the country name when the map is tapped or clicked. */
    onSelect(handler) {
      selectHandler = handler;
    },

    dispose() {
      running = false;
      if (frame !== null) cancelAnimationFrame(frame);
      controls.dispose();
      renderer.dispose();
      labelRenderer.domElement.remove();
      for (const entry of byName.values()) {
        entry.mesh.geometry.dispose();
        entry.cap.dispose();
        entry.side.dispose();
      }
      for (const piece of [ocean, shadow]) {
        piece.geometry.dispose();
        piece.material.map?.dispose();
        piece.material.dispose();
      }
      scene.background?.dispose();
      coast.dispose();
      interior.dispose();
    },
  };
}

/**
 * One class of border as a single instanced line batch.
 *
 * Colour lives per segment rather than in the material, so a hovered country's
 * outline can brighten without a second draw call, and height lives in a buffer
 * the hover writes into directly -- the two ends of a segment are six floats at
 * a known offset, so raising a country is a handful of array writes rather than
 * a rebuilt geometry.
 *
 * @param {{segments: number[]}} border
 * @param {{ink: string, width: number, opacity: number}} style
 */
function createBorder(border, style) {
  const count = border.segments.length / 4;
  const positions = new Float32Array(count * 6);
  const colours = new Float32Array(count * 6);
  // Working-space channels, which is where the shader multiplies them; reading
  // them out once keeps the hover's inner loop to arithmetic.
  const ink = new Color(style.ink).toArray();
  const lit = new Color(style.ink).lerp(HOVER_WHITE, 0.75).toArray();

  for (let i = 0; i < count; i++) {
    const source = i * 4;
    const target = i * 6;
    positions[target] = border.segments[source];
    positions[target + 1] = LINE_Y;
    positions[target + 2] = -border.segments[source + 1];
    positions[target + 3] = border.segments[source + 2];
    positions[target + 4] = LINE_Y;
    positions[target + 5] = -border.segments[source + 3];
    for (let channel = 0; channel < 3; channel++) {
      colours[target + channel] = ink[channel];
      colours[target + 3 + channel] = ink[channel];
    }
  }

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  geometry.setColors(colours);

  const material = new LineMaterial({
    color: 0xffffff, // the segments carry the colour
    vertexColors: true,
    linewidth: style.width, // screen pixels, so borders stay readable at every zoom
    worldUnits: false,
    transparent: true,
    opacity: style.opacity,
    // Instanced lines draw as triangles, so a depth offset applies and holds the
    // border clear of the cap at grazing angles.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  material.resolution.set(window.innerWidth, window.innerHeight);

  const object = new LineSegments2(geometry, material);
  object.renderOrder = 2;
  object.frustumCulled = false;

  const positionBuffer = geometry.attributes.instanceStart.data;
  const colourBuffer = geometry.attributes.instanceColorStart.data;
  let dirty = false;

  return {
    object,
    material,

    /**
     * Raise a country's own segments and brighten them by how far along the
     * hover has travelled.
     */
    lift(indices, height) {
      if (!indices.length) return;
      const progress = height / HOVER_LIFT;
      for (const index of indices) {
        const at = index * 6;
        positions[at + 1] = LINE_Y + height;
        positions[at + 4] = LINE_Y + height;
        for (let channel = 0; channel < 3; channel++) {
          const value = ink[channel] + (lit[channel] - ink[channel]) * progress;
          colours[at + channel] = value;
          colours[at + 3 + channel] = value;
        }
      }
      dirty = true;
    },

    /** Hand this frame's writes to the GPU, once, however many countries moved. */
    flush() {
      if (!dirty) return;
      positionBuffer.needsUpdate = true;
      colourBuffer.needsUpdate = true;
      dirty = false;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** A country name pinned to the map, drawn as HTML over the canvas. */
function makeLabel(text, [x, y]) {
  const element = document.createElement("div");
  element.className = "map-label";
  element.textContent = text;
  const label = new CSS2DObject(element);
  // The label is a child of the flattened mesh, so its frame is still the
  // shape's: x and y are board coordinates, z is height above the ocean.
  label.position.set(x, y, PLATE_HEIGHT + 0.4);
  return label;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** Ease both ends of the hover, so a plate neither jumps off the water nor lands hard. */
function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** Whether this browser can run the board at all. */
export function webglAvailable() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch {
    return false;
  }
}
