// On-screen controls for touch screens: a spring-centred yoke stick,
// a throttle lever, rudder/brake/flap buttons, and one-finger look /
// two-finger zoom on the 3D view.  Taps on cockpit switches still work
// (the browser turns taps into mouse clicks).

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class TouchControls {
  constructor(app) {
    this.app = app;
    this.stick = { x: 0, y: 0, id: null };
    this.rudder = 0;
    this.visible = false;
    this.pointers = new Map();
    this.build();
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    if (coarse) this.show(true);
    // Any real touch shows the controls (tablets with keyboards stay tidy until then).
    window.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch" && !this.visible) this.show(true); }, true);
  }

  build() {
    const el = document.createElement("div");
    el.id = "touch";
    el.hidden = true;
    el.innerHTML = `
      <div class="t-stick" aria-label="Yoke"><div class="t-knob"></div></div>
      <div class="t-throttle" aria-label="Throttle"><div class="t-fill"></div><span>THR</span></div>
      <div class="t-buttons">
        <button type="button" data-hold="rudder-left" aria-label="Rudder left">◀</button>
        <button type="button" data-hold="rudder-right" aria-label="Rudder right">▶</button>
        <button type="button" data-hold="brake">Brake</button>
        <button type="button" data-tap="park">Park</button>
        <button type="button" data-tap="flaps-up">Flaps −</button>
        <button type="button" data-tap="flaps-down">Flaps +</button>
        <button type="button" data-hold="trim-down" aria-label="Trim nose down">Trim ▼</button>
        <button type="button" data-hold="trim-up" aria-label="Trim nose up">Trim ▲</button>
      </div>`;
    document.body.append(el);
    this.el = el;
    this.knob = el.querySelector(".t-knob");
    this.fill = el.querySelector(".t-fill");

    const stick = el.querySelector(".t-stick");
    const moveStick = (e) => {
      const r = stick.getBoundingClientRect();
      const rad = r.width / 2;
      let x = (e.clientX - (r.left + rad)) / rad;
      let y = (e.clientY - (r.top + rad)) / rad;
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      this.stick.x = x;
      this.stick.y = y;
      this.knob.style.transform = `translate(${x * rad * 0.7}px, ${y * rad * 0.7}px)`;
    };
    stick.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      stick.setPointerCapture(e.pointerId);
      this.stick.id = e.pointerId;
      moveStick(e);
    });
    stick.addEventListener("pointermove", (e) => { if (e.pointerId === this.stick.id) moveStick(e); });
    const release = (e) => {
      if (e.pointerId !== this.stick.id) return;
      this.stick = { x: 0, y: 0, id: null };
      this.knob.style.transform = "";
    };
    stick.addEventListener("pointerup", release);
    stick.addEventListener("pointercancel", release);

    const thr = el.querySelector(".t-throttle");
    const setThrottle = (e) => {
      const r = thr.getBoundingClientRect();
      this.app.controls.setThrottle(clamp(1 - (e.clientY - r.top) / r.height, 0, 1));
    };
    thr.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      thr.setPointerCapture(e.pointerId);
      setThrottle(e);
    });
    thr.addEventListener("pointermove", (e) => { if (thr.hasPointerCapture(e.pointerId)) setThrottle(e); });

    this.holds = new Set();
    for (const b of el.querySelectorAll("button")) {
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        if (b.dataset.hold) this.startHold(b.dataset.hold);
        else this.tap(b.dataset.tap);
      });
      const up = () => { if (b.dataset.hold) this.endHold(b.dataset.hold); };
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
    }

    // Look around with one finger on the 3D view, zoom with two.
    const canvas = this.app.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    canvas.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 1) {
        this.app.views.look(e.clientX - p.x, e.clientY - p.y);
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = e.clientX;
        p.y = e.clientY;
        const after = Math.hypot(a.x - b.x, a.y - b.y);
        if (before > 0 && Math.abs(after - before) > 8) this.app.views.wheel(after > before ? -1 : 1);
        return;
      }
      p.x = e.clientX;
      p.y = e.clientY;
    });
    const drop = (e) => this.pointers.delete(e.pointerId);
    canvas.addEventListener("pointerup", drop);
    canvas.addEventListener("pointercancel", drop);
  }

  show(on) {
    this.visible = on;
    this.el.hidden = !on;
    document.body.classList.toggle("touch", on);
  }

  tap(act) {
    const c = this.app.controls;
    if (act === "park") c.toggleParkingBrake();
    else if (act === "flaps-up") c.flapsDown(-1);
    else if (act === "flaps-down") c.flapsDown(1);
  }

  startHold(act) {
    this.holds.add(act);
    if (act === "brake") this.app.controls.applyBrakes(1);
  }

  endHold(act) {
    this.holds.delete(act);
    if (act === "brake") this.app.controls.applyBrakes(0);
  }

  update(dt) {
    if (!this.visible || !this.app.flying) return;
    const p = this.app.sim.props;
    const c = this.app.controls;
    // Spring-centred stick with a softer centre, like a gamepad.
    const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.5);
    if (this.stick.id !== null || this.wasActive) {
      p.set("/controls/flight/aileron", curve(this.stick.x));
      p.set("/controls/flight/elevator", curve(this.stick.y));
      this.wasActive = this.stick.id !== null;
    }
    const target = this.holds.has("rudder-left") ? -1 : this.holds.has("rudder-right") ? 1 : 0;
    if (target || this.rudder) {
      this.rudder += clamp(target - this.rudder, -3 * dt, 3 * dt);
      if (!target && Math.abs(this.rudder) < 0.02) this.rudder = 0;
      p.set("/controls/flight/rudder", this.rudder);
    }
    if (this.holds.has("trim-up")) c.elevatorTrim(-0.1 * dt);
    if (this.holds.has("trim-down")) c.elevatorTrim(0.1 * dt);
    this.fill.style.height = `${Math.round(p.get("/controls/engines/engine[0]/throttle") * 100)}%`;
  }
}
