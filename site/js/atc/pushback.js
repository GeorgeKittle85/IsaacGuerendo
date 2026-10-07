// The pushback tug: FlightGear's Autopush (Nasal/Autopush/autopush.nas and
// driver.nas, by Michael Danilov, Joshua Davidson and Merspieler, GPL-2.0)
// ported to JavaScript.  autopush.nas holds a target speed with a PID
// controller that pushes on the nose gear; driver.nas steers the tug along
// a route of waypoints, here the parking position's pushback route from the
// airport's ground network.
//
// Each flight model takes the tug's force its own way (def.tug.type):
//   autopush  FlightGear's autopush interface (the 747-400): the force goes
//             in through /sim/model/autopush/force-*, and while connected the
//             flight model steers the nose wheel from steer-cmd-norm.
//   towbar    the c172p's own towbar (Systems/towbar.xml): attached, it pulls
//             along the nose wheel, which it steers; ground crew push.
//   pushback  JSBSim's generic pushback system (the F-16): it holds
//             /sim/model/pushback/target-speed-fps itself once the tug is in
//             place (position-norm 1); the tug steers the nose wheel.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const M2FT = 3.28084;
const KMH_TO_FPS = 0.911344;
const UNITCONV = M2FT / 3.6; // (ft / s^2) / ((km / h) / s), autopush.nas
const ARRIVE_S = 6; // the military tug drives in on its arc (position-norm 0 -> 1)

// The 747-400's autopush-config.xml, also used for the other aircraft.
const CONFIG = {
  K_p: 0.5, F_p: 0.15, K_i: 0.25, F_i: 0.1, K_d: 0, F_d: 0,
  K_psi: 0.03, F_psi: 1, K_psidot: 0.03, F_psidot: 1,
  R_turn_min: 9, D_stop: 5, K_yaw: 1,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const normdeg180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** courseAndDistance() between {lat, lon} points (flat earth: a pushback is short). */
function courseAndDistance(a, b) {
  const dy = (b.lat - a.lat) * 111195;
  const dx = (b.lon - a.lon) * 111195 * Math.cos(a.lat * D2R);
  return { course: (Math.atan2(dx, dy) * R2D + 360) % 360, dist: Math.hypot(dx, dy) };
}

export class Pushback {
  /**
   * sim: the Simulation (props, fdm); tug: the aircraft definition's `tug`
   * ({type, speedKmh, maxSteerDeg}); say(text): a message from the tug driver.
   */
  constructor(sim, tug, say = () => {}) {
    this.sim = sim;
    this.tug = tug;
    this.say = say;
    this.state = "off"; // off, arriving, connected, pushing, stopping, leaving
    this.position = 0; // the military tug's arc, 0..1
  }

  get props() {
    return this.sim.props;
  }

  get active() {
    return this.state !== "off";
  }

  /** Brings the tug and hooks it up; `route` is [{lat, lon}] waypoints behind the aircraft. */
  connect(route) {
    if (this.active) return;
    const p = this.props;
    this.route = [{ lat: p.get("/position/latitude-deg"), lon: p.get("/position/longitude-deg") }, ...route];
    this.int = 0;
    this.V = 0;
    this.target = 0;
    this.steer = 0;
    this.toWp = 0;
    this.timer = 0;
    this.force = 0;
    if (this.tug.type === "pushback") {
      p.set("/sim/model/pushback/enabled", true);
      this.state = "arriving";
    } else {
      this.hookUp();
    }
  }

  hookUp() {
    this.state = "connected";
    this.apply(0, 0, true);
    const parked = this.props.getBool("/controls/gear/brake-parking");
    this.say(parked ? "Pushback connected, please release brakes." : "Pushback connected.");
  }

  /** Stops where it is and unhooks. */
  cancel() {
    if (!this.active) return;
    if (this.state === "connected" || this.state === "pushing") this.say("Stopping the pushback.");
    this.state = "stopping";
    this.target = 0;
    this.stopTimer = 0;
  }

  disconnect() {
    this.apply(0, 0, false);
    this.say("Pushback and bypass pin removed.");
    if (this.tug.type === "pushback") this.state = "leaving";
    else this.state = "off";
  }

  /** Off at once (a reset or a new flight). */
  reset() {
    if (this.active && this.state !== "leaving") this.apply(0, 0, false);
    const p = this.props;
    if (this.tug.type === "pushback") {
      p.set("/sim/model/pushback/position-norm", 0);
      p.set("/sim/model/pushback/enabled", false);
    }
    this.position = 0;
    this.state = "off";
  }

  /** Puts the force and steering where the aircraft's flight model takes them. */
  apply(force, steer, connected) {
    const p = this.props;
    const fdm = this.sim.fdm;
    switch (this.tug.type) {
      case "autopush": {
        const yaw = p.get("/sim/model/autopush/yaw") * CONFIG.K_yaw * D2R;
        p.set("/sim/model/autopush/connected", connected);
        p.set("/sim/model/autopush/force-lbf", connected ? force : 0);
        p.set("/sim/model/autopush/force-x", Math.cos(yaw));
        p.set("/sim/model/autopush/force-y", Math.sin(yaw));
        p.set("/sim/model/autopush/force-z", 0);
        p.set("/sim/model/autopush/steer-cmd-norm", connected ? steer : 0);
        break;
      }
      case "towbar":
        p.set("external_reactions/towbar/attached", connected ? 1 : 0);
        p.set("external_reactions/towbar/magnitude", connected ? force : 0);
        p.set("external_reactions/towbar/steer-deg", connected ? steer * (this.tug.maxSteerDeg ?? 30) : 0);
        break;
      case "pushback": {
        // JSBSim's pushback system holds the speed (Systems/pushback.xml).
        const w = p.get("inertia/weight-lbs");
        p.set("/sim/model/pushback/kp", w / 20);
        p.set("/sim/model/pushback/ki", w / 40);
        p.set("/sim/model/pushback/kd", 0);
        p.set("/sim/model/pushback/target-speed-fps", connected ? this.target * KMH_TO_FPS : 0);
        p.set("/sim/model/pushback/position-norm", connected ? 1 : this.position);
        fdm.steerOverride = connected ? steer : null;
        break;
      }
    }
  }

  /** autopush.nas _loop(): force for the target speed, along the nose wheel. */
  speedControl(dt) {
    const p = this.props;
    if (!p.getBool("/gear/gear[0]/wow")) return 0;
    const V = p.get("/gear/gear[0]/rollspeed-ms") * 3.6;
    const deltaV = this.target - V;
    const minusDV = this.V - V;
    const prop = clamp(CONFIG.K_p * deltaV, -CONFIG.F_p, CONFIG.F_p);
    // autopush.nas skips the integral on long frames; a slow frame rate
    // here should not stall the push, so it integrates over at most 50 ms.
    if (dt > 0) this.int = clamp(this.int + CONFIG.K_i * deltaV * Math.min(dt, 0.049), -CONFIG.F_i, CONFIG.F_i);
    const deriv = dt > 0.002 ? clamp((CONFIG.K_d * minusDV) / dt, -CONFIG.F_d, CONFIG.F_d) : 0;
    this.V = V;
    return (prop + this.int + deriv) * p.get("inertia/weight-lbs") * UNITCONV;
  }

  /** driver.nas _loop(): target speed and steering along the route. */
  drive(dt) {
    const p = this.props;
    const pos = { lat: p.get("/position/latitude-deg"), lon: p.get("/position/longitude-deg") };
    const hdg = p.get("/orientation/heading-deg");
    if (this.toWp === 0) {
      // driver.nas start(): push if the first leg is behind the aircraft.
      const psiPark = courseAndDistance(this.route[0], this.route[1]).course;
      this.push = Math.abs(normdeg180(hdg - psiPark)) > 90 ? 1 : 0;
      this.sign = 1 - 2 * this.push;
      this.toWp = 1;
      this.psi = hdg + this.push * 180;
    }
    const wp = this.route[this.toWp];
    const { course: A, dist: D } = courseAndDistance(pos, wp);
    const psiLeg = courseAndDistance(this.route[this.toWp - 1], wp).course;
    const deltaPsi = normdeg180(A - psiLeg);
    const psi = hdg + this.push * 180;
    const deltaA = clamp(CONFIG.K_psi * normdeg180(A - psi), -CONFIG.F_psi, CONFIG.F_psi);
    const minusPsiDot = dt > 0.002
      ? clamp((CONFIG.K_psidot * normdeg180(this.psi - psi)) / dt, -CONFIG.F_psidot, CONFIG.F_psidot) : 0;
    this.psi = psi;
    const last = this.toWp === this.route.length - 1;
    if (last) {
      if (D < CONFIG.D_stop || Math.abs(deltaPsi) > 90) {
        this.done();
        return;
      }
    } else if (D < CONFIG.R_turn_min || Math.abs(deltaPsi) > 90) {
      this.toWp++;
    }
    this.target = this.sign * (this.tug.speedKmh ?? 8);
    this.steer = clamp(this.sign * (deltaA + minusPsiDot), -1, 1);
  }

  done() {
    this.target = 0;
    this.steer = 0;
    this.state = "stopping";
    this.stopTimer = 0;
    const p = this.props;
    // driver.nas: "Push back facing ..." is said when it starts; at the end:
    this.say(`Pushback complete${p.getBool("/controls/gear/brake-parking") ? "" : ", please set parking brake"}.`);
    this.completed = true;
  }

  /** The heading the aircraft will face at the end of the route (driver.nas). */
  facing() {
    const r = this.route;
    const c = courseAndDistance(r[r.length - 2], r[r.length - 1]).course;
    return (c + 180) % 360;
  }

  update(dt) {
    const p = this.props;
    switch (this.state) {
      case "off":
        return;
      case "arriving":
        this.position = Math.min(1, this.position + dt / ARRIVE_S);
        p.set("/sim/model/pushback/position-norm", this.position);
        if (this.position >= 1) this.hookUp();
        return;
      case "leaving":
        this.position = Math.max(0, this.position - dt / ARRIVE_S);
        p.set("/sim/model/pushback/position-norm", this.position);
        if (this.position <= 0) {
          p.set("/sim/model/pushback/enabled", false);
          this.state = "off";
        }
        return;
      case "connected": {
        this.apply(this.speedControl(dt), 0, true);
        const brakes = Math.max(p.get("/controls/gear/brake-left"), p.get("/controls/gear/brake-right"));
        if (!p.getBool("/controls/gear/brake-parking") && brakes < 0.1) {
          this.state = "pushing";
          this.completed = false;
          const face = Math.round((this.facing() - p.get("/environment/magnetic-variation-deg") + 360) % 360);
          this.say(`Push back facing ${String(face === 0 ? 360 : face).padStart(3, "0")}.`);
        }
        return;
      }
      case "pushing":
        this.drive(dt);
        this.apply(this.speedControl(dt), this.steer, true);
        return;
      case "stopping": {
        this.target = 0;
        this.apply(this.speedControl(dt), 0, true);
        this.stopTimer += dt;
        const still = Math.abs(p.get("/velocities/groundspeed-kt")) < 0.6;
        if ((still && (p.getBool("/controls/gear/brake-parking") || this.stopTimer > 8)) || this.stopTimer > 20) {
          this.disconnect();
        }
        return;
      }
    }
  }
}
