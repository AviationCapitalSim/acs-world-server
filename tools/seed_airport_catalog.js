// ============================================================
// ACS + AIRBUS OCC
// tools/seed_airport_catalog.js
// ------------------------------------------------------------
// Purpose:
//   Seeds public.airport_catalog from data/acs_airport_db.js
//
// Source:
//   data/acs_airport_db.js
//
// Target:
//   public.airport_catalog
// ============================================================

import dotenv from "dotenv";
import pg from "pg";
import { ACS_AIRPORT_DB } from "../data/acs_airport_db.js";

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function cleanTextOrNull(value) {
  const text = cleanText(value);
  return text.length ? text : null;
}

function cleanNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function cleanNumberOrZero(value) {
  const num = cleanNumberOrNull(value);
  return num === null ? 0 : num;
}

function prepareAirportForSeed(airport) {
  if (!airport || !airport.icao) {
    throw new Error("Airport missing ICAO");
  }

  const icao = cleanText(airport.icao).toUpperCase();

  const city = cleanText(airport.city) || icao;
  const country = cleanText(airport.country) || "UNKNOWN";
  const continent = cleanText(airport.continent) || "UNKNOWN";

  if (!airport.city) {
    console.warn(`ACS AIRPORT SEED WARNING - ${icao} missing city. Using ICAO as city fallback.`);
  }

  if (!airport.country) {
    console.warn(`ACS AIRPORT SEED WARNING - ${icao} missing country. Using UNKNOWN fallback.`);
  }

  if (!airport.continent) {
    console.warn(`ACS AIRPORT SEED WARNING - ${icao} missing continent. Using UNKNOWN fallback.`);
  }

  return {
    icao,
    iata: airport.iata ? cleanText(airport.iata).toUpperCase() : null,

    city,
    country,
    continent,
    region: cleanTextOrNull(airport.region),

    latitude: cleanNumberOrNull(airport.latitude),
    longitude: cleanNumberOrNull(airport.longitude),
    elevation_ft: cleanNumberOrNull(airport.elevation_ft),

    runway_m: cleanNumberOrNull(airport.runway_m),
    open_hrs: cleanTextOrNull(airport.open_hrs),
    category: cleanTextOrNull(airport.category),

    demand_y: cleanNumberOrZero(airport.demand_y),
    demand_c: cleanNumberOrZero(airport.demand_c),
    demand_f: cleanNumberOrZero(airport.demand_f),

    slot_cost_usd: cleanNumberOrZero(airport.slot_cost_usd),
    landing_fee_usd: cleanNumberOrZero(airport.landing_fee_usd),
    fuel_usd_gal: cleanNumberOrZero(airport.fuel_usd_gal),
    ticket_fee_percent: cleanNumberOrZero(airport.ticket_fee_percent),
    pax_growth_factor: cleanNumberOrZero(airport.pax_growth_factor || 1),

    slot_capacity: cleanNumberOrZero(airport.slot_capacity),
    aircraft_limit: cleanTextOrNull(airport.aircraft_limit),

    notes: cleanText(airport.notes),
    source: cleanText(airport.source) || "ACS_AIRPORT_DB",
  };
}

async function seedAirportCatalog() {
  const client = await pool.connect();

  try {
    console.log("============================================");
    console.log("ACS AIRPORT CATALOG SEED - START");
    console.log("============================================");
    console.log(`Loaded airports from ACS_AIRPORT_DB: ${ACS_AIRPORT_DB.length}`);

    await client.query("BEGIN");

    let inserted = 0;
    let updated = 0;
    let processed = 0;

    for (const rawAirport of ACS_AIRPORT_DB) {
      const airport = prepareAirportForSeed(rawAirport);

      const result = await client.query(
        `
        INSERT INTO public.airport_catalog (
          icao,
          iata,
          city,
          country,
          continent,
          region,
          latitude,
          longitude,
          elevation_ft,
          runway_m,
          open_hrs,
          category,
          demand_y,
          demand_c,
          demand_f,
          slot_cost_usd,
          landing_fee_usd,
          fuel_usd_gal,
          ticket_fee_percent,
          pax_growth_factor,
          slot_capacity,
          aircraft_limit,
          notes,
          source
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15,
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24
        )
        ON CONFLICT (icao)
        DO UPDATE SET
          iata = EXCLUDED.iata,
          city = EXCLUDED.city,
          country = EXCLUDED.country,
          continent = EXCLUDED.continent,
          region = EXCLUDED.region,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          elevation_ft = EXCLUDED.elevation_ft,
          runway_m = EXCLUDED.runway_m,
          open_hrs = EXCLUDED.open_hrs,
          category = EXCLUDED.category,
          demand_y = EXCLUDED.demand_y,
          demand_c = EXCLUDED.demand_c,
          demand_f = EXCLUDED.demand_f,
          slot_cost_usd = EXCLUDED.slot_cost_usd,
          landing_fee_usd = EXCLUDED.landing_fee_usd,
          fuel_usd_gal = EXCLUDED.fuel_usd_gal,
          ticket_fee_percent = EXCLUDED.ticket_fee_percent,
          pax_growth_factor = EXCLUDED.pax_growth_factor,
          slot_capacity = EXCLUDED.slot_capacity,
          aircraft_limit = EXCLUDED.aircraft_limit,
          notes = EXCLUDED.notes,
          source = EXCLUDED.source,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted;
        `,
        [
          airport.icao,
          airport.iata,
          airport.city,
          airport.country,
          airport.continent,
          airport.region,
          airport.latitude,
          airport.longitude,
          airport.elevation_ft,
          airport.runway_m,
          airport.open_hrs,
          airport.category,
          airport.demand_y,
          airport.demand_c,
          airport.demand_f,
          airport.slot_cost_usd,
          airport.landing_fee_usd,
          airport.fuel_usd_gal,
          airport.ticket_fee_percent,
          airport.pax_growth_factor,
          airport.slot_capacity,
          airport.aircraft_limit,
          airport.notes,
          airport.source,
        ]
      );

      processed++;

      if (result.rows[0].inserted) {
        inserted++;
      } else {
        updated++;
      }
    }

    await client.query("COMMIT");

    console.log("============================================");
    console.log("ACS AIRPORT CATALOG SEED - COMPLETE");
    console.log("============================================");
    console.log(`Inserted: ${inserted}`);
    console.log(`Updated: ${updated}`);
    console.log(`Total processed: ${processed}`);

    const continentSummary = await pool.query(`
      SELECT
        continent,
        COUNT(*) AS airports
      FROM public.airport_catalog
      GROUP BY continent
      ORDER BY continent;
    `);

    console.log("============================================");
    console.log("AIRPORTS BY CONTINENT");
    console.log("============================================");
    console.table(continentSummary.rows);

    const categorySummary = await pool.query(`
      SELECT
        category,
        COUNT(*) AS airports
      FROM public.airport_catalog
      GROUP BY category
      ORDER BY airports DESC, category;
    `);

    console.log("============================================");
    console.log("AIRPORTS BY CATEGORY");
    console.log("============================================");
    console.table(categorySummary.rows);
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("============================================");
    console.error("ACS AIRPORT CATALOG SEED - FAILED");
    console.error("============================================");
    console.error(error);

    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seedAirportCatalog();
