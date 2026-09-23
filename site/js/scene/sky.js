// Sky, sun, stars and fog.
//
// The sun and stars are placed from the real date and time (the Sun from the
// usual low-precision solar ephemeris, the stars from FlightGear's own
// Astro/stars catalogue, the Yale Bright Star Catalogue).  Sky and haze
// colours follow the sun's elevation; the same colours feed the scenery
// shaders' fog so distant terrain melts into the horizon.

import * as THREE from "three";
import { sceneryUniforms } from "./materials.js";
import { enuBasis } from "./geo.js";

const D2R = Math.PI / 180;

/** Julian day number of a JS Date. */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Greenwich mean sidereal time in degrees. */
export function gmstDeg(date) {
  const n = julianDay(date) - 2451545.0;
  return (((280.46061837 + 360.98564736629 * n) % 360) + 360) % 360;
}

/** Unit vector to the Sun in ECEF (low-precision ephemeris, ~0.01°). */
export function sunEcef(date) {
  const n = julianDay(date) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * D2R;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const lon = ra - gmstDeg(date) * D2R;
  return [Math.cos(dec) * Math.cos(lon), Math.cos(dec) * Math.sin(lon), Math.sin(dec)];
}

/** Sun elevation (degrees) at a place and time. */
export function sunElevation(lat, lon, date) {
  const s = sunEcef(date);
  const u = enuBasis(lat, lon).u;
  return Math.asin(s[0] * u[0] + s[1] * u[1] + s[2] * u[2]) / D2R;
}

/**
 * UTC time (a Date on the given day) when the sun is at `elevDeg`, rising
 * (morning) or setting; FlightGear's --timeofday presets work the same way.
 */
export function timeForSun(lat, lon, day, { elevDeg, rising = true, noon = false, midnight = false }) {
  const base = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  // Local solar noon is around 12:00 - lon/15 h UTC.
  const solarNoon = base + (12 - lon / 15) * 3600e3;
  const at = (t) => sunElevation(lat, lon, new Date(t));
  if (noon || midnight) {
    let best = solarNoon + (midnight ? 12 * 3600e3 : 0);
    let bestE = at(best);
    for (let dt = -3600e3; dt <= 3600e3; dt += 60e3) {
      const e = at(solarNoon + (midnight ? 12 * 3600e3 : 0) + dt);
      if (midnight ? e < bestE : e > bestE) { bestE = e; best = solarNoon + (midnight ? 12 * 3600e3 : 0) + dt; }
    }
    return new Date(best);
  }
  // Search the half-day before (rising) or after (setting) solar noon.
  const start = rising ? solarNoon - 12 * 3600e3 : solarNoon;
  let prev = at(start);
  for (let t = start + 60e3; t <= start + 12 * 3600e3; t += 60e3) {
    const e = at(t);
    if ((rising && prev < elevDeg && e >= elevDeg) || (!rising && prev > elevDeg && e <= elevDeg)) return new Date(t);
    prev = e;
  }
  return new Date(rising ? solarNoon - 3 * 3600e3 : solarNoon + 3 * 3600e3);
}

// Linear-light colours keyed by sun elevation (degrees).
const KEYS = [
  // elev, zenith, horizon, glow, sun, ambient
  [-18, [0.0008, 0.0012, 0.003], [0.0015, 0.002, 0.004], [0, 0, 0], [0, 0, 0], [0.012, 0.014, 0.022]],
  [-8, [0.003, 0.006, 0.02], [0.012, 0.012, 0.022], [0.03, 0.012, 0.006], [0, 0, 0], [0.025, 0.027, 0.04]],
  [-3, [0.012, 0.028, 0.09], [0.16, 0.1, 0.08], [0.35, 0.13, 0.04], [0.02, 0.01, 0.005], [0.06, 0.06, 0.08]],
  [1, [0.035, 0.085, 0.26], [0.5, 0.36, 0.27], [0.9, 0.38, 0.1], [0.8, 0.42, 0.2], [0.13, 0.13, 0.16]],
  [8, [0.05, 0.14, 0.46], [0.55, 0.58, 0.66], [0.55, 0.36, 0.18], [1.1, 0.9, 0.7], [0.22, 0.24, 0.29]],
  [25, [0.04, 0.15, 0.52], [0.5, 0.61, 0.78], [0.3, 0.25, 0.19], [1.25, 1.17, 1.04], [0.28, 0.31, 0.38]],
  [90, [0.03, 0.14, 0.52], [0.45, 0.59, 0.8], [0.2, 0.18, 0.15], [1.3, 1.26, 1.18], [0.3, 0.33, 0.41]],
];

function sampleKeys(elev) {
  let i = 0;
  while (i < KEYS.length - 2 && elev > KEYS[i + 1][0]) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = Math.min(1, Math.max(0, (elev - a[0]) / (b[0] - a[0])));
  const mix = (k) => a[k].map((v, j) => v + (b[k][j] - v) * t);
  return { zenith: mix(1), horizon: mix(2), glow: mix(3), sun: mix(4), ambient: mix(5) };
}

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = (modelMatrix * vec4(position, 0.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 sunDir;
  uniform vec3 upDir;
  uniform vec3 zenithColor;
  uniform vec3 horizonColor;
  uniform vec3 glowColor;
  uniform vec3 sunColor;
  uniform vec3 groundColor;
  uniform float sunSize;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float e = dot(d, upDir);
    float c = dot(d, sunDir);
    float h = 1.0 - clamp(e, 0.0, 1.0);
    vec3 col = mix(zenithColor, horizonColor, pow(h, 4.0));
    // Forward scattering around the sun, strongest near the horizon.
    float glow = pow(max(c, 0.0), 6.0) * (0.35 + 0.65 * pow(h, 3.0)) + pow(max(c, 0.0), 80.0) * 0.8;
    col += glowColor * glow;
    // The solar disc.
    col += sunColor * 6.0 * smoothstep(1.0 - sunSize * 1.3, 1.0 - sunSize, c);
    if (e < 0.0) col = mix(col, groundColor, clamp(-e * 12.0, 0.0, 1.0));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const STAR_VERTEX = /* glsl */ `
  attribute float mag;
  uniform float visibility;
  uniform float pixelRatio;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float b = clamp((5.2 - mag) / 6.0, 0.0, 1.0);
    vAlpha = b * visibility;
    gl_PointSize = (1.0 + 2.2 * b * b) * pixelRatio;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) discard;
    gl_FragColor = vec4(vec3(0.9, 0.93, 1.0) * vAlpha * (1.0 - r), 1.0);
  }
`;

export class Sky {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.uniforms = {
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      upDir: { value: new THREE.Vector3(0, 1, 0) },
      zenithColor: { value: new THREE.Color() },
      horizonColor: { value: new THREE.Color() },
      glowColor: { value: new THREE.Color() },
      sunColor: { value: new THREE.Color() },
      groundColor: { value: new THREE.Color() },
      sunSize: { value: 0.00004 },
    };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide, depthWrite: false, depthTest: false,
      }),
    );
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    dome.name = "sky";
    this.dome = dome;
    scene.add(dome);

    this.sunLight = new THREE.DirectionalLight(0xffffff, Math.PI);
    this.sunLight.name = "sun";
    this.ambient = new THREE.AmbientLight(0xffffff, Math.PI);
    scene.add(this.sunLight, this.sunLight.target, this.ambient);
    scene.fog = new THREE.FogExp2(0xffffff, 0.00005);

    this.stars = null;
    this.visibilityM = 30000;
    this.sunElevationDeg = 45;
  }

  /** stars: [[ra, dec, mag], ...] in radians (J2000). */
  setStars(stars) {
    const pos = new Float32Array(stars.length * 3);
    const mag = new Float32Array(stars.length);
    stars.forEach(([ra, dec, m], i) => {
      // Equatorial unit vectors; rotated into ECEF by sidereal time each frame.
      pos[i * 3] = Math.cos(dec) * Math.cos(ra) * 900;
      pos[i * 3 + 1] = Math.cos(dec) * Math.sin(ra) * 900;
      pos[i * 3 + 2] = Math.sin(dec) * 900;
      mag[i] = m;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("mag", new THREE.BufferAttribute(mag, 1));
    this.starUniforms = {
      visibility: { value: 0 },
      pixelRatio: { value: this.renderer.getPixelRatio() },
    };
    const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
      // Not "transparent": opaque objects draw in renderOrder, so the stars
      // go right after the sky dome and before the terrain covers them.
      uniforms: this.starUniforms, vertexShader: STAR_VERTEX, fragmentShader: STAR_FRAGMENT,
      transparent: false, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    pts.frustumCulled = false;
    pts.renderOrder = -999;
    pts.matrixAutoUpdate = false;
    pts.name = "stars";
    this.stars = pts;
    this.scene.add(pts);
  }

  setVisibility(m) {
    this.visibilityM = Math.max(200, m);
  }

  /** Updates everything for the camera position and the given UTC date. */
  update(frame, camera, date) {
    const cam = camera.position;
    const g = frame.renderToGeodetic(cam);
    const b = enuBasis(g.lat, g.lon);
    const up = frame.dirToRender(b.u, new THREE.Vector3());
    const sun = frame.dirToRender(sunEcef(date), new THREE.Vector3()).normalize();
    const elev = Math.asin(Math.max(-1, Math.min(1, sun.dot(up)))) / D2R;
    this.sunElevationDeg = elev;
    const k = sampleKeys(elev);

    // Haze: lower visibility washes the sky out toward the horizon colour.
    const haze = Math.min(1, Math.max(0, (20000 - this.visibilityM) / 18000));
    const lin = (c, a) => new THREE.Color(c[0], c[1], c[2]).multiplyScalar(a);
    const zenith = lin(k.zenith, 1).lerp(lin(k.horizon, 0.9), haze * 0.6);
    const horizon = lin(k.horizon, 1);
    const u = this.uniforms;
    u.sunDir.value.copy(sun);
    u.upDir.value.copy(up);
    u.zenithColor.value.copy(zenith);
    u.horizonColor.value.copy(horizon);
    u.glowColor.value.copy(lin(k.glow, 1 - haze * 0.5));
    u.sunColor.value.copy(lin(k.sun, 1 - haze * 0.7));
    u.groundColor.value.copy(horizon).multiplyScalar(0.8);
    this.dome.position.copy(cam);

    // Scenery shader state.
    const su = sceneryUniforms;
    su.sunDir.value.copy(sun);
    su.sunColor.value.copy(lin(k.sun, 1 - haze * 0.3));
    su.ambientColor.value.copy(lin(k.ambient, 1));
    su.fogColor.value.copy(horizon);
    su.fogDensity.value = Math.sqrt(Math.log(100)) / this.visibilityM;
    su.night.value = Math.min(1, Math.max(0, (2 - elev) / 8));
    su.glowColor.value.copy(lin(k.glow, 1 - haze * 0.5));
    su.upDir.value.copy(up);
    su.sunElevation.value = elev;

    this.sunLight.color.copy(su.sunColor.value);
    this.sunLight.position.copy(cam).addScaledVector(sun, 1000);
    this.sunLight.target.position.copy(cam);
    this.ambient.color.copy(su.ambientColor.value);
    this.scene.fog.color.copy(horizon);
    this.scene.fog.density = su.fogDensity.value;

    if (this.stars) {
      // Celestial sphere -> ECEF (rotate by -GMST about the pole) -> render.
      const gmst = gmstDeg(date) * D2R;
      const m = new THREE.Matrix4().makeRotationZ(-gmst);
      const toRender = new THREE.Matrix4();
      const e = frame.dirToRender([1, 0, 0]), n = frame.dirToRender([0, 1, 0]), z = frame.dirToRender([0, 0, 1]);
      toRender.set(e.x, n.x, z.x, 0, e.y, n.y, z.y, 0, e.z, n.z, z.z, 0, 0, 0, 0, 1);
      this.stars.matrix.copy(toRender).multiply(m).setPosition(cam);
      this.stars.matrixWorldNeedsUpdate = true;
      this.starUniforms.visibility.value = Math.min(1, Math.max(0, (-4 - elev) / 8)) * (1 - haze);
      this.stars.visible = this.starUniforms.visibility.value > 0.01;
    }
    return { sunElevation: elev };
  }
}
