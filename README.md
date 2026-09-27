# FlightGear Web

FlightGear's flight simulation running in a web browser. The JSBSim flight
dynamics engine, FlightGear's default flight model, is compiled to
WebAssembly. It flies FlightGear's Cessna 172P, or an F-16 Fighting Falcon,
over FlightGear's own San Francisco Bay Area scenery, rendered with three.js.

The whole thing is a static website with no server-side code. It can be
hosted on GitHub Pages or any web server.

## What's in it

- **Flight model.** JSBSim 1.3.1, built with Emscripten, runs the c172p
  JSBSim model at 120 Hz.
  - Ground contact uses the real scenery triangles, and the surface
    material under each wheel sets friction and bumpiness, as in FlightGear.
  - A port of FlightGear's JSBSim interface connects the controls,
    engines, fuel, gear and environment.
- **Aircraft systems.**
  - FlightGear's property tree, with its property rules and autopilot
    components.
  - The standard instruments: pitot/static and vacuum systems, airspeed,
    altimeter, attitude, heading, turn coordinator, VSI and compass.
  - The c172p's electrical and engine logic.
  - Engine starts work as in FlightGear: magnetos, primer and starter, or
    autostart.
- **Cockpit.** The c172p 3D model with its FlightGear animations.
  - Gauges, switches, knobs and doors respond to the mouse and show
    tooltips, following SimGear's rules.
  - The Nasal snippets in the aircraft's bindings run through a small
    Nasal-to-JavaScript translator.
  - FlightGear's procedural lights (nav, strobe, beacon, cabin) are drawn
    with a port of its light shader.
- **F-16 Fighting Falcon.** Pick it in the start menu.
  - JSBSim's own F-16 flight model: fly-by-wire flight controls, automatic
    flaperons and leading edge flaps, and an F100-PW-229 turbofan with
    afterburner. The engine starts like a jet: the starter spins it up, and
    the fuel comes on at 20% N2.
  - A 3D model converted from Blender to glTF. Its own animations drive the
    gear retraction, flaperons, stabilators, rudder, speed brakes, leading
    edge flaps and canopy. The wheels turn, and an afterburner plume lights up.
  - Engine, afterburner, gear and wind sounds recorded for FlightGear's F-16.
- **Scenery.** FlightGear World Scenery 2.0 for 37–38°N, 121–123°W, with
  FlightGear's regional materials.
  - Runways and markings, plus runway, taxiway and approach lighting
    (PAPI, REIL, sequenced flashers).
  - TerraSync scenery objects: the Golden Gate and Bay Bridges, downtown
    San Francisco, the SFO and Oakland terminals, and more.
- **Sky.** The sun is placed from the real date and time, and the night sky
  uses FlightGear's star catalogue. Haze follows the visibility setting.
- **Sound.** The c172p's FlightGear sound configuration (engine, wind,
  stall horn, tyres, flaps, switches, doors) plays through the Web Audio
  API, following SimGear's sound rules.
- **Controls.** FlightGear's keyboard bindings, a mouse yoke mode, gamepads
  and joysticks. On phones and tablets, on-screen controls appear: a stick,
  a throttle lever, and rudder, brake, flap and trim buttons.
- **Views.** Cockpit, helicopter, chase, tower and fly-by.

## Running it locally

Serve the `site/` directory with any static web server, then open it in a
browser with WebGL 2 (current Chrome, Edge, Firefox or Safari):

```sh
python3 -m http.server --directory site 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk will not work: browsers block
WebAssembly and module loading from `file://` URLs.

URL parameters skip the start menu, for example:

```
?autostart&aircraft=f16&airport=KSFO&runway=28R&position=final&time=dusk&wind=280@10&vis=35000&range=25
```

| Parameter | Values |
| --- | --- |
| `aircraft` | `c172p` (default), `f16` |
| `position` | `runway`, `cold` (runway, engine off), `final` (3 nm final), `air` (3000 ft above the airport) |
| `time` | `morning`, `noon`, `afternoon`, `dusk`, `evening`, `midnight`, `now` |
| `wind` | direction the wind blows from @ speed in knots |
| `vis` | visibility in metres |
| `range` | scenery loading radius in km |

## Deploying to GitHub Pages

`.github/workflows/pages.yml` publishes `site/` whenever `main` changes. To
enable it, go to the repository's **Settings → Pages** and set **Source** to
**GitHub Actions**.

## Flying

The start menu picks the aircraft, airport, runway, time of day and weather.
On a runway start the parking brake is set: press **B** to release it, then
**Page Up** to add power. Press **?** in the simulator for the full list of
keys.

| Keys | Action |
| --- | --- |
| Arrow keys or numpad 8 2 4 6 | Elevator and ailerons |
| Numpad 0 / Enter | Rudder |
| Page Up / Page Down | Throttle |
| Home / End | Elevator trim |
| `[` `]` | Flaps |
| `b`, `B` | Brakes, parking brake |
| `s`, Shift+S | Starter, autostart |
| `v`, right-drag, `x`/`X` | Change view, look around, zoom |
| Tab | Mouse controls the yoke |
| `p`, `a`/`A` | Pause, speed up / slow down |

In the F-16, the top half of the throttle is the afterburner (the flight
data strip shows **AB**), and the flaps are automatic:

| Keys | Action |
| --- | --- |
| `g`, `G` | Gear up, gear down (not with weight on the wheels) |
| `k`, `K`, Ctrl+B | Speed brake in, out, toggle |
| `c` | Canopy (on the ground) |
| Shift+S | Engine start |

On touch screens the F-16 gets **Gear** and **Spd brk** buttons instead of
the flap buttons.

## Repository layout

| Path | Contents |
| --- | --- |
| `site/` | The website: `index.html`, `css/`, `js/`, `wasm/` (JSBSim build), `data/` (converted FlightGear data), `vendor/` (three.js) |
| `site/js/fdm`, `props`, `systems`, `instruments`, `aircraft`, `nasal` | The simulation: JSBSim interface, property tree, property rules, instruments, c172p and F-16 systems, the aircraft list, Nasal translator |
| `site/js/scene`, `model` | Rendering: geodesy, scenery tiles and materials, sky, lights, scenery objects, AC3D and FlightGear model loading, glTF aircraft models |
| `site/js/sound` | Aircraft sound (SimGear's XML sound system on Web Audio) |
| `site/js/app` | User interface: controls, input, touch controls, views, menu, flight data strip |
| `wasm/` | JSBSim WebAssembly build script, C++ bridge and patch |
| `tools/` | Data conversion pipeline and tests (`tools/f16/`: the F-16's sound configuration) |

## Rebuilding the data

The converted data in `site/data` is committed, so none of this is needed
just to run or host the site.

Requirements:

- Python 3.9+ with Pillow and NumPy: `pip install -r tools/requirements.txt`
- Node.js 18+
- The FlightGear 2024.1 data package (`FlightGear-2024.1.x-data.txz` from
  the FlightGear download page), extracted: this is `FG_ROOT` below

```sh
tools/build_all.sh FG_ROOT build/terrasync
```

This downloads the needed TerraSync scenery (terrain, objects and shared
models, checked against TerraSync's SHA-1 indexes) and converts:

- the aircraft: flight model, properties, rules, 3D model, sounds
- the scenery: tiles, airports and objects
- the star catalogue

The F-16 comes from other sources: JSBSim's F-16 flight model, sounds from
FlightGear's F-16 in FGAddon, and the Blender model `F-16_EXP_animated.blend`.
`tools/build_f16.sh` downloads the first two and converts all three. It needs
Blender 4.x, or Python 3.11 with `pip install bpy==4.2.*`:

```sh
tools/build_f16.sh path/to/F-16_EXP_animated.blend
# or, with the bpy module: BLENDER_PYTHON=/path/to/python3.11 tools/build_f16.sh ...
```

The .blend file points to texture images in an `F-16 EXP.fbm` folder that
is not part of it. If that folder is next to the .blend, the textures are
converted as well; without it, the model is painted in F-16 greys.

To rebuild the flight model itself, install the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
and run:

```sh
source /path/to/emsdk/emsdk_env.sh
wasm/build.sh build/wasm
```

## Tests

```sh
npm test                  # flight model smoke test + Nasal translator tests (Node only)
npm install && npm run test:e2e -- --chromium /path/to/chrome [--aircraft f16]
```

The smoke test flies takeoffs with the WebAssembly JSBSim, first the c172p
and then the F-16 (with the gear coming up), checks the climbs, and starts
the F-16's engine from cold. The end-to-end test loads the site in headless
Chromium, takes off from San Francisco in the chosen aircraft and saves
screenshots.

## Credits and licenses

This project is licensed under the GNU General Public License, version 2 or
(at your option) any later version; see `LICENSE`. It is built from these
projects:

- [FlightGear](https://www.flightgear.org/): aircraft, scenery, materials,
  models, star catalogue, and the simulator code the JavaScript here is
  ported from (GPL-2.0-or-later).
- The Cessna 172P by the c172p team (GPL-2.0-or-later).
- [JSBSim](https://github.com/JSBSim-Team/jsbsim) (LGPL-2.1-or-later), and
  its F-16 flight model by Erik Hofman (GPL).
- Sounds from FlightGear's F-16
  ([FGAddon](https://sourceforge.net/p/flightgear/fgaddon/), GPL-2.0-or-later).
- The F-16 3D model `F-16_EXP_animated.blend`, supplied by the repository
  owner.
- [SimGear](https://gitlab.com/flightgear/simgear)'s magnetic variation
  model.
- [three.js](https://threejs.org/) (MIT).

See `THIRD_PARTY_NOTICES.md` for details.
