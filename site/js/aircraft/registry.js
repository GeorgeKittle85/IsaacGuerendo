// The aircraft the start menu offers: where each one's data lives, its
// systems code, its 3D model and its start-up numbers.
//
//   engines      throttles the pilot moves together (the 747's APU excluded)
//   flaps        flap detents (/sim/flaps/setting) and their names, if not
//                FlightGear's default of three equal steps
//   wingspanM    picks parking spots big enough (a spot's radius is half the
//                span it takes)
//   noseGearM    nose wheel ahead of the reference point: it follows the taxi line
//   tug          how a pushback tug moves it (ground/pushback.js): FlightGear's
//                autopush interface, the c172p's own towbar, or JSBSim's
//                generic pushback system
//   callsign     on the radio, written and spoken

import { C172P } from "./c172p.js";
import { F16, F16_PROPS, F16_RULES } from "./f16.js";
import { F16_MODEL } from "./f16-model.js";
import { B744 } from "./b744.js";

export const AIRCRAFT = [
  {
    id: "c172p",
    name: "Cessna 172P Skyhawk",
    short: "Cessna 172P",
    blurb: "FlightGear's four-seat trainer with a full 3D cockpit. Gentle, forgiving, 110 kt cruise.",
    // Plan-view silhouette for the start menu (64 × 64, nose up).
    icon: "M32 5c2 0 3 2 3 5v10h24c1 0 2 1 2 2v4c0 1-1 2-2 2H35v18l2 1h8c1 0 1.5.5 1.5 1.5v3c0 1-.5 1.5-1.5 1.5H34.5L32 60l-2.5-2H19c-1 0-1.5-.5-1.5-1.5v-3c0-1 .5-1.5 1.5-1.5h8l2-1V28H5c-1 0-2-1-2-2v-4c0-1 1-2 2-2h24V10c0-3 1-5 3-5z",
    data: { fdm: "data/fdm/c172p.json", props: "data/aircraft/c172p/props.json", rules: "data/aircraft/c172p/rules.json" },
    Systems: C172P,
    model: { type: "fg", url: "data/aircraft/c172p/model" },
    sound: "data/aircraft/c172p/sound",
    start: { finalKts: 70, finalFlaps: 1 / 3, airKts: 100 },
    engines: 2,
    wingspanM: 11,
    noseGearM: 1.05,
    tug: { type: "towbar", maxSteerDeg: 30, speedKmh: 4 },
    callsign: { text: "N85KG", spoken: "Skyhawk eight five kilo golf", short: "Skyhawk eight five kilo golf" },
  },
  {
    id: "f16",
    name: "F-16 Fighting Falcon",
    short: "F-16",
    blurb: "JSBSim's fly-by-wire F-16 with an afterburning F100 engine and retractable gear. Fast, twitchy, loud.",
    icon: "M32 2l2 10 1 10 2 4 21 16v4l-20-1v5l12 8v3l-15-2-1 3h-4l-1-3-15 2v-3l12-8v-5l-20 1v-4l21-16 2-4 1-10z",
    data: { fdm: "data/fdm/f16.json", props: F16_PROPS, rules: F16_RULES },
    Systems: F16,
    model: { type: "gltf", ...F16_MODEL },
    sound: "data/aircraft/f16/sound",
    retractableGear: true,
    speedbrake: true,
    autoFlaps: true,
    start: { finalKts: 155, airKts: 300, airGearUp: true, throttle: 0.4 },
    engines: 1,
    wingspanM: 9.96,
    noseGearM: 3.04,
    // FlightGear's military tug, hitched at the nose wheel (JSBSim's NOSE_LG contact).
    tug: { type: "pushback", maxSteerDeg: 80, speedKmh: 6,
      model: { url: "data/models/pushback-military", offset: [-3.04, 0, -1.83], steer: "fcs/steer-pos-deg" } },
    // Viper is the F-16's nickname; 85 is a certain 49ers tight end's number.
    callsign: { text: "VIPER85", spoken: "Viper eight five", short: "Viper eight five" },
  },
  {
    id: "747",
    name: "Boeing 747-400",
    short: "747-400",
    blurb: "FlightGear's Queen of the Skies: four CF6 turbofans, flaps 1 to 30, up to 397 tonnes. Push back from a gate and taxi it with ATC.",
    icon: "M32 2c1.6 0 2.6 2 2.6 5v14l7.4 5.4V23h3v5.6l5-3.6V22h3v5l7 5.2V36l-26-8.6V45l6.8 5.4V54L33 51l-1 3-1-3-8.8 3v-3.6L29 45V27.4L3 36v-3.8L10 27v-5h3v3l5 3.6V23h3v3.4L28.4 21V7c0-3 1-5 3.6-5z",
    data: { fdm: "data/fdm/747-400.json", props: "data/aircraft/747-400/props.json", rules: "data/aircraft/747-400/rules.json" },
    Systems: B744,
    model: { type: "fg", url: "data/aircraft/747-400/model" },
    sound: "data/aircraft/747-400/sound",
    retractableGear: true,
    speedbrake: "autospoilers",
    reversers: true,
    // 747-400-set.xml /sim/flaps: detents 0, 1, 5, 10, 20, 25 and 30.
    flaps: { settings: [0, 0.033, 0.167, 0.333, 0.667, 0.833, 1], names: ["UP", "1", "5", "10", "20", "25", "30"] },
    start: { finalKts: 150, finalFlaps: 0.833, airKts: 250, airGearUp: true, throttle: 0.6, takeoffFlaps: 0.667, runwayOffsetM: 50 },
    engines: 4,
    wingspanM: 64.4,
    noseGearM: 22.05,
    tug: { type: "autopush", speedKmh: 8 },
    callsign: { text: "FTH85", spoken: "Faithful eight five heavy", short: "Faithful eight five heavy" },
  },
];

export function aircraftById(id) {
  return AIRCRAFT.find((a) => a.id === id) ?? AIRCRAFT[0];
}
