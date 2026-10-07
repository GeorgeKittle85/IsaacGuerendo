# FlightGear Web

FlightGear's flight simulation running in a web browser. The JSBSim flight
dynamics engine, FlightGear's default flight model, is compiled to
WebAssembly. It flies FlightGear's Cessna 172P, an F-16 Fighting Falcon, or
FlightGear's Boeing 747-400 over FlightGear's own San Francisco Bay Area
scenery, rendered with three.js. Start at a gate, have a tug push you back,
and taxi out the way the ground controller tells you.

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
    edge flaps and canopy. The wheels turn and ride up and down with the
    struts' compression, and an afterburner plume lights up.
  - A head-up display in the cockpit view: pitch ladder, flight path marker,
    gun cross, airspeed, altitude, radar altitude, vertical speed, heading
    tape, Mach, G and angle of attack.
  - Engine, afterburner, gear and wind sounds recorded for FlightGear's F-16.
- **Boeing 747-400.** FlightGear's 747-400 (Gijs de Rooy and the 747 team).
  Pick it in the start menu.
  - Its own JSBSim flight model: four GE CF6-80C2B1F turbofans and an APU,
    flaps 1, 5, 10, 20, 25 and 30, body gear steering, thrust reversers.
  - Its property rules: autobrake, the four-position speedbrake lever with
    autospoilers, the PFD logic and the autopilot components.
  - Its Nasal ported where the flight model depends on it: the four
    hydraulic systems (without pressure the elevators float and the nose
    wheel freezes) and the autostart, which starts the APU and then all
    four engines.
  - Its 3D model, with the cockpit, lights, gear and flap animations, and
    its sounds.
- **Gates, pushback and ATC.** Choose **At a gate** in the start menu.
  - Gates and parking spots come from FlightGear's ground networks
    (TerraSync's `groundnet.xml`): 209 at San Francisco, and others at
    Oakland, San Jose and more Bay Area airports. The menu lists the ones
    big enough for the aircraft.
  - **Pushback:** a port of FlightGear's Autopush. The tug follows the
    gate's pushback route from the ground network, holding a walking pace
    and steering the nose wheel. The 747 is pushed by FlightGear's Goldhofer
    tug, the F-16 by its military tug (which drives in first), the Cessna
    by ground crew with its own towbar.
  - **ATC:** press **'** (as in FlightGear) to talk to San Francisco Ground,
    Tower and NorCal Departure. Ground clears you to the runway through
    named taxiways, with runway crossings and the hold short point:
    *"runway 28R, taxi via F, Q, C, cross runways 19R, 19L and 28L, hold
    short of runway 28R."* The route is drawn on the ground as a green
    line with a red bar at the hold short point, and Ground gives
    progressive taxi instructions before each turn ("turn left on
    Foxtrot"), a new route if you miss one, and a warning if you roll past
    the hold line. At the runway, Tower clears you for takeoff; after
    landing, Ground picks a free gate that fits and taxis you in.
  - The controllers talk through the browser's speech synthesis, in ATC
    phraseology (phonetic alphabet, runways and frequencies read out).
  - Taxi routing works on the ground network like FlightGear's ground
    controller (shortest route, with turn costs). The groundnets carry no
    taxiway names; they come from the same airport on the X-Plane Scenery
    Gateway (GPL), whose named ATC taxi routes are matched to FlightGear's
    taxiways. Where TerraSync has no ground network, the Gateway's routes
    and ramp starts are used, if its runways match FlightGear's.
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
?autostart&aircraft=747&airport=KSFO&runway=28R&position=gate&gate=D55&time=dusk&wind=280@10&vis=35000&range=25
```

| Parameter | Values |
| --- | --- |
| `aircraft` | `c172p` (default), `f16`, `747` |
| `position` | `runway`, `cold` (runway, engine off), `gate`, `gate-cold` (at a gate, engines off), `final` (3 nm final), `air` (3000 ft above the airport) |
| `gate` | a gate or parking spot, e.g. `D55` (implies `position=gate`) |
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
| `H` | Head-up display on / off |
| Shift+S | Engine start |

On touch screens the F-16 gets **Gear** and **Spd brk** buttons instead of
the flap buttons.

The 747-400 takes off with flaps 10 or 20 (a runway start sets 20) and
rotates at about 150 kt:

| Keys | Action |
| --- | --- |
| `[` `]` | Flaps: UP, 1, 5, 10, 20, 25, 30 |
| `g`, `G` | Gear up, gear down |
| Ctrl+B, `k`/`K` | Speedbrake lever: down, armed, flight detent, up |
| Delete | Thrust reversers (on the ground, at idle) |
| Shift+S | Autostart: APU, then engines 1–4 |

### From the gate

Start **At a gate**, then:

1. Press **'** and choose **Request pushback**. When the tug is connected,
   release the parking brake (**B**). The tug pushes you back along the
   gate's pushback route and unhooks; set the parking brake.
2. Press **'** and **Request taxi**. Follow the green line at 10–20 kt.
   Ground calls each turn; the panel at the top left shows the next one
   and how far it is.
3. Stop at the red bar (hold short). Ground hands you to Tower: press **'**,
   **Ready for departure**, and take off when cleared.

After landing, slow down, leave the runway and press **'** for **Request
taxi to the gate**.

| Keys | Action |
| --- | --- |
| `'` | ATC menu (also the **ATC** button) |
| `1`–`9` | Choose in the ATC menu |

## Repository layout

| Path | Contents |
| --- | --- |
| `site/` | The website: `index.html`, `css/`, `js/`, `wasm/` (JSBSim build), `data/` (converted FlightGear data), `vendor/` (three.js) |
| `site/js/fdm`, `props`, `systems`, `instruments`, `aircraft`, `nasal` | The simulation: JSBSim interface, property tree, property rules, instruments, c172p, F-16 and 747-400 systems, the aircraft list, Nasal translator |
| `site/js/atc` | Ground operations: ground networks and taxi routing, the pushback tug (Autopush), the ATC, the taxi line |
| `site/js/scene`, `model` | Rendering: geodesy, scenery tiles and materials, sky, lights, scenery objects, AC3D and FlightGear model loading, glTF aircraft models |
| `site/js/sound` | Aircraft sound (SimGear's XML sound system on Web Audio) |
| `site/js/app` | User interface: controls, input, touch controls, views, menu, flight data strip, radio |
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

The 747-400 comes from FlightGear's Aircraft-2024 package, plus a few shared
FGData files (defaults, effects, the pushback tugs) that `tools/build_747.sh`
fetches with a sparse checkout of FGData:

```sh
tools/build_747.sh            # downloads 747-400.zip from the FlightGear mirror
```

The ground networks (gates, pushback routes, taxiways) come from TerraSync,
with taxiway names from the X-Plane Scenery Gateway:

```sh
python3 tools/build_groundnets.py --scenery site/data/scenery --cache build/groundnets
```

To rebuild the flight model itself, install the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
and run:

```sh
source /path/to/emsdk/emsdk_env.sh
wasm/build.sh build/wasm
```

## Tests

```sh
npm test                  # flight model smoke test, Nasal translator and ground operations tests (Node only)
npm install && npm run test:e2e -- --chromium /path/to/chrome [--aircraft f16|747] [--gate D55]
```

The smoke test flies takeoffs with the WebAssembly JSBSim, the c172p, the
F-16 and the 747 (with the gear coming up), checks the climbs, and starts
the F-16's and the 747's engines from cold. The ground operations test
routes every airport's taxiways, then flies each aircraft through a whole
departure from a San Francisco gate: pushback, Ground's taxi clearance,
taxiing the route to the hold short point, the takeoff clearance and the
handoff to Departure; and an arrival: landing clearance, taxi in and
parking at a gate. The end-to-end test loads the site in headless
Chromium, takes off from San Francisco in the chosen aircraft and saves
screenshots; with `--gate`, it starts at that gate, pushes back with the
tug and gets a taxi clearance instead.

## Credits and licenses

This project is licensed under the GNU General Public License, version 2 or
(at your option) any later version; see `LICENSE`. It is built from these
projects:

- [FlightGear](https://www.flightgear.org/): aircraft, scenery, materials,
  models, star catalogue, and the simulator code the JavaScript here is
  ported from (GPL-2.0-or-later).
- The Cessna 172P by the c172p team (GPL-2.0-or-later).
- The Boeing 747-400 by Gijs de Rooy and the 747 team (GPL-2.0), and
  FlightGear's Autopush pushback by Michael Danilov, Joshua Davidson and
  Merspieler (GPL-2.0).
- The X-Plane Scenery Gateway's airport data, for taxiway names
  (GPL-2.0-or-later).
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
