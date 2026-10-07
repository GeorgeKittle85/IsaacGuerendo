// The taxi route drawn on the ground, like an airport's "follow the greens"
// centreline lights: a glowing ribbon along the route ATC gave, with chevrons
// running the way to go, red bars at the hold short points, and a ring at a
// parking position.  The part already taxied fades out behind the aircraft.

import * as THREE from "three";

const LIFT = 0.25; // metres above the ground

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float along;
  attribute float side;
  varying float vAlong;
  varying float vSide;
  void main() {
    vAlong = along;
    vSide = side;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 color;
  uniform float passed;
  uniform float time;
  uniform float total;
  varying float vAlong;
  varying float vSide;
  void main() {
    #include <logdepthbuf_fragment>
    if (vAlong < passed - 4.0) discard;
    // Chevrons pointing along the route, moving that way.
    float chevron = fract((vAlong - abs(vSide) * 3.0 - time * 8.0) / 12.0);
    float glow = 0.7 + 0.6 * smoothstep(0.0, 0.25, chevron) * (1.0 - smoothstep(0.35, 0.55, chevron));
    float edge = 1.0 - smoothstep(0.85, 1.0, abs(vSide));
    float fadeIn = smoothstep(passed - 4.0, passed + 6.0, vAlong);
    float fadeOut = 1.0 - smoothstep(total - 40.0, total, vAlong) * 0.6;
    float a = edge * fadeIn * fadeOut;
    gl_FragColor = vec4(color * glow, a);
  }
`;

export class TaxiRouteView {
  /** frame: RenderFrame; elevation(lat, lon) -> metres or null; fallbackElev() -> metres. */
  constructor(scene, frame, elevation, fallbackElev) {
    this.scene = scene;
    this.frame = frame;
    this.elevation = elevation;
    this.fallbackElev = fallbackElev;
    this.group = new THREE.Group();
    this.group.name = "taxi-route";
    this.scene.add(this.group);
    this.visible = true;
    this.uniforms = null;
    this.time = 0;
  }

  setVisible(on) {
    this.visible = on;
    this.group.visible = on;
  }

  clear() {
    for (const o of [...this.group.children]) {
      o.geometry?.dispose();
      o.material?.dispose();
      this.group.remove(o);
    }
    this.uniforms = null;
  }

  /** A point on the airport's plane (net.latlon) to render coordinates, on the ground. */
  ground(net, x, y, lift = LIFT) {
    const ll = net.latlon(x, y);
    const e = this.elevation(ll.lat, ll.lon) ?? this.fallbackElev();
    return this.frame.geodeticToRender(ll.lat, ll.lon, e + lift);
  }

  /** The route from groundnet.js: {points, cum, length, hold, crossings, parking}. */
  show(route, net, { span = 20 } = {}) {
    this.clear();
    const width = Math.max(1.8, Math.min(4, span * 0.06));
    this.ribbon(route.points, net, width, 0x46f08c);
    for (const h of [route.hold, ...route.crossings].filter(Boolean)) this.bar(net, h, width, h === route.hold ? 0xff3030 : 0xffc040);
    if (route.parking) this.ring(net, route.points.at(-1), Math.max(2, span * 0.08));
    this.group.visible = this.visible;
  }

  /** A pushback route: the same line, amber, without chevron direction meaning. */
  showPath(points, net) {
    this.clear();
    this.ribbon(points, net, 1.6, 0xffb040);
  }

  progress(s) {
    if (this.uniforms) this.uniforms.passed.value = s;
  }

  update(dt) {
    this.time += dt;
    if (this.uniforms) this.uniforms.time.value = this.time;
  }

  ribbon(points, net, width, color) {
    // Resample every 3 m so the ribbon follows the ground.
    const pts = [];
    const along = [];
    let s = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(L / 3));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        along.push(s + L * t);
      }
      s += L;
    }
    if (pts.length < 2) return;
    const pos = [], alongAttr = [], sideAttr = [], index = [];
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
      let dx = p1.x - p0.x, dy = p1.y - p0.y;
      const L = Math.hypot(dx, dy) || 1;
      dx /= L;
      dy /= L;
      // Normal on the plane: (dy, -dx) is to the right of travel.
      for (const side of [-1, 1]) {
        const v = this.ground(net, pts[i].x + dy * side * width / 2, pts[i].y - dx * side * width / 2);
        pos.push(v.x, v.y, v.z);
        alongAttr.push(along[i]);
        sideAttr.push(side);
      }
      if (i > 0) {
        const a = 2 * (i - 1);
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("along", new THREE.Float32BufferAttribute(alongAttr, 1));
    geo.setAttribute("side", new THREE.Float32BufferAttribute(sideAttr, 1));
    geo.setIndex(index);
    this.uniforms = {
      color: { value: new THREE.Color(color) }, passed: { value: -10 }, time: { value: 0 }, total: { value: s },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    this.group.add(mesh);
  }

  /** A bar across the route at a hold short point. */
  bar(net, h, width, color) {
    const r = (h.dir * Math.PI) / 180;
    const fx = Math.sin(r), fy = Math.cos(r); // along the route
    const half = Math.max(6, width * 4);
    const depth = 0.9;
    const corners = [[-half, 0], [half, 0], [-half, depth], [half, depth]].map(([side, fwd]) =>
      this.ground(net, h.x + fy * side + fx * fwd, h.y - fx * side + fy * fwd, LIFT + 0.05));
    const geo = new THREE.BufferGeometry().setFromPoints(corners);
    geo.setIndex([0, 1, 2, 1, 3, 2]);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    this.group.add(mesh);
  }

  /** A ring where to stop at a parking position. */
  ring(net, p, radius) {
    const segs = 40;
    const pos = [];
    const index = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      for (const r of [radius, radius + 0.5]) {
        const v = this.ground(net, p.x + Math.sin(a) * r, p.y + Math.cos(a) * r, LIFT + 0.05);
        pos.push(v.x, v.y, v.z);
      }
      if (i > 0) {
        const k = 2 * (i - 1);
        index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    const mat = new THREE.MeshBasicMaterial({ color: 0x46f08c, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    this.group.add(mesh);
  }
}

