// The `c172p` Nasal namespace that the aircraft's cockpit bindings call:
// doors (doors.nas, FlightGear's aircraft.door), click sounds (c172p.nas
// click()), the primer and a few helpers.

import { interpolateProperty } from "../props/sgexpr.js";

/** aircraft.door: a property that swings between 0 and 1. */
class Door {
  constructor(app, node, swingTime) {
    this.app = app;
    this.node = node;
    this.swingTime = swingTime;
  }

  get pos() {
    return this.app.sim.props.get(`${this.node}/position-norm`);
  }

  move(target) {
    const p = this.app.sim.props;
    const pos = this.pos;
    if (pos !== target) interpolateProperty(p, `${this.node}/position-norm`, target, Math.abs(pos - target) * this.swingTime);
  }

  /** Opens a closed door and closes an open one (aircraft.door.toggle). */
  toggle() {
    if (this.target === undefined) this.target = this.pos < 0.5 ? 1 : 0;
    this.move(this.target);
    this.target = 1 - this.target;
  }

  open() { this.move(1); this.target = 0; }
  close() { this.move(0); this.target = 1; }
}

export function createC172pNamespace(app) {
  const door = (name, t) => new Door(app, `/sim/model/door-positions/${name}`, t);
  const clickTimers = new Map();
  return {
    leftDoor: door("leftDoor", 2),
    rightDoor: door("rightDoor", 2),
    leftWindow: door("leftWindow", 2),
    rightWindow: door("rightWindow", 2),
    baggageDoor: door("baggageDoor", 2),
    oilDoor: door("oilDoor", 1),
    gloveboxDoor: door("gloveboxDoor", 1),
    /** c172p.nas click(): pulses /sim/model/c172p/sound/click-<name> for the sound system. */
    click(name, timeout = 0.1) {
      const p = app.sim.props;
      const path = `/sim/model/c172p/sound/click-${name}`;
      p.set(path, true);
      clearTimeout(clickTimers.get(path));
      clickTimers.set(path, setTimeout(() => p.set(path, false), Math.max(0.05, timeout) * 1000));
    },
    pumpPrimer() {
      app.aircraft.pumpPrimer();
    },
    toggle_domelight() {
      const p = app.sim.props;
      p.set("/sim/model/c172p/lighting/dome-norm", (p.get("/sim/model/c172p/lighting/dome-norm") + 1) % 4);
    },
    reset_view() { app.views.reset(); },
    update_view() {},
    increment() {},
    control_surface_check_elevator() {},
    control_surface_check_left_aileron() {},
    control_surface_check_right_aileron() {},
    control_surface_check_rudder() {},
    kma20: { instances: [{ fgcom: { ptt() {} } }] },
  };
}
