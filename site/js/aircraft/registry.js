// The aircraft the start menu offers: where each one's data lives, its
// systems code, its 3D model and its start-up numbers.

import { C172P } from "./c172p.js";
import { F16, F16_PROPS, F16_RULES } from "./f16.js";
import { F16_MODEL } from "./f16-model.js";

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
  },
];

export function aircraftById(id) {
  return AIRCRAFT.find((a) => a.id === id) ?? AIRCRAFT[0];
}
