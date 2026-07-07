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
  const route = ACS_routeLabel(row.origin, row.destination);
  const flightNumbers = [
    ACS_text(row.flight_number_out),
    ACS_text(row.flight_number_in)
  ].filter(Boolean).join("/");

  const flightLabel = flightNumbers || `ROUTE-${row.route_plan_id}`;

  return {
    id: `SLOTS_WARNING:${row.route_plan_id}`,
    alert_id: `SLOTS_WARNING:${row.route_plan_id}`,
    alert_key: `SLOTS_WARNING:${row.airline_id}:${row.route_plan_id}`,
    type: "slots",
    category: "slots",
    level: Number(row.slot_week) >= 6 ? "critical" : "warning",
    title: "SLOTS WARNING",
    message: `Flight ${flightLabel} / ${route} has no assigned aircraft. Week ${row.slot_week} of 6.`,
    timestamp: row.current_sim_time || row.reserved_sim_time,
    source: "airport_slot_bookings",
    route_plan_id: row.route_plan_id,
    route_uid: row.route_uid,
    slot_week: Number(row.slot_week)
  };
}

function ACS_hrShortageAlert(row) {
  const staff = Number(row.staff || 0);
  const required = Number(row.required || 0);
  const deficit = Math.max(0, required - staff);
  const deficitRatio = required > 0 ? deficit / required : 0;

  const criticalDepartments = new Set([
    "pilots_small",
    "pilots_medium",
    "pilots_large",
    "pilots_vlarge",
    "cabin",
    "flightops",
    "maintenance",
    "ground"
  ]);

  const isCritical =
    staff <= 0 ||
    deficitRatio >= 0.5 ||
    criticalDepartments.has(ACS_text(row.dept_id));

  return {
    id: `HR_SHORTAGE:${row.dept_id}`,
    alert_id: `HR_SHORTAGE:${row.dept_id}`,
    alert_key: `HR_SHORTAGE:${row.airline_id}:${row.dept_id}`,
    type: "hr",
    category: "hr",
    level: isCritical ? "critical" : "warning",
    title: "HR SHORTAGE",
    message: `HR shortage: ${ACS_text(row.dept_name)} ${staff}/${required}.`,
    timestamp: row.current_sim_time || row.updated_at || new Date().toISOString(),
    source: "hr_departments",
    dept_id: row.dept_id,
    dept_name: row.dept_name,
    staff,
    required,
    deficit
  };
}

/* ============================================================
   ACS OCC ALERTS
   ------------------------------------------------------------
   Runtime alerts only.
   No Railway alerts table.
   No localStorage authority.
   GET only reads. It does not punish, cancel, hire, or mutate.
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

    const slotsResult = await pool.query(
      `
      WITH world_time AS (
        SELECT acs_get_current_sim_time() AS current_sim_time
      ),
      pending_slot_routes AS (
        SELECT
          rp.id AS route_plan_id,
          rp.route_uid,
          rp.airline_id,
          rp.origin,
          rp.destination,
          rp.flight_number_out,
          rp.flight_number_in,
          MIN(asb.reserved_sim_time) AS reserved_sim_time,
          COUNT(asb.id)::INTEGER AS reserved_slots_count
        FROM public.route_plans rp
        JOIN public.airport_slot_bookings asb
          ON asb.route_plan_id = rp.id
         AND asb.airline_id = rp.airline_id
        WHERE rp.airline_id = $1
          AND rp.aircraft_id IS NULL
          AND UPPER(COALESCE(rp.route_state, 'ACTIVE')) <> 'CANCELLED'
          AND asb.slot_status = 'RESERVED'
          AND asb.reserved_sim_time IS NOT NULL
        GROUP BY
          rp.id,
          rp.route_uid,
          rp.airline_id,
          rp.origin,
          rp.destination,
          rp.flight_number_out,
          rp.flight_number_in
      )
      SELECT
        psr.*,
        wt.current_sim_time,
        (
          FLOOR(
            EXTRACT(EPOCH FROM (wt.current_sim_time - psr.reserved_sim_time))
            / 604800
          ) + 1
        )::INTEGER AS slot_week
      FROM pending_slot_routes psr
      CROSS JOIN world_time wt
      WHERE (
        FLOOR(
          EXTRACT(EPOCH FROM (wt.current_sim_time - psr.reserved_sim_time))
          / 604800
        ) + 1
      ) BETWEEN 2 AND 6
      ORDER BY psr.reserved_sim_time ASC, psr.route_plan_id ASC
      LIMIT 100
      `,
      [airlineId]
    );

    for (const row of slotsResult.rows) {
      alerts.push(ACS_slotWarningAlert(row));
    }

    const hrResult = await pool.query(
      `
      SELECT
        hd.airline_id,
        hd.dept_id,
        hd.dept_name,
        hd.staff,
        hd.required,
        hd.updated_at,
        acs_get_current_sim_time() AS current_sim_time
      FROM public.hr_departments hd
      WHERE hd.airline_id = $1
        AND COALESCE(hd.required, 0) > 0
        AND COALESCE(hd.staff, 0) < COALESCE(hd.required, 0)
      ORDER BY
        (COALESCE(hd.required, 0) - COALESCE(hd.staff, 0)) DESC,
        hd.dept_id ASC
      LIMIT 100
      `,
      [airlineId]
    );

    for (const row of hrResult.rows) {
      alerts.push(ACS_hrShortageAlert(row));
    }

    return res.status(200).json({ alerts });

  } catch (error) {
    console.error("[ACS OCC] alerts failed:", error);

    return res.status(500).json({
      alerts: [],
      error: "OCC_ALERTS_FAILED"
    });
  }
});

export default router;
