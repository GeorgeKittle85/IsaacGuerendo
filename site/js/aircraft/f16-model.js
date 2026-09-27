// The F-16's 3D model (F-16_EXP_animated.blend, converted to glTF by
// tools/build_gltf_model.py) and how the flight model drives it.
//
// The Blender model is about 1.8 times life size, nose along -Y, left wing
// along +X.  It is scaled to the F-16's real 15.06 m length and placed so its
// wheels sit on JSBSim's gear contact points (f16.xml, relative to the VRP).
//
// Its armature has two actions: "Gear_Cycle" (frame 1 gear down, frame 91
// gear up, doors included) and "ControlSurfaces_Demo", which shows each
// surface at one deflection; the frames below pick those poses:
//   flaperons (Roll L/R) trailing edge down 15° at frame 100,
//   stabilators (Pitch L/R) trailing edge down 18° at frame 20,
//   rudder (Yaw) trailing edge right 20° at frame 140,
//   speed brakes (Brake Top/Bottom) open 35° at frame 260,
//   canopy open 40° at frame 300.

import * as THREE from "three";

const D2R = Math.PI / 180;
const SCALE = 0.544; // 15.06 m / 27.68 m
// Nozzle exit in model axes (Blender y 12.11, z -0.605, scaled and offset).
const OFFSET = [-0.46, 0, 0.54];
const NOZZLE = [12.11 * SCALE + OFFSET[0], 0, -0.605 * SCALE + OFFSET[2]];

/** Paint and glass tweaks for the glTF's PBR materials. */
function material(mat) {
  // No environment map in this renderer: keep metals from turning black.
  mat.metalness = Math.min(mat.metalness, 0.35);
  if (mat.name === "Canopy" || mat.name === "Window") {
    mat.transparent = true;
    mat.opacity = 0.22;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.roughness = 0.05;
  }
}

/** Afterburner plume: nested additive cones behind the nozzle. */
function afterburner(root, props) {
  const group = new THREE.Group();
  group.name = "afterburner";
  group.position.set(...NOZZLE);
  const uniforms = { level: { value: 0 }, time: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      varying float vAlong;
      varying float vEdge;
      void main() {
        vAlong = 1.0 - uv.y;         // 1 at the nozzle, 0 at the tip
        vEdge = abs(normal.y) + abs(normal.z);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float level;
      uniform float time;
      varying float vAlong;
      varying float vEdge;
      void main() {
        float a = vAlong;
        // Shock diamonds: bright bands close behind the nozzle.
        float diamonds = 0.55 + 0.45 * cos((1.0 - a) * 34.0 - time * 3.0);
        vec3 core = vec3(0.75, 0.8, 1.0);
        vec3 outer = vec3(1.0, 0.45, 0.12);
        vec3 col = mix(outer, core, smoothstep(0.55, 1.0, a) * diamonds);
        float alpha = level * pow(a, 1.6) * (0.55 + 0.45 * diamonds) * (0.35 + 0.65 * vEdge);
        gl_FragColor = vec4(col * alpha, alpha);
      }`,
  });
  const cones = [[0.42, 5.5], [0.3, 3.8], [0.18, 2.4]].map(([r, h]) => {
    // Cone along +x (aft): the tip at x = h, the base at the nozzle.
    const geo = new THREE.ConeGeometry(r, h, 24, 1, true);
    geo.rotateZ(-Math.PI / 2);
    geo.translate(h / 2, 0, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    group.add(mesh);
    return { mesh, h };
  });
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({
    color: 0xffa050, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  group.add(glow);
  root.add(group);
  let t = 0;
  return [{
    update(dt) {
      t += dt;
      // JSBSim's afterburner: throttle position 1..2 above full dry thrust.
      const ab = props.getBool("/engines/engine[0]/augmentation")
        ? Math.min(1, Math.max(0, props.get("fcs/throttle-pos-norm") - 1)) : 0;
      const level = ab > 0 ? 0.45 + 0.55 * ab : 0;
      group.visible = level > 0;
      uniforms.level.value = level * (0.93 + 0.07 * Math.sin(t * 40));
      uniforms.time.value = t;
      for (const c of cones) c.mesh.scale.set(0.7 + 0.3 * ab, 1, 1);
      glow.material.opacity = 0.6 * level;
    },
  }];
}

const g = (p, path) => p.get(path);

export const F16_MODEL = {
  name: "F-16",
  url: "data/aircraft/f16/model/f16.glb",
  scale: SCALE,
  offset: OFFSET,
  material,
  clips: [
    // Gear position 1 (down) is frame 1, 0 (up) is frame 91.
    { clip: "Gear_Cycle", from: 1, to: 91, value: (p) => 1 - g(p, "/gear/gear[0]/position-norm") },
  ],
  bones: [
    // Flaperons: roll (JSBSim's aileron deflection, rad) plus the automatic
    // trailing edge flap (tef-control 1 = 20°), trailing edge down positive.
    { bone: "Roll L", clip: "ControlSurfaces_Demo", frame: 100,
      value: (p) => (g(p, "fcs/left-aileron-pos-rad") + 0.349 * g(p, "fcs/tef-control")) / (15 * D2R) },
    { bone: "Roll R", clip: "ControlSurfaces_Demo", frame: 100,
      value: (p) => (g(p, "fcs/right-aileron-pos-rad") + 0.349 * g(p, "fcs/tef-control")) / (15 * D2R) },
    // Stabilators: pitch plus differential roll (JSBSim's dht-*-pos-rad; the
    // left one is signed the other way).
    { bone: "Pitch L", clip: "ControlSurfaces_Demo", frame: 20, value: (p) => -g(p, "fcs/dht-left-pos-rad") / (18 * D2R) },
    { bone: "Pitch R", clip: "ControlSurfaces_Demo", frame: 20, value: (p) => g(p, "fcs/dht-right-pos-rad") / (18 * D2R) },
    // Rudder: FlightGear's surface position, +1 = trailing edge right = 30°.
    { bone: "Yaw", clip: "ControlSurfaces_Demo", frame: 140, value: (p) => (g(p, "/surface-positions/rudder-pos-norm") * 30) / 20 },
    { bone: "Brake Top", clip: "ControlSurfaces_Demo", frame: 260, value: (p) => g(p, "fcs/speedbrake-pos-deg") / 35 },
    { bone: "Brake Bottom", clip: "ControlSurfaces_Demo", frame: 260, value: (p) => g(p, "fcs/speedbrake-pos-deg") / 35 },
    { bone: "Canopy", clip: "ControlSurfaces_Demo", frame: 300, value: (p) => g(p, "fcs/canopy-pos-norm") },
    // Leading edge flaps (no demo pose): droop about the hinge, the bone's y axis.
    { bone: "Front Flaps L", axis: [0, 1, 0], value: (p) => g(p, "fcs/lef-pos-deg") * D2R },
    { bone: "Front Flaps R", axis: [0, 1, 0], value: (p) => -g(p, "fcs/lef-pos-deg") * D2R },
  ],
  spin: [
    // Main wheels: the bones' y axes are the axles (pointing outboard).
    { bone: "Wheel L", axis: [0, 1, 0], sign: 1, radius: 0.31, speed: (p) => g(p, "/gear/gear[1]/rollspeed-ms") },
    { bone: "Wheel R", axis: [0, 1, 0], sign: -1, radius: 0.31, speed: (p) => g(p, "/gear/gear[2]/rollspeed-ms") },
    // Nose wheel: bone "G", axle along its z axis.
    { bone: "G", axis: [0, 0, 1], sign: 1, radius: 0.22, speed: (p) => g(p, "/gear/gear[0]/rollspeed-ms") },
  ],
  extras: afterburner,
};
