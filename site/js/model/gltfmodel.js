// Aircraft models in glTF (converted from Blender by tools/build_gltf_model.py),
// animated from the flight model's properties the way FlightGear's model
// animations are, but through the model's own armature:
//
//   - "clip" parts play one of the model's actions to a point in time, e.g.
//     the gear retraction follows the gear position;
//   - "bones" rotate a bone about an axis taken from a pose in one of the
//     model's actions (the pose at `frame`), scaled by a property value, so a
//     demo animation that shows a surface at one deflection is enough to
//     drive it both ways;
//   - "shift" parts move a bone along a direction in model axes, e.g. a
//     wheel riding up its strut as the gear compresses;
//   - "spin" parts turn wheels by the distance rolled.
//
// The model is placed in FlightGear's model axes (x aft, y right, z up, metres)
// with the scale and offset in the aircraft definition.

import * as THREE from "three";
import { GLTFLoader } from "../../vendor/addons/loaders/GLTFLoader.js";

const FPS = 30; // Blender's scene frame rate; glTF keys are at frame / FPS
// three.js names nodes the way animation tracks refer to them ("Roll L" -> "Roll_L").
const nodeName = (name) => THREE.PropertyBinding.sanitizeNodeName(name);

/** Values of a clip's track at the key closest to `time`. */
function trackValue(track, time) {
  const times = track.times;
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - time) < Math.abs(times[best] - time)) best = i;
  const n = track.getValueSize();
  return Array.from(track.values.slice(best * n, best * n + n));
}

/** Drops the tracks of a clip that never change (other bones held at rest). */
function movingTracks(clip) {
  const tracks = clip.tracks.filter((t) => {
    const n = t.getValueSize();
    const v = t.values;
    for (let i = n; i < v.length; i++) if (Math.abs(v[i] - v[i % n]) > 1e-5) return true;
    return false;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

export class GLTFAircraftModel {
  /**
   * gltf: GLTFLoader result; def: the aircraft definition's `model` entry;
   * props: the property tree.
   */
  constructor(gltf, def, props) {
    this.props = props;
    this.def = def;
    this.root = new THREE.Group();
    this.root.name = def.name ?? "aircraft";
    this.pickMeshes = [];

    const scene = gltf.scene;
    // glTF axes (x left, y up, z forward for this model) -> model axes.
    const s = def.scale;
    const [dx, dy, dz] = def.offset;
    const m = new THREE.Matrix4().set(
      0, 0, -s, dx,
      -s, 0, 0, dy,
      0, s, 0, dz,
      0, 0, 0, 1,
    );
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(m);
    holder.add(scene);
    this.root.add(holder);

    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false; // skinned bounds do not follow the bones
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) def.material?.(mat);
    });

    this.bones = new Map();
    scene.traverse((o) => { if (o.isBone) this.bones.set(o.name, o); });
    const clips = new Map(gltf.animations.map((c) => [c.name, c]));
    this.mixer = new THREE.AnimationMixer(scene);

    this.clips = (def.clips ?? []).map((c) => {
      const clip = clips.get(c.clip);
      if (!clip) throw new Error(`animation ${c.clip} missing from the model`);
      const action = this.mixer.clipAction(movingTracks(clip));
      action.play();
      action.paused = true;
      const t0 = (c.from ?? 1) / FPS, t1 = (c.to ?? clip.duration * FPS) / FPS;
      return { ...c, action, t0, t1 };
    });

    const q = new THREE.Quaternion();
    this.boneAnims = [];
    for (const b of def.bones ?? []) {
      const bone = this.bones.get(nodeName(b.bone));
      if (!bone) continue;
      const rest = bone.quaternion.clone();
      let axis, angle;
      if (b.clip) {
        // The pose at `frame` relative to the rest pose, as an axis and angle.
        const track = clips.get(b.clip)?.tracks.find((t) => t.name === `${bone.name}.quaternion`);
        if (!track) continue;
        const delta = rest.clone().invert().multiply(q.fromArray(trackValue(track, b.frame / FPS)));
        if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
        angle = 2 * Math.acos(Math.min(1, delta.w));
        const sn = Math.sqrt(Math.max(1e-12, 1 - delta.w * delta.w));
        axis = new THREE.Vector3(delta.x / sn, delta.y / sn, delta.z / sn);
      } else {
        axis = new THREE.Vector3(...b.axis);
        angle = 1;
      }
      this.boneAnims.push({ ...b, node: bone, rest, axis, angle });
    }

    // Shifts: the model-axes direction (metres) in the bone's parent space.
    this.root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    this.shifts = [];
    for (const sh of def.shift ?? []) {
      const node = this.bones.get(nodeName(sh.bone));
      if (!node) continue;
      const parent = new THREE.Matrix4().multiplyMatrices(rootInv, node.parent.matrixWorld);
      const dir = new THREE.Vector3(...sh.dir).applyMatrix3(new THREE.Matrix3().setFromMatrix4(parent).invert());
      this.shifts.push({ ...sh, node, dir, base: node.position.clone() });
    }

    this.spins = [];
    for (const w of def.spin ?? []) {
      const node = this.bones.get(nodeName(w.bone));
      if (node) this.spins.push({ ...w, node, axis: new THREE.Vector3(...w.axis), base: node.quaternion.clone(), angle: 0 });
    }
    this.extras = def.extras?.(this.root, props) ?? [];
    this.tmpQ = new THREE.Quaternion();
  }

  static async load(url, def, props) {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new GLTFAircraftModel(gltf, def, props);
  }

  update(dt, camera) {
    const p = this.props;
    // Clips: property value 0..1 -> a time between the clip's `from` and `to`.
    for (const c of this.clips) {
      const v = Math.max(0, Math.min(1, c.value(p)));
      c.action.time = c.t0 + (c.t1 - c.t0) * v;
    }
    // Shifted and spinning bones start each frame from the pose the clips
    // last gave them (their rest pose if no clip moves them).  The mixer
    // writes a bone only when the clip's value changes, so going back to
    // the rest pose here would leave a retracted gear's wheels hanging down
    // once the gear stops moving.
    for (const sh of this.shifts) sh.node.position.copy(sh.base);
    for (const w of this.spins) w.node.quaternion.copy(w.base);
    this.mixer.update(0);
    for (const sh of this.shifts) sh.base.copy(sh.node.position);
    for (const w of this.spins) w.base.copy(w.node.quaternion);
    const tq = this.tmpQ;
    for (const b of this.boneAnims) {
      tq.setFromAxisAngle(b.axis, b.angle * b.value(p));
      b.node.quaternion.copy(b.rest).multiply(tq);
    }
    for (const sh of this.shifts) {
      const v = sh.value(p);
      if (Number.isFinite(v)) sh.node.position.addScaledVector(sh.dir, v);
    }
    for (const w of this.spins) {
      // Rollspeed is in m/s at the tyre.
      const speed = w.speed(p);
      if (Number.isFinite(speed)) w.angle = (w.angle + (dt * speed) / w.radius) % (2 * Math.PI);
      tq.setFromAxisAngle(w.axis, w.angle * (w.sign ?? 1));
      w.node.quaternion.multiply(tq);
    }
    for (const e of this.extras) e.update?.(dt, camera);
  }
}
