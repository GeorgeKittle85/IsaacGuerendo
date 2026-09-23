// JSBSim <-> JavaScript bridge for the FlightGear-in-the-browser build.
//
// Exposes a small C API (called from JS through cwrap) around a single
// FGFDMExec instance, plus a ground callback that asks the JavaScript scenery
// code for the terrain elevation and surface normal under any point, the same
// job FlightGear's own ground cache does for JSBSim on the desktop.

#include <emscripten.h>

#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "FGFDMExec.h"
#include "initialization/FGInitialCondition.h"
#include "initialization/FGTrim.h"
#include "input_output/FGGroundCallback.h"
#include "input_output/FGPropertyManager.h"
#include "math/FGColumnVector3.h"
#include "math/FGLocation.h"
#include "models/FGInertial.h"

// SimGear's WMM2020 magnetic model (third_party/simgear-magvar), compiled with
// renamed symbols so it does not clash with JSBSim's older bundled copy.
unsigned long int fgweb_yymmdd_to_julian_days(int yy, int mm, int dd);
double fgweb_calc_magvar(double lat, double lon, double h, long dat, double* field);

using namespace JSBSim;

// Implemented in JS (see site/js/fdm/jsbsim.js). Writes into out[0..3]:
//   elevation above the WGS84 ellipsoid (m), surface normal (east, north, up)
//   and returns 1 when terrain is known at that spot, 0 otherwise.
EM_JS(int, js_ground_query, (double latRad, double lonRad, double altM, double* out), {
  return Module.groundQuery ? Module.groundQuery(latRad, lonRad, altM, out >> 3) : 0;
});

namespace {

constexpr double kFtToM = 0.3048;

class WebGroundCallback : public FGGroundCallback {
public:
  WebGroundCallback(double semiMajor, double semiMinor) : a(semiMajor), b(semiMinor) {}

  double GetAGLevel(double /*t*/, const FGLocation& location, FGLocation& contact,
                    FGColumnVector3& normal, FGColumnVector3& vel,
                    FGColumnVector3& angularVel) const override {
    vel.InitMatrix();
    angularVel.InitMatrix();

    FGLocation l = location;
    l.SetEllipse(a, b);
    const double lat = l.GetGeodLatitudeRad();
    const double lon = l.GetLongitude();
    const double altFt = l.GetGeodAltitude();

    double q[4] = {0.0, 0.0, 0.0, 1.0};
    double elevFt = fallbackElevationFt;
    if (js_ground_query(lat, lon, altFt * kFtToM, q) && std::isfinite(q[0])) {
      elevFt = q[0] / kFtToM;
    } else {
      q[1] = 0.0; q[2] = 0.0; q[3] = 1.0;
    }

    // Local east/north/up normal -> ECEF.
    const double sLat = std::sin(lat), cLat = std::cos(lat);
    const double sLon = std::sin(lon), cLon = std::cos(lon);
    const double nE = q[1], nN = q[2], nU = q[3];
    normal = FGColumnVector3(-sLon * nE - sLat * cLon * nN + cLat * cLon * nU,
                              cLon * nE - sLat * sLon * nN + cLat * sLon * nU,
                              cLat * nN + sLat * nU);

    contact.SetEllipse(a, b);
    contact.SetPositionGeodetic(lon, lat, elevFt);
    return altFt - elevFt;
  }

  void SetTerrainElevation(double h) override { fallbackElevationFt = h; }
  void SetEllipse(double semimajor, double semiminor) override { a = semimajor; b = semiminor; }

private:
  double a, b;
  double fallbackElevationFt = 0.0;
};

std::unique_ptr<FGFDMExec> fdm;
std::vector<SGPropertyNode_ptr> handles;
std::string lastError;

void setError(const std::string& msg) { lastError = msg; }

// FGFDMExec's destructor unties every property, which evaluates the functions
// bound to them; if one refers to a property that was never created it throws
// from a destructor and terminates.  Untie first ourselves, creating whatever
// the error message names, and leak the instance rather than abort if anything
// else goes wrong.
void destroyFdm() {
  if (!fdm) return;
  for (int attempt = 0; attempt < 2000; ++attempt) {
    try {
      fdm->Unbind();
      fdm.reset();
      return;
    } catch (const std::exception& e) {
      const std::string msg = e.what();
      const std::string key = "The property ";
      const auto pos = msg.find(key);
      if (pos == std::string::npos) break;
      std::string name = msg.substr(pos + key.size());
      name = name.substr(0, name.find(' '));
      fdm->GetPropertyManager()->GetNode()->getNode(name, true);
    } catch (...) {
      break;
    }
  }
  fdm.release();  // intentionally leaked: safer than std::terminate
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* jsb_version() { return JSBSIM_VERSION; }

EMSCRIPTEN_KEEPALIVE const char* jsb_last_error() { return lastError.c_str(); }

// Creates a fresh FDM whose files live under rootDir in the virtual FS.
EMSCRIPTEN_KEEPALIVE int jsb_create(const char* rootDir) {
  try {
    handles.clear();
    destroyFdm();
    fdm = std::make_unique<FGFDMExec>();
    fdm->SetRootDir(SGPath(rootDir));
    fdm->SetDebugLevel(0);
    auto inertial = fdm->GetInertial();
    inertial->SetGroundCallback(
        new WebGroundCallback(inertial->GetSemimajor(), inertial->GetSemiminor()));
    return 1;
  } catch (const std::exception& e) {
    setError(e.what());
  } catch (...) {
    setError("unknown error creating FDM");
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE int jsb_load_model(const char* aircraftPath, const char* enginePath,
                                        const char* systemsPath, const char* model) {
  if (!fdm) return 0;
  try {
    if (fdm->LoadModel(SGPath(aircraftPath), SGPath(enginePath), SGPath(systemsPath),
                       model, true))
      return 1;
    setError(std::string("LoadModel failed for ") + model);
  } catch (const std::exception& e) {
    setError(e.what());
  } catch (...) {
    setError("unknown error loading model");
  }
  return 0;
}

// Returns a handle for a property path (relative paths are resolved under
// /fdm/jsbsim, absolute ones against the global tree like in FlightGear).
EMSCRIPTEN_KEEPALIVE int jsb_prop(const char* path, int create) {
  if (!fdm) return -1;
  auto pm = fdm->GetPropertyManager();
  SGPropertyNode* node = pm->GetNode()->getNode(path, create != 0);
  if (!node) return -1;
  for (size_t i = 0; i < handles.size(); ++i)
    if (handles[i] == node) return static_cast<int>(i);
  handles.push_back(node);
  return static_cast<int>(handles.size() - 1);
}

EMSCRIPTEN_KEEPALIVE double jsb_get(int h) {
  if (h < 0 || h >= static_cast<int>(handles.size())) return NAN;
  return handles[h]->getDoubleValue();
}

EMSCRIPTEN_KEEPALIVE void jsb_set(int h, double v) {
  if (h < 0 || h >= static_cast<int>(handles.size())) return;
  SGPropertyNode* n = handles[h];
  // Keep bool/int typed nodes typed, so conditions comparing them still work.
  switch (n->getType()) {
    case simgear::props::BOOL: n->setBoolValue(v != 0.0); break;
    case simgear::props::INT: n->setIntValue(static_cast<int>(std::lround(v))); break;
    case simgear::props::LONG: n->setLongValue(std::llround(v)); break;
    default: n->setDoubleValue(v); break;
  }
}

EMSCRIPTEN_KEEPALIVE void jsb_get_many(const int* hs, double* out, int n) {
  for (int i = 0; i < n; ++i) out[i] = jsb_get(hs[i]);
}

EMSCRIPTEN_KEEPALIVE void jsb_set_many(const int* hs, const double* in, int n) {
  for (int i = 0; i < n; ++i) jsb_set(hs[i], in[i]);
}

EMSCRIPTEN_KEEPALIVE const char* jsb_get_string(int h) {
  static std::string s;
  if (h < 0 || h >= static_cast<int>(handles.size())) return "";
  s = handles[h]->getStringValue();
  return s.c_str();
}

EMSCRIPTEN_KEEPALIVE void jsb_set_string(int h, const char* v) {
  if (h < 0 || h >= static_cast<int>(handles.size())) return;
  handles[h]->setStringValue(v);
}

EMSCRIPTEN_KEEPALIVE void jsb_set_bool(int h, int v) {
  if (h < 0 || h >= static_cast<int>(handles.size())) return;
  handles[h]->setBoolValue(v != 0);
}

// 0 none, 1 bool, 2 int/long, 3 float/double, 4 string, 5 alias, 6 other.
EMSCRIPTEN_KEEPALIVE int jsb_prop_type(int h) {
  if (h < 0 || h >= static_cast<int>(handles.size())) return 0;
  switch (handles[h]->getType()) {
    case simgear::props::BOOL: return 1;
    case simgear::props::INT:
    case simgear::props::LONG: return 2;
    case simgear::props::FLOAT:
    case simgear::props::DOUBLE: return 3;
    case simgear::props::STRING:
    case simgear::props::UNSPECIFIED: return 4;
    case simgear::props::ALIAS: return 5;
    case simgear::props::NONE: return 0;
    default: return 6;
  }
}

// Makes `path` an alias of `target` (FlightGear uses this for e.g.
// /engines/active-engine -> /engines/engine[0]).
EMSCRIPTEN_KEEPALIVE int jsb_alias(const char* path, const char* target) {
  if (!fdm) return 0;
  auto root = fdm->GetPropertyManager()->GetNode();
  SGPropertyNode* t = root->getNode(target, true);
  SGPropertyNode* n = root->getNode(path, true);
  return n->alias(t) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int jsb_run_ic() {
  if (!fdm) return 0;
  try {
    return fdm->RunIC() ? 1 : 0;
  } catch (const std::exception& e) {
    setError(e.what());
  } catch (...) {
    setError("unknown error in RunIC");
  }
  return 0;
}

// Runs up to `steps` integration steps; returns the number actually run.
EMSCRIPTEN_KEEPALIVE int jsb_run(int steps) {
  if (!fdm) return 0;
  int done = 0;
  try {
    for (; done < steps; ++done)
      if (!fdm->Run()) break;
  } catch (const std::exception& e) {
    setError(e.what());
  } catch (...) {
    setError("unknown error in Run");
  }
  return done;
}

// JSBSim trim modes: 0 longitudinal, 1 full, 2 ground, 3 pullup, 4 custom, 5 turn.
EMSCRIPTEN_KEEPALIVE int jsb_trim(int mode) {
  if (!fdm) return 0;
  try {
    FGTrim trim(fdm.get(), static_cast<TrimMode>(mode));
    return trim.DoTrim() ? 1 : 0;
  } catch (const std::exception& e) {
    setError(e.what());
  } catch (...) {
    setError("unknown error in trim");
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE double jsb_get_dt() { return fdm ? fdm->GetDeltaT() : 0.0; }

EMSCRIPTEN_KEEPALIVE void jsb_set_dt(double dt) {
  if (fdm) fdm->Setdt(dt);
}

EMSCRIPTEN_KEEPALIVE double jsb_sim_time() { return fdm ? fdm->GetSimTime() : 0.0; }

// Magnetic variation in degrees (east positive), like FlightGear's
// /environment/magnetic-variation-deg.  yy is the two digit year.
EMSCRIPTEN_KEEPALIVE double jsb_magvar_deg(double latDeg, double lonDeg, double altM,
                                            int yy, int mm, int dd) {
  double field[6];
  const double d2r = M_PI / 180.0;
  const long jd = static_cast<long>(fgweb_yymmdd_to_julian_days(yy, mm, dd));
  return fgweb_calc_magvar(latDeg * d2r, lonDeg * d2r, altM / 1000.0, jd, field) / d2r;
}

// Magnetic dip (inclination) in degrees, down positive, like SGMagVar::get_magdip().
EMSCRIPTEN_KEEPALIVE double jsb_magdip_deg(double latDeg, double lonDeg, double altM,
                                            int yy, int mm, int dd) {
  double field[6];
  const double d2r = M_PI / 180.0;
  const long jd = static_cast<long>(fgweb_yymmdd_to_julian_days(yy, mm, dd));
  fgweb_calc_magvar(latDeg * d2r, lonDeg * d2r, altM / 1000.0, jd, field);
  return std::atan(field[5] / std::sqrt(field[3] * field[3] + field[4] * field[4])) / d2r;
}

EMSCRIPTEN_KEEPALIVE void jsb_hold(int on) {
  if (!fdm) return;
  if (on) fdm->Hold(); else fdm->Resume();
}

}  // extern "C"
