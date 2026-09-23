// Keyboard, mouse and gamepad input with FlightGear's default bindings
// (fgdata keyboard.xml + the c172p's c172p-keyboard.xml) and SimGear's
// cockpit picking rules (SGPickAnimation.cxx).
//
// Keys that FlightGear marks repeatable act on every key-repeat event, just
// as they do on the desktop, so holding an arrow key keeps moving the yoke.

import * as THREE from "three";

const LOOK = { 8: 0, 9: 315, 6: 270, 3: 225, 2: 180, 1: 135, 4: 90, 7: 45 };
const LOOK_ARROWS = { ArrowUp: 0, ArrowRight: 270, ArrowDown: 180, ArrowLeft: 90 };

export const HELP = [
  ["Flight controls", [
    ["↑ ↓ / 8 2", "Elevator (push / pull)"],
    ["← → / 4 6", "Ailerons"],
    ["0 / Enter (Insert)", "Rudder left / right"],
    ["5", "Center yoke and rudder"],
    ["Home End / 7 1", "Elevator trim"],
    ["[ ]", "Flaps up / down"],
    ["Tab", "Mouse yoke mode"],
  ]],
  ["Engine", [
    ["PgUp PgDn / 9 3", "Throttle"],
    ["m M", "Mixture richer / leaner"],
    ["{ }", "Magnetos (key switch)"],
    ["s", "Starter (hold)"],
    ["Shift+S", "Autostart"],
  ]],
  ["Ground", [
    ["b", "Brakes (hold)"],
    [", .", "Left / right brake"],
    ["B", "Parking brake"],
  ]],
  ["View", [
    ["v V", "Next / previous view"],
    ["x X / wheel", "Zoom in / out"],
    ["Right-drag", "Look around / orbit"],
    ["Shift + arrows", "Look forward, left, right, back"],
    ["q", "Reset view"],
    ["y", "Hide yokes"],
  ]],
  ["Simulator", [
    ["p", "Pause"],
    ["a A", "Speed up / slow down"],
    ["t T", "Time of day forward / back (hold)"],
    ["z Z", "Visibility up / down"],
    ["l L", "Panel lights up / down"],
    ["h", "Flight data: compact, full, off"],
    ["Esc", "Menu"],
    ["Shift+Esc", "Reset flight"],
    ["? / F1", "This help"],
  ]],
];

export class Input {
  /**
   * app: {canvas, camera, controls, views, hud, sim, aircraft, model (FGModel),
   *       nasal, togglePause(), toggleHelp(), openMenu(), reset(), autostart(),
   *       timeWarp(dir), setVisibility(f)}
   */
  constructor(app) {
    this.app = app;
    this.held = new Map(); // key -> {up()}
    this.mouse = { x: 0, y: 0, ndc: new THREE.Vector2(), inside: false };
    this.drag = null; // right-button look drag
    this.active = null; // pick being pressed
    this.yokeMode = false;
    this.raycaster = new THREE.Raycaster();
    this.hoverTimer = 0;
    this.hovered = null;
    this.gamepadActive = false;
    this.gamepadPrev = [];
    this.warp = 0;
    this.enabled = true;
  }

  attach() {
    const c = this.app.canvas;
    window.addEventListener("keydown", (e) => this.keydown(e));
    window.addEventListener("keyup", (e) => this.keyup(e));
    window.addEventListener("blur", () => this.releaseAll());
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mousedown", (e) => this.mousedown(e));
    window.addEventListener("mouseup", (e) => this.mouseup(e));
    window.addEventListener("mousemove", (e) => this.mousemove(e));
    c.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    c.addEventListener("mouseleave", () => { this.mouse.inside = false; this.app.hud.showTooltip(null); });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== c && this.yokeMode) this.setYokeMode(false);
    });
  }

  get ctl() {
    return this.app.controls;
  }

  // ------------------------------------------------------------ keyboard

  keydown(e) {
    if (!this.enabled) return;
    const app = this.app;
    // Overlays first: Esc (or ?/F1 for the key list) closes them; other keys
    // do not reach the aircraft while a menu is up.
    if (!document.getElementById("help").hidden) {
      if (e.key === "Escape" || e.key === "?" || e.key === "F1") {
        app.toggleHelp(false);
        e.preventDefault();
      }
      return;
    }
    if (app.menu?.isOpen) {
      if (e.key === "Escape" && app.flying) {
        app.menu.close();
        e.preventDefault();
      }
      return;
    }
    if (e.target.closest?.("input, select, textarea")) return;
    const handled = this.handleKey(e);
    if (handled) e.preventDefault();
  }

  keyup(e) {
    const k = this.held.get(e.code);
    if (k) {
      this.held.delete(e.code);
      k.up?.();
    }
  }

  releaseAll() {
    for (const k of this.held.values()) k.up?.();
    this.held.clear();
  }

  hold(e, down, up) {
    if (e.repeat && this.held.has(e.code)) return true;
    down();
    this.held.set(e.code, { up });
    return true;
  }

  handleKey(e) {
    const app = this.app;
    const c = this.ctl;
    const key = e.key;
    const digit = /^(Digit|Numpad)([0-9])$/.exec(e.code);
    // Shift + number pad / arrows: look directions.
    if (e.shiftKey && !e.ctrlKey && !e.altKey) {
      if (digit && LOOK[digit[2]] !== undefined) { app.views.lookDirection(LOOK[digit[2]]); return true; }
      if (LOOK_ARROWS[key] !== undefined) { app.views.lookDirection(LOOK_ARROWS[key]); return true; }
      if (key === "Escape") { app.reset(); return true; }
    }
    if (e.ctrlKey || e.metaKey) {
      if (key === "v" || key === "V") { app.setView(0); return true; }
      if (key === "x" || key === "X") { app.views.resetFov(); return true; }
      return false;
    }
    if (e.altKey) return false;
    // Number pad with NumLock off produces navigation keys; use the digit.
    const k = digit && e.code.startsWith("Numpad") ? digit[2] : key;
    switch (k) {
      case "ArrowUp": case "8": c.incElevator(0.05); return true;
      case "ArrowDown": case "2": c.incElevator(-0.05); return true;
      case "ArrowLeft": case "4": c.incAileron(-0.05); return true;
      case "ArrowRight": case "6": c.incAileron(0.05); return true;
      case "5": case "Clear": c.centerFlightControls(); return true;
      case "0": case "Insert": c.incRudder(-0.05); return true;
      case "Enter": c.incRudder(0.05); return true;
      case "Home": case "7": c.elevatorTrim(0.001); return true;
      case "End": case "1": c.elevatorTrim(-0.001); return true;
      case "PageUp": case "9": c.incThrottle(0.01); return true;
      case "PageDown": case "3": c.incThrottle(-0.01); return true;
      case "[": if (!e.repeat) c.flapsDown(-1); return true;
      case "]": if (!e.repeat) c.flapsDown(1); return true;
      case "b": return this.hold(e, () => c.applyBrakes(1), () => c.applyBrakes(0));
      case ",": return this.hold(e, () => c.applyBrakes(1, -1), () => c.applyBrakes(0, -1));
      case ".": return this.hold(e, () => c.applyBrakes(1, 1), () => c.applyBrakes(0, 1));
      case "B": if (!e.repeat) c.toggleParkingBrake(); return true;
      case "m": c.adjMixture(1); return true;
      case "M": c.adjMixture(-1); return true;
      case "{": if (!e.repeat) c.stepMagnetos(-1); return true;
      case "}": if (!e.repeat) c.stepMagnetos(1); return true;
      case "s": return this.hold(e, () => c.startEngine(1), () => c.startEngine(0));
      case "S": if (!e.repeat) app.autostart(); return true;
      case "v": if (!e.repeat) app.stepView(1); return true;
      case "V": if (!e.repeat) app.stepView(-1); return true;
      case "x": app.zoom(-1); return true;
      case "X": app.zoom(1); return true;
      case "q": case "Q": app.views.reset(); return true;
      case "p": if (!e.repeat) app.togglePause(); return true;
      case "a": if (!e.repeat) c.speedup(1); return true;
      case "A": if (!e.repeat) c.speedup(-1); return true;
      case "t": return this.hold(e, () => { this.warp = 1; }, () => { this.warp = 0; });
      case "T": return this.hold(e, () => { this.warp = -1; }, () => { this.warp = 0; });
      case "z": app.adjustVisibility(1.1); return true;
      case "Z": app.adjustVisibility(1 / 1.1); return true;
      case "h": if (!e.repeat) app.hud.cycle(); return true;
      case "l": this.adjustProp("/controls/lighting/instruments-norm", 0.1); return true;
      case "L": this.adjustProp("/controls/lighting/instruments-norm", -0.1); return true;
      case "o": if (!e.repeat) this.domeLight(); return true;
      case "y": if (!e.repeat) this.toggleYokes(); return true;
      case "D": return this.hold(e, () => app.sim.props.set("/autopilot/kap140/settings/ap-disc", 1),
        () => app.sim.props.set("/autopilot/kap140/settings/ap-disc", 0));
      case "d": return this.hold(e, () => app.sim.props.set("/autopilot/kap140/settings/cws", 1),
        () => app.sim.props.set("/autopilot/kap140/settings/cws", 0));
      case "Tab": if (!e.repeat) this.setYokeMode(!this.yokeMode); return true;
      case "?": case "F1": if (!e.repeat) app.toggleHelp(); return true;
      case "Escape": if (!e.repeat) app.openMenu(); return true;
      default: return false;
    }
  }

  adjustProp(path, d) {
    const p = this.app.sim.props;
    p.set(path, Math.min(1, Math.max(0, p.get(path) + d)));
  }

  domeLight() {
    // interior-lighting.nas toggle_domelight(): cycles 0..3
    const p = this.app.sim.props;
    p.set("/sim/model/c172p/lighting/dome-norm", (p.get("/sim/model/c172p/lighting/dome-norm") + 1) % 4);
  }

  toggleYokes() {
    const p = this.app.sim.props;
    p.set("/sim/model/hide-yoke", !p.getBool("/sim/model/hide-yoke"));
    p.set("/sim/model/c172p/cockpit/control-lock-placed", false);
  }

  // --------------------------------------------------------------- mouse

  setYokeMode(on) {
    this.yokeMode = on;
    const c = this.app.canvas;
    if (on) {
      c.requestPointerLock?.();
      this.app.hud.message("Mouse controls the yoke (Tab or Esc to release)");
    } else if (document.pointerLockElement === c) {
      document.exitPointerLock();
    }
    document.body.classList.toggle("yoke-mode", on);
  }

  updateMouse(e) {
    const r = this.app.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.mouse.inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  /** All pickable hits under the mouse, nearest first (FGRenderer::pick). */
  pickHits() {
    const model = this.app.model;
    if (!model) return [];
    this.raycaster.setFromCamera(this.mouse.ndc, this.app.camera);
    this.raycaster.near = 0.02;
    this.raycaster.far = 60;
    const hits = this.raycaster.intersectObjects(model.pickMeshes ?? [], false);
    const out = [];
    const seen = new Set();
    for (const h of hits) {
      let o = h.object;
      let visible = true;
      let pick = null;
      for (let n = o; n; n = n.parent) {
        if (!n.visible) { visible = false; break; }
        if (!pick && n.userData.pick) pick = n.userData.pick;
      }
      // Keep walking for outer picks (nested pick groups each get a chance).
      if (!visible || !pick) continue;
      for (let n = o; n; n = n.parent) {
        const pk = n.userData.pick;
        if (pk && !seen.has(pk)) {
          seen.add(pk);
          out.push(pk);
        }
      }
    }
    return out;
  }

  mousedown(e) {
    if (!this.enabled) return;
    this.updateMouse(e);
    if (this.yokeMode) return;
    if (e.button === 2 || (e.button === 0 && this.app.views.view.type !== "cockpit" && !this.pickHits().length)) {
      this.drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
      return;
    }
    const button = e.button === 0 && e.altKey ? 1 : e.button;
    this.press(button, e.shiftKey);
  }

  /** SGPickCallback::buttonPressed on the first pick that accepts it. */
  press(button, shifted) {
    for (const pick of this.pickHits()) {
      if (!pick.enabled()) continue;
      if (pick.knob) {
        let dir = 0;
        if (button === 0 || button === 3) dir = 1;
        else if (button === 1 || button === 4) dir = -1;
        if (!dir) continue;
        this.active = { pick, dir, shifted, t: -pick.knob.interval, x: this.mouse.x, y: this.mouse.y, dragged: false, button };
        return true;
      }
      const act = pick.actions.find((a) => a.buttons.has(button));
      if (!act) continue;
      act.down();
      this.active = { pick, act, t: -act.interval, button };
      return true;
    }
    return false;
  }

  release() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (a.pick.knob) {
      if (!a.dragged) a.pick.knob.fire(a.dir, a.shifted);
      a.pick.knob.release();
    } else {
      a.act.up();
    }
  }

  mouseup(e) {
    if (this.drag && (e.button === this.drag.button)) {
      const d = this.drag;
      this.drag = null;
      if (!d.moved && d.button === 2) {
        this.updateMouse(e);
        if (this.press(2, e.shiftKey)) this.release();
      }
      return;
    }
    this.release();
  }

  mousemove(e) {
    if (this.yokeMode && document.pointerLockElement === this.app.canvas) {
      const k = 0.0025;
      if (e.buttons & 1) this.ctl.incRudder(e.movementX * k);
      else this.ctl.incAileron(e.movementX * k);
      this.ctl.incElevator(-e.movementY * k);
      return;
    }
    const px = this.mouse.x, py = this.mouse.y;
    this.updateMouse(e);
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (!this.drag.moved && dx * dx + dy * dy < 9) return;
      this.drag.moved = true;
      this.app.views.look(e.clientX - (this.drag.lx ?? this.drag.x), e.clientY - (this.drag.ly ?? this.drag.y));
      this.drag.lx = e.clientX;
      this.drag.ly = e.clientY;
      return;
    }
    const a = this.active;
    if (a?.pick.knob) {
      const kn = a.pick.knob;
      const dx = this.mouse.x - a.x, dy = this.mouse.y - a.y;
      if (!a.dragged && dx * dx + dy * dy < 5) return;
      a.dragged = true;
      // SimGear drags in window coordinates with y up.
      let delta = (kn.dragDirection === "vertical" ? -dy : dx) / kn.dragScale;
      while (Math.abs(delta) >= 1) {
        kn.fire(delta > 0 ? 1 : -1, e.shiftKey);
        delta -= Math.sign(delta);
        a.x = this.mouse.x;
        a.y = this.mouse.y;
      }
    }
    void px; void py;
  }

  wheel(e) {
    e.preventDefault();
    if (!this.enabled) return;
    this.updateMouse(e);
    const dir = e.deltaY < 0 ? 1 : -1;
    if (this.yokeMode) {
      this.ctl.incThrottle(dir * 0.02);
      return;
    }
    // Wheel up/down are buttons 3/4, pressed and released at once.
    if (this.press(dir > 0 ? 3 : 4, e.shiftKey)) {
      this.release();
      return;
    }
    this.app.wheelZoom(dir);
  }

  // -------------------------------------------------------------- update

  update(dt) {
    const a = this.active;
    if (a) {
      if (a.pick.knob) {
        if (!a.dragged) {
          a.t += dt;
          while (a.t > a.pick.knob.interval) {
            a.t -= Math.max(a.pick.knob.interval, 1e-3);
            a.pick.knob.fire(a.dir, a.shifted);
          }
        }
      } else if (a.act.repeatable) {
        a.t += dt;
        while (a.t > a.act.interval) {
          a.t -= Math.max(a.act.interval, 1e-3);
          a.act.down();
        }
      }
    }
    if (this.warp) this.app.timeWarp(this.warp * 30 * 60 * dt);

    // Hover tooltips, a few times per second.
    this.hoverTimer -= dt;
    if (this.hoverTimer <= 0 && !this.drag && !this.yokeMode) {
      this.hoverTimer = 0.1;
      let text = null;
      if (this.mouse.inside && this.app.model) {
        const pick = this.pickHits().find((p) => p.tooltip && p.enabled());
        if (pick) text = pick.tooltip();
        this.app.canvas.style.cursor = this.pickHits().length ? "pointer" : "";
      }
      this.app.hud.showTooltip(text, this.mouse.x, this.mouse.y);
    }
    this.pollGamepad(dt);
  }

  // ------------------------------------------------------------- gamepad

  pollGamepad(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad) return;
    const c = this.ctl;
    const dz = (v, z = 0.08) => (Math.abs(v) < z ? 0 : (v - Math.sign(v) * z) / (1 - z));
    const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.6);
    const ax = pad.axes;
    const pressed = (i) => !!pad.buttons[i]?.pressed;
    const edge = (i) => pressed(i) && !this.gamepadPrev[i];
    const moved = ax.some((v, i) => i < 4 && Math.abs(v) > 0.2);
    if (moved) this.gamepadActive = true;
    const p = this.app.sim.props;
    if (this.gamepadActive) {
      if (pad.mapping === "standard") {
        p.set("/controls/flight/aileron", curve(dz(ax[0] ?? 0)));
        p.set("/controls/flight/elevator", curve(dz(ax[1] ?? 0)));
        p.set("/controls/flight/rudder", curve(dz(ax[2] ?? 0)));
        const thr = dz(ax[3] ?? 0, 0.15);
        if (thr) c.incThrottle(-thr * 0.6 * dt);
      } else {
        // Joysticks: x/y stick, twist or 4th axis rudder, 3rd axis throttle.
        p.set("/controls/flight/aileron", curve(dz(ax[0] ?? 0, 0.04)));
        p.set("/controls/flight/elevator", curve(dz(ax[1] ?? 0, 0.04)));
        if (ax.length > 3) p.set("/controls/flight/rudder", curve(dz(ax[3] ?? ax[5] ?? 0, 0.06)));
        if (ax.length > 2) c.setThrottle((1 - (ax[2] ?? 1)) / 2);
      }
    }
    if (pad.mapping === "standard") {
      const rt = pad.buttons[7]?.value ?? 0, lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.05) c.incThrottle(rt * 0.5 * dt);
      if (lt > 0.05) c.incThrottle(-lt * 0.5 * dt);
      if (edge(0)) c.applyBrakes(1);
      if (!pressed(0) && this.gamepadPrev[0]) c.applyBrakes(0);
      if (edge(1)) c.toggleParkingBrake();
      if (edge(2)) c.flapsDown(-1);
      if (edge(3)) c.flapsDown(1);
      if (edge(4)) this.app.stepView(-1);
      if (edge(5)) this.app.stepView(1);
      if (edge(9)) this.app.togglePause();
      if (edge(8)) this.app.toggleHelp();
      if (pressed(12)) c.elevatorTrim(0.03 * dt);
      if (pressed(13)) c.elevatorTrim(-0.03 * dt);
      if (edge(14)) this.app.zoom(1);
      if (edge(15)) this.app.zoom(-1);
    }
    this.gamepadPrev = pad.buttons.map((b) => b.pressed);
  }
}
