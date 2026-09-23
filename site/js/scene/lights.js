// Airport lighting from the scenery tiles' light groups (BTG point lights).
//
// Each FlightGear light material (RWY_WHITE_LIGHTS, RWY_BLUE_TAXIWAY_LIGHTS,
// ...) becomes a point cloud drawn with a small shader: directional lights
// only shine toward their normal, VASI/PAPI boxes switch between white and
// red with the viewer's approach angle, REILs strobe, the approach
// "rabbit" sequences and runway guard lights wig-wag.

import * as THREE from "three";
import { sceneryUniforms } from "./materials.js";

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float night;
  uniform float time;
  uniform float pixelRatio;
  uniform float fogDensity;
  uniform float intensity;
  uniform int mode;
  uniform float count;
  uniform vec3 color;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * wp;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    float dist = length(mv.xyz);
    vec3 toCam = normalize(cameraPosition - wp.xyz);
    vec3 up = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
    float directional = 1.0;
    vec3 c = color;
    if (dot(normal, normal) > 0.01) {
      vec3 n = normalize(mat3(modelMatrix) * normal);
      if (mode == 1) {
        // VASI/PAPI: white above the box's glide-path angle, red below.
        float horizontal = length(n - up * dot(n, up));
        float nAngle = atan(dot(n, up), horizontal);
        vec3 flat = normalize(n - up * dot(n, up));
        float facing = dot(toCam - up * dot(toCam, up), flat);
        float vAngle = atan(dot(toCam, up), max(facing, 1e-4));
        c = vAngle > nAngle ? vec3(1.0, 1.0, 0.95) : vec3(1.0, 0.15, 0.1);
        directional = smoothstep(0.0, 0.2, facing);
      } else {
        directional = smoothstep(-0.02, 0.25, dot(n, toCam));
      }
    }
    float on = 1.0;
    float id = float(gl_VertexID);
    if (mode == 2) on = step(fract(time * 2.0 - id / max(count, 1.0)), 0.12);          // sequenced "rabbit"
    else if (mode == 3) on = step(fract(time * 1.1), 0.08);                              // REIL strobe
    else if (mode == 4) on = 0.5 + 0.5 * sin(time * 6.2832);                             // pulse
    else if (mode == 5) on = step(0.5, fract(time + 0.5 * mod(id, 2.0)));                // wig-wag
    float fog = exp(-pow(fogDensity * dist * 0.55, 2.0));
    float day = 0.18 + 0.82 * night;
    vAlpha = intensity * directional * on * fog * day;
    vColor = c;
    float size = clamp(900.0 / max(dist, 1.0), 1.6, 9.0) * (0.6 + 0.4 * night);
    gl_PointSize = size * pixelRatio;
    if (vAlpha < 0.003) gl_PointSize = 0.0;
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) discard;
    float core = exp(-r * 4.0);
    gl_FragColor = vec4(vColor * vAlpha * (core * 1.6 + 0.15), 1.0);
    #include <colorspace_fragment>
  }
`;

const MODES = {
  RWY_VASI_LIGHTS: 1,
  RWY_SEQUENCED_LIGHTS: 2,
  RWY_REIL_LIGHTS: 3,
  RWY_YELLOW_PULSE_LIGHTS: 4,
  RWY_GUARD_LIGHTS: 5,
};

export class AirportLights {
  constructor(renderer) {
    this.renderer = renderer;
    this.materials = new Map();
    this.time = { value: 0 };
  }

  material(def, count) {
    const mode = MODES[def.name] ?? 0;
    const key = mode === 2 ? `${def.name}:${count}` : def.name;
    let m = this.materials.get(key);
    if (m) return m;
    const e = def.emissive ?? [1, 1, 1, 1];
    m = new THREE.ShaderMaterial({
      name: def.name,
      uniforms: {
        night: sceneryUniforms.night,
        fogDensity: sceneryUniforms.fogDensity,
        time: this.time,
        pixelRatio: { value: this.renderer.getPixelRatio() },
        intensity: { value: 0.6 + 0.8 * (e[3] ?? 1) },
        mode: { value: mode },
        count: { value: count },
        color: { value: new THREE.Color().setRGB(e[0], e[1], e[2], THREE.SRGBColorSpace) },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.materials.set(key, m);
    return m;
  }

  /** SceneryManager.lightFactory: tile light groups -> THREE.Group. */
  build(lights, manager) {
    const group = new THREE.Group();
    group.name = "lights";
    for (const L of lights) {
      const def = manager.materialDefs[L.material];
      if (!def) continue;
      const n = L.pos.length / 3;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(L.pos, 3));
      // int8 x4 normals (w unused), normalised to [-1, 1].
      const nrm = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        nrm[i * 3] = L.nrm[i * 4] / 127;
        nrm[i * 3 + 1] = L.nrm[i * 4 + 1] / 127;
        nrm[i * 3 + 2] = L.nrm[i * 4 + 2] / 127;
      }
      geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
      geo.computeBoundingSphere();
      const pts = new THREE.Points(geo, this.material(def, n));
      pts.renderOrder = 5;
      group.add(pts);
    }
    return group;
  }

  update(t) {
    this.time.value = t;
  }
}
