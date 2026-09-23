// WGS84 geodesy and the render frame.
//
// Everything is rendered in an east/north/up frame anchored at a reference
// point (mapped to three.js axes x = east, y = up, z = south), so the Earth's
// curvature is correct over the whole scenery area.  Scenery tiles and the
// aircraft keep their own local frames and are placed with double-precision
// matrices computed here, which keeps float32 GPU precision where it matters.

import * as THREE from "three";

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export function geodeticToEcef(latDeg, lonDeg, h, out = [0, 0, 0]) {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  out[0] = (n + h) * c * Math.cos(lon);
  out[1] = (n + h) * c * Math.sin(lon);
  out[2] = (n * (1 - WGS84_E2) + h) * s;
  return out;
}

export function ecefToGeodetic(x, y, z) {
  const b = WGS84_A * (1 - WGS84_F);
  const ep2 = WGS84_E2 / (1 - WGS84_E2);
  const p = Math.hypot(x, y);
  const th = Math.atan2(z * WGS84_A, p * b);
  const st = Math.sin(th);
  const ct = Math.cos(th);
  const lat = Math.atan2(z + ep2 * b * st * st * st, p - WGS84_E2 * WGS84_A * ct * ct * ct);
  const lon = Math.atan2(y, x);
  const sl = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
  return { lat: lat * R2D, lon: lon * R2D, alt: p / Math.cos(lat) - n };
}

/** East, north and up unit vectors (ECEF) at a geodetic position. */
export function enuBasis(latDeg, lonDeg) {
  const la = latDeg * D2R;
  const lo = lonDeg * D2R;
  const sla = Math.sin(la), cla = Math.cos(la), slo = Math.sin(lo), clo = Math.cos(lo);
  return {
    e: [-slo, clo, 0],
    n: [-sla * clo, -sla * slo, cla],
    u: [cla * clo, cla * slo, sla],
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class RenderFrame {
  constructor(lat, lon) {
    this.setReference(lat, lon);
  }

  setReference(lat, lon) {
    this.lat = lat;
    this.lon = lon;
    this.ref = geodeticToEcef(lat, lon, 0);
    this.basis = enuBasis(lat, lon);
  }

  /** ECEF vector (direction, no translation) -> render axes. */
  dirToRender(v, out = new THREE.Vector3()) {
    const { e, n, u } = this.basis;
    return out.set(dot(e, v), dot(u, v), -dot(n, v));
  }

  ecefToRender(p, out = new THREE.Vector3()) {
    const d = [p[0] - this.ref[0], p[1] - this.ref[1], p[2] - this.ref[2]];
    return this.dirToRender(d, out);
  }

  renderToEcef(v) {
    const { e, n, u } = this.basis;
    const x = v.x, y = v.y, z = -v.z; // east, up, north
    return [
      this.ref[0] + e[0] * x + u[0] * y + n[0] * z,
      this.ref[1] + e[1] * x + u[1] * y + n[1] * z,
      this.ref[2] + e[2] * x + u[2] * y + n[2] * z,
    ];
  }

  geodeticToRender(lat, lon, h, out = new THREE.Vector3()) {
    return this.ecefToRender(geodeticToEcef(lat, lon, h), out);
  }

  renderToGeodetic(v) {
    const p = this.renderToEcef(v);
    return ecefToGeodetic(p[0], p[1], p[2]);
  }

  /**
   * Matrix taking a local frame at (lat, lon, h) with axes
   * (x = east, y = north, z = up) into the render frame.
   */
  enuMatrix(lat, lon, h, out = new THREE.Matrix4()) {
    const b = enuBasis(lat, lon);
    const E = this.dirToRender(b.e);
    const N = this.dirToRender(b.n);
    const U = this.dirToRender(b.u);
    const T = this.geodeticToRender(lat, lon, h);
    return out.set(
      E.x, N.x, U.x, T.x,
      E.y, N.y, U.y, T.y,
      E.z, N.z, U.z, T.z,
      0, 0, 0, 1,
    );
  }

  /** Same as enuMatrix but for a frame whose origin is given in ECEF. */
  enuMatrixAtEcef(ecef, lat, lon, out = new THREE.Matrix4()) {
    const b = enuBasis(lat, lon);
    const E = this.dirToRender(b.e);
    const N = this.dirToRender(b.n);
    const U = this.dirToRender(b.u);
    const T = this.ecefToRender(ecef);
    return out.set(
      E.x, N.x, U.x, T.x,
      E.y, N.y, U.y, T.y,
      E.z, N.z, U.z, T.z,
      0, 0, 0, 1,
    );
  }

  /** Local "up" at a render-frame point. */
  upAt(v, out = new THREE.Vector3()) {
    const g = this.renderToGeodetic(v);
    return this.dirToRender(enuBasis(g.lat, g.lon).u, out);
  }
}

/**
 * Orientation of a FlightGear aircraft model in the render frame.
 * FlightGear models use x = aft, y = right, z = up; JSBSim gives the body
 * attitude (phi, theta, psi) relative to local north/east/down.
 */
export function aircraftMatrix(frame, lat, lon, alt, rollDeg, pitchDeg, headingDeg, out = new THREE.Matrix4()) {
  const enu = frame.enuMatrix(lat, lon, alt);
  const phi = rollDeg * D2R, th = pitchDeg * D2R, psi = headingDeg * D2R;
  const cph = Math.cos(phi), sph = Math.sin(phi), cth = Math.cos(th), sth = Math.sin(th);
  const cps = Math.cos(psi), sps = Math.sin(psi);
  // Body axes (x fwd, y right, z down) expressed in NED.
  const xb = [cth * cps, cth * sps, -sth];
  const yb = [sph * sth * cps - cph * sps, sph * sth * sps + cph * cps, sph * cth];
  const zb = [cph * sth * cps + sph * sps, cph * sth * sps - sph * cps, cph * cth];
  // NED -> ENU: (n, e, d) -> (e, n, -d)
  const toEnu = (v) => [v[1], v[0], -v[2]];
  // FlightGear model axes: x aft = -xb, y right = yb, z up = -zb.
  const mx = toEnu(xb).map((c) => -c);
  const my = toEnu(yb);
  const mz = toEnu(zb).map((c) => -c);
  const local = new THREE.Matrix4().set(
    mx[0], my[0], mz[0], 0,
    mx[1], my[1], mz[1], 0,
    mx[2], my[2], mz[2], 0,
    0, 0, 0, 1,
  );
  return out.multiplyMatrices(enu, local);
}
