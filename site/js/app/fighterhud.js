// The F-16's head-up display, drawn over the cockpit view on a 2D canvas.
//
// Everything outside-world related is conformal: pitch ladder rungs, the
// flight path marker and the boresight are placed by projecting their
// directions through the same camera as the 3D view, so they line up with
// the horizon whatever the view's pitch offset, zoom or the aircraft's
// attitude.  The symbols follow the F-16's HUD: gun cross, flight path
// marker, pitch ladder (dashed below the horizon), airspeed box on the left,
// altitude box and radar altitude on the right, heading tape at the top, and
// Mach, G and angle of attack at the lower left.

import * as THREE from "three";

const D2R = Math.PI / 180;
const GREEN = "rgba(90, 255, 120, 0.95)";
const SHADOW = "rgba(0, 25, 0, 0.45)";
// The combiner's field of view around its centre, which sits below the
// boresight (degrees); its bottom edge is the glare shield.
const HALF_W = 13;
const HALF_H = 10.5;
const CENTER_DOWN = 2.5;
const FAR = 5000; // m: where directions are projected

const wrap360 = (d) => ((d % 360) + 360) % 360;

export class FighterHud {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "fighter-hud";
    this.canvas.setAttribute("aria-hidden", "true");
    document.body.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.enabled = true;
    this.shown = false;
    this.maxG = 1;
    this.t = {
      v: new THREE.Vector3(), p: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(),
      up: new THREE.Vector3(), fwdH: new THREE.Vector3(), rightH: new THREE.Vector3(), d: new THREE.Vector3(),
      e: new THREE.Vector3(), n: new THREE.Vector3(), u: new THREE.Vector3(),
    };
  }

  toggle(on = !this.enabled) {
    this.enabled = on;
    return on;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  clear() {
    if (!this.shown) return;
    this.shown = false;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Screen position of a direction from the camera, or null if behind it. */
  project(camera, dir) {
    const t = this.t;
    t.p.copy(camera.position).addScaledVector(dir, FAR);
    t.v.copy(t.p).applyMatrix4(camera.matrixWorldInverse);
    if (t.v.z > -1) return null;
    t.p.project(camera);
    return { x: ((t.p.x + 1) / 2) * this.w, y: ((1 - t.p.y) / 2) * this.h };
  }

  /**
   * camera: the cockpit camera; aircraftMatrix: the model's matrix in render
   * space (x aft, y right, z up); enu: {e, n, u} render-space unit vectors at
   * the aircraft; p: the property tree.
   */
  draw(camera, aircraftMatrix, enu, p) {
    if (!this.enabled) {
      this.clear();
      return;
    }
    this.resize();
    const ctx = this.ctx;
    const t = this.t;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.shown = true;

    const m = aircraftMatrix.elements;
    t.fwd.set(-m[0], -m[1], -m[2]).normalize();
    t.right.set(m[4], m[5], m[6]).normalize();
    t.up.set(m[8], m[9], m[10]).normalize();
    const U = enu.u;
    t.fwdH.copy(t.fwd).addScaledVector(U, -t.fwd.dot(U));
    if (t.fwdH.lengthSq() < 1e-6) {
      // Nose straight up or down: the heading is where the belly or the
      // canopy points.
      const s = t.fwd.dot(U) > 0 ? -1 : 1;
      t.fwdH.copy(t.up).multiplyScalar(s).addScaledVector(U, -t.up.dot(U) * s);
    }
    t.fwdH.normalize();
    t.rightH.crossVectors(t.fwdH, U).normalize();

    // The combiner: centre below the boresight, fixed to the aircraft.
    t.d.copy(t.fwd).multiplyScalar(Math.cos(CENTER_DOWN * D2R)).addScaledVector(t.up, -Math.sin(CENTER_DOWN * D2R));
    const c = this.project(camera, t.d);
    if (!c) return;
    const vfov = camera.fov * D2R;
    const pxPerTan = this.h / 2 / Math.tan(vfov / 2);
    const hw = Math.tan(HALF_W * D2R) * pxPerTan;
    const hh = Math.tan(HALF_H * D2R) * pxPerTan;
    const box = { l: c.x - hw, r: c.x + hw, t: c.y - hh, b: c.y + hh };
    if (box.r < 0 || box.l > this.w || box.b < 0 || box.t > this.h) return;
    const k = Math.max(0.8, Math.min(1.8, hh / 125)); // symbol scale
    const font = (px) => `600 ${Math.round(px * k)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.l, box.t, box.r - box.l, box.b - box.t);
    ctx.clip();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const lines = new Path2D();
    const dashed = new Path2D();
    const texts = [];
    const text = (s, x, y, align = "center", size = 13) => texts.push({ s, x, y, align, size });
    const seg = (path, x0, y0, x1, y1) => { path.moveTo(x0, y0); path.lineTo(x1, y1); };

    // Pitch ladder, centred on the heading.
    const pitch = p.get("/orientation/pitch-deg");
    const lo = Math.max(-90, Math.floor((pitch - 25) / 5) * 5);
    const hi = Math.min(90, Math.ceil((pitch + 25) / 5) * 5);
    for (let a = lo; a <= hi; a += 5) {
      t.d.copy(t.fwdH).multiplyScalar(Math.cos(a * D2R)).addScaledVector(U, Math.sin(a * D2R));
      const pt = this.project(camera, t.d);
      if (!pt) continue;
      t.d.addScaledVector(t.rightH, 0.05);
      const q = this.project(camera, t.d);
      if (!q) continue;
      let ux = q.x - pt.x, uy = q.y - pt.y;
      const len = Math.hypot(ux, uy) || 1;
      ux /= len;
      uy /= len;
      // Toward the horizon, perpendicular to the rung (screen y is down).
      const tx = a > 0 ? -uy : uy, ty = a > 0 ? ux : -ux;
      if (a === 0) {
        const gap = 28 * k, far = hw * 1.6;
        seg(lines, pt.x - ux * far, pt.y - uy * far, pt.x - ux * gap, pt.y - uy * gap);
        seg(lines, pt.x + ux * gap, pt.y + uy * gap, pt.x + ux * far, pt.y + uy * far);
        continue;
      }
      const gap = 22 * k, outer = 58 * k, tick = 7 * k;
      const path = a > 0 ? lines : dashed;
      for (const sgn of [-1, 1]) {
        const x0 = pt.x + sgn * ux * gap, y0 = pt.y + sgn * uy * gap;
        const x1 = pt.x + sgn * ux * outer, y1 = pt.y + sgn * uy * outer;
        seg(path, x0, y0, x1, y1);
        seg(lines, x0, y0, x0 + tx * tick, y0 + ty * tick);
        text(String(Math.abs(a)), x1 + sgn * ux * 14 * k, y1 + sgn * uy * 14 * k + 4 * k, "center", 11);
      }
    }

    // Gun cross at the boresight.
    const bs = this.project(camera, t.fwd);
    if (bs) {
      const a = 9 * k, g = 3 * k;
      seg(lines, bs.x - a, bs.y, bs.x - g, bs.y);
      seg(lines, bs.x + g, bs.y, bs.x + a, bs.y);
      seg(lines, bs.x, bs.y - a, bs.x, bs.y - g);
      seg(lines, bs.x, bs.y + g, bs.x, bs.y + a);
    }

    // Flight path marker: where the aircraft is going.
    const vN = p.get("/velocities/speed-north-fps"), vE = p.get("/velocities/speed-east-fps");
    const vD = p.get("/velocities/speed-down-fps");
    const speed = Math.hypot(vN, vE, vD);
    if (speed > 30) {
      t.d.copy(enu.n).multiplyScalar(vN).addScaledVector(enu.e, vE).addScaledVector(U, -vD).normalize();
      const f = this.project(camera, t.d);
      if (f) {
        const x = Math.max(box.l + 20 * k, Math.min(box.r - 20 * k, f.x));
        const y = Math.max(box.t + 20 * k, Math.min(box.b - 20 * k, f.y));
        const r = 6 * k;
        lines.moveTo(x + r, y);
        lines.arc(x, y, r, 0, Math.PI * 2);
        seg(lines, x - r, y, x - r - 11 * k, y);
        seg(lines, x + r, y, x + r + 11 * k, y);
        seg(lines, x, y - r, x, y - r - 7 * k);
      }
    }

    // Heading tape along the top of the combiner.
    const hdg = p.get("/orientation/heading-magnetic-deg");
    const tapeY = box.t + 22 * k;
    const pxPerDeg = (hw * 0.8) / 15;
    for (let d = Math.ceil((hdg - 16) / 5) * 5; d <= hdg + 16; d += 5) {
      const x = c.x + (d - hdg) * pxPerDeg;
      const big = d % 10 === 0;
      seg(lines, x, tapeY, x, tapeY - (big ? 8 : 4) * k);
      if (big) text(String(wrap360(d) / 10).padStart(2, "0"), x, tapeY - 11 * k, "center", 11);
    }
    seg(lines, c.x, tapeY + 2 * k, c.x - 5 * k, tapeY + 9 * k);
    seg(lines, c.x, tapeY + 2 * k, c.x + 5 * k, tapeY + 9 * k);
    const hdgText = String(Math.round(wrap360(hdg)) % 360 || 360).padStart(3, "0");
    text(hdgText, c.x, tapeY + 22 * k, "center", 12);

    // Airspeed (left) and altitude (right) boxes, level with the boresight.
    const midY = bs ? Math.max(box.t + 60 * k, Math.min(box.b - 60 * k, bs.y)) : c.y;
    const ias = Math.max(0, p.get("/instrumentation/airspeed-indicator/indicated-speed-kt"));
    const alt = p.get("/instrumentation/altimeter/indicated-altitude-ft");
    const bw = 58 * k, bh = 20 * k;
    const lx = box.l + 16 * k, rx = box.r - 16 * k - bw;
    lines.rect(lx, midY - bh / 2, bw, bh);
    lines.rect(rx, midY - bh / 2, bw, bh);
    text(String(Math.round(ias)), lx + bw - 6 * k, midY + 5 * k, "right", 14);
    const altR = Math.round(alt / 10) * 10;
    const thousands = Math.trunc(altR / 1000);
    const rest = String(Math.abs(altR % 1000)).padStart(3, "0");
    text(thousands ? `${thousands},${rest}` : rest, rx + bw - 6 * k, midY + 5 * k, "right", 14);
    const agl = p.get("/position/altitude-agl-ft");
    if (agl < 5000) text(`AR ${String(Math.max(0, Math.round(agl / 10) * 10)).padStart(5, "0")}`, rx + bw, midY + 24 * k, "right", 11);
    const vs = Math.round((p.get("/velocities/vertical-speed-fps") * 60) / 100) * 100;
    text(vs > 0 ? `+${vs}` : vs < 0 ? `−${-vs}` : "0", rx + bw, midY - 16 * k, "right", 11);

    // Mach, G and angle of attack.
    const gLoad = p.get("/accelerations/pilot-g");
    if (p.getBool("/gear/gear[1]/wow")) this.maxG = 1;
    this.maxG = Math.max(this.maxG, gLoad);
    const bx = box.l + 16 * k;
    text(`M ${p.get("/velocities/mach").toFixed(2)}`, bx, box.b - 44 * k, "left", 12);
    text(`G ${gLoad.toFixed(1)}  ${this.maxG.toFixed(1)}`, bx, box.b - 28 * k, "left", 12);
    text(`α ${p.get("/orientation/alpha-deg").toFixed(1)}`, bx, box.b - 12 * k, "left", 12);
    if (p.get("/gear/gear[0]/position-norm") > 0.01) text("GEAR", box.r - 16 * k, box.b - 12 * k, "right", 12);
    if (p.getBool("/engines/engine[0]/augmentation")) text("AB", box.r - 16 * k, box.b - 28 * k, "right", 12);

    // Dark halo first so the green reads against a bright sky.
    for (const [path, dash] of [[lines, []], [dashed, [6 * k, 5 * k]]]) {
      ctx.setLineDash(dash);
      ctx.strokeStyle = SHADOW;
      ctx.lineWidth = 3.6 * k;
      ctx.stroke(path);
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 1.5 * k;
      ctx.stroke(path);
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = SHADOW;
    ctx.fillStyle = GREEN;
    for (const s of texts) {
      ctx.font = font(s.size);
      ctx.textAlign = s.align;
      ctx.strokeText(s.s, s.x, s.y);
      ctx.fillText(s.s, s.x, s.y);
    }
    ctx.restore();
  }
}
