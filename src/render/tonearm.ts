/**
 * Tonearm + pivot, modelled in 3D and rendered once (top-down, orthographic) with PBR materials and a studio
 * environment map, then handed to the 2D stage as sprites. The stage keeps doing the cheap part every frame
 * (rotate the arm sprite about the pivot, drop shadow), while the chrome gets real reflections.
 *
 * Units are the record radius R. Scene axes: x along the arm, y up (= sprite -y), z toward the camera.
 */
import {
  ACESFilmicToneMapping, BackSide, BoxGeometry, Color, MeshBasicMaterial, PlaneGeometry, CanvasTexture, CatmullRomCurve3, CylinderGeometry, DirectionalLight,
  ExtrudeGeometry, Group, Mesh, MeshPhysicalMaterial, Object3D, OrthographicCamera, PMREMGenerator, Scene, Shape,
  SphereGeometry, SRGBColorSpace, Texture, TubeGeometry, Vector3, WebGLRenderer, type Material,
} from 'three'
import { makeCanvas } from './rand'

export interface ArmSprite {
  canvas: HTMLCanvasElement
  /** pivot position inside the sprite (px) */
  ox: number
  oy: number
  /** stylus tip relative to the pivot, in units of the record radius */
  tipX: number
  tipY: number
}

// ── proportions, measured off the reference video at 1920×1198 (R = 555px) ──
// distances along the arm from the pivot centre, in record radii
const TUBE_R = 0.025
const TUBE_Z = 0.07
const TUBE_END = 0.90      // tube disappears into the collar
const COLLAR_END = 0.99
const NECK_END = 1.08      // narrow black neck below the collar…
const PLATE_END = 1.205    // …widening into the mounting plate
const STYLUS_X = 1.232     // stylus tip (pivot→tip = 1.22R in the video)
const PIVOT_HALF = 0.17

/**
 * Dark product-photo studio: near-black room with a few soft light strips. Chrome viewed from above then shows
 * two bright bands on mid-grey (like the reference) instead of the washed-out white a bright room gives.
 */
function studio() {
  const s = new Scene()
  s.add(new Mesh(new BoxGeometry(20, 20, 20), new MeshBasicMaterial({ color: 0x3a3b40, side: BackSide })))
  const panel = (w: number, h: number, x: number, y: number, z: number, intensity: number, tint = 0xffffff) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(tint).multiplyScalar(intensity), side: BackSide }))
    m.position.set(x, y, z); m.lookAt(0, 0, 0); m.rotateY(Math.PI); s.add(m)
  }
  panel(14, 3.2, 0, 3.0, 5, 4.5)      // main strip: upper band on the tube
  panel(14, 2.4, 0, -3.4, 4.2, 2.6)   // weaker strip: lower band
  panel(3, 3, -5, 4, 3, 3, 0xfff1e6)  // warm key softbox
  panel(14, 2.5, 0, 0.3, 8, 1.1)      // soft top fill: mid-grey core between the bands
  return s
}

let renderer: WebGLRenderer | null = null
let envTex: Texture | null = null

function getRenderer() {
  if (!renderer) {
    renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.setClearColor(0x000000, 0)
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.outputColorSpace = SRGBColorSpace
    const pm = new PMREMGenerator(renderer)
    envTex = pm.fromScene(studio(), 0.02).texture
    pm.dispose()
  }
  return renderer
}

function makeScene() {
  const scene = new Scene()
  scene.environment = envTex
  const key = new DirectionalLight(0xffffff, 1.1); key.position.set(-1.2, 1.4, 2.5); scene.add(key)
  const fill = new DirectionalLight(0xffd9c4, 0.35); fill.position.set(1.5, -1, 1.2); scene.add(fill)
  return scene
}

/** Render a scene top-down into a fresh 2D canvas. Bounds are in scene units. */
function snapshot(scene: Scene, left: number, right: number, top: number, bottom: number, k: number) {
  const r = getRenderer()
  const w = Math.ceil((right - left) * k), h = Math.ceil((top - bottom) * k)
  r.setSize(w, h, false)
  const cam = new OrthographicCamera(left, right, top, bottom, 0.01, 10)
  cam.position.set(0, 0, 5); cam.lookAt(0, 0, 0)
  r.render(scene, cam)
  const out = makeCanvas(w, h)
  out.getContext('2d')!.drawImage(r.domElement, 0, 0)
  scene.traverse((o: Object3D) => {
    const m = o as Mesh
    if (m.geometry) m.geometry.dispose()
    const mat = m.material as Material | Material[] | undefined
    if (mat) (Array.isArray(mat) ? mat : [mat]).forEach(x => x.dispose())
  })
  return out
}

// ── materials ──
const chrome = () => new MeshPhysicalMaterial({ color: 0xffffff, metalness: 1, roughness: 0.1 })
const satin = () => new MeshPhysicalMaterial({ color: 0xe8e9ec, metalness: 1, roughness: 0.24 })
const gunmetal = () => new MeshPhysicalMaterial({ color: 0x55575d, metalness: 0.9, roughness: 0.42 })
// NB: material.envMapIntensity is ignored for scene.environment, so dark materials get their own envMap to be able to dial it down
const plastic = () => new MeshPhysicalMaterial({ color: 0x040405, metalness: 0.0, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, envMap: envTex, envMapIntensity: 0.28 })
const dark = () => new MeshPhysicalMaterial({ color: 0x050506, metalness: 0.2, roughness: 0.6, envMap: envTex, envMapIntensity: 0.15 })

/** cylinder lying along +x from x0 to x1 */
function rod(x0: number, x1: number, r: number, z: number, mat: Material, seg = 64) {
  const m = new Mesh(new CylinderGeometry(r, r, x1 - x0, seg, 1), mat)
  m.rotation.z = -Math.PI / 2
  m.position.set((x0 + x1) / 2, 0, z)
  return m
}
function extrude(shape: Shape, depth: number, mat: Material, bevel = 0.003) {
  return new Mesh(new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 24 }), mat)
}
function screwHead(x: number, y: number, z: number, r: number) {
  const g = new Group()
  const head = new Mesh(new CylinderGeometry(r, r * 1.05, r * 0.7, 32), satin())
  head.rotation.x = Math.PI / 2; head.position.set(x, y, z); g.add(head)
  const slot = new Mesh(new BoxGeometry(r * 1.7, r * 0.28, r * 0.3), dark())
  slot.position.set(x, y, z + r * 0.36); slot.rotation.z = 0.7; g.add(slot)
  return g
}

export function buildArm(k: number): ArmSprite {
  getRenderer()
  const scene = makeScene()
  const arm = new Group(); scene.add(arm)

  // flat gunmetal lift plate running under the tube from the pivot, tapered, with two black holes at its end
  const lp = new Shape()
  lp.moveTo(0.02, -0.058); lp.lineTo(0.235, -0.043); lp.quadraticCurveTo(0.27, -0.04, 0.27, 0); lp.quadraticCurveTo(0.27, 0.04, 0.235, 0.043)
  lp.lineTo(0.02, 0.058); lp.closePath()
  const plate = extrude(lp, 0.01, gunmetal(), 0.003); plate.position.z = TUBE_Z - TUBE_R - 0.004; arm.add(plate)
  for (const y of [-0.033, 0.033]) {
    const h = new Mesh(new CylinderGeometry(0.0075, 0.0075, 0.004, 20), dark()); h.rotation.x = Math.PI / 2
    h.position.set(0.245, y, TUBE_Z - TUBE_R + 0.01); arm.add(h)
  }

  // polished tube
  arm.add(rod(0, TUBE_END + 0.01, TUBE_R, TUBE_Z, chrome()))

  // headshell (one extruded silhouette): narrow neck under the collar, then the wider mounting plate
  const sh = new Shape()
  sh.moveTo(COLLAR_END - 0.02, -0.031); sh.lineTo(NECK_END - 0.012, -0.034); sh.lineTo(NECK_END + 0.006, -0.05)
  sh.lineTo(PLATE_END, -0.05); sh.lineTo(PLATE_END, 0.05); sh.lineTo(NECK_END + 0.006, 0.05)
  sh.lineTo(NECK_END - 0.012, 0.034); sh.lineTo(COLLAR_END - 0.02, 0.031); sh.closePath()
  const shell = extrude(sh, 0.024, plastic(), 0.005); shell.position.z = TUBE_Z - 0.034; arm.add(shell)
  const top = TUBE_Z - 0.034 + 0.024 + 0.005
  // two screws in short slots near the plate's far end
  for (const y of [-0.03, 0.03]) {
    const s = new Mesh(new BoxGeometry(0.04, 0.014, 0.002), dark()); s.position.set(PLATE_END - 0.04, y, top); arm.add(s)
    arm.add(screwHead(PLATE_END - 0.04, y, top + 0.002, 0.0095))
  }
  // cartridge peeking out past the plate, with its orange strip and the stylus
  const cart = new Mesh(new BoxGeometry(0.03, 0.07, 0.02), plastic()); cart.position.set(PLATE_END + 0.012, 0, TUBE_Z - 0.05); arm.add(cart)
  const orange = new Mesh(new BoxGeometry(0.022, 0.012, 0.004), new MeshPhysicalMaterial({ color: 0xd96f1c, roughness: 0.35, clearcoat: 0.5 }))
  orange.position.set(PLATE_END + 0.014, 0, TUBE_Z - 0.038); arm.add(orange)
  const tip = new Mesh(new SphereGeometry(0.003, 12, 8), new MeshPhysicalMaterial({ color: 0xd9dbe0, metalness: 1, roughness: 0.2 }))
  tip.position.set(STYLUS_X, 0, TUBE_Z - 0.055); arm.add(tip)

  // finger lift: flat tapered bar leaving the right side (+y here) at ~57° to the arm
  const fl = new Shape()
  fl.moveTo(0, -0.009); fl.lineTo(0.152, -0.0055); fl.quadraticCurveTo(0.162, 0, 0.152, 0.0055); fl.lineTo(0, 0.009); fl.closePath()
  const lift = extrude(fl, 0.005, plastic(), 0.0018)
  lift.position.set(NECK_END + 0.012, 0.042, TUBE_Z - 0.016); lift.rotation.z = 1.1; arm.add(lift)
  // little silver bracket at the lift's root
  const clip = new Mesh(new BoxGeometry(0.016, 0.006, 0.006), gunmetal()); clip.position.set(NECK_END - 0.004, 0.04, top - 0.004); arm.add(clip)

  // copper + black leads looping out above the lift
  const lead = (pts: [number, number][], color: number) => arm.add(new Mesh(
    new TubeGeometry(new CatmullRomCurve3(pts.map(([x, y]) => new Vector3(x, y, TUBE_Z - 0.006))), 24, 0.0018, 8),
    new MeshPhysicalMaterial({ color, metalness: color === 0xc8764a ? 1 : 0, roughness: 0.35 })))
  lead([[1.005, 0.026], [1.0, 0.046], [1.02, 0.05], [1.04, 0.036]], 0xc8764a)
  lead([[1.01, 0.028], [1.008, 0.052], [1.032, 0.054], [1.048, 0.034]], 0x1a1012)

  // stepped chrome collar: short neck, satin body with bright rims
  arm.add(rod(TUBE_END - 0.004, TUBE_END + 0.016, 0.03, TUBE_Z, chrome()))
  arm.add(rod(TUBE_END + 0.016, COLLAR_END - 0.008, 0.036, TUBE_Z, satin()))
  arm.add(rod(TUBE_END + 0.016, TUBE_END + 0.022, 0.0372, TUBE_Z, chrome()))
  arm.add(rod(COLLAR_END - 0.008, COLLAR_END, 0.0365, TUBE_Z, chrome()))

  const padL = 0.08, padT = 0.16, right = STYLUS_X + 0.03, bottom = -0.1
  const canvas = snapshot(scene, -padL, right, padT, bottom, k)
  // scene y is up, sprite y is down: the tip sits on the axis, so the flip doesn't move it
  return { canvas, ox: padL * k, oy: padT * k, tipX: STYLUS_X, tipY: 0 }
}

function conicTexture() {
  const c = makeCanvas(512, 512), g = c.getContext('2d')!
  const cg = g.createConicGradient(0.4, 256, 256)
  for (let i = 0; i <= 16; i++) cg.addColorStop(i / 16, i % 2 ? '#8e9096' : '#b4b6bc')
  g.fillStyle = cg; g.fillRect(0, 0, 512, 512)
  const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace
  return t
}

/**
 * Fixed pivot (not rotated): smooth gunmetal disc, thin chrome ring, dark recess, brushed cap.
 * Scene y is up = screen up here, since this sprite is drawn unrotated.
 */
export function buildPivot(k: number): { base: HTMLCanvasElement; cap: HTMLCanvasElement; half: number } {
  getRenderer()
  const H = PIVOT_HALF
  const disc = (r: number, h: number, z: number, mat: Material) => {
    const m = new Mesh(new CylinderGeometry(r, r, h, 96), mat); m.rotation.x = Math.PI / 2; m.position.z = z; return m
  }

  const bs = makeScene()
  bs.add(disc(0.148, 0.03, 0.015, new MeshPhysicalMaterial({ color: 0x4c4e53, metalness: 0.85, roughness: 0.42 })))
  bs.add(disc(0.126, 0.004, 0.032, chrome()))
  bs.add(disc(0.117, 0.006, 0.033, dark()))
  // short crescent slot, lower-left
  bs.add(new Mesh(new TubeGeometry(new CatmullRomCurve3(
    Array.from({ length: 7 }, (_, i) => { const a = Math.PI * (1.12 + i * 0.035); return new Vector3(Math.cos(a) * 0.137, Math.sin(a) * 0.137, 0.031) }),
  ), 24, 0.0045, 8), dark()))
  bs.add(screwHead(-0.041, -0.103, 0.034, 0.0085))
  bs.add(screwHead(0.097, -0.058, 0.034, 0.0085))
  for (const [x, y, a] of [[-0.095, -0.025, 0.25], [0.094, 0.023, 0.25]]) {
    const clip = new Mesh(new BoxGeometry(0.01, 0.022, 0.006), satin()); clip.position.set(x, y, 0.036); clip.rotation.z = a; bs.add(clip)
  }
  const base = snapshot(bs, -H, H, H, -H, k)

  const cs = makeScene()
  const side = gunmetal()
  const capTop = new MeshPhysicalMaterial({ color: 0x6c6e74, metalness: 1, roughness: 0.4, map: conicTexture() })
  const capM = new Mesh(new CylinderGeometry(0.09, 0.092, 0.05, 96), [side, capTop, side])
  capM.rotation.x = Math.PI / 2; capM.position.z = 0.09; cs.add(capM)
  const cap = snapshot(cs, -H, H, H, -H, k)

  return { base, cap, half: H }
}
