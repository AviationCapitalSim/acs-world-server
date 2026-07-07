import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function ACS_airlineId(req) {
  const airlineId = Number(req.airline_id);
  return Number.isInteger(airlineId) && airlineId > 0 ? airlineId : null;
}

async function ACS_getCurrentSimTime(client) {
  const result = await client.query(`
    SELECT acs_get_current_sim_time() AS current_sim_time
  `);

  return result.rows[0]?.current_sim_time || null;
}

async function ACS_canCreateOccAlert(client, airlineId, alertKey, currentSimTime) {
  const result = await client.query(
    `
    SELECT
      id,
      deleted_at,
      deleted_sim_time
    FROM public.occ_alerts
    WHERE airline_id = $1
      AND alert_key = $2
    ORDER BY id DESC
    LIMIT 1
    `,
    [airlineId, alertKey]
  );

  if (!result.rows.length) {
    return true;
  }

  const last = result.rows[0];

  if (!last.deleted_at) {
    return false;
  }

  if (!last.deleted_sim_time || !currentSimTime) {
    return false;
  }

  const waitResult = await client.query(
    `
    SELECT ($1::TIMESTAMPTZ >= ($2::TIMESTAMPTZ + INTERVAL '7 days')) AS can_create
    `,
    [currentSimTime, last.deleted_sim_time]
  );

  return waitResult.rows[0]?.can_create === true;
}

async function ACS_createOccAlertIfAllowed(client, alert, currentSimTime) {
  const allowed = await ACS_canCreateOccAlert(
    client,
    alert.airline_id,
    alert.alert_key,
    currentSimTime
  );

  if (!allowed) return;

  await client.query(
    `
    INSERT INTO public.occ_alerts (
      airline_id,
      alert_key,
      category,
      level,
      title,
      message,
      source,
      source_ref,
      event_sim_time,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
    `,
    [
      alert.airline_id,
      alert.alert_key,
      alert.category,
      alert.level,
      alert.title,
      alert.message,
      alert.source,
      alert.source_ref || null,
      currentSimTime
    ]
  );
}

async function ACS_syncHrAlerts(client, airlineId, currentSimTime) {
  const result = await client.query(
    `
    SELECT
      airline_id,
      dept_id,
      dept_name,
      staff,
      required
    FROM public.hr_departments
    WHERE airline_id = $1
      AND COALESCE(required, 0) > 0
      AND COALESCE(staff, 0) < COALESCE(required, 0)
    ORDER BY dept_id
    `,
    [airlineId]
  );

  for (const row of result.rows) {
    const staff = Number(row.staff || 0);
    const required = Number(row.required || 0);
    const deficit = Math.max(0, required - staff);
    const deficitRatio = required > 0 ? deficit / required : 0;

    const level =
      staff <= 0 || deficitRatio >= 0.5
        ? "critical"
        : "warning";

    await ACS_createOccAlertIfAllowed(
      client,
      {
        airline_id: airlineId,
        alert_key: `HR_SHORTAGE:${row.dept_id}`,
        category: "hr",
        level,
        title: "HR SHORTAGE",
        message: `HR shortage: ${row.dept_name} ${staff}/${required}.`,
        source: "hr_departments",
        source_ref: row.dept_id
      },
      currentSimTime
    );
  }
}

async function ACS_syncSlotAlerts(client, airlineId, currentSimTime) {
  const result = await client.query(
    `
    WITH pending_slot_routes AS (
      SELECT
        rp.id AS route_plan_id,
        rp.route_uid,
        rp.airline_id,
        rp.origin,
        rp.destination,
        rp.flight_number_out,
        rp.flight_number_in,
        MIN(asb.reserved_sim_time) AS reserved_sim_time
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
      (
        FLOOR(
          EXTRACT(EPOCH FROM ($2::TIMESTAMPTZ - psr.reserved_sim_time))
          / 604800
        ) + 1
      )::INTEGER AS slot_week
    FROM pending_slot_routes psr
    WHERE (
      FLOOR(
        EXTRACT(EPOCH FROM ($2::TIMESTAMPTZ - psr.reserved_sim_time))
        / 604800
      ) + 1
    ) BETWEEN 2 AND 6
    ORDER BY psr.reserved_sim_time ASC
    `,
    [airlineId, currentSimTime]
  );

  for (const row of result.rows) {
    const flightLabel = [row.flight_number_out, row.flight_number_in]
      .filter(Boolean)
      .join("/") || `ROUTE-${row.route_plan_id}`;

    await ACS_createOccAlertIfAllowed(
      client,
      {
        airline_id: airlineId,
        alert_key: `SLOTS_WARNING:${row.route_plan_id}`,
        category: "slots",
        level: Number(row.slot_week) >= 6 ? "critical" : "warning",
        title: "SLOTS WARNING",
        message: `Flight ${flightLabel} / ${row.origin}-${row.destination} has no assigned aircraft. Week ${row.slot_week} of 6.`,
        source: "airport_slot_bookings",
        source_ref: String(row.route_plan_id)
      },
      currentSimTime
    );
  }
}

router.get("/occ/alerts", requireAuth, async (req, res) => {
  const airlineId = ACS_airlineId(req);

  if (!airlineId) {
    return res.status(401).json({
      alerts: [],
      error: "NO_ACTIVE_AIRLINE"
    });
  }

  const client = await pool.connect();

  try {
    const currentSimTime = await ACS_getCurrentSimTime(client);

    await ACS_syncHrAlerts(client, airlineId, currentSimTime);
    await ACS_syncSlotAlerts(client, airlineId, currentSimTime);

    const result = await client.query(
      `
      SELECT
        id,
        airline_id,
        alert_key,
        category,
        level,
        title,
        message,
        source,
        source_ref,
        event_sim_time,
        created_at,
        updated_at
      FROM public.occ_alerts
      WHERE airline_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      `,
      [airlineId]
    );

    const alerts = result.rows.map(row => ({
      id: String(row.id),
      alert_id: String(row.id),
      alert_key: row.alert_key,
      category: row.category,
      type: row.category,
      level: row.level,
      title: row.title,
      message: row.message,
      source: row.source,
      source_ref: row.source_ref,
      timestamp: row.event_sim_time || row.created_at,
      updated_at: row.updated_at
    }));

    return res.status(200).json({ alerts });

  } catch (error) {
    console.error("[ACS OCC] alerts failed:", error);

    return res.status(500).json({
      alerts: [],
      error: "OCC_ALERTS_FAILED"
    });
  } finally {
    client.release();
  }
});

router.delete("/occ/alerts", requireAuth, async (req, res) => {
  const airlineId = ACS_airlineId(req);

  if (!airlineId) {
    return res.status(401).json({
      ok: false,
      error: "NO_ACTIVE_AIRLINE"
    });
  }

  const alertIds = Array.isArray(req.body?.alert_ids)
    ? req.body.alert_ids.map(id => Number(id)).filter(Number.isInteger)
    : [];

  if (!alertIds.length) {
    return res.status(400).json({
      ok: false,
      error: "NO_ALERT_IDS"
    });
  }

  try {
    const currentSimTimeResult = await pool.query(`
      SELECT acs_get_current_sim_time() AS current_sim_time
    `);

    const currentSimTime = currentSimTimeResult.rows[0]?.current_sim_time || null;

    const result = await pool.query(
      `
      UPDATE public.occ_alerts
      SET
        deleted_at = NOW(),
        deleted_sim_time = $3,
        updated_at = NOW()
      WHERE airline_id = $1
        AND id = ANY($2::BIGINT[])
        AND deleted_at IS NULL
      RETURNING id
      `,
      [airlineId, alertIds, currentSimTime]
    );

    return res.status(200).json({
      ok: true,
      deleted_count: result.rows.length
    });

  } catch (error) {
    console.error("[ACS OCC] delete alerts failed:", error);

    return res.status(500).json({
      ok: false,
      error: "OCC_ALERT_DELETE_FAILED"
    });
  }
});

export default router;
