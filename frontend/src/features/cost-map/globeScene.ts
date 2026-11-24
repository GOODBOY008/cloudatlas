import { geoEquirectangular, geoGraticule, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import {
  AmbientLight, CanvasTexture, DirectionalLight, MathUtils, Mesh, MeshLambertMaterial,
  PerspectiveCamera, Scene, SphereGeometry, Spherical, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { RegionExpense, WorldGeography } from './regions'

type Coordinates = RegionExpense['coordinates']
const home = { lat: 25, lon: 15 }
const homeDistance = 3.8

function surfacePoint({ lat, lon }: Coordinates) {
  return new Vector3().setFromSphericalCoords(1, MathUtils.degToRad(90 - lat), MathUtils.degToRad(90 + lon))
}

// An equirectangular texture shares the sphere's UVs, including at the antimeridian.
function earthTexture(geography: WorldGeography, viewport: HTMLElement) {
  const atlas = document.createElement('canvas')
  atlas.width = 2048
  atlas.height = atlas.width / 2
  const ink = atlas.getContext('2d')
  if (!ink) throw new Error('Canvas 2D unavailable')
  const path = geoPath(geoEquirectangular().scale(atlas.width / (2 * Math.PI))
    .translate([atlas.width / 2, atlas.height / 2]), ink)
  const countries = feature(geography, geography.objects.countries)
  const grid = geoGraticule().step([30, 30])()
  const texture = new CanvasTexture(atlas)
  texture.colorSpace = SRGBColorSpace

  const paint = () => {
    const styles = getComputedStyle(viewport)
    const color = (token: string) => `rgb(${styles.getPropertyValue(token).trim()})`
    ink.fillStyle = color('--accent-soft')
    ink.fillRect(0, 0, atlas.width, atlas.height)
    ink.beginPath()
    path(countries)
    ink.fillStyle = color('--map-land')
    ink.fill()
    ink.globalAlpha = 0.42
    ink.fillStyle = color('--chart-1')
    ink.fill()
    ink.strokeStyle = color('--map-edge')
    ink.lineWidth = 1.3
    ink.stroke()
    ink.beginPath()
    path(grid)
    ink.globalAlpha = 0.19
    ink.lineWidth = 1
    ink.strokeStyle = color('--chart-1')
    ink.stroke()
    ink.globalAlpha = 1
    texture.needsUpdate = true
  }
  return { texture, paint }
}

export function createGlobe(viewport: HTMLElement, geography: WorldGeography, onLost: () => void) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('webgl2', { alpha: true, antialias: true })
  if (!context) throw new Error('WebGL 2 unavailable')
  const earth = earthTexture(geography, viewport)
  const renderer = new WebGLRenderer({ canvas, context, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  canvas.setAttribute('aria-hidden', 'true')
  viewport.prepend(canvas)

  const scene = new Scene()
  const camera = new PerspectiveCamera(36, 1, 0.1, 20)
  camera.position.copy(surfacePoint(home)).multiplyScalar(homeDistance)
  const controls = new OrbitControls(camera, canvas)
  controls.enablePan = false
  controls.minDistance = 1.85
  controls.maxDistance = 6
  const geometry = new SphereGeometry(1, 80, 48)
  const material = new MeshLambertMaterial({ map: earth.texture })
  const sun = new DirectionalLight(0xffffff, 1.65)
  sun.position.set(-3, 4, 5)
  camera.add(sun)
  scene.add(camera, new AmbientLight(0xffffff, 1.85), new Mesh(geometry, material))

  let markers: { point: Vector3; element: HTMLElement }[] = []
  let flight: { from: Spherical; to: Spherical; start: number } | null = null
  let frame = 0
  let width = 0
  let height = 0
  let repaint = true
  let initialView = true
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const current = new Spherical()
  const projected = new Vector3()
  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(draw)
  }
  function draw(now: number) {
    // Keep the pending frame set while controls.update() emits its change event.
    if (repaint) {
      earth.paint()
      repaint = false
    }
    if (flight) {
      const t = motion.matches ? 1 : Math.min(1, (now - flight.start) / 620)
      const eased = MathUtils.smoothstep(t, 0, 1)
      current.set(
        MathUtils.lerp(flight.from.radius, flight.to.radius, eased),
        MathUtils.lerp(flight.from.phi, flight.to.phi, eased),
        MathUtils.lerp(flight.from.theta, flight.to.theta, eased),
      )
      camera.position.setFromSpherical(current)
      controls.update()
      if (t === 1) flight = null
    }
    renderer.render(scene, camera)
    for (const { point, element } of markers) {
      // The tangent plane separates the visible hemisphere from its occluded side.
      const visible = point.dot(camera.position) > 1
      element.style.visibility = visible ? 'visible' : 'hidden'
      if (!visible) continue
      projected.copy(point).project(camera)
      const x = (projected.x + 1) * width / 2
      const y = (1 - projected.y) * height / 2
      element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
    }
    frame = 0
    if (flight) requestDraw()
  }

  function resize() {
    width = Math.max(1, viewport.clientWidth)
    height = Math.max(1, viewport.clientHeight)
    camera.aspect = width / height
    camera.zoom = Math.min(1, camera.aspect)
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    requestDraw()
  }
  function focus(coordinates = home, resetZoom = false) {
    const from = new Spherical().setFromVector3(camera.position)
    const to = new Spherical().setFromVector3(surfacePoint(coordinates)).makeSafe()
    to.radius = resetZoom ? homeDistance : from.radius
    // Select the short route even when crossing ±180°.
    to.theta = from.theta + Math.atan2(Math.sin(to.theta - from.theta), Math.cos(to.theta - from.theta))
    if (initialView || motion.matches) {
      flight = null
      camera.position.setFromSpherical(to)
      controls.update()
    } else {
      flight = { from, to, start: performance.now() }
    }
    initialView = false
    requestDraw()
  }
  function stopFlight() { flight = null }
  function onKey(event: KeyboardEvent) {
    if (event.target !== viewport || event.altKey || event.ctrlKey || event.metaKey) return
    const step = Math.PI / 12
    switch (event.key) {
      case 'ArrowLeft': controls.rotateLeft(step); break
      case 'ArrowRight': controls.rotateLeft(-step); break
      case 'ArrowUp': controls.rotateUp(step); break
      case 'ArrowDown': controls.rotateUp(-step); break
      default: return
    }
    stopFlight()
    event.preventDefault()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(viewport)
  controls.addEventListener('change', requestDraw)
  controls.addEventListener('start', stopFlight)
  viewport.addEventListener('keydown', onKey)
  canvas.addEventListener('webglcontextlost', onLost)
  resize()

  return {
    focus,
    zoom(inward: boolean) {
      stopFlight()
      if (inward) controls.dollyIn(0.83)
      else controls.dollyOut(0.83)
    },
    setMarkers(entries: { coordinates: Coordinates; element: HTMLElement }[]) {
      markers = entries.map(({ coordinates, element }) => ({ point: surfacePoint(coordinates), element }))
      requestDraw()
    },
    refreshTheme() { repaint = true; requestDraw() },
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('keydown', onKey)
      canvas.removeEventListener('webglcontextlost', onLost)
      controls.removeEventListener('change', requestDraw)
      controls.removeEventListener('start', stopFlight)
      controls.dispose()
      geometry.dispose()
      material.dispose()
      earth.texture.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
