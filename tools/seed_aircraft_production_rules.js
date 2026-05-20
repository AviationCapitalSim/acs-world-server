/* ============================================================
   🟦 ACS AIRCRAFT PRODUCTION RULES SEED — v1.0
   ------------------------------------------------------------
   File:
   tools/seed_aircraft_production_rules.js

   Purpose:
   - Generate historical OEM production rules
   - Build aircraft industrial availability
   - Feed factory catalog by simulation year
   - PostgreSQL becomes industrial authority
   ============================================================ */

import pg from "pg";

const { Pool } = pg;

/* ============================================================
   🔹 DATABASE CONNECTION
   ============================================================ */

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* ============================================================
   🔹 HELPERS
   ============================================================ */

  function determineCategory(row) {
     
  const seats = Number(row.seats || 0);

  if (seats <= 19) return "PISTON";
  if (seats <= 70) return "TURBOPROP";
  if (seats <= 110) return "REGIONAL_JET";
  if (seats <= 240) return "NARROWBODY";
  if (seats <= 420) return "WIDEBODY";

  return "OTHER";
}

function determineCapacityTier(category, year) {

  if (year <= 1945) {
    return "LIMITED";
  }

  if (year <= 1970) {
    return "LOW";
  }

  if (year <= 2000) {
    return "MEDIUM";
  }

  if (category === "NARROWBODY") {
    return "MASS";
  }

  if (category === "WIDEBODY") {
    return "HIGH";
  }

  return "MEDIUM";
}

function determineProductionEndYear(year, category) {

  if (year <= 1945) return year + 8;

  if (year <= 1970) {
    if (category === "widebody") return year + 25;
    return year + 20;
  }

  if (year <= 2000) {
    if (category === "narrowbody") return year + 30;
    return year + 25;
  }

  return null;
}

function determineMonthlyMin(category) {

  switch (category) {
    case "general_aviation":
      return 1;

    case "regional":
      return 2;

    case "narrowbody":
      return 4;

    case "widebody":
      return 2;

    case "heavy":
      return 1;

    default:
      return 1;
  }
}

function determineMonthlyMax(category, year) {

  if (year <= 1945) {
    switch (category) {
      case "general_aviation": return 2;
      case "regional": return 4;
      case "narrowbody": return 6;
      case "widebody": return 2;
      case "heavy": return 1;
      default: return 2;
    }
  }

  if (year <= 1970) {
    switch (category) {
      case "general_aviation": return 4;
      case "regional": return 6;
      case "narrowbody": return 10;
      case "widebody": return 4;
      case "heavy": return 2;
      default: return 4;
    }
  }

  switch (category) {
    case "general_aviation": return 6;
    case "regional": return 10;
    case "narrowbody": return 20;
    case "widebody": return 8;
    case "heavy": return 4;
    default: return 6;
  }
}

/* ============================================================
   🔹 MAIN SEED
   ============================================================ */

async function seedProductionRules() {

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    const catalog = await client.query(`
      SELECT
        manufacturer,
        model_key,
        aircraft_name,
        year,
        seats
      FROM aircraft_catalog
      WHERE is_active = true
      ORDER BY year ASC
    `);

    console.log(`✅ Aircraft loaded: ${catalog.rows.length}`);

    let processed = 0;

    for (const row of catalog.rows) {

      const year = Number(row.year);

      if (!year || year < 1900) {
        continue;
      }

      const category =
        determineCategory(row);

      const productionStart =
        year;

      const productionEnd =
        determineProductionEndYear(
          year,
          category
        );

      const capacityTier =
        determineCapacityTier(
          category,
          year
        );

      const monthlyMin =
        determineMonthlyMin(category);

      const monthlyMax =
        determineMonthlyMax(
          category,
          year
        );

      await client.query(
        `
        INSERT INTO aircraft_production_rules (
          manufacturer,
          model_key,
          aircraft_name,
          aircraft_category,
          production_start_year,
          production_end_year,
          first_delivery_year,
          last_delivery_year,
          capacity_tier,
          manufacturer_weight,
          model_weight,
          monthly_min_units,
          monthly_max_units,
          is_factory_available,
          is_active_rule,
          notes,
          updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,
          1.0,
          1.0,
          $10,$11,
          TRUE,
          TRUE,
          $12,
          NOW()
        )
        ON CONFLICT (model_key)
        DO UPDATE SET
          aircraft_category = EXCLUDED.aircraft_category,
          production_start_year = EXCLUDED.production_start_year,
          production_end_year = EXCLUDED.production_end_year,
          first_delivery_year = EXCLUDED.first_delivery_year,
          last_delivery_year = EXCLUDED.last_delivery_year,
          capacity_tier = EXCLUDED.capacity_tier,
          monthly_min_units = EXCLUDED.monthly_min_units,
          monthly_max_units = EXCLUDED.monthly_max_units,
          is_factory_available = TRUE,
          is_active_rule = TRUE,
          updated_at = NOW()
        `,
        [
          row.manufacturer,
          row.model_key,
          row.aircraft_name,
          category,
          productionStart,
          productionEnd,
          productionStart,
          productionEnd,
          capacityTier,
          monthlyMin,
          monthlyMax,
          `AUTO_GENERATED_RULE_${new Date().getUTCFullYear()}`
        ]
      );

      processed++;
    }

    await client.query("COMMIT");

    console.log("✅ AIRCRAFT PRODUCTION RULES COMPLETED");
    console.log(`✅ Rules processed: ${processed}`);

  } catch (err) {

    await client.query("ROLLBACK");

    console.error("❌ PRODUCTION RULES FAILED");
    console.error(err);

    process.exit(1);

  } finally {

    client.release();
    await pool.end();

  }
}

seedProductionRules();
