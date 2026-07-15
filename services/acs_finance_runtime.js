/* ============================================================
   ACS FINANCE MONTHLY CLOSE RUNTIME â€” PostgreSQL Authority v1.0
   ============================================================ */

import { pool } from "../db/pool.js";
import { ACS_ensureFinancePeriod } from "../routes/finance_core.js";

const FINANCE_LOCK_NAMESPACE = 1095783253;

async function ACS_closeFinanceForAirline(airlineId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1, $2)",
      [FINANCE_LOCK_NAMESPACE, airlineId]
    );

    const result = await ACS_ensureFinancePeriod(
      client,
      airlineId
    );

    await client.query("COMMIT");

    return {
      processedCount: Array.isArray(result?.closed_months)
        ? result.closed_months.length
        : 0
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  } finally {
    client.release();
  }
}

export async function ACS_runFinanceMonthlyCloseRuntime() {
  const airlinesResult = await pool.query(
    `
    SELECT airline_id
    FROM public.company_finance
    WHERE airline_id IS NOT NULL
    ORDER BY airline_id
    `
  );

  let processedCount = 0;

  for (const row of airlinesResult.rows) {
    const airlineId = Number(row.airline_id);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      continue;
    }

    const result = await ACS_closeFinanceForAirline(airlineId);
    processedCount += Number(result?.processedCount || 0);
  }

  return {
    processedCount,
    airlineCount: airlinesResult.rows.length
  };
}
