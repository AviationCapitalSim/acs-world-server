import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function ACS_airlineId(req) {
  const airlineId = Number(req.airline_id);
  return Number.isInteger(airlineId) && airlineId > 0 ? airlineId : null;
}

function ACS_text(value) {
  return String(value ?? "").trim();
}

function ACS_routeLabel(origin, destination) {
  const from = ACS_text(origin).toUpperCase();
  const to = ACS_text(destination).toUpperCase();

  if (from && to) return `${from}-${to}`;
  if (from) return from;
  if (to) return to;

  return "ROUTE";
}

function ACS_slotWarningAlert(row) {
  const flightNumber = ACS_text(row.flight_number) || `SCHEDULE-${row.id}`;
  const route = ACS_routeLabel(row.origin, row.destination);

  return {
    id: `SLOTS_WARNING:${row.id}`,
    alert_id: `SLOTS_WARNING:${row.id}`,
    alert_key: `SLOTS_WARNING:${row.airline_id}:${row.id}`,
    type: "slots",
    category: "slots",
    level: "warning",
    title: "SLOTS WARNING",
    message: `Flight ${flightNumber} / ${route} has no assigned aircraft.`,
    timestamp: row.updated_at || row.created_at || new Date().toISOString(),
    source: "schedule_items"
  };
}

/* ============================================================
   ACS OCC ALERTS
   ------------------------------------------------------------
   Runtime alerts only.
   No Railway alerts table.
   No localStorage authority.
   ============================================================ */

router.get("/occ/alerts", requireAuth, async (req, res) => {
  const airlineId = ACS_airlineId(req);

  if (!airlineId) {
    return res.status(401).json({
      alerts: [],
      error: "NO_ACTIVE_AIRLINE"
    });
  }

  try {
    const alerts = [];

    /* ==========================================================
       SLOTS WARNING
       ----------------------------------------------------------
       A scheduled service flight exists, but has no aircraft.
       Player receives only flight/route information.
       No aircraft recommendation.
       ========================================================== */

    const slotsResult = await pool.query(
      `
      SELECT
        si.id,
        si.airline_id,
        si.origin,
        si.destination,
        si.selected_day,
        si.departure,
        si.flight_number,
        si.status,
        si.created_at,
        si.updated_at
      FROM public.schedule_items si
      WHERE si.airline_id = $1
        AND si.aircraft_id IS NULL
        AND LOWER(COALESCE(si.status, 'planned')) <> 'cancelled'
        AND LOWER(COALESCE(si.item_type, 'service')) = 'service'
      ORDER BY
        CASE LOWER(si.selected_day)
          WHEN 'mon' THEN 1
          WHEN 'tue' THEN 2
          WHEN 'wed' THEN 3
          WHEN 'thu' THEN 4
          WHEN 'fri' THEN 5
          WHEN 'sat' THEN 6
          WHEN 'sun' THEN 7
          ELSE 8
        END,
        si.departure NULLS LAST,
        si.id
      LIMIT 100
      `,
      [airlineId]
    );

    for (const row of slotsResult.rows) {
      alerts.push(ACS_slotWarningAlert(row));
    }

    return res.status(200).json({
      alerts
    });

  } catch (error) {
    console.error("[ACS OCC] alerts failed:", error);

    return res.status(500).json({
      alerts: [],
      error: "OCC_ALERTS_FAILED"
    });
  }
});

export default router;
