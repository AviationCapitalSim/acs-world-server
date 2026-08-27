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

async function ACS_syncHrAlerts(
  client,
  airlineId,
  currentSimTime
) {
  const simResult = await client.query(
    `
    SELECT
      EXTRACT(
        YEAR FROM $1::TIMESTAMPTZ
      )::INTEGER AS sim_year,

      EXTRACT(
        MONTH FROM $1::TIMESTAMPTZ
      )::INTEGER AS sim_month
    `,
    [currentSimTime]
  );

  const simYear = Number(
    simResult.rows[0]?.sim_year
  );

  const simMonth = Number(
    simResult.rows[0]?.sim_month
  );

  if (
    !Number.isInteger(simYear) ||
    !Number.isInteger(simMonth)
  ) {
    throw new Error("INVALID_HR_ALERT_SIM_TIME");
  }

  const salaryHalf =
    simMonth <= 6 ? 1 : 2;

  const result = await client.query(
    `
    WITH hr_status AS (
      SELECT
        department.dept_id,
        department.dept_name,

        COALESCE(
          department.staff,
          0
        )::INTEGER AS staff,

        COALESCE(
          department.required,
          0
        )::INTEGER AS required,

        COALESCE(
          department.morale,
          100
        )::NUMERIC AS morale,

        COALESCE(
          department.salary,
          0
        )::NUMERIC AS salary,

        CASE
          WHEN department.dept_id
               LIKE 'pilots\\_%' ESCAPE '\\'
            THEN standard.standard_two_crew_cost
          ELSE standard.monthly_salary
        END::NUMERIC AS standard_salary

      FROM public.hr_departments department

      JOIN public.hr_salary_standards standard
        ON standard.dept_id =
           department.dept_id
       AND standard.cycle_year = $2
       AND standard.cycle_half = $3

      WHERE department.airline_id = $1
    )

    SELECT
      dept_id,
      dept_name,
      staff,
      required,
      morale,
      salary,
      standard_salary

    FROM hr_status

    WHERE
      (
        required > 0
        AND staff < required
      )
      OR
      (
        morale <= 80
        AND salary < standard_salary
      )

    ORDER BY dept_id
    `,
    [
      airlineId,
      simYear,
      salaryHalf
    ]
  );

  if (result.rows.length === 0) {
    return;
  }

  const staffingIssues = [];
  const salaryIssues = [];

  let level = "warning";

  for (const row of result.rows) {
    const staff = Number(row.staff || 0);
    const required = Number(row.required || 0);
    const morale = Number(row.morale || 100);
    const salary = Number(row.salary || 0);
    const standardSalary = Number(
      row.standard_salary || 0
    );

    if (
      required > 0 &&
      staff < required
    ) {
      const deficit =
        Math.max(0, required - staff);

      const deficitRatio =
        required > 0
          ? deficit / required
          : 0;

      staffingIssues.push(
        `${row.dept_name} ${staff}/${required}`
      );

      if (
        staff <= 0 ||
        deficitRatio >= 0.5
      ) {
        if (level !== "severe") {
          level = "critical";
        }
      }
    }

    if (
      morale <= 80 &&
      salary < standardSalary
    ) {
      salaryIssues.push(
        `${row.dept_name}: morale ${Math.round(
          morale
        )}%, salary $${Math.round(
          salary
        ).toLocaleString("en-US")}/$${Math.round(
          standardSalary
        ).toLocaleString("en-US")}`
      );

      if (morale <= 55) {
        level = "severe";

      } else if (
        morale <= 70 &&
        level !== "severe"
      ) {
        level = "critical";
      }
    }
  }

  const messageParts = [];

  if (staffingIssues.length > 0) {
    messageParts.push(
      `Staff shortages: ${staffingIssues.join(
        "; "
      )}.`
    );
  }

  if (salaryIssues.length > 0) {
    messageParts.push(
      `Salary morale: ${salaryIssues.join(
        "; "
      )}.`
    );
  }

  const monthKey =
    `${simYear}-${String(simMonth).padStart(
      2,
      "0"
    )}`;

  await ACS_createOccAlertIfAllowed(
    client,
    {
      airline_id: airlineId,

      alert_key:
        `HR_CENTER:MONTH:${monthKey}`,

      category: "hr",
      level,

      title:
        "HR CENTER — MONTHLY PERSONNEL STATUS",

      message: messageParts.join(" "),

      source: "hr_departments",
      source_ref: monthKey
    },
    currentSimTime
  );
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
        AND UPPER(COALESCE(rp.route_state, 'ACTIVE')) <> 'CANCELLED'
        AND asb.slot_status = 'RESERVED'
        AND asb.reserved_sim_time IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.schedule_items si
          WHERE si.airline_id = rp.airline_id
            AND si.route_plan_id = rp.id
            AND si.item_type = 'flight'
            AND LOWER(COALESCE(si.status, 'planned')) = 'assigned'
            AND si.aircraft_id IS NOT NULL
        )
      GROUP BY
        rp.id,
        rp.route_uid,
        rp.airline_id,
        rp.origin,
        rp.destination,
        rp.flight_number_out,
        rp.flight_number_in
    ),
    slot_age AS (
      SELECT
        psr.*,
        (
          FLOOR(
            EXTRACT(EPOCH FROM ($2::TIMESTAMPTZ - psr.reserved_sim_time))
            / 604800
          ) + 1
        )::INTEGER AS slot_week
      FROM pending_slot_routes psr
    )
    SELECT *
    FROM slot_age
    WHERE slot_week BETWEEN 2 AND 6
    ORDER BY reserved_sim_time ASC
    `,
    [airlineId, currentSimTime]
  );

  for (const row of result.rows) {
    const slotWeek = Number(row.slot_week);

    const flightLabel = [row.flight_number_out, row.flight_number_in]
      .filter(Boolean)
      .join("/") || `ROUTE-${row.route_plan_id}`;

    await ACS_createOccAlertIfAllowed(
      client,
      {
        airline_id: airlineId,
        alert_key: `SLOT_WARNING:${row.route_plan_id}:W${slotWeek}`,
        category: "schedule",
        level: slotWeek >= 6 ? "critical" : "warning",
        title: "SLOT WARNING",
        message: `Flight ${flightLabel} / ${row.origin}-${row.destination} slot has no assigned aircraft`,
        source: "airport_slot_bookings",
        source_ref: String(row.route_plan_id)
      },
      currentSimTime
    );
  }
}

async function ACS_syncExpiredSlotRoutes(client, airlineId, currentSimTime) {
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`ACS_OCC_EXPIRED_SLOT_ROUTES|${airlineId}`]
    );

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
          AND UPPER(COALESCE(rp.route_state, 'ACTIVE')) <> 'CANCELLED'
          AND asb.slot_status = 'RESERVED'
          AND asb.reserved_sim_time IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.schedule_items si
            WHERE si.airline_id = rp.airline_id
              AND si.route_plan_id = rp.id
              AND si.item_type = 'flight'
              AND LOWER(COALESCE(si.status, 'planned')) = 'assigned'
              AND si.aircraft_id IS NOT NULL
          )
        GROUP BY
          rp.id,
          rp.route_uid,
          rp.airline_id,
          rp.origin,
          rp.destination,
          rp.flight_number_out,
          rp.flight_number_in
      ),
      slot_age AS (
        SELECT
          psr.*,
          (
            FLOOR(
              EXTRACT(EPOCH FROM ($2::TIMESTAMPTZ - psr.reserved_sim_time))
              / 604800
            ) + 1
          )::INTEGER AS slot_week
        FROM pending_slot_routes psr
      )
      SELECT *
      FROM slot_age
      WHERE slot_week > 6
      ORDER BY reserved_sim_time ASC
      `,
      [airlineId, currentSimTime]
    );

    for (const row of result.rows) {
      const routePlanId = Number(row.route_plan_id);

      await client.query(
        `
        SELECT id
        FROM public.route_plans
        WHERE id = $1
          AND airline_id = $2
        FOR UPDATE
        `,
        [routePlanId, airlineId]
      );

      const assignedCheck = await client.query(
        `
        SELECT 1
        FROM public.schedule_items si
        WHERE si.airline_id = $1
          AND si.route_plan_id = $2
          AND si.item_type = 'flight'
          AND LOWER(COALESCE(si.status, 'planned')) = 'assigned'
          AND si.aircraft_id IS NOT NULL
        LIMIT 1
        `,
        [airlineId, routePlanId]
      );

      if (assignedCheck.rows.length) {
        continue;
      }

      await client.query(
        `
        UPDATE public.schedule_items
        SET
          status = 'cancelled',
          aircraft_id = NULL,
          aircraft_registration = NULL,
          updated_at = NOW()
        WHERE airline_id = $1
          AND route_plan_id = $2
          AND item_type = 'flight'
          AND LOWER(COALESCE(status, 'planned'))
              NOT IN ('cancelled', 'in_progress', 'completed')
        `,
        [airlineId, routePlanId]
      );

      await client.query(
        `
        UPDATE public.airport_slot_bookings
        SET
          slot_status = 'CANCELLED',
          released_at = $3,
          updated_at = NOW()
        WHERE airline_id = $1
          AND route_plan_id = $2
          AND slot_status = 'RESERVED'
        `,
        [airlineId, routePlanId, currentSimTime]
      );

      await client.query(
        `
        UPDATE public.route_plans
        SET
          route_state = 'CANCELLED',
          aircraft_id = NULL,
          registration = NULL,
          updated_at = NOW()
        WHERE airline_id = $1
          AND id = $2
          AND UPPER(COALESCE(route_state, 'ACTIVE')) <> 'CANCELLED'
        `,
        [airlineId, routePlanId]
      );

      const flightLabel = [row.flight_number_out, row.flight_number_in]
        .filter(Boolean)
        .join("/") || `ROUTE-${row.route_plan_id}`;

      await ACS_createOccAlertIfAllowed(
        client,
        {
          airline_id: airlineId,
          alert_key: `SLOT_NON_USE:${row.route_plan_id}`,
          category: "schedule",
          level: "critical",
          title: "SLOT CENTER",
          message: `Flight ${flightLabel} / ${row.origin}-${row.destination} slot released for non-use.`,
          source: "airport_slot_bookings",
          source_ref: String(row.route_plan_id)
        },
        currentSimTime
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("[ACS OCC] expired slot rollback failed:", rollbackError);
      }
    }

    throw error;
  }
}

async function ACS_syncFinanceAlerts(client, airlineId, currentSimTime) {
  const result = await client.query(
    `
    SELECT
      airline_id,
      capital,
      TO_CHAR($2::TIMESTAMPTZ, 'IYYY-"W"IW') AS finance_week_key
    FROM public.company_finance
    WHERE airline_id = $1
      AND COALESCE(capital, 0) < 0
    LIMIT 1
    `,
    [airlineId, currentSimTime]
  );

  if (!result.rows.length) return;

  const row = result.rows[0];

  const capital = Math.round(Number(row.capital || 0));
  const financeWeekKey = String(row.finance_week_key || "UNKNOWN_WEEK");

  const formattedCapital =
    capital < 0
      ? `-$${Math.abs(capital).toLocaleString("en-US")}`
      : `$${capital.toLocaleString("en-US")}`;

  await ACS_createOccAlertIfAllowed(
    client,
    {
      airline_id: airlineId,
      alert_key: `FINANCE_CENTER:NEGATIVE_CAPITAL:${financeWeekKey}`,
      category: "finance",
      level: "critical",
      title: "FINANCE CENTER",
      message: `Cash balance negative: ${formattedCapital}.`,
      source: "company_finance",
      source_ref: String(airlineId)
    },
    currentSimTime
  );
}

async function ACS_syncMaintenanceOverdueAlerts(client, airlineId, currentSimTime) {
  const result = await client.query(
    `
    SELECT
      af.id AS aircraft_id,
      af.registration,
      af.aircraft_name,

      ams.c_check_status,
      ams.c_check_due_date,
      ams.d_check_status,
      ams.d_check_due_date,

      COALESCE(cs.auto_c_check, FALSE) AS auto_c_check,
      COALESCE(cs.auto_d_check, FALSE) AS auto_d_check

    FROM public.aircraft_maintenance_status ams

    JOIN public.aircraft_fleet af
      ON af.id = ams.aircraft_id
     AND af.airline_id = ams.airline_id

    LEFT JOIN public.company_settings cs
      ON cs.airline_id = ams.airline_id

    WHERE ams.airline_id = $1
      AND (
        (
          UPPER(COALESCE(ams.c_check_status, '')) = 'OVERDUE'
          AND COALESCE(cs.auto_c_check, FALSE) = FALSE
        )
        OR
        (
          UPPER(COALESCE(ams.d_check_status, '')) = 'OVERDUE'
          AND COALESCE(cs.auto_d_check, FALSE) = FALSE
        )
      )

    ORDER BY af.id ASC
    `,
    [airlineId]
  );

  for (const row of result.rows) {
    const aircraftLabel =
      String(row.registration || "").trim() ||
      String(row.aircraft_name || "").trim() ||
      `Aircraft ${row.aircraft_id}`;

    if (
      String(row.d_check_status || "").toUpperCase() === "OVERDUE" &&
      row.auto_d_check !== true
    ) {
      await ACS_createOccAlertIfAllowed(
        client,
        {
          airline_id: airlineId,
          alert_key: `MAINTENANCE_D_CHECK_OVERDUE:${row.aircraft_id}`,
          category: "maintenance",
          level: "critical",
          title: "D CHECK OVERDUE",
          message: `Aircraft ${aircraftLabel} D Check overdue.`,
          source: "aircraft_maintenance_status",
          source_ref: String(row.aircraft_id)
        },
        currentSimTime
      );
    }

    if (
      String(row.c_check_status || "").toUpperCase() === "OVERDUE" &&
      row.auto_c_check !== true
    ) {
      await ACS_createOccAlertIfAllowed(
        client,
        {
          airline_id: airlineId,
          alert_key: `MAINTENANCE_C_CHECK_OVERDUE:${row.aircraft_id}`,
          category: "maintenance",
          level: "warning",
          title: "C CHECK OVERDUE",
          message: `Aircraft ${aircraftLabel} C Check overdue.`,
          source: "aircraft_maintenance_status",
          source_ref: String(row.aircraft_id)
        },
        currentSimTime
      );
    }
  }
}

async function ACS_getOccGlobalAirlineIds(client, currentSimTime) {
  const result = await client.query(
    `
    WITH slot_airlines AS (
      SELECT DISTINCT
        rp.airline_id
      FROM public.route_plans rp
      JOIN public.airport_slot_bookings asb
        ON asb.route_plan_id = rp.id
       AND asb.airline_id = rp.airline_id
      WHERE UPPER(COALESCE(rp.route_state, 'ACTIVE')) <> 'CANCELLED'
        AND asb.slot_status = 'RESERVED'
        AND asb.reserved_sim_time IS NOT NULL
        AND (
          FLOOR(
            EXTRACT(EPOCH FROM ($1::TIMESTAMPTZ - asb.reserved_sim_time))
            / 604800
          ) + 1
        ) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM public.schedule_items si
          WHERE si.airline_id = rp.airline_id
            AND si.route_plan_id = rp.id
            AND si.item_type = 'flight'
            AND LOWER(COALESCE(si.status, 'planned')) = 'assigned'
            AND si.aircraft_id IS NOT NULL
        )
    ),
    hr_airlines AS (
      SELECT DISTINCT
        airline_id
      FROM public.hr_departments
      WHERE COALESCE(required, 0) > 0
        AND COALESCE(staff, 0) < COALESCE(required, 0)
    ),
    finance_airlines AS (
      SELECT DISTINCT
        airline_id
      FROM public.company_finance
      WHERE COALESCE(capital, 0) < 0
    )
    SELECT DISTINCT airline_id
    FROM (
      SELECT airline_id FROM slot_airlines
      UNION
      SELECT airline_id FROM hr_airlines
      UNION
      SELECT airline_id FROM finance_airlines
    ) all_airlines
    WHERE airline_id IS NOT NULL
    ORDER BY airline_id ASC
    `,
    [currentSimTime]
  );

  return result.rows
    .map(row => Number(row.airline_id))
    .filter(id => Number.isInteger(id) && id > 0);
}

async function ACS_syncOccAlertsForAirline(client, airlineId, currentSimTime) {
  const results = [];

    const syncJobs = [
    ["HR", ACS_syncHrAlerts],
    ["SLOT", ACS_syncSlotAlerts],
    ["SLOT_EXPIRED", ACS_syncExpiredSlotRoutes],
    ["FINANCE", ACS_syncFinanceAlerts]
  ];

  for (const [syncName, syncFn] of syncJobs) {
    try {
      await syncFn(client, airlineId, currentSimTime);
      results.push({ sync: syncName, ok: true });
    } catch (error) {
      console.error(`[ACS OCC] ${syncName} global sync failed:`, {
        airline_id: airlineId,
        error: error.message
      });

      results.push({
        sync: syncName,
        ok: false,
        error: error.message
      });
    }
  }

  return results;
}

let ACS_occGlobalSyncTimer = null;
let ACS_occGlobalSyncRunning = false;

async function ACS_runGlobalOccAlertSync(source = "timer") {
  if (ACS_occGlobalSyncRunning) return;

  ACS_occGlobalSyncRunning = true;

  let client = null;

  try {
    client = await pool.connect();

    const lockResult = await client.query(`
      SELECT pg_try_advisory_lock(hashtext('ACS_OCC_GLOBAL_ALERT_SYNC')) AS locked
    `);

    if (lockResult.rows[0]?.locked !== true) {
      return;
    }

    const currentSimTime =
      await ACS_getCurrentSimTime(client);

    const airlineIds =
      await ACS_getOccGlobalAirlineIds(
        client,
        currentSimTime
      );

    for (const airlineId of airlineIds) {
      await ACS_syncOccAlertsForAirline(
        client,
        airlineId,
        currentSimTime
      );
    }

    console.log(
      "[ACS OCC] global alert sync completed:",
      {
        source,
        airlines: airlineIds.length,
        current_sim_time: currentSimTime
      }
    );

  } catch (error) {
    console.error(
      "[ACS OCC] global alert sync failed:",
      error
    );

  } finally {
    if (client) {
      try {
        await client.query(`
          SELECT pg_advisory_unlock(
            hashtext('ACS_OCC_GLOBAL_ALERT_SYNC')
          )
        `);
      } catch (_) {}

      client.release();
    }

    ACS_occGlobalSyncRunning = false;
  }
}

function ACS_startGlobalOccAlertSync() {
  if (ACS_occGlobalSyncTimer) return;

  setTimeout(() => {
    ACS_runGlobalOccAlertSync("startup");
  }, 10000);

  ACS_occGlobalSyncTimer = setInterval(() => {
    ACS_runGlobalOccAlertSync("interval");
  }, 60000);

  console.log("[ACS OCC] global alert sync started");
}

router.get("/occ/alerts", requireAuth, async (req, res) => {
  const airlineId = ACS_airlineId(req);

  if (!airlineId) {
    return res.status(401).json({
      alerts: [],
      error: "NO_ACTIVE_AIRLINE"
    });
  }

  try {
    const result = await pool.query(
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
    console.error("[ACS OCC] alerts read failed:", error);

    return res.status(500).json({
      alerts: [],
      error: "OCC_ALERTS_READ_FAILED"
    });
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

ACS_startGlobalOccAlertSync();

export default router;
