// FlightGear's standard views (defaults.xml /sim/view[n]) and the c172p's
// pilot eye point (c172p-views.xml).
//
// "lookfrom" views sit in the aircraft: view offsets are x right, y up,
// z back, relative to the model origin, rotated with the aircraft attitude.
// "lookat" views orbit a target (the aircraft) at a distance, following its
// heading and/or attitude with the damping FlightGear uses.

import * as THREE from "three";
import { aircraftMatrix, enuBasis } from "../scene/geo.js";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const VIEWS = [
  { name: "Cockpit View", type: "cockpit", fov: 73.6 },
  { name: "Helicopter View", type: "lookat", follow: "heading", distance: 25, height: 0, fov: 55 },
  { name: "Chase View", type: "lookat", follow: "attitude", distance: 25, height: 5, damping: 1.8, fov: 55 },
  { name: "Chase View Without Yaw", type: "lookat", follow: "pitchroll", distance: 25, height: 5, damping: 1.8, fov: 55 },
  { name: "Tower View", type: "tower", fov: 55 },
  { name: "Fly-By View", type: "flyby", fov: 55 },
];

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Body axes (forward, right, down) of a heading/pitch/roll, in NED. */
function bodyAxes(hDeg, pDeg, rDeg) {
  const ps = hDeg * D2R, th = pDeg * D2R, ph = rDeg * D2R;
  const cph = Math.cos(ph), sph = Math.sin(ph), cth = Math.cos(th), sth = Math.sin(th);
  const cps = Math.cos(ps), sps = Math.sin(ps);
  return {
    fwd: [cth * cps, cth * sps, -sth],
    right: [sph * sth * cps - cph * sps, sph * sth * sps + cph * cps, sph * cth],
    down: [cph * sth * cps + sph * sps, cph * sth * sps - sph * cps, cph * cth],
  };
}

export class ViewManager {
  /**
   * ctx: {frame (RenderFrame), camera, props getter, elevation(lat, lon) -> m|null,
   *       towers: [{lat, lon, altM, name}], aspect getter}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.index = 0;
    this.state = VIEWS.map((v) => ({
      hOff: 0, pOff: v.type === "cockpit" ? -12 : v.type === "lookat" && v.follow === "heading" ? 0 : 0,
      hGoal: null, fov: v.fov, distance: v.distance ?? 25, zoom: 1,
    }));
    this.cockpitEye = { x: -0.21, y: 0.273, z: 0.36, pitch: -12 };
    this.damped = null;
    this.flyby = null;
    this.tower = null;
    this.towerTimer = 0;
    this.tmp = {
      m: new THREE.Matrix4(), m2: new THREE.Matrix4(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
      s: new THREE.Vector3(), up: new THREE.Vector3(), eye: new THREE.Vector3(), target: new THREE.Vector3(),
    };
    // Model axes (x aft, y right, z up) -> camera axes (x right, y up, z back).
    this.modelToCamera = new THREE.Matrix4().set(
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    );
  }

  get view() {
    return VIEWS[this.index];
  }

  get current() {
    return this.state[this.index];
  }

  /** Reads the pilot eye point from the aircraft's /sim/view config. */
  configureCockpit(props) {
    const g = (k, d) => {
      const h = props.jsb.handle(`/sim/view/config/${k}`, false);
      return h >= 0 ? props.jsb.get(h) : d;
    };
    this.cockpitEye = {
      x: g("x-offset-m", -0.21), y: g("y-offset-m", 0.273), z: g("z-offset-m", 0.36), pitch: g("pitch-offset-deg", -12),
    };
    const fov = g("default-field-of-view-deg", 73.6);
    VIEWS[0].fov = fov;
    this.state[0].fov = fov;
    this.state[0].pOff = this.cockpitEye.pitch;
  }

  setView(i) {
    this.index = ((i % VIEWS.length) + VIEWS.length) % VIEWS.length;
    this.damped = null;
    this.flyby = null;
    this.fixedHeading = null;
    return this.view.name;
  }

  step(dir) {
    return this.setView(this.index + (dir > 0 ? 1 : -1));
  }

  reset() {
    const s = this.current;
    const v = this.view;
    s.hOff = 0;
    s.hGoal = null;
    s.pOff = v.type === "cockpit" ? this.cockpitEye.pitch : 0;
    s.fov = v.fov;
    s.distance = v.distance ?? 25;
    s.zoom = 1;
  }

  /** Mouse look / orbit, in pixels. */
  look(dx, dy) {
    const s = this.current;
    s.hGoal = null;
    const k = this.view.type === "cockpit" ? 0.15 * (s.fov / 60) : 0.3;
    s.hOff = wrap180(s.hOff - dx * k);
    s.pOff = Math.max(-89, Math.min(89, s.pOff + dy * k));
    if (this.view.type === "cockpit") s.hOff = Math.max(-140, Math.min(140, s.hOff));
  }

  /** Shift+numpad look directions: FlightGear's goal-heading-offset-deg. */
  lookDirection(deg) {
    const s = this.current;
    s.hGoal = wrap180(deg);
  }

  /** FOV zoom: FlightGear's view.increase()/decrease() step (40 steps from 1'/px to 120°). */
  zoom(dir) {
    const s = this.current;
    const min = Math.max(1, (this.ctx.width() || 1280) / 60);
    const mul = Math.exp(Math.log(120 / min) / 40);
    if (this.view.type === "tower") {
      s.zoom = Math.max(0.05, Math.min(20, s.zoom * (dir > 0 ? mul : 1 / mul)));
      return s.zoom;
    }
    s.fov = Math.max(min * 0.5, Math.min(120, dir > 0 ? s.fov * mul : s.fov / mul));
    return s.fov;
  }

  /** Mouse wheel in external views changes the distance. */
  wheel(dir) {
    const v = this.view;
    const s = this.current;
    if (v.type === "lookat") s.distance = Math.max(8, Math.min(400, s.distance * (dir > 0 ? 1.1 : 1 / 1.1)));
    else this.zoom(-dir);
  }

  resetFov() {
    this.current.fov = this.view.fov;
    this.current.zoom = 1;
  }

  /** Nearest airport tower (FlightGear's /sim/tower follows the closest airport). */
  pickTower(lat, lon) {
    let best = null;
    let bestD = Infinity;
    for (const t of this.ctx.towers ?? []) {
      const d = Math.hypot(t.lat - lat, (t.lon - lon) * Math.cos(lat * D2R));
      if (d < bestD) { bestD = d; best = t; }
    }
    this.tower = best;
  }

  /**
   * Positions the camera. ac: {lat, lon, alt (m), roll, pitch, heading (deg),
   * vN, vE, vD (m/s)}.
   */
  update(dt, ac, camera) {
    const { frame } = this.ctx;
    const v = this.view;
    const s = this.current;
    const T = this.tmp;

    if (s.hGoal !== null) {
      const d = wrap180(s.hGoal - s.hOff);
      s.hOff = Math.abs(d) < 0.5 ? s.hGoal : wrap180(s.hOff + d * Math.min(1, dt * 6));
      if (s.hOff === s.hGoal) s.hGoal = null;
    }

    let near = 0.5;
    let hfov = s.fov;

    if (v.type === "cockpit") {
      aircraftMatrix(frame, ac.lat, ac.lon, ac.alt, ac.roll, ac.pitch, ac.heading, T.m);
      const e = this.cockpitEye;
      // Leaning into the side window when looking far left/right (view limits).
      let x = e.x;
      const ah = Math.abs(s.hOff);
      if (ah > 65) x += Math.sign(s.hOff) * -0.15 * Math.min(1, (ah - 65) / 75);
      T.m2.makeTranslation(e.z, x, e.y);
      T.m.multiply(T.m2).multiply(this.modelToCamera);
      T.m2.makeRotationY(s.hOff * D2R);
      T.m.multiply(T.m2);
      T.m2.makeRotationX(s.pOff * D2R);
      T.m.multiply(T.m2);
      T.m.decompose(camera.position, camera.quaternion, T.s);
      near = 0.05;
    } else {
      frame.geodeticToRender(ac.lat, ac.lon, ac.alt, T.target);
      const b = enuBasis(ac.lat, ac.lon);
      const E = frame.dirToRender(b.e, new THREE.Vector3());
      const N = frame.dirToRender(b.n, new THREE.Vector3());
      const U = frame.dirToRender(b.u, new THREE.Vector3());
      const ned = (a) => new THREE.Vector3().addScaledVector(N, a[0]).addScaledVector(E, a[1]).addScaledVector(U, -a[2]);

      if (v.type === "lookat") {
        // Damped attitude (SimGear view damping: first-order lag at rate `damping`).
        if (!this.damped) this.damped = { h: ac.heading, p: ac.pitch, r: ac.roll };
        const k = v.damping ? 1 - Math.exp(-dt * v.damping) : 1;
        const D = this.damped;
        D.h = wrap180(D.h + wrap180(ac.heading - D.h) * k);
        D.p += (ac.pitch - D.p) * k;
        D.r += (ac.roll - D.r) * k;
        let h, p = 0, r = 0;
        if (v.follow === "heading") h = ac.heading;
        else if (v.follow === "attitude") { h = D.h; p = D.p; r = D.r; }
        else {
          if (this.fixedHeading === null || this.fixedHeading === undefined) this.fixedHeading = ac.heading;
          h = this.fixedHeading; p = D.p; r = D.r;
        }
        const ax = bodyAxes(h + s.hOff, p + s.pOff, r);
        const fwd = ned(ax.fwd), up = ned(ax.down).negate();
        T.eye.copy(T.target).addScaledVector(fwd, -s.distance).addScaledVector(up, v.height);
        T.up.copy(up);
      } else if (v.type === "tower") {
        this.towerTimer -= dt;
        if (!this.tower || this.towerTimer <= 0) {
          this.pickTower(ac.lat, ac.lon);
          this.towerTimer = 5;
        }
        const t = this.tower ?? { lat: ac.lat + 0.01, lon: ac.lon, altM: ac.alt + 30 };
        frame.geodeticToRender(t.lat, t.lon, t.altM, T.eye);
        frame.dirToRender(enuBasis(t.lat, t.lon).u, T.up);
        near = 1;
        // Keep the aircraft a sensible size on screen (zoom with x/X).
        const dist = T.eye.distanceTo(T.target);
        // Frame about 30 m across at the aircraft (x/X zoom from there).
        hfov = Math.max(0.3, Math.min(60, 2 * Math.atan((15 / s.zoom) / Math.max(1, dist)) * R2D));
      } else {
        // Fly-by: wait beside the flight path ahead of the aircraft, then jump
        // ahead again once it has gone by (Nasal view.nas flyby).
        const vel = ned([ac.vN, ac.vE, ac.vD]);
        const speed = vel.length();
        const dir = speed > 2 ? vel.clone().normalize() : ned(bodyAxes(ac.heading, 0, 0).fwd);
        const fb = this.flyby;
        const passed = fb && T.target.clone().sub(fb.eye).dot(dir) > Math.max(60, speed * 3);
        if (!fb || passed || T.target.distanceTo(fb.eye) > 3000) {
          const right = new THREE.Vector3().crossVectors(dir, U).normalize();
          const ahead = Math.max(80, Math.min(1500, speed * 8));
          const eye = T.target.clone().addScaledVector(dir, ahead).addScaledVector(right, 25).addScaledVector(U, 3);
          this.flyby = { eye };
        }
        T.eye.copy(this.flyby.eye);
        T.up.copy(U);
      }

      // Keep the eye above the ground.
      const g = frame.renderToGeodetic(T.eye);
      const elev = this.ctx.elevation(g.lat, g.lon);
      if (elev !== null && g.alt < elev + 1.2) {
        frame.dirToRender(enuBasis(g.lat, g.lon).u, T.v);
        T.eye.addScaledVector(T.v, elev + 1.2 - g.alt);
        if (v.type === "flyby") this.flyby.eye.copy(T.eye);
      }
      camera.position.copy(T.eye);
      camera.up.copy(T.up);
      camera.lookAt(T.target);
    }

    const aspect = this.ctx.aspect();
    const vfov = 2 * Math.atan(Math.tan((hfov * D2R) / 2) / aspect) * R2D;
    if (Math.abs(camera.fov - vfov) > 1e-6 || camera.near !== near || camera.aspect !== aspect) {
      camera.fov = vfov;
      camera.near = near;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
    return { name: v.name, hfov };
  }
}
