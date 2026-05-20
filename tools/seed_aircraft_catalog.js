/* ============================================================
   🟦 ACS AIRCRAFT CATALOG SEED TOOL — BETA v1.0
   ------------------------------------------------------------
   File: tools/seed_aircraft_catalog.js
   Source: data/acs_aircraft_db.js
   Target: PostgreSQL table aircraft_catalog
   Purpose:
   - Migrate ACS aircraft universe into backend authority
   - Insert new aircraft
   - Update existing aircraft by model_key
   - Preserve full original object in raw_data
   ============================================================ */

import fs from "fs";
import path from "path";
import vm from "vm";
import pg from "pg";
import { fileURLToPath } from "url";

const { Pool } = pg;

/* ============================================================
   🔹 __dirname FIX FOR ES MODULES
   ============================================================ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ============================================================
   🔹 DATABASE CONNECTION
   ============================================================ */

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* ============================================================
   🔹 LOAD AIRCRAFT DB SOURCE
   ============================================================ */

const dbPath = path.join(__dirname, "../data/acs_aircraft_db.js");

if (!fs.existsSync(dbPath)) {
  console.error("❌ Missing file: data/acs_aircraft_db.js");
  process.exit(1);
}

const sourceCode = fs.readFileSync(dbPath, "utf8");

const sandbox = {
  console,
  window: {},
  global: {}
};

vm.createContext(sandbox);

const wrappedSource = `
  ${sourceCode}
  global.ACS_AIRCRAFT_DB = ACS_AIRCRAFT_DB;
`;

vm.runInContext(wrappedSource, sandbox);

const aircraftDB =
  sandbox.global.ACS_AIRCRAFT_DB ||
  sandbox.window.ACS_AIRCRAFT_DB ||
  sandbox.ACS_AIRCRAFT_DB;

if (!Array.isArray(aircraftDB)) {
  console.error("❌ ACS_AIRCRAFT_DB was not found or is not an array.");
  process.exit(1);
}

console.log(`✅ Aircraft source loaded: ${aircraftDB.length}`);

/* ============================================================
   🔹 NORMALIZATION HELPERS
   ============================================================ */

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function cleanNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeModelKey(manufacturer, model) {
  return `${manufacturer || "unknown"}_${model || "unknown"}`
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\+/g, "plus")
    .replace(/\./g, "")
    .replace(/\//g, "_")
    .replace(/\(/g, "")
    .replace(/\)/g, "")
    .replace(/-/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeImageFilename(aircraft, manufacturer, model) {
  return (
    cleanText(aircraft.image_filename) ||
    cleanText(aircraft.image) ||
    `${normalizeModelKey(manufacturer, model)}.jpg`
  );
}

/* ============================================================
   🔹 UPSERT AIRCRAFT
   ============================================================ */

async function seedAircraftCatalog() {
  const client = await pool.connect();

  let insertedOrUpdated = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");

    for (const aircraft of aircraftDB) {
      const manufacturer = cleanText(aircraft.manufacturer);
      const model = cleanText(aircraft.model);

      if (!manufacturer || !model) {
        skipped++;
        continue;
      }

      const modelKey =
        cleanText(aircraft.model_key) ||
        normalizeModelKey(manufacturer, model);

      const aircraftName =
        cleanText(aircraft.aircraft_name) ||
        `${manufacturer} ${model}`;

      const productionYear =
        cleanNumber(aircraft.production_year) ||
        cleanNumber(aircraft.year);

      const aircraftCategory =
        cleanText(aircraft.aircraft_category) ||
        cleanText(aircraft.category) ||
        "commercial";

      const status =
        cleanText(aircraft.status) ||
        "active";

      const imageFilename = normalizeImageFilename(
        aircraft,
        manufacturer,
        model
      );

      const rawData = aircraft;

      await client.query(
        `
        INSERT INTO aircraft_catalog (
          model_key,
          manufacturer,
          model,
          aircraft_name,
          production_year,
          year,
          seats,
          range_nm,
          speed_kts,
          mtow_kg,
          fuel_burn_kgph,
          price_acs_usd,
          engines,
          aircraft_category,
          status,
          image_filename,
          raw_data,
          is_active,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, TRUE, NOW()
        )
        ON CONFLICT (model_key)
        DO UPDATE SET
          manufacturer = EXCLUDED.manufacturer,
          model = EXCLUDED.model,
          aircraft_name = EXCLUDED.aircraft_name,
          production_year = EXCLUDED.production_year,
          year = EXCLUDED.year,
          seats = EXCLUDED.seats,
          range_nm = EXCLUDED.range_nm,
          speed_kts = EXCLUDED.speed_kts,
          mtow_kg = EXCLUDED.mtow_kg,
          fuel_burn_kgph = EXCLUDED.fuel_burn_kgph,
          price_acs_usd = EXCLUDED.price_acs_usd,
          engines = EXCLUDED.engines,
          aircraft_category = EXCLUDED.aircraft_category,
          status = EXCLUDED.status,
          image_filename = EXCLUDED.image_filename,
          raw_data = EXCLUDED.raw_data,
          is_active = TRUE,
          updated_at = NOW();
        `,
        [
          modelKey,
          manufacturer,
          model,
          aircraftName,
          productionYear,
          productionYear,
          cleanNumber(aircraft.seats),
          cleanNumber(aircraft.range_nm),
          cleanNumber(aircraft.speed_kts),
          cleanNumber(aircraft.mtow_kg),
          cleanNumber(aircraft.fuel_burn_kgph),
          cleanNumber(aircraft.price_acs_usd),
          cleanText(aircraft.engines),
          aircraftCategory,
          status,
          imageFilename,
          rawData
        ]
      );

      insertedOrUpdated++;
    }

    await client.query("COMMIT");

    console.log("✅ AIRCRAFT CATALOG SEED COMPLETED");
    console.log(`✅ Inserted/Updated: ${insertedOrUpdated}`);
    console.log(`⚠️ Skipped: ${skipped}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ AIRCRAFT CATALOG SEED FAILED");
    console.error(error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedAircraftCatalog();
