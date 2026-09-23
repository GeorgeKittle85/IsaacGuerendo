// Scenery materials: FlightGear material definitions (Materials/regions/*.xml)
// rendered with small custom shaders.  Land cover gets texture coordinates
// from world position using FlightGear's xsize/ysize (metres per texture
// repeat); runways and markings use the BTG texture coordinates.

import * as THREE from "three";

/** Shared lighting/atmosphere state, updated once per frame by the sky. */
export const sceneryUniforms = {
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  sunColor: { value: new THREE.Color(1, 1, 1) },
  ambientColor: { value: new THREE.Color(0.35, 0.38, 0.45) },
  fogColor: { value: new THREE.Color(0.7, 0.78, 0.88) },
  fogDensity: { value: 0.00004 },
  night: { value: 0 },
  time: { value: 0 },
  glowColor: { value: new THREE.Color(0, 0, 0) },
  upDir: { value: new THREE.Vector3(0, 1, 0) },
};

const COMMON_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying float vDist;
`;

const COMMON_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform vec3 ambientColor;
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform float night;
  uniform vec3 glowColor;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying float vDist;

  // Haze colour toward a view direction: the sky's horizon colour plus the
  // sun's forward-scattering glow (matches sky.js at the horizon).
  vec3 hazeColor(vec3 viewDir) {
    float c = max(dot(viewDir, sunDir), 0.0);
    return fogColor + glowColor * (pow(c, 6.0) + 0.8 * pow(c, 80.0));
  }

  vec3 applyFog(vec3 col) {
    float f = 1.0 - exp(-fogDensity * fogDensity * vDist * vDist);
    return mix(col, hazeColor(normalize(vWorldPos - cameraPosition)), clamp(f, 0.0, 1.0));
  }
`;

const VERTEX = /* glsl */ `
  ${COMMON_VERTEX}
  uniform vec2 texScale;
  uniform float lift;
  varying vec2 vUv;
  varying vec2 vUv2;
  void main() {
    // Painted lines lie on the pavement; lift them a few centimetres (the
    // logarithmic depth buffer ignores polygon offset).
    vec3 p = position + normal * lift;
    vec4 worldPos = modelMatrix * vec4(p, 1.0);
    vWorldPos = worldPos.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    #ifdef USE_UV_ATTR
      vUv = uv;
    #else
      // east/north metres -> texture repeats; a second, rotated lookup at a
      // larger scale breaks up visible tiling like FlightGear's overlays.
      vec2 en = vec2(worldPos.x, -worldPos.z);
      vUv = en * texScale;
      vUv2 = mat2(0.8, -0.6, 0.6, 0.8) * en * texScale * 0.23;
    #endif
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    vDist = length(mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

const TERRAIN_FRAGMENT = /* glsl */ `
  ${COMMON_FRAGMENT}
  uniform sampler2D map;
  uniform float hasMap;
  uniform vec3 tint;
  uniform vec3 emissive;
  uniform float alphaTest;
  uniform float specular;
  varying vec2 vUv;
  varying vec2 vUv2;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 tex = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0);
    #ifndef USE_UV_ATTR
      vec4 tex2 = hasMap > 0.5 ? texture2D(map, vUv2) : vec4(1.0);
      tex.rgb = mix(tex.rgb, tex2.rgb, 0.35) * (0.9 + 0.2 * tex2.g);
    #endif
    if (tex.a < alphaTest) discard;
    vec3 n = normalize(vNormalW);
    float ndl = max(dot(n, sunDir), 0.0);
    vec3 light = ambientColor + sunColor * ndl;
    vec3 col = tex.rgb * tint * light;
    if (specular > 0.0) {
      vec3 v = normalize(cameraPosition - vWorldPos);
      vec3 h = normalize(v + sunDir);
      col += sunColor * specular * pow(max(dot(n, h), 0.0), 24.0);
    }
    // City lights: FlightGear's emissive colour, only after dusk.
    col += emissive * night * 4.0;
    gl_FragColor = vec4(applyFog(col), tex.a);
    #include <colorspace_fragment>
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  ${COMMON_FRAGMENT}
  uniform sampler2D map;
  uniform float hasMap;
  uniform float time;
  uniform vec3 deepColor;
  varying vec2 vUv;
  varying vec2 vUv2;

  float wave(vec2 p, vec2 dir, float k, float speed) {
    return sin(dot(p, dir) * k + time * speed);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vec2(vWorldPos.x, -vWorldPos.z);
    // Procedural ripples: a few travelling sine waves perturb the normal.
    float dx = 0.0, dy = 0.0;
    vec2 dirs[4];
    dirs[0] = normalize(vec2(1.0, 0.3)); dirs[1] = normalize(vec2(-0.4, 1.0));
    dirs[2] = normalize(vec2(0.7, -0.8)); dirs[3] = normalize(vec2(-1.0, -0.2));
    float ks[4];
    ks[0] = 0.21; ks[1] = 0.37; ks[2] = 0.83; ks[3] = 1.7;
    for (int i = 0; i < 4; i++) {
      float c = cos(dot(p, dirs[i]) * ks[i] + time * (0.6 + 0.35 * float(i)));
      dx += dirs[i].x * c * 0.06 / (1.0 + float(i));
      dy += dirs[i].y * c * 0.06 / (1.0 + float(i));
    }
    vec3 nUp = normalize(vNormalW);
    vec3 east = normalize(cross(vec3(0.0, 0.0, -1.0), nUp) + vec3(1e-4, 0.0, 0.0));
    vec3 north = normalize(cross(nUp, east));
    vec3 n = normalize(nUp - east * dx - north * dy);
    vec3 v = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
    vec3 tex = hasMap > 0.5 ? texture2D(map, vUv).rgb : vec3(0.3, 0.4, 0.45);
    vec3 base = mix(deepColor, tex * 0.6, 0.35) * (ambientColor + sunColor * max(dot(nUp, sunDir), 0.0));
    vec3 sky = fogColor;
    vec3 col = mix(base, sky, clamp(0.15 + fres * 0.85, 0.0, 1.0));
    vec3 h = normalize(v + sunDir);
    col += sunColor * pow(max(dot(n, h), 0.0), 180.0) * 1.5;
    gl_FragColor = vec4(applyFog(col), 1.0);
    #include <colorspace_fragment>
  }
`;

function baseUniforms() {
  return {
    sunDir: sceneryUniforms.sunDir,
    sunColor: sceneryUniforms.sunColor,
    ambientColor: sceneryUniforms.ambientColor,
    fogColor: sceneryUniforms.fogColor,
    fogDensity: sceneryUniforms.fogDensity,
    night: sceneryUniforms.night,
    time: sceneryUniforms.time,
    glowColor: sceneryUniforms.glowColor,
  };
}

const linear = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

/** Builds the material for one FlightGear material definition. */
export function createMaterial(def, texture, hasUv) {
  const uniforms = {
    ...baseUniforms(),
    map: { value: texture },
    hasMap: { value: texture ? 1 : 0 },
    texScale: { value: new THREE.Vector2(1 / (def.xsize || 1000), 1 / (def.ysize || 1000)) },
    lift: { value: def.kind === "marking" ? 0.06 : 0 },
  };
  const defines = hasUv ? { USE_UV_ATTR: "" } : {};
  if (def.kind === "water") {
    uniforms.deepColor = { value: new THREE.Color(0.02, 0.07, 0.1) };
    return new THREE.ShaderMaterial({
      name: def.name, uniforms, defines, vertexShader: VERTEX, fragmentShader: WATER_FRAGMENT,
    });
  }
  const d = def.diffuse ?? [0.8, 0.8, 0.8];
  const e = def.emissive ?? [0, 0, 0];
  uniforms.tint = { value: new THREE.Color(d[0] / 0.8, d[1] / 0.8, d[2] / 0.8) };
  uniforms.emissive = { value: linear(e) };
  uniforms.alphaTest = { value: def.kind === "marking" ? 0.3 : 0.0 };
  uniforms.specular = { value: def.kind === "runway" ? 0.08 : 0.0 };
  return new THREE.ShaderMaterial({
    name: def.name, uniforms, defines, vertexShader: VERTEX, fragmentShader: TERRAIN_FRAGMENT,
  });
}
