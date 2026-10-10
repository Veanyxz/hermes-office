/**
 * Avatar rig: a low-poly figure whose limbs stay individually addressable so the
 * animation layer can pose them without touching the mesh hierarchy.
 *
 * Proportions follow a 1.8 m human, measured from the feet:
 *
 *   head top   1.80   chest group 1.42   shoulder 1.56
 *   hip        0.98   knee 0.50         sole 0.00
 *
 * The first version pinned the shoulder at 2.26 — ABOVE the head top at 2.08 —
 * which is why every posed arm ended up beside the ears.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { rbox } from './bevel'
import { BALL_R, ROLE_COLORS } from './layout'
import type { AgentRole } from '@/types/hermes'

export type Limb = {
  shoulder: THREE.Object3D
  elbow: THREE.Object3D
}

export type Avatar = {
  group: THREE.Group
  chest: THREE.Object3D
  neck: THREE.Object3D
  head: THREE.Object3D
  hips: THREE.Object3D
  /**
   * The WAIST joint — the pivot that lays the whole upper body down.
   *
   * `chest` pivots at the TOP of the torso, so leaning it forward tips the shoulders and
   * head while the torso itself stays upright: fine for a crouch or a typing lean, useless
   * for lying down. Without a waist, a swimmer and a bench press both read as a STANDING
   * body with its head tipped back, which is exactly how they looked.
   *
   * This is a child of `hips` holding the torso, chest and arms, so rotating it lays the
   * upper body flat while the legs stay where they are.
   */
  waist: THREE.Object3D
  arms: [Limb, Limb]
  legs: [Limb, Limb]
  /**
   * Equipment the avatar can hold.
   *
   * A pose makes an item visible and puts it where the fists are; everything not held
   * stays hidden. These are parented to the avatar's GROUP (see the note where they are
   * added), so they stay attached while the body turns and walks without the scene
   * having to track them.
   */
  held: {
    barbell: THREE.Group
    /**
     * The knurled grip bands on the bar, so a pose can slide them onto the hands.
     *
     * A fixed offset only fits one grip width; a bench press opens wider than a press, and
     * the hands would end up on bare bar between the bands.
     */
    barbellGrips: THREE.Mesh[]
    dumbbells: [THREE.Group, THREE.Group]
    /** A burger in the right hand; hidden when the meal is a pizza. */
    burger: THREE.Group
    /** A pizza box held in both hands; hidden when the meal is a burger. */
    pizza: THREE.Group
    /** BBQ tongs, one in the right hand. */
    tongs: THREE.Group
    /**
     * A bowling ball, on the right palm.
     *
     * The FIST is the ball's TOP, not its centre: a hand rests on top of a 0.218 m ball, so
     * centring it on the fist would sink half the ball through the wrist.
     */
    bowlingBall: THREE.Group
  }
  /**
   * Swimwear: the trunks, plus every mesh a swim pose turns to BARE SKIN.
   *
   * The swap is done by material COLOUR, not by hiding meshes and showing bare ones. Each
   * mesh already owns its own material (`mat()` builds one per call), so recolouring the
   * shirt and both legs costs nothing and leaves the rig's geometry — and therefore every
   * joint offset the poses are written against — exactly as it was.
   *
   * `color` is the dry colour to put back. It is READ off the material at build time rather
   * than typed again here, so changing a role's shirt colour cannot leave the restore value
   * pointing at the old one.
   */
  /**
   * The avatar's bare-skin tone, as passed to `buildAvatar`. Kept so the swim pose can strip a
   * body back to skin without knowing which complexion it was given.
   */
  skin: number
  swimwear: {
    trunks: THREE.Group
    skinnable: { mesh: THREE.Mesh; color: number }[]
  }
}

/* ------------------------------------------------------------ proportions -- */
export const HIP_STAND = 0.98
const TORSO_H = 0.66
const TORSO_W = 0.42
const TORSO_D = 0.24
/** The chest group sits on top of the torso; its Y is the shoulder's origin. */
export const CHEST_Y = TORSO_H
/** Shoulder joint, below the chest top. */
/**
 * Shoulder joint height ABOVE the chest origin — which is the top of the torso and the
 * base of the neck.
 *
 * This was 0.14, putting the joint at world y 1.78 while the head spans 1.65-1.98: the
 * shoulders sat level with the middle of the face, the deltoid caps read as a pair of
 * balls beside the head, and the hands only reached 1.15 on a body whose hips are at
 * 0.98 — arms too short to hang, held up beside the skull.
 *
 * 0 is where the anatomy actually is: the shoulder joint at the top of the ribcage,
 * level with the base of the neck. Fingertips then land at 0.99 against hips at 0.98,
 * which is where a standing person's hands hang.
 */
export const SHOULDER_Y = 0
export const SHOULDER_X = 0.25
export const UPPER_ARM = 0.32
export const FOREARM = 0.30
/** Elbow joint to the fist's centre — the hand mesh's own offset. */
export const FIST_FROM_ELBOW = FOREARM + 0.03
const HIP_X = 0.11
const THIGH = 0.48
const SHIN = 0.46

const mat = (color: number, rough = 0.7) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough })

/* ------------------------------------------------------------ body shapes -- */

/**
 * A box that tapers: the top face scaled by `top`, the bottom face by `bot`.
 *
 * `BoxGeometry` puts half its 24 vertices above the mid-plane and half below, so scaling
 * each half independently turns it into a narrowing prism at ZERO extra triangles — the
 * silhouette is what changes, not the cost. `computeVertexNormals` then relights the
 * taper so the narrowing actually catches light instead of shading like a flat wall.
 *
 * This is the whole difference between a torso and a standing carton. A human is never
 * the same width from shoulder to waist: the shoulders are the widest point, the chest
 * tucks in, the waist narrower still. A constant-width box cannot say any of that, and
 * the eye reads "carton" long before it reads "person".
 */
function taper(g: THREE.BufferGeometry, top: number, bot = top): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) {
    const s = p.getY(i) > 0 ? top : bot
    p.setX(i, p.getX(i) * s)
    p.setZ(i, p.getZ(i) * s)
  }
  p.needsUpdate = true
  g.computeVertexNormals()
  return g
}

/** Multiply a hex colour's channels — used for collar/belt that must read as the shirt,
 *  just in shadow. Clamped so a dark role colour cannot wrap around to bright. */
function shade(color: number, k: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * k))
  const g = Math.min(255, Math.round(((color >> 8) & 255) * k))
  const b = Math.min(255, Math.round((color & 255) * k))
  return (r << 16) | (g << 8) | b
}

/**
 * Hair colour and skin tone, both derived from a name.
 *
 * Ten bodies in one room all with the same hair and the same complexion reads as clones
 * — the office looks like one model copy-pasted. Neither choice is random: a given agent
 * must look identical on every reload and in every screenshot, so both are hashed off a
 * seed string (the agent's name) rather than taken from `Math.random()`.
 */
const HAIR_TONES = [0x2b2723, 0x4a3428, 0x191512, 0x6b4a2a, 0x7d7671, 0x3d2b1f]
export const SKIN_TONES = [0xe9c19a, 0xd9a97c, 0xf0d0b0, 0xc08a5e, 0x8a5f42, 0xf5ddc4]

/** FNV-1a — stable across runs and machines, unlike a date-seeded PRNG. */
function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

/** The skin tone an agent with this name should wear, stable across reloads. */
export function skinFor(seed: string): number {
  return SKIN_TONES[Math.floor(hash01(seed + '\u0000skin') * SKIN_TONES.length)]
}

/**
 * Merge many small parts — each already transformed into its parent's frame — into ONE
 * geometry carrying a flat colour per part.
 *
 * Eleven meshes for one head meant eleven draw calls per head, times ten bodies in the
 * room, and that was the single largest addition the face made to the frame. The parts
 * never move relative to each other: eyes sit on the face, the face sits under the hair.
 * Merging them costs nothing visually and gives back ten draw calls per avatar.
 *
 * The colour rides in a `color` attribute rather than in the material, so one
 * `vertexColors` material renders skin, hair, brows and eyes together.
 *
 * `mergeGeometries` refuses to mix indexed and non-indexed buffers and needs every
 * attribute present, so everything is normalised to non-indexed with position, normal,
 * uv and color — the same care `batch.ts` takes for the office itself.
 */
/** Scale, then rotate about Z, then translate — applied straight into the vertices so a
 *  part arrives at `mergeColored` already sitting in its parent's frame. Order matters:
 *  scaling after translating would stretch the part away from where it was aimed. */
function place(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.BufferGeometry {
  if (sx !== 1 || sy !== 1 || sz !== 1) g.scale(sx, sy, sz)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

function mergeColored(parts: { g: THREE.BufferGeometry; color: number }[]): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = []
  for (const { g, color } of parts) {
    const geo = g.index ? g.toNonIndexed() : g.clone()
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name)
    }
    if (!geo.attributes.uv) {
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2))
    }
    if (!geo.attributes.normal) geo.computeVertexNormals()
    // `THREE.Color` converts the hex from sRGB into the LINEAR working space, which is
    // what a `vertexColors` material reads. Writing the raw hex bytes instead — which is
    // what this did first — left every merged part a second conversion too light: hair
    // 0x241f1c came out as #696260 grey, brows vanished into the skin, and the shirt hem
    // turned pale. It read as "the face was never modelled" when the parts were all
    // there, just painted the wrong colour.
    const n = geo.attributes.position.count
    const col = new Float32Array(n * 3)
    const rgb = new THREE.Color(color)
    const r = rgb.r
    const gr = rgb.g
    const b = rgb.b
    for (let i = 0; i < n; i++) {
      col[i * 3] = r
      col[i * 3 + 1] = gr
      col[i * 3 + 2] = b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.clearGroups()
    geos.push(geo)
  }
  const merged = mergeGeometries(geos, false)
  for (const geo of geos) geo.dispose()
  if (!merged) throw new Error('mergeColored: attribute sets did not match')
  merged.computeBoundingSphere()
  return merged
}

/* -------------------------------------------------------- held equipment -- */

/**
 * Shared buffers for held equipment.
 *
 * Eleven avatars each carrying their own copy of a barbell would be eleven identical
 * sets of buffers, so the geometry and the materials live at module scope and only the
 * meshes are per-avatar.
 */
const STEEL = new THREE.MeshStandardMaterial({ color: 0xb9c0c6, metalness: 0.4, roughness: 0.3 })
const KNURL = new THREE.MeshStandardMaterial({ color: 0x6f767c, metalness: 0.3, roughness: 0.9 })
const IRON = new THREE.MeshStandardMaterial({ color: 0x24282c, metalness: 0.5, roughness: 0.55 })

const BAR_GEO = new THREE.CylinderGeometry(0.031, 0.031, 1.9, 12)
const BAR_GRIP_GEO = new THREE.CylinderGeometry(0.037, 0.037, 0.26, 12)
const COLLAR_GEO = new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12)
const PLATE_GEOS = [
  new THREE.CylinderGeometry(0.21, 0.21, 0.065, 18),
  new THREE.CylinderGeometry(0.18, 0.18, 0.065, 18),
  new THREE.CylinderGeometry(0.14, 0.14, 0.065, 18),
]
const DUMBBELL_HANDLE_GEO = new THREE.CylinderGeometry(0.022, 0.022, 0.22, 8)
const DUMBBELL_HEAD_GEO = new THREE.CylinderGeometry(0.075, 0.075, 0.07, 14)

/**
 * A loaded barbell, sized from the GRIP and not from a real bar.
 *
 * The fists in the press pose are 0.82 m apart, so a 2.2 m Olympic bar would read as
 * scaffolding around a 1.8 m figure. 1.9 m with the plates outboard of the grip looks
 * like a bar somebody is actually holding, and the plate radii match the rack's so it
 * reads as the same object that was on it.
 *
 * The bar lies along local +X and is centred on the origin, so a pose places it by
 * putting its origin at the midpoint of the two fists.
 */
function buildBarbell(): { group: THREE.Group; grips: THREE.Mesh[] } {
  const g = new THREE.Group()
  const grips: THREE.Mesh[] = []
  const bar = new THREE.Mesh(BAR_GEO, STEEL)
  bar.rotation.z = Math.PI / 2
  g.add(bar)
  for (const side of [-1, 1]) {
    // Knurled bands exactly where the fists close: the grip is what makes the bar read
    // as HELD rather than as a prop balanced on the hands.
    const grip = new THREE.Mesh(BAR_GRIP_GEO, KNURL)
    grip.rotation.z = Math.PI / 2
    grip.position.x = side * 0.41
    g.add(grip)
    grips.push(grip)
    const collar = new THREE.Mesh(COLLAR_GEO, IRON)
    collar.rotation.z = Math.PI / 2
    collar.position.x = side * 0.66
    g.add(collar)
    // plates, biggest inboard — the same grading as the rack's
    for (const [i, off] of [0.73, 0.82, 0.905].entries()) {
      const plate = new THREE.Mesh(PLATE_GEOS[i], IRON)
      plate.rotation.z = Math.PI / 2
      plate.position.x = side * off
      g.add(plate)
    }
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  g.visible = false
  return { group: g, grips }
}

/**
 * A dumbbell. The handle lies along local +X, level with the fist that holds it.
 *
 * Deliberately not following the forearm: a curl is done with the wrist locked, so the
 * bell stays level while the arm swings under it.
 */
function buildDumbbell(): THREE.Group {
  const g = new THREE.Group()
  const handle = new THREE.Mesh(DUMBBELL_HANDLE_GEO, STEEL)
  handle.rotation.z = Math.PI / 2
  g.add(handle)
  for (const side of [-1, 1]) {
    const head = new THREE.Mesh(DUMBBELL_HEAD_GEO, IRON)
    head.rotation.z = Math.PI / 2
    head.position.x = side * 0.115
    g.add(head)
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  g.visible = false
  return g
}

/**
 * A burger, held in one hand.
 *
 * Built as a stack of discs so it reads as a burger from any angle: bottom bun, patty,
 * cheese, lettuce, top bun. Held with the fist wrapped around it, so the stack sits
 * slightly ABOVE the fist centre (a hand holds the bottom half).
 */
function buildBurger(): THREE.Group {
  const g = new THREE.Group()
  const bun = new THREE.MeshStandardMaterial({ color: 0xc98a3e, roughness: 0.8 })
  const patty = new THREE.MeshStandardMaterial({ color: 0x5a3620, roughness: 0.9 })
  const cheese = new THREE.MeshStandardMaterial({ color: 0xe8b53a, roughness: 0.7 })
  const lettuce = new THREE.MeshStandardMaterial({ color: 0x6aa84f, roughness: 0.85 })
  const discs: [THREE.Material, number, number][] = [
    [bun, 0.075, 0.028],
    [patty, 0.072, 0.022],
    [cheese, 0.074, 0.012],
    [lettuce, 0.078, 0.014],
    [bun, 0.073, 0.03],
  ]
  let y = 0
  for (const [m, r, h] of discs) {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), m)
    d.position.y = y + h / 2
    y += h
    g.add(d)
  }
  // the whole stack sits above the grip, because a fist holds the bottom
  g.position.y = 0
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  g.visible = false
  return g
}

/**
 * A pizza, held in both hands: an open box with the pie inside.
 *
 * Flat and wide, so it needs both fists — which is also why the eating pose uses both
 * arms. The pie is a disc with a crust ring and four pepperoni.
 */
function buildPizza(): THREE.Group {
  const g = new THREE.Group()
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xd8b98a, roughness: 0.9 })
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.025, 0.3), boxMat)
  g.add(base)
  const crust = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.13, 0.022, 20),
    new THREE.MeshStandardMaterial({ color: 0xd9a44e, roughness: 0.85 }),
  )
  crust.position.y = 0.024
  g.add(crust)
  const cheese = new THREE.Mesh(
    new THREE.CylinderGeometry(0.112, 0.112, 0.012, 20),
    new THREE.MeshStandardMaterial({ color: 0xf0d27a, roughness: 0.6 }),
  )
  cheese.position.y = 0.036
  g.add(cheese)
  for (const [px, pz] of [
    [-0.05, 0.03],
    [0.05, -0.04],
    [0.02, 0.06],
    [-0.04, -0.06],
  ] as const) {
    const pep = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.01, 12),
      new THREE.MeshStandardMaterial({ color: 0xb33a2a, roughness: 0.7 }),
    )
    pep.position.set(px, 0.044, pz)
    g.add(pep)
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  g.visible = false
  return g
}

/**
 * BBQ tongs: two arms joined at a pivot, held in one fist.
 *
 * The pose squeezes them (the arms close by a few degrees), which is what makes the
 * cooking read as handling food rather than standing at a counter.
 */
function buildTongs(): THREE.Group {
  const g = new THREE.Group()
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa2a8, metalness: 0.7, roughness: 0.35 })
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.26, 0.012), steel)
    arm.position.set(side * 0.012, -0.13, 0)
    arm.rotation.z = side * 0.05
    g.add(arm)
  }
  const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 10), steel)
  pivot.rotation.z = Math.PI / 2
  g.add(pivot)
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  g.visible = false
  return g
}

/**
 * A bowling ball, held in one fist.
 *
 * Built with the fist at the ball's TOP: the shell hangs 0.109 below the grip point, so the
 * palm sits on it the way a hand actually carries a house ball. Centring it would bury half
 * the ball in the forearm.
 *
 * The three finger holes are what stop it reading as a plain sphere — a glossy blue ball with
 * no holes is a ball, not a bowling ball.
 */
function buildBowlingBall(): THREE.Group {
  const g = new THREE.Group()
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0x1d3f8f, roughness: 0.32, metalness: 0.18 }),
  )
  shell.position.y = -BALL_R
  g.add(shell)
  const holeMat = new THREE.MeshStandardMaterial({ color: 0x0a1220, roughness: 0.95 })
  for (const [hx, hz] of [
    [-0.033, -0.022],
    [0.033, -0.022],
    [0, 0.042],
  ] as const) {
    const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.06, 8), holeMat)
    hole.position.set(hx, -BALL_R + 0.085, hz)
    g.add(hole)
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true
  })
  g.visible = false
  return g
}

export function buildAvatar(role: AgentRole, skin = 0xe9c19a, seed: string = role): Avatar {
  const group = new THREE.Group()
  const accent = ROLE_COLORS[role] ?? 0x6f8fa8
  const trouser = 0x46505a
  // Hair follows the seed, not the role: two developers must not share a haircut colour,
  // or the room still reads as clones wearing different shirts.
  const HAIR = HAIR_TONES[Math.floor(hash01(seed + '\u0000hair') * HAIR_TONES.length)]

  // ---- legs (built first so the hip sits at the top of them)
  const hips = new THREE.Group()
  hips.position.y = HIP_STAND
  group.add(hips)

  const legMeshes: THREE.Mesh[] = []
  const makeLeg = (side: number): Limb => {
    const hipJoint = new THREE.Group()
    hipJoint.position.set(side * HIP_X, 0, 0)
    hips.add(hipJoint)
    // Thigh and shin are tapered CYLINDERS, not boxes. A leg is thickest at the hip and
    // at the calf and thinnest at the knee and ankle; a constant-width box gets none of
    // that, which is why the old legs read as two stacked planks. Ten radial segments
    // (40 triangles) are enough to look round from the office camera and no more.
    //
    // Joint positions are untouched — the poses in anim.ts are written against these
    // numbers, and facing.ts measures the feet from them.
    const thigh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.088, 0.072, THIGH, 10),
      mat(trouser),
    )
    thigh.position.y = -THIGH / 2
    hipJoint.add(thigh)
    const knee = new THREE.Group()
    knee.position.y = -THIGH
    hipJoint.add(knee)
    const shin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.072, 0.055, SHIN, 10),
      mat(0x39424b),
    )
    shin.position.y = -SHIN / 2
    knee.add(shin)
    // A shoe, not a slab: rounded toe box over a thin lighter sole, pushed forward so the
    // figure stands ON its feet instead of balancing on a centred brick.
    //
    // The sole's BOTTOM is kept at exactly -SHIN - 0.02, the same height the old foot box
    // reached. Every seated pose in layout.ts is tuned against that contact point, so
    // moving it would re-seat every agent in the room by a centimetre.
    const shoe = new THREE.Mesh(
      mergeColored([
        { g: place(rbox(0.15, 0.08, 0.27, 0.032), 0, -SHIN + 0.02, 0.048), color: 0x2f3438 },
        { g: place(rbox(0.156, 0.016, 0.276, 0.007), 0, -SHIN - 0.012, 0.048), color: 0xdad3c6 },
      ]),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }),
    )
    knee.add(shoe)
    legMeshes.push(thigh, shin)
    return { shoulder: hipJoint, elbow: knee }
  }
  const legs: [Limb, Limb] = [makeLeg(-1), makeLeg(1)]

  // ---- torso
  //
  // The torso hangs from the WAIST, which pivots at the hip. `chest` still sits on top of
  // the torso and still pivots there — that is the shoulder joint — but the waist is what
  // lets the whole upper body lie down.
  const waist = new THREE.Group()
  waist.position.y = 0
  hips.add(waist)

  // Tapered torso: widest at the shoulders, narrowing to the waist. This is the single
  // biggest reason the old body read as a carton — a human silhouette is never the same
  // width from shoulder to hip, and the eye clocks the flat sides instantly.
  // The SHOULDER YOKE: a wider mass across the top of the ribcage, reaching out past
  // SHOULDER_X = 0.25 so both shoulder joints sit INSIDE it rather than on its edge.
  // Without it the joint is a bare pivot with an arm hanging off it, and the arm reads
  // as bolted on beside the torso instead of growing out of it.
  //
  // Merged into the TORSO rather than kept as its own mesh: one fewer draw call per
  // avatar, and it then takes the swim recolour with the rest of the shirt — bare
  // shoulders are what a swimmer should have, and a leftover shirt-coloured pad across
  // the shoulders is not.
  //
  // Top edge is held to waist-frame 0.645 (world 1.625), BELOW the jaw at world 1.65.
  // The joint itself moved down to 0 when the arms were lowered, so the yoke now sits
  // under the deltoid caps instead of reaching above them; the caps dress the joint and
  // this only widens the ribcage the caps land on.
  const yoke = place(
    taper(rbox(0.46, 0.15, TORSO_D * 0.94, 0.05), 0.94, 1.0),
    0,
    0.57,
    0,
  )
  const torso = new THREE.Mesh(
    mergeColored([
      { g: place(taper(rbox(TORSO_W, TORSO_H, TORSO_D, 0.05), 1.0, 0.84), 0, TORSO_H / 2, 0), color: accent },
      { g: yoke, color: shade(accent, 0.93) },
    ]),
    mat(0xffffff),
  )
  waist.add(torso)

  // Shirt hem and collar, merged into one mesh.
  //
  // The hem is a darker band at the bottom of the torso, so the shirt has an edge instead
  // of running into the trousers as one unbroken column. The collar sits at the neck
  // opening — enough to say "shirt" from the office camera without modelling a lapel.
  //
  // Both take the swim recolour, so they are one material and one draw call, and both
  // go bare with the torso rather than leaving a coloured ring hovering at the neck.
  const hem = new THREE.Mesh(
    mergeColored([
      { g: place(rbox(TORSO_W * 0.87, 0.045, TORSO_D * 0.9, 0.018), 0, 0.022, 0), color: shade(accent, 0.72) },
      {
        // Sits ON TOP of the shoulder yoke (which reaches 0.75), not at TORSO_H —
        // parked at the old height it vanished inside the yoke and left no collar at all.
        g: place(rbox(0.2, 0.032, TORSO_D * 0.72, 0.013), 0, 0.752, 0.01, -0.18),
        color: shade(accent, 0.8),
      },
    ]),
    mat(0xffffff),
  )
  waist.add(hem)

  const chest = new THREE.Group()
  chest.position.y = CHEST_Y
  waist.add(chest)

  // Neck as a cylinder: a box neck shows its corners through the jaw on every head turn.
  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.062, 0.1, 12), mat(skin, 0.85))
  neckMesh.position.y = 0.045
  const neck = new THREE.Group()
  neck.add(neckMesh)
  chest.add(neck)

  const head = new THREE.Group()

  // ---- face and hair, merged into ONE mesh --------------------------------
  // The head was a bare cube: no eyes, no features, so every agent in the room was an
  // anonymous box on a stick. These parts are all children of the HEAD group, so they
  // track every head turn the poses make without the animation layer knowing they exist.
  //
  // They are merged rather than kept as eleven meshes because eleven meshes is eleven
  // draw calls per head, times ten bodies in the room. The parts never move relative to
  // each other, so merging is free visually and gives back the draw calls.
  //
  // Everything is placed in the HEAD GROUP's frame by baking the transform into the
  // geometry before the merge; the merged mesh itself sits at the group's origin.
  const headParts: { g: THREE.BufferGeometry; color: number }[] = [
    // shell — widest at the crown, tapering toward the jaw
    { g: place(rbox(0.28, 0.3, 0.275, 0.075), 0, 0.16, 0), color: skin },
    // eyes: dark, slightly recessed, sized to read at office-camera distance
    { g: place(new THREE.SphereGeometry(0.026, 10, 8), -0.058, 0.185, 0.129), color: 0x241f1c },
    { g: place(new THREE.SphereGeometry(0.026, 10, 8), 0.058, 0.185, 0.129), color: 0x241f1c },
    // brows: tilted down toward the outside. Flat bars read as a unibrow; the tilt is
    // what makes a neutral face look like it is thinking.
    { g: place(rbox(0.058, 0.015, 0.02, 0.006, 1), -0.058, 0.228, 0.132, 0.12), color: HAIR },
    { g: place(rbox(0.058, 0.015, 0.02, 0.006, 1), 0.058, 0.228, 0.132, -0.12), color: HAIR },
    // nose and mouth: the smallest marks that stop a face reading as blank
    { g: place(rbox(0.026, 0.04, 0.032, 0.01), 0, 0.152, 0.134), color: shade(skin, 0.9) },
    { g: place(rbox(0.05, 0.013, 0.02, 0.005, 1), 0, 0.106, 0.131), color: shade(skin, 0.58) },
    // ears: flattened rounds sized off the head so they cannot float free of it
    { g: place(new THREE.SphereGeometry(0.034, 8, 6), -0.136, 0.165, 0, 0, 0.42, 0.85, 0.7), color: shade(skin, 0.95) },
    { g: place(new THREE.SphereGeometry(0.034, 8, 6), 0.136, 0.165, 0, 0, 0.42, 0.85, 0.7), color: shade(skin, 0.95) },
    // hair: a cap over the crown plus a fall down the back, tapering at the hairline
    // instead of ending in a hard horizontal cut across the forehead
    { g: place(taper(rbox(0.3, 0.15, 0.295, 0.062), 1.0, 0.9), 0, 0.268, 0), color: HAIR },
    { g: place(rbox(0.295, 0.15, 0.1, 0.04), 0, 0.2, -0.105), color: HAIR },
  ]
  const headMesh = new THREE.Mesh(
    mergeColored(headParts),
    // One roughness for the whole head. Eyes want to be glossier than skin, but a single
    // material is what makes the merge possible, and at office distance the difference
    // is invisible.
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 }),
  )
  head.add(headMesh)

  neck.add(head)

  // NO role badge. There used to be a glowing torus hovering over every head, spinning
  // and bobbing — a halo on a low-poly body that already has a face, a name label AND a
  // desk monitor showing its status. It was the loudest thing in the frame and said
  // nothing the other three did not.

  // Collected so the swim swap can strip them with the rest of the shirt (see `skinnable`).
  const cuffs: THREE.Mesh[] = []
  const makeArm = (side: number): Limb => {
    const shoulder = new THREE.Group()
    shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, 0)
    chest.add(shoulder)
    // DELTOID plus sleeve, merged into one mesh.
    //
    // The deltoid is a rounded cap sitting ON the shoulder joint. The joint is a bare
    // pivot at (SHOULDER_X, SHOULDER_Y) with a cylinder hanging off it, so without a
    // cap the arm meets the body at a hard corner and reads as bolted on beside the
    // torso instead of growing out of it. The cap fills that corner, and merging it
    // with the sleeve keeps it at one draw call.
    //
    // The sleeve itself ends mid-upper-arm, as a real sleeve does, so the arm is shirt
    // then skin rather than one unbroken colour from shoulder to fingertip.
    const upper = new THREE.Mesh(
      mergeColored([
        {
          g: place(new THREE.SphereGeometry(0.1, 10, 8), 0, -0.02, 0, 0, 1.05, 0.92, 1.0),
          color: accent,
        },
        {
          g: place(new THREE.CylinderGeometry(0.062, 0.052, UPPER_ARM, 10), 0, -UPPER_ARM / 2, 0),
          color: accent,
        },
      ]),
      mat(0xffffff),
    )
    shoulder.add(upper)
    const cuff = new THREE.Mesh(rbox(0.115, 0.028, 0.115, 0.012), mat(shade(accent, 0.72)))
    cuff.position.y = -UPPER_ARM + 0.012
    shoulder.add(cuff)
    cuffs.push(cuff)
    const elbow = new THREE.Group()
    elbow.position.y = -UPPER_ARM
    shoulder.add(elbow)
    // Forearm tapers toward the wrist — thickest just below the elbow.
    const fore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.042, FOREARM, 10),
      mat(skin, 0.85),
    )
    fore.position.y = -FOREARM / 2
    elbow.add(fore)
    // The hand keeps its EXACT old offset: FIST_FROM_ELBOW is FOREARM + 0.03, and anim.ts
    // places every held item by that number. Moving it breaks the barbell, the burger and
    // the bowling ball all at once.
    // Sized to the WRIST, not to a mitten. The forearm now tapers to r=0.042, and a
    // 9.8 cm-wide hand on an 8.4 cm wrist left the two reading as separate objects with
    // daylight between them — which is exactly what a screenshot showed: a pale shape
    // hovering beside the arm.
    // The offset stays EXACTLY FOREARM + 0.03 = FIST_FROM_ELBOW. anim.ts places every
    // held item by that constant — the barbell, the burger, the bowling ball — so
    // nudging it for looks would quietly unstick the props from the hands.
    const hand = new THREE.Mesh(rbox(0.086, 0.1, 0.066, 0.028), mat(skin, 0.85))
    hand.position.y = -FOREARM - 0.03
    elbow.add(hand)
    return { shoulder, elbow }
  }
  const arms: [Limb, Limb] = [makeArm(-1), makeArm(1)]

  // ---- equipment, hidden until a pose picks it up
  //
  // Parented to the GROUP, not to the chest. `fistInAvatar` in anim.ts resolves the
  // fist all the way out to the avatar's own frame (fist -> elbow -> shoulder -> chest
  // -> hips -> group), so the item's position is expressed in that frame too. Hanging
  // it off the chest applied the chest's transform a second time and the bar floated
  // 1.67 m from the hands.
  const { group: barbell, grips: barbellGrips } = buildBarbell()
  group.add(barbell)
  const dumbbells: [THREE.Group, THREE.Group] = [buildDumbbell(), buildDumbbell()]
  for (const d of dumbbells) group.add(d)
  const burger = buildBurger()
  group.add(burger)
  const pizza = buildPizza()
  group.add(pizza)
  const tongs = buildTongs()
  group.add(tongs)
  const bowlingBall = buildBowlingBall()
  group.add(bowlingBall)

  // ---- swimwear, hidden until a pose strips the avatar down ----
  //
  // Parented to the HIPS, so the trunks stay on the body when the waist lays a swimmer flat.
  const trunks = new THREE.Group()
  const trunkBody = new THREE.Mesh(
    taper(rbox(0.46, 0.3, 0.31, 0.06), 1.0, 0.92),
    mat(0x1f3a5f),
  )
  trunkBody.position.y = -0.11
  trunks.add(trunkBody)
  // a lighter waistband, which is what makes a navy shape read as trunks and not as shorts
  const waistband = new THREE.Mesh(rbox(0.468, 0.058, 0.318, 0.022), mat(0x33639e))
  waistband.position.y = 0.03
  trunks.add(waistband)
  trunks.visible = false
  hips.add(trunks)

  const colorOf = (m: THREE.Mesh) => ((m.material as THREE.MeshStandardMaterial).color.getHex())
  // The shirt HEM, COLLAR and both SLEEVES CUFFS go in too. The swim swap is a colour
  // change, so anything left wearing shirt colours would float as a coloured band around
  // a bare body — a collar ring hovering at the neck is worse than no collar at all.
  // They are all separate meshes from the torso, so none of them were picked up by it.
  const skinnable: { mesh: THREE.Mesh; color: number }[] = [
    torso,
    ...legMeshes,
    hem,
    ...cuffs,
  ].map((m) => ({
    mesh: m,
    color: colorOf(m),
  }))

  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = false
    }
  })

  return {
    group, chest, neck, head, hips, waist, arms, legs,
    held: { barbell, barbellGrips, dumbbells, burger, pizza, tongs, bowlingBall },
    skin,
    swimwear: { trunks, skinnable },
  }
}
