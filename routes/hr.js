import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

/* ============================================================
   HR DEFAULT STRUCTURE (18 DEPARTMENTS)
   ------------------------------------------------------------
   • CEO siempre = 1
   • Personal mínimo inicial para aerolínea nueva
   • Solo se inserta si la airline no tiene HR todavía
============================================================ */

const HR_DEFAULT = [

  { id:"ceo", name:"Airline CEO", role:"ceo", staff:1, required:1 },

  { id:"vp", name:"High Level Management (VP)", role:"ceo", staff:0, required:0 },

  { id:"middle", name:"Middle Level Management", role:"admin", staff:1, required:1 },

  { id:"economics", name:"Economics & Finance", role:"admin", staff:1, required:1 },

  { id:"comms", name:"Corporate Communications", role:"admin", staff:0, required:0 },

  { id:"hr", name:"Human Resources", role:"admin", staff:1, required:1 },

  { id:"quality", name:"Quality Department", role:"ground", staff:1, required:1 },

  { id:"security", name:"Safety & Security", role:"ground", staff:0, required:0 },

  { id:"customers", name:"Customer Services", role:"flight_ops", staff:0, required:0 },

  { id:"flightops", name:"Flight Ops Division", role:"flight_ops", staff:1, required:1 },

  { id:"maintenance", name:"Technical Maintenance", role:"maintenance", staff:0, required:0 },

  { id:"ground", name:"Ground Handling", role:"ground", staff:0, required:0 },

  { id:"routes", name:"Route Strategies Department", role:"flight_ops", staff:1, required:1 },

  { id:"pilots_small",  name:"Pilots (Small A/C)",  role:"pilot_small",  staff:0, required:0 },

  { id:"pilots_medium", name:"Pilots (Medium A/C)", role:"pilot_medium", staff:0, required:0 },

  { id:"pilots_large",  name:"Pilots (Large A/C)",  role:"pilot_large",  staff:0, required:0 },

  { id:"pilots_vlarge", name:"Pilots (Very Large A/C)", role:"pilot_vlarge", staff:0, required:0 },

  { id:"cabin", name:"Cabin Crew", role:"cabin", staff:0, required:0 }

];


/* ============================================================
   HR BOOTSTRAP (SERVER SIDE ONLY)
   ------------------------------------------------------------
   • Si la airline no tiene departamentos → los crea
   • Garantiza CEO = 1
============================================================ */

async function ensureHRInitialized(airlineId) {

  const check = await pool.query(
    `SELECT COUNT(*) FROM hr_departments WHERE airline_id = $1`,
    [airlineId]
  );

  const count = Number(check.rows[0].count);

  if (count > 0) return;

  console.log(`HR INIT → Creating default departments for airline ${airlineId}`);

  for (const d of HR_DEFAULT) {

    await pool.query(
      `
      INSERT INTO hr_departments
(
  airline_id,
  dept_id,
  dept_name,
  base_role,
  staff,
  required,
  morale,
  salary,
  payroll,
  bonus,
  years
)
VALUES
(
  $1,$2,$3,$4,$5,$6,100,0,0,0,0
)
ON CONFLICT (airline_id, dept_id)
DO NOTHING
      `,
      [
        airlineId,
        d.id,
        d.name,
        d.role,
        d.staff,
        d.required
      ]
    );

  }

}

/* ============================================================
   ACS HR REQUIRED RESOLVER — BACKEND AUTHORITY
   ------------------------------------------------------------
   - PostgreSQL is authority
   - Calculates required staff from real assigned schedule
   - Does NOT hire staff
   - Does NOT touch finance
   - Does NOT use localStorage
============================================================ */

async function recalculateHRRequired(airlineId) {

  const result = await pool.query(
    `
    WITH active_flights AS (
      SELECT
        si.airline_id,
        si.aircraft_id,
        si.route_plan_id,
        COALESCE(af.model_key, si.model_key, rp.model_key) AS model_key,
        COALESCE(si.distance_nm, rp.distance_nm, 0) AS distance_nm,
        COALESCE(si.block_time_min, rp.block_time_min, 0) AS block_time_min
      FROM public.schedule_items si
      LEFT JOIN public.route_plans rp
        ON rp.id = si.route_plan_id
       AND rp.airline_id = si.airline_id
      LEFT JOIN public.aircraft_fleet af
        ON af.id = si.aircraft_id
       AND af.airline_id = si.airline_id
      WHERE si.airline_id = $1
        AND LOWER(COALESCE(si.status, '')) = 'assigned'
        AND si.item_type = 'flight'
        AND si.aircraft_id IS NOT NULL
    ),
    aircraft_week AS (
      SELECT
        af.airline_id,
        af.aircraft_id,
        af.model_key,
        COUNT(*) AS weekly_legs,
        SUM(af.block_time_min) AS weekly_block_minutes,
        MAX(ac.seats) AS seats,
        MAX(ac.mtow_kg) AS mtow_kg,
        MAX(ac.engines) AS engines
      FROM active_flights af
      LEFT JOIN public.aircraft_catalog ac
        ON LOWER(ac.model_key) = LOWER(af.model_key)
      GROUP BY af.airline_id, af.aircraft_id, af.model_key
    )
    SELECT
      COUNT(*)::int AS active_aircraft,
      COALESCE(SUM(weekly_legs), 0)::int AS assigned_flights,
      COALESCE(SUM(weekly_block_minutes), 0)::int AS weekly_block_minutes,

      COALESCE(SUM(CASE WHEN COALESCE(seats, 0) <= 19 THEN 4 ELSE 0 END), 0)::int AS pilots_small,
      COALESCE(SUM(CASE WHEN COALESCE(seats, 0) > 19 AND COALESCE(seats, 0) <= 70 THEN 6 ELSE 0 END), 0)::int AS pilots_medium,
      COALESCE(SUM(CASE WHEN COALESCE(seats, 0) > 70 AND COALESCE(seats, 0) <= 150 THEN 10 ELSE 0 END), 0)::int AS pilots_large,
      COALESCE(SUM(CASE WHEN COALESCE(seats, 0) > 150 THEN 16 ELSE 0 END), 0)::int AS pilots_vlarge,

      COALESCE(SUM(
        CASE
          WHEN COALESCE(seats, 0) <= 9 THEN 0
          WHEN COALESCE(seats, 0) <= 19 THEN 1
          WHEN COALESCE(seats, 0) <= 70 THEN 4
          WHEN COALESCE(seats, 0) <= 150 THEN 8
          ELSE 14
        END
      ), 0)::int AS cabin,

      GREATEST(1, CEIL(COUNT(*) * 1.0))::int AS maintenance,
      GREATEST(1, CEIL(COUNT(*) * 1.0))::int AS ground,
      GREATEST(1, CEIL(COALESCE(SUM(weekly_legs), 0) / 20.0))::int AS flightops,
      GREATEST(1, CEIL(COUNT(DISTINCT model_key) / 2.0))::int AS quality,
      GREATEST(1, CEIL(COALESCE(SUM(weekly_legs), 0) / 25.0))::int AS routes,
      GREATEST(0, CEIL(COALESCE(SUM(weekly_legs), 0) / 25.0))::int AS customers,
      GREATEST(0, CEIL(COUNT(*) / 4.0))::int AS security
    FROM aircraft_week
    `,
    [airlineId]
  );

  const r = result.rows[0] || {};

  const required = {
    ceo: 1,
    vp: 0,
    middle: 1,
    economics: 1,
    comms: 0,
    hr: 1,

    quality: Number(r.quality || 1),
    security: Number(r.security || 0),
    customers: Number(r.customers || 0),
    flightops: Number(r.flightops || 1),
    maintenance: Number(r.maintenance || 0),
    ground: Number(r.ground || 0),
    routes: Number(r.routes || 1),

    pilots_small: Number(r.pilots_small || 0),
    pilots_medium: Number(r.pilots_medium || 0),
    pilots_large: Number(r.pilots_large || 0),
    pilots_vlarge: Number(r.pilots_vlarge || 0),
    cabin: Number(r.cabin || 0)
  };

  for (const [deptId, requiredStaff] of Object.entries(required)) {
    await pool.query(
      `
      UPDATE public.hr_departments
      SET
        required = $3,
        updated_at = NOW()
      WHERE airline_id = $1
        AND dept_id = $2
      `,
      [airlineId, deptId, requiredStaff]
    );
  }

  return required;
}

/* ============================================================
   ACS HR MORALE MONTHLY RESOLVER — BACKEND AUTHORITY
   ------------------------------------------------------------
   - PostgreSQL authority
   - Runs once per sim month per department
   - Penalizes morale only when staff < required
   - Does not hire staff
   - Does not touch finance
============================================================ */

async function applyHRMoraleMonthlyResolver(airlineId) {

  const simResult = await pool.query(`
    SELECT
      EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year,
      EXTRACT(MONTH FROM acs_get_current_sim_time())::int AS sim_month
  `);

  const simYear = Number(simResult.rows[0]?.sim_year);
  const simMonth = Number(simResult.rows[0]?.sim_month);

  if (!Number.isInteger(simYear) || !Number.isInteger(simMonth)) {
    return { ok: false, skipped: true, reason: "INVALID_SIM_TIME" };
  }

  const departmentsResult = await pool.query(
    `
    SELECT
      dept_id,
      dept_name,
      staff,
      required,
      morale,
      morale_last_sim_year,
      morale_last_sim_month
    FROM public.hr_departments
    WHERE airline_id = $1
    FOR UPDATE
    `,
    [airlineId]
  );

  const updates = [];

  for (const dep of departmentsResult.rows) {

    const staff = Number(dep.staff || 0);
    const required = Number(dep.required || 0);
    const morale = Number(dep.morale || 100);

    if (
      Number(dep.morale_last_sim_year) === simYear &&
      Number(dep.morale_last_sim_month) === simMonth
    ) {
      continue;
    }

    const deficit = Math.max(0, required - staff);

    let moraleDelta = 0;

    if (required > 0 && deficit > 0) {
      const ratio = deficit / required;

      if (ratio >= 1) moraleDelta = -8;
      else if (ratio >= 0.76) moraleDelta = -6;
      else if (ratio >= 0.51) moraleDelta = -4;
      else if (ratio >= 0.26) moraleDelta = -2;
      else moraleDelta = -1;
    } else if (deficit === 0 && morale < 100) {
      moraleDelta = 1;
    }

    const newMorale = Math.max(
      40,
      Math.min(100, morale + moraleDelta)
    );

    await pool.query(
      `
      UPDATE public.hr_departments
      SET
        morale = $3,
        morale_last_sim_year = $4,
        morale_last_sim_month = $5,
        updated_at = NOW()
      WHERE airline_id = $1
        AND dept_id = $2
      `,
      [airlineId, dep.dept_id, newMorale, simYear, simMonth]
    );

    updates.push({
      dept_id: dep.dept_id,
      dept_name: dep.dept_name,
      staff,
      required,
      deficit,
      old_morale: morale,
      morale_delta: moraleDelta,
      new_morale: newMorale
    });
  }

  return {
    ok: true,
    sim_year: simYear,
    sim_month: simMonth,
    updated_count: updates.length,
    updates
  };
}

/* ============================================================
   GET HR DEPARTMENTS
   ------------------------------------------------------------
   • Server authority
   • Inicializa HR automáticamente si está vacío
============================================================ */

router.get("/hr/departments/:airlineId", async (req, res) => {

  const airlineId = req.params.airlineId;

  try {

    /* --------------------------------------------------------
       1️⃣ Garantizar que HR exista
    -------------------------------------------------------- */

    await ensureHRInitialized(airlineId);

    await recalculateHRRequired(airlineId);

    await applyHRMoraleMonthlyResolver(airlineId);
     
    /* --------------------------------------------------------
       2️⃣ Obtener departamentos
    -------------------------------------------------------- */

    const result = await pool.query(
      `
      SELECT
        dept_id,
        dept_name,
        base_role,
        staff,
        required,
        morale,
        salary,
        payroll,
        bonus,
        years
      FROM hr_departments
      WHERE airline_id = $1
      ORDER BY dept_id
      `,
      [airlineId]
    );

    res.json({
      ok: true,
      departments: result.rows
    });

  } catch (err) {

    console.error("HR FETCH ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });

  }

});

/* ============================================================
   PATCH HR STAFF (PERSIST STAFF CHANGES)
   ------------------------------------------------------------
   Guarda cambios de staff en Railway
   ============================================================ */

router.patch("/hr/staff", async (req, res) => {

 const { airline_id, dept_id, staff, morale, salary, payroll } = req.body;

  try {

    await pool.query(
`
UPDATE hr_departments
SET
  staff = $3,
  morale = COALESCE($4, morale),
  salary = COALESCE($5, salary),
  payroll = COALESCE($6, payroll),
  updated_at = NOW()
WHERE airline_id = $1
AND dept_id = $2
`,
[airline_id, dept_id, staff, morale, salary, payroll]
);

    res.json({ ok: true });

  } catch (err) {

    console.error("HR UPDATE ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });

  }

});

/* ============================================================
   GET HR PAYROLL TOTAL
   ============================================================ */

router.get("/hr/payroll/:airlineId", async (req, res) => {

  const { airlineId } = req.params;

  try {

    const result = await pool.query(`
      SELECT COALESCE(SUM(payroll),0) AS total
      FROM hr_departments
      WHERE airline_id = $1
    `,[airlineId]);

    res.json({
      ok: true,
      payroll: Number(result.rows[0].total)
    });

  } catch(err){

    console.error("HR PAYROLL ERROR:", err);

    res.status(500).json({
      ok:false,
      error: err.message
    });

  }

});

let HR_MORALE_SCHEDULER = null;
let HR_MORALE_RUNNING = false;

async function runHRMoraleSchedulerTick() {
  if (HR_MORALE_RUNNING) return;

  HR_MORALE_RUNNING = true;

  const client = await pool.connect();

  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(35702026) AS locked"
    );

    if (lock.rows[0]?.locked !== true) return;

    const airlinesResult = await client.query(`
      SELECT DISTINCT airline_id
      FROM public.hr_departments
      ORDER BY airline_id
    `);

    for (const row of airlinesResult.rows) {
      const airlineId = Number(row.airline_id);
      if (!Number.isInteger(airlineId)) continue;

      await recalculateHRRequired(airlineId);
      await applyHRMoraleMonthlyResolver(airlineId);
    }

  } catch (err) {
    console.error("HR MORALE SCHEDULER ERROR:", err);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(35702026)");
    } catch (_) {}

    client.release();
    HR_MORALE_RUNNING = false;
  }
}

export function startHRMoraleScheduler() {
  if (HR_MORALE_SCHEDULER) return;

  HR_MORALE_SCHEDULER = setInterval(
    runHRMoraleSchedulerTick,
    60 * 1000
  );

  runHRMoraleSchedulerTick();

  console.log("[ACS HR] Morale scheduler started");
}

export function stopHRMoraleScheduler() {
  if (!HR_MORALE_SCHEDULER) return;

  clearInterval(HR_MORALE_SCHEDULER);
  HR_MORALE_SCHEDULER = null;

  console.log("[ACS HR] Morale scheduler stopped");
}

export default router;
