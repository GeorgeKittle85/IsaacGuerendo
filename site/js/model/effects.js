// FlightGear effects on aircraft models (Effects/*.eff and the aircraft's
// own .eff files, packaged by tools/build_model.py).
//
// Most effects only refine how a surface is shaded (glass reflections,
// light maps) and keep the standard material here.  Procedural lights
// (Effects/procedural-light: nav lights, strobes, beacon, cabin lights) are
// real geometry that FlightGear draws with Shaders/light-ALS.{vert,frag};
// that shader is ported below, so they appear as glowing points rather than
// white panels.

import * as THREE from "three";
import { sceneryUniforms } from "../scene/materials.js";

/** Walks an effect's inherits-from chain: [key, parent, ...]. */
export function effectChain(effects, key) {
  const chain = [];
  for (let k = key; k && effects[k] && !chain.includes(k); k = effects[k].parent) chain.push(k);
  return chain;
}

/** Parameters with children overriding parents. */
export function effectParameters(effects, key) {
  const out = {};
  for (const k of effectChain(effects, key).reverse()) Object.assign(out, effects[k].parameters);
  return out;
}

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vVertex;
  varying vec3 vRelPos;
  varying float vDist;
  void main() {
    // light-ALS.vert: turn the light's disc to face the viewer.
    mat4 invMV = inverse(modelViewMatrix);
    vec3 ep = (invMV * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 l = (invMV * vec4(0.0, 0.0, 1.0, 1.0)).xyz;
    vec3 u = normalize(ep - l);
    vec3 r = normalize(vec3(-u.y, u.x, 0.0) + vec3(1e-6, 0.0, 0.0));
    vec3 w = cross(u, r);
    vVertex = position;
    vRelPos = position - ep;
    vec3 p = position.x * u + position.y * r + position.z * w;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 colorBase;
  uniform vec3 colorCenter;
  uniform float intensityScale;
  uniform vec3 pointing;
  uniform bool isDirectional;
  uniform bool isStrobe;
  uniform float innerAngle;
  uniform float outerAngle;
  uniform float zeroAngle;
  uniform float outerGain;
  uniform float time;
  uniform float fogDensity;
  uniform float sunElevation;
  varying vec3 vVertex;
  varying vec3 vRelPos;
  varying float vDist;

  float shape(vec3 coord, float fade, float transmission, float glare, float lightArg) {
    float r = length(coord) / max(fade, 0.2);
    float sinphi = normalize(coord.yz + vec2(1e-6)).y;
    float sinterm = sin(mod((sinphi - 3.0) * (sinphi - 3.0), 6.2832));
    float s2 = sinterm * sinterm;
    float ray = s2 * s2 * s2 * s2 * s2;
    ray *= exp(-40.0 * r * r) * smoothstep(0.8, 1.0, fade) * smoothstep(0.7, 1.0, glare);
    float base = exp(-80.0 * r * r);
    float halo = 0.2 * exp(-10.0 * r * r) * (1.0 - smoothstep(-5.0, 0.0, lightArg));
    float fogEffect = 1.0 - smoothstep(0.4, 0.8, transmission);
    float intensity = clamp(base + halo + ray, 0.0, 1.0) + 0.2 * fogEffect * (1.0 - smoothstep(0.3, 0.6, r));
    return intensity * fade;
  }

  float directionalFade(float direction) {
    float ia = 1.0 - innerAngle;
    float oa = 1.0 - outerAngle;
    float za = 1.0 - zeroAngle;
    if (direction > ia) return 1.0;
    if (direction > oa) return outerGain + (1.0 - outerGain) * (direction - oa) / (ia - oa);
    if (direction > za) return outerGain * (direction - za) / (oa - za);
    return 0.0;
  }

  float strobeFade(float fade) {
    float a1 = sin(4.0 * time);
    float a2 = sin(4.0 * time - 0.4);
    return fade * 0.825 * (pow(a1, 40.0) + pow(a2, 8.0));
  }

  void main() {
    #include <logdepthbuf_fragment>
    float transmission = exp(-pow(fogDensity * vDist, 2.0));
    // FlightGear's terminator distance / 100 km is about 1.1 x the sun's elevation in degrees.
    float lightArg = 1.1 * sunElevation;
    float direction = dot(normalize(vRelPos), normalize(pointing));
    float fade = isDirectional ? directionalFade(direction) : 1.0;
    if (isStrobe) fade = strobeFade(fade);
    fade *= intensityScale;
    float glare = length(colorCenter) / 1.7321 * (1.0 - smoothstep(-5.0, 10.0, lightArg));
    float intensity = shape(vVertex, fade, transmission, glare, lightArg);
    vec3 color = mix(colorBase, colorCenter, intensity * intensity);
    gl_FragColor = vec4(color, intensity * transmission);
  }
`;

/**
 * A material for one procedural light.  `intensity` is updated by the
 * caller when the effect's intensity_scale comes from a property.
 */
export function proceduralLightMaterial(params) {
  const num = (k, d) => (typeof params[k] === "number" ? params[k] : d);
  const bool = (k) => params[k] === true || params[k] === 1 || params[k] === "true";
  return new THREE.ShaderMaterial({
    name: "procedural-light",
    uniforms: {
      colorBase: { value: new THREE.Vector3(num("light_color_base_r", 1), num("light_color_base_g", 0), num("light_color_base_b", 0)) },
      colorCenter: { value: new THREE.Vector3(num("light_color_center_r", 1), num("light_color_center_g", 1), num("light_color_center_b", 1)) },
      intensityScale: { value: num("intensity_scale", 1) },
      pointing: { value: new THREE.Vector3(num("pointing_x", -1), num("pointing_y", 0), num("pointing_z", 0)) },
      isDirectional: { value: bool("is_directional") },
      isStrobe: { value: bool("is_strobe") },
      innerAngle: { value: num("inner_angle", 0.2) },
      outerAngle: { value: num("outer_angle", 0.4) },
      zeroAngle: { value: num("zero_angle", 0.7) },
      outerGain: { value: num("outer_gain", 0.5) },
      time: sceneryUniforms.time,
      fogDensity: sceneryUniforms.fogDensity,
      sunElevation: sceneryUniforms.sunElevation,
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
