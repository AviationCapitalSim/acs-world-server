// ============================================================
// ACS + AIRBUS OCC
// data/acs_airport_db.js
// Global Airport Database Consolidator - ES Module Version
// ------------------------------------------------------------
// Purpose:
//   Consolidates the 7 ACS continent airport JS databases into
//   one backend-readable airport authority array.
//
// Source files:
//   engine/airports/world_airports_sa.js
//   engine/airports/world_airports_na.js
//   engine/airports/world_airports_eu.js
//   engine/airports/world_airports_as.js
//   engine/airports/world_airports_af.js
//   engine/airports/world_airports_oc.js
//   engine/airports/world_airports_me.js
//
// Output:
//   ACS_AIRPORT_DB
// ============================================================

import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------------------------------------
// Source files
// ------------------------------------------------------------

export const AIRPORT_SOURCE_FILES = [
  {
    key: "SouthAmerica",
    label: "South America",
    file: path.join(__dirname, "..", "engine", "airports", "world_airports_sa.js"),
  },
  {
    key: "NorthAmerica",
    label: "North America",
    file: path.join(__dirname, "..", "engine", "airports", "world_airports_na.js"),
  },
  {
    key: "Europe",
    label: "Europe",
    file: path.join(__dirname, "..", "engine", "airports", "world_airports_eu.js"),
  },
  {
    key: "Asia",
    label: "Asia",
    file: path.join(__dirname, "..", "engine", "airports", "world_airports_as.js"),
  },
  {
    key: "Africa",
    label: "Africa",
    file: path.join(__dirname, "..", "engine", "airports", "world_airports_af.js"),
  },
  {
    key: "Oceania",
    label: "Oceania",
    file: path.join(__dirname, "..", "engine", "airports", "world_airports_oc.js"),
  },
  {
    key: "MiddleEast",
    label: "Middle East",
    file: path.join(__dirname, "..", "engine", "airports", "world_airports_me.js"),
  },
];

// ------------------------------------------------------------
// Safe value helpers
// ------------------------------------------------------------

function toStringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function toStringOrEmpty(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toNumberOrZero(value) {
  const num = toNumberOrNull(value);
  return num === null ? 0 : num;
}

function normalizeIcao(value) {
  const text = toStringOrNull(value);
  return text ? text.toUpperCase() : null;
}

function normalizeIata(value) {
  const text = toStringOrNull(value);
  return text ? text.toUpperCase() : null;
}

// ------------------------------------------------------------
// Airport normalizer
// ------------------------------------------------------------

function normalizeAirport(rawAirport, fallbackContinent) {
  const demand = rawAirport && rawAirport.demand ? rawAirport.demand : {};

  return {
    icao: normalizeIcao(rawAirport.icao),
    iata: normalizeIata(rawAirport.iata),

    city: toStringOrEmpty(rawAirport.city),
    country: toStringOrEmpty(rawAirport.country),
    continent: toStringOrEmpty(rawAirport.continent || fallbackContinent),
    region: toStringOrNull(rawAirport.region),

    latitude: toNumberOrNull(rawAirport.latitude),
    longitude: toNumberOrNull(rawAirport.longitude),
    elevation_ft: toNumberOrNull(rawAirport.elevation_ft),

    runway_m: toNumberOrNull(rawAirport.runway_m),
    open_hrs: toStringOrNull(rawAirport.open_hrs),
    category: toStringOrNull(rawAirport.category),

    demand_y: toNumberOrZero(demand.Y),
    demand_c: toNumberOrZero(demand.C),
    demand_f: toNumberOrZero(demand.F),

    slot_cost_usd: toNumberOrZero(rawAirport.slot_cost_usd),
    landing_fee_usd: toNumberOrZero(rawAirport.landing_fee_usd),
    fuel_usd_gal: toNumberOrZero(rawAirport.fuel_usd_gal),
    ticket_fee_percent: toNumberOrZero(rawAirport.ticket_fee_percent),
    pax_growth_factor: toNumberOrZero(rawAirport.pax_growth_factor || 1),

    slot_capacity: toNumberOrZero(rawAirport.slot_capacity),
    aircraft_limit: toStringOrNull(rawAirport.aircraft_limit),

    notes: toStringOrEmpty(rawAirport.notes),
    source: "ACS_CONTINENT_JS",
  };
}

// ------------------------------------------------------------
// Load continent file in isolated VM context
// ------------------------------------------------------------

function loadAirportFile(source) {
  if (!fs.existsSync(source.file)) {
    throw new Error(`Airport source file not found: ${source.file}`);
  }

  const code = fs.readFileSync(source.file, "utf8");

  const sandbox = {
    WorldAirportsACS: {},
    console,
  };

  vm.createContext(sandbox);

  vm.runInContext(code, sandbox, {
    filename: source.file,
  });

  const airports = sandbox.WorldAirportsACS[source.key];

  if (!Array.isArray(airports)) {
    throw new Error(
      `Invalid airport source structure in ${source.file}. Expected WorldAirportsACS.${source.key} = []`
    );
  }

  return airports.map((airport) => normalizeAirport(airport, source.label));
}

// ------------------------------------------------------------
// Build global airport DB
// ------------------------------------------------------------

export function buildAirportDatabase() {
  const allAirports = [];
  const seenIcao = new Set();

  for (const source of AIRPORT_SOURCE_FILES) {
    const airports = loadAirportFile(source);

    for (const airport of airports) {
      if (!airport.icao) {
        throw new Error(`Airport without ICAO detected in ${source.file}`);
      }

      if (seenIcao.has(airport.icao)) {
        throw new Error(`Duplicate airport ICAO detected: ${airport.icao}`);
      }

      seenIcao.add(airport.icao);
      allAirports.push(airport);
    }
  }

  return allAirports;
}

export const ACS_AIRPORT_DB = buildAirportDatabase();
