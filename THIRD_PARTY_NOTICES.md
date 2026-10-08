# Third-party notices

This repository and the website it builds include work from the projects
below. The combined work is distributed under the GNU General Public
License, version 2 or later (see `LICENSE`).

## FlightGear

- Website: https://www.flightgear.org/
- Sources: https://gitlab.com/flightgear/fgdata and https://gitlab.com/flightgear/flightgear
- License: GNU General Public License, version 2 or later

Included or converted from FlightGear 2024.1:

- The Cessna 172P aircraft (`Aircraft/c172p`) by the c172p team
  (https://github.com/c172p-team/c172p): flight model, systems, 3D model,
  textures and effects.
- The Boeing 747-400 (`Aircraft/747-400`, the Aircraft-2024 package from the
  FlightGear download mirrors) by Gijs de Rooy, Jonathan Redpath, Ivan
  Ngeow, Markus Bulik, Alexander Barrett, Ron Jensen and the 747 team
  (https://github.com/gijsrooy/747-400): flight model, property rules,
  3D model, textures and sounds. Its `COPYING` is the GNU General Public
  License, version 2.
- The pushback tugs (`Models/Airport/Pushback`: the Goldhofer tug the 747
  tows with, and the military tug used for the F-16), models and artwork
  courtesy of the XPGoodWay team.
- Airport ground networks from TerraSync (`Airports/*/*.groundnet.xml`):
  parking positions, pushback routes and taxiways, by the FlightGear
  scenery contributors.
- Material definitions and textures (`Materials/`, `Textures/`).
- The airport database (`Airports/apt.dat.gz`).
- The star catalogue (`Astro/stars.gz`, from the Yale Bright Star Catalogue).
- Shared and static scenery models from TerraSync (`Models/`, `Objects/`),
  and World Scenery 2.0 terrain (`Terrain/`) for 37–38°N, 121–123°W. These
  are the work of the FlightGear scenery contributors
  (https://scenery.flightgear.org/).
- JavaScript ports of FlightGear code and scripts:
  - its JSBSim interface (`src/FDM/JSBSim/JSBSim.cxx`)
  - instruments and systems (`src/Instrumentation`, `src/Systems`)
  - property rules and autopilot components (`src/Autopilot`)
  - input bindings and commands
  - the view system
  - the c172p's Nasal scripts
  - the 747-400's Nasal hydraulics and autostart (`744_hyd.nas`, `system.nas`)
  - `Nasal/controls.nas`
  - Autopush, the pushback tug (`Nasal/Autopush/autopush.nas` and
    `driver.nas`, Copyright (c) 2018 Michael Danilov, Joshua Davidson and
    Merspieler, GPL-2.0)
- A port of the procedural light shader (`Shaders/light-ALS.*`).

## 737-family (the Boeing 737 MAX 8)

- Sources: https://github.com/naviat-dev/737-family
- License: GNU General Public License, version 2 (its `LICENSE`)
- Authors: Israel Emmanuel (naviat), Josh Davidson (Octal450), Austin
  Tallent (falconbird16), Braindamage, Captain Jake, Marsdolphin, Semir
  Gebran (CaptB), SP-NTX and the 737 MAX team; its JSBSim flight model by
  Michael Soitanen, YV3399, Octal450 and sriemmanuel787

Included or converted by `tools/build_737.sh`:

- From its `dev` branch (commit 2d6ebdc): the JSBSim flight model
  (`737-8.xml`, the LEAP-1B and 131-9D APU engines, the APU, electrical and
  hydraulic systems), the property rules, the Autopush tug configuration
  and the sound recordings (the SASA CFM56 set, callouts and GPWS voices),
  in `site/data/fdm/737-8.json` and `site/data/aircraft/737-8`.
- From its `fde` branch (commit 8c26140): the 3D model and textures
  (`Models/737-8.ac`), its ALS lights and the Kalmar FB250 pushback tug.
- `site/js/aircraft/b738m.js` adjusts the flight model as it loads (see the
  comments there) and does what the project's unfinished Nasal does not yet:
  brakes, speedbrake, autobrakes, reversers, engine and APU starts.
- `tools/b737/737-8-web.xml` (the model on the flight model's gear, the tug,
  lights, spoilers and nose gear retraction) and `tools/b737/b737-sound.xml`
  are written for this website from the project's files.

## X-Plane Scenery Gateway

- Website: https://gateway.x-plane.com/
- License: GNU General Public License, version 2 or later (the Gateway's
  airport data, which FlightGear's `apt.dat` also comes from)

Used by `tools/build_groundnets.py` (the scenery ids are in each
`site/data/scenery/groundnets/*.json`): taxiway names for FlightGear's
ground networks, and the ATC taxi routes and ramp starts of the airports
TerraSync has no ground network for.

## SimGear

- Sources: https://gitlab.com/flightgear/simgear
- License: GNU Library General Public License, version 2 or later
  (`simgear/magvar/coremag.cxx` states it was released under the GPL)

Used:

- The World Magnetic Model code (`wasm/third_party/simgear-magvar`).
- JavaScript ports of:
  - conditions and expressions
  - the model loader and animations
  - pick callbacks
  - scenery object placement
  - the BTG reader

## JSBSim

- Website: https://jsbsim.sourceforge.net/
- Sources: https://github.com/JSBSim-Team/jsbsim
- License: GNU Lesser General Public License, version 2.1 or later

JSBSim 1.3.1 is compiled to WebAssembly (`site/wasm/jsbsim.wasm`).
`wasm/build.sh` downloads the sources and applies
`wasm/patches/jsbsim-emscripten.patch`.

JSBSim's F-16 flight model (`aircraft/f16`, with `engine/F100-PW-229.xml`
and `engine/direct.xml`) by Erik Hofman is included in
`site/data/fdm/f16.json`. Its files state the GNU General Public License.

## FlightGear F-16 (FGAddon)

- Sources: https://sourceforge.net/p/flightgear/fgaddon/ (`Aircraft/f16`)
- License: GNU General Public License, version 2 or later
- Copyright (C) 2023 Erik Hofman and the F-16's authors (see its
  `authors.txt`); engine recordings by Carsten "GEED" Brueggmann

Its sound recordings are included, resampled, in
`site/data/aircraft/f16/sound`.

## F-16 3D model

`site/data/aircraft/f16/model/f16.glb` is converted from
`F-16_EXP_animated.blend`, supplied by the repository owner.

## three.js

- Website: https://threejs.org/
- License: MIT (see `site/vendor/three.LICENSE`)

`site/vendor/addons` holds three.js's glTF loader and the utilities it
imports, from the same release (r186).

## Emscripten

- Website: https://emscripten.org/
- License: MIT / University of Illinois/NCSA Open Source License

The JavaScript runtime in `site/wasm/jsbsim.mjs` is generated by
Emscripten.
