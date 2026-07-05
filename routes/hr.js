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
    WHEN COALESCE(seats, 0) <= 19 THEN 2
    WHEN COALESCE(seats, 0) <= 50 THEN 4
    WHEN COALESCE(seats, 0) <= 100 THEN 6
    WHEN COALESCE(seats, 0) <= 180 THEN 10
    WHEN COALESCE(seats, 0) <= 300 THEN 16
    ELSE 24
  END
), 0)::int AS cabin,

GREATEST(1, CEIL(COUNT(*) * 1.2))::int AS maintenance,
GREATEST(1, CEIL(COUNT(*) * 2.0))::int AS ground,
GREATEST(1, CEIL(COALESCE(SUM(weekly_legs), 0) / 18.0))::int AS flightops,
GREATEST(1, CEIL(COUNT(DISTINCT model_key) / 2.0))::int AS quality,
GREATEST(1, CEIL(COALESCE(SUM(weekly_legs), 0) / 22.0))::int AS routes,
GREATEST(0, CEIL(COALESCE(SUM(weekly_legs), 0) / 18.0))::int AS customers,
GREATEST(0, CEIL(COUNT(*) / 3.0))::int AS security
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
   ACS HR OPERATIONAL RISK RESOLVER — PHASE 3A
   ------------------------------------------------------------
   Server-side only.
   Calculates HR operational risk per airline.
   Does NOT delay, cancel, or modify flights yet.
============================================================ */

const HR_OPERATIONAL_RULES = {
  pilots_small:  { area: "flight_crew", critical: true,  hardBlock: true,  weight: 35 },
  pilots_medium: { area: "flight_crew", critical: true,  hardBlock: true,  weight: 35 },
  pilots_large:  { area: "flight_crew", critical: true,  hardBlock: true,  weight: 35 },
  pilots_vlarge: { area: "flight_crew", critical: true,  hardBlock: true,  weight: 35 },

  cabin:       { area: "cabin_crew",  critical: true,  hardBlock: true,  weight: 28 },
  flightops:   { area: "dispatch",    critical: true,  hardBlock: true,  weight: 22 },
  maintenance: { area: "maintenance", critical: true,  hardBlock: true,  weight: 25 },
  ground:      { area: "ground_ops",  critical: true,  hardBlock: true,  weight: 24 },

  routes:      { area: "planning",    critical: false, hardBlock: false, weight: 12 },
  customers:   { area: "service",     critical: false, hardBlock: false, weight: 10 },
  quality:     { area: "quality",     critical: false, hardBlock: false, weight: 10 },
  security:    { area: "safety",      critical: false, hardBlock: false, weight: 12 },

  ceo:       { area: "admin", critical: false, hardBlock: false, weight: 4 },
  vp:        { area: "admin", critical: false, hardBlock: false, weight: 4 },
  middle:    { area: "admin", critical: false, hardBlock: false, weight: 4 },
  economics: { area: "admin", critical: false, hardBlock: false, weight: 4 },
  comms:     { area: "admin", critical: false, hardBlock: false, weight: 3 },
  hr:        { area: "admin", critical: false, hardBlock: false, weight: 5 }
};

function ACS_HR_classifyDepartmentRisk(dept) {
  const deptId = String(dept.dept_id || "");
  const rule = HR_OPERATIONAL_RULES[deptId] || {
    area: "general",
    critical: false,
    hardBlock: false,
    weight: 5
  };

  const staff = Math.max(0, Number(dept.staff || 0));
  const required = Math.max(0, Number(dept.required || 0));
  const deficit = Math.max(0, required - staff);

  if (required <= 0 || deficit <= 0) {
    return {
      dept_id: deptId,
      dept_name: dept.dept_name,
      area: rule.area,
      staff,
      required,
      deficit: 0,
      coveragePct: 100,
      severity: "OK",
      hardBlock: false,
      riskPoints: 0
    };
  }

  const coverage = staff / required;
  const coveragePct = Math.round(coverage * 100);
  const deficitRatio = deficit / required;

  let severity = "WARNING";
  let hardBlock = false;

  if (rule.hardBlock && staff <= 0) {
    severity = "BLOCKED";
    hardBlock = true;
  } else if (rule.critical && coverage < 0.5) {
    severity = "CRITICAL";
  } else if (deficitRatio >= 0.5) {
    severity = "CRITICAL";
  }

  const riskPoints = Math.round(rule.weight * deficitRatio);

  return {
    dept_id: deptId,
    dept_name: dept.dept_name,
    area: rule.area,
    staff,
    required,
    deficit,
    coveragePct,
    severity,
    hardBlock,
    riskPoints
  };
}

export async function resolveHROperationalRisk(airlineId) {
  await ensureHRInitialized(airlineId);

  if (typeof recalculateHRRequired === "function") {
    await recalculateHRRequired(airlineId);
  }

  const result = await pool.query(
    `
    SELECT
      dept_id,
      dept_name,
      staff,
      required,
      morale
    FROM public.hr_departments
    WHERE airline_id = $1
    ORDER BY dept_id
    `,
    [airlineId]
  );

  const departments = result.rows.map(ACS_HR_classifyDepartmentRisk);

  const totalRiskPoints = departments.reduce(
    (sum, d) => sum + Number(d.riskPoints || 0),
    0
  );

  const blockedDepartments = departments.filter(d => d.severity === "BLOCKED");
  const criticalDepartments = departments.filter(d => d.severity === "CRITICAL");
  const warningDepartments = departments.filter(d => d.severity === "WARNING");

  const dispatchBlocked = blockedDepartments.length > 0;

  let operationalStatus = "OK";

  if (dispatchBlocked) {
    operationalStatus = "BLOCKED";
  } else if (criticalDepartments.length > 0) {
    operationalStatus = "CRITICAL";
  } else if (warningDepartments.length > 0) {
    operationalStatus = "WARNING";
  }

  const delayRiskPct = Math.min(95, Math.max(0, totalRiskPoints));
  const cancelRiskPct = dispatchBlocked
    ? Math.min(85, Math.max(35, Math.round(totalRiskPoints * 0.75)))
    : Math.min(70, Math.max(0, Math.round(totalRiskPoints * 0.45)));

  return {
    ok: true,
    airline_id: Number(airlineId),
    operationalStatus,
    dispatchBlocked,
    delayRiskPct,
    cancelRiskPct,
    blockedDepartments,
    criticalDepartments,
    warningDepartments,
    departments
  };
}

/* ============================================================
   ACS HR → SKYTRACK FLIGHT RISK FEED — PHASE 3B
   ------------------------------------------------------------
   Server-side diagnostic only.
   Does NOT update schedule_items.
   Does NOT cancel flights.
   Does NOT write delays.
   Gives SkyTrack a personnel-risk view per flight.
============================================================ */

function ACS_HR_getPilotDeptForSeats(seats) {
  const s = Number(seats || 0);

  if (s <= 19) return "pilots_small";
  if (s <= 70) return "pilots_medium";
  if (s <= 150) return "pilots_large";
  return "pilots_vlarge";
}

function ACS_HR_buildFlightPersonnelRisk(flight, riskByDept, globalRisk) {
  const seats = Number(flight.seats || 0);
  const pilotDept = ACS_HR_getPilotDeptForSeats(seats);

  const relevantDeptIds = [
    pilotDept,
    "flightops",
    "maintenance",
    "ground"
  ];

  if (seats > 9) {
    relevantDeptIds.push("cabin");
  }

  const problems = relevantDeptIds
    .map(deptId => riskByDept.get(deptId))
    .filter(dep => dep && Number(dep.deficit || 0) > 0);

  const blocked = problems.some(dep => dep.severity === "BLOCKED");
  const critical = problems.some(dep => dep.severity === "CRITICAL");
  const warning = problems.some(dep => dep.severity === "WARNING");

  let opsStatus = "ON TIME";
  let delayMinutes = 0;

  if (blocked) {
    opsStatus = "CANCELLED - PERSONNEL";
    delayMinutes = null;
  } else if (critical || warning) {
    opsStatus = "DELAYED - PERSONNEL";

    const localRiskPoints = problems.reduce(
      (sum, dep) => sum + Number(dep.riskPoints || 0),
      0
    );

    const riskScore = Math.max(
      Number(globalRisk.delayRiskPct || 0),
      localRiskPoints
    );

    delayMinutes = critical
      ? Math.min(120, Math.max(30, Math.round(riskScore * 1.5)))
      : Math.min(60, Math.max(15, Math.round(riskScore * 1.1)));
  }

  return {
    schedule_item_id: flight.id,
    flight_number: flight.flight_number,
    aircraft_registration: flight.aircraft_registration,
    aircraft: flight.aircraft,
    model_key: flight.model_key,
    seats,
    origin: flight.origin,
    destination: flight.destination,
    selected_day: flight.selected_day,
    departure: flight.departure,
    arrival: flight.arrival,
    schedule_status: flight.status,

    opsStatus,
    delayMinutes,

    personnelRisk: {
      globalStatus: globalRisk.operationalStatus,
      delayRiskPct: globalRisk.delayRiskPct,
      cancelRiskPct: globalRisk.cancelRiskPct,
      pilotDept,
      affectedDepartments: problems.map(dep => ({
        dept_id: dep.dept_id,
        dept_name: dep.dept_name,
        area: dep.area,
        staff: dep.staff,
        required: dep.required,
        deficit: dep.deficit,
        coveragePct: dep.coveragePct,
        severity: dep.severity
      }))
    },

    reasons: problems.map(dep =>
      `${dep.dept_name}: ${dep.staff}/${dep.required}`
    )
  };
}

export async function resolveHRSkyTrackRiskFeed(airlineId) {
  const globalRisk = await resolveHROperationalRisk(airlineId);

  const riskByDept = new Map(
    globalRisk.departments.map(dep => [dep.dept_id, dep])
  );

  const flightsResult = await pool.query(
    `
    SELECT
      si.id,
      si.airline_id,
      si.route_plan_id,
      si.aircraft_id,
      si.flight_number,
      si.origin,
      si.destination,
      si.selected_day,
      si.departure,
      si.arrival,
      si.status,
      si.aircraft_registration,
      si.aircraft,
      COALESCE(af.model_key, si.model_key, rp.model_key) AS model_key,
      COALESCE(ac.seats, 0)::int AS seats
    FROM public.schedule_items si
    LEFT JOIN public.route_plans rp
      ON rp.id = si.route_plan_id
     AND rp.airline_id = si.airline_id
    LEFT JOIN public.aircraft_fleet af
      ON af.id = si.aircraft_id
     AND af.airline_id = si.airline_id
    LEFT JOIN public.aircraft_catalog ac
      ON LOWER(ac.model_key) = LOWER(COALESCE(af.model_key, si.model_key, rp.model_key))
    WHERE si.airline_id = $1
      AND si.item_type = 'flight'
      AND LOWER(COALESCE(si.status, '')) = 'assigned'
      AND si.aircraft_id IS NOT NULL
    ORDER BY si.id DESC
    LIMIT 250
    `,
    [airlineId]
  );

  const flights = flightsResult.rows.map(flight =>
    ACS_HR_buildFlightPersonnelRisk(flight, riskByDept, globalRisk)
  );

  return {
    ok: true,
    airline_id: Number(airlineId),
    source: "HR_PERSONNEL_RISK",
    mode: "DIAGNOSTIC_ONLY",
    globalRisk: {
      operationalStatus: globalRisk.operationalStatus,
      dispatchBlocked: globalRisk.dispatchBlocked,
      delayRiskPct: globalRisk.delayRiskPct,
      cancelRiskPct: globalRisk.cancelRiskPct
    },
    flights
  };
}

/* ============================================================
   ACS HR OPS IMPACT WRITER — PHASE 3E
   ------------------------------------------------------------
   Persists personnel delay/cancellation into SkyTrack ops table.
   Global logic:
   - per airline_id
   - per aircraft_registration
   - per sim day
   - delay propagates through same aircraft daily rotation
   - resets next sim day based on current HR state
   - does NOT touch finance/passengers/reputation
============================================================ */

function ACS_HR_clampDelayMinutes(value) {
  const n = Number(value || 0);
  return Math.max(0, Math.min(240, Math.round(n)));
}

function ACS_HR_getDayCarryRecoveryMinutes(flight) {
  const turnaround = Number(flight.turnaround_min || 0);

  if (turnaround >= 60) return 30;
  if (turnaround >= 35) return 20;
  return 12;
}

function ACS_HR_shouldCancelForPersonnel(flightRisk, carriedDelay) {
  if (flightRisk.opsStatus === "CANCELLED - PERSONNEL") return true;
  if (Number(carriedDelay || 0) >= 240) return true;
  return false;
}

export async function applyHROpsImpactForAirline(airlineId) {
  const simResult = await pool.query(`
    SELECT
      EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year,
      EXTRACT(MONTH FROM acs_get_current_sim_time())::int AS sim_month,
      EXTRACT(DAY FROM acs_get_current_sim_time())::int AS sim_day,
      LOWER(TRIM(TO_CHAR(acs_get_current_sim_time(), 'dy'))) AS sim_dow
  `);

  const sim = simResult.rows[0];

  const simYear = Number(sim?.sim_year);
  const simMonth = Number(sim?.sim_month);
  const simDay = Number(sim?.sim_day);
  const simDow = String(sim?.sim_dow || "").slice(0, 3);

  if (!Number.isInteger(simYear) || !Number.isInteger(simMonth) || !Number.isInteger(simDay) || !simDow) {
    return {
      ok: false,
      skipped: true,
      reason: "INVALID_SIM_TIME"
    };
  }

  const globalRisk = await resolveHROperationalRisk(airlineId);

  const riskByDept = new Map(
    globalRisk.departments.map(dep => [dep.dept_id, dep])
  );

  const flightsResult = await pool.query(
    `
    SELECT
      si.id,
      si.airline_id,
      si.route_plan_id,
      si.aircraft_id,
      si.flight_number,
      si.origin,
      si.destination,
      si.selected_day,
      si.departure,
      si.arrival,
      si.status,
      si.dep_abs_min,
      si.arr_abs_min,
      si.turnaround_min,
      si.aircraft_registration,
      si.aircraft,
      COALESCE(af.model_key, si.model_key, rp.model_key) AS model_key,
      COALESCE(ac.seats, 0)::int AS seats
    FROM public.schedule_items si
    LEFT JOIN public.route_plans rp
      ON rp.id = si.route_plan_id
     AND rp.airline_id = si.airline_id
    LEFT JOIN public.aircraft_fleet af
      ON af.id = si.aircraft_id
     AND af.airline_id = si.airline_id
    LEFT JOIN public.aircraft_catalog ac
      ON LOWER(ac.model_key) = LOWER(COALESCE(af.model_key, si.model_key, rp.model_key))
    WHERE si.airline_id = $1
      AND si.item_type = 'flight'
      AND LOWER(COALESCE(si.status, '')) = 'assigned'
      AND LOWER(COALESCE(si.selected_day, '')) = $2
      AND si.aircraft_id IS NOT NULL
    ORDER BY
      si.aircraft_registration ASC NULLS LAST,
      COALESCE(si.dep_abs_min, 0) ASC,
      si.id ASC
    `,
    [airlineId, simDow]
  );

  const carryByAircraft = new Map();
  const applied = [];

  for (const flight of flightsResult.rows) {
    const aircraftReg = String(flight.aircraft_registration || `AIRCRAFT-${flight.aircraft_id}`);
    const baseRisk = ACS_HR_buildFlightPersonnelRisk(flight, riskByDept, globalRisk);

    const previousCarry = Number(carryByAircraft.get(aircraftReg) || 0);
    const baseDelay = ACS_HR_clampDelayMinutes(baseRisk.delayMinutes || 0);
    let finalDelay = Math.max(baseDelay, previousCarry);

    let opsStatus = "ON TIME";
    let cancelReason = null;

    if (ACS_HR_shouldCancelForPersonnel(baseRisk, finalDelay)) {
      opsStatus = "CANCELLED - PERSONNEL";
      finalDelay = 0;
      cancelReason = "HR_PERSONNEL_SHORTAGE";
      carryByAircraft.set(aircraftReg, Math.max(previousCarry, 90));
    } else if (finalDelay > 0) {
      opsStatus = "DELAYED - PERSONNEL";

      const recovery = ACS_HR_getDayCarryRecoveryMinutes(flight);
      const nextCarry = Math.max(0, finalDelay - recovery);

      carryByAircraft.set(aircraftReg, nextCarry);
    } else {
      carryByAircraft.set(aircraftReg, 0);
    }

    const riskPayload = {
      globalStatus: globalRisk.operationalStatus,
      dispatchBlocked: globalRisk.dispatchBlocked,
      delayRiskPct: globalRisk.delayRiskPct,
      cancelRiskPct: globalRisk.cancelRiskPct,
      personnelRisk: baseRisk.personnelRisk,
      reasons: baseRisk.reasons,
      carriedDelayIn: previousCarry,
      finalDelayMinutes: finalDelay
    };

    await pool.query(
      `
      INSERT INTO public.skytrack_ops_impacts (
        airline_id,
        schedule_item_id,
        sim_year,
        sim_month,
        sim_day,
        sim_dow,
        aircraft_registration,
        flight_number,
        origin,
        destination,
        ops_status,
        delay_minutes,
        delay_source,
        cancel_reason,
        risk_source,
        risk_payload,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        CASE WHEN $12 > 0 THEN 'HR_PERSONNEL' ELSE NULL END,
        $13,
        'HR_PERSONNEL_RISK',
        $14::jsonb,
        NOW()
      )
      ON CONFLICT (airline_id, schedule_item_id, sim_year, sim_month, sim_day)
      DO UPDATE SET
        sim_dow = EXCLUDED.sim_dow,
        aircraft_registration = EXCLUDED.aircraft_registration,
        flight_number = EXCLUDED.flight_number,
        origin = EXCLUDED.origin,
        destination = EXCLUDED.destination,
        ops_status = EXCLUDED.ops_status,
        delay_minutes = EXCLUDED.delay_minutes,
        delay_source = EXCLUDED.delay_source,
        cancel_reason = EXCLUDED.cancel_reason,
        risk_source = EXCLUDED.risk_source,
        risk_payload = EXCLUDED.risk_payload,
        updated_at = NOW()
      `,
      [
        airlineId,
        flight.id,
        simYear,
        simMonth,
        simDay,
        simDow,
        flight.aircraft_registration,
        flight.flight_number,
        flight.origin,
        flight.destination,
        opsStatus,
        finalDelay,
        cancelReason,
        JSON.stringify(riskPayload)
      ]
    );

    applied.push({
      schedule_item_id: flight.id,
      flight_number: flight.flight_number,
      aircraft_registration: flight.aircraft_registration,
      origin: flight.origin,
      destination: flight.destination,
      opsStatus,
      delayMinutes: finalDelay,
      carriedDelayIn: previousCarry,
      reasons: baseRisk.reasons
    });
  }

  return {
    ok: true,
    mode: "PERSISTED",
    airline_id: Number(airlineId),
    sim_year: simYear,
    sim_month: simMonth,
    sim_day: simDay,
    sim_dow: simDow,
    globalRisk: {
      operationalStatus: globalRisk.operationalStatus,
      dispatchBlocked: globalRisk.dispatchBlocked,
      delayRiskPct: globalRisk.delayRiskPct,
      cancelRiskPct: globalRisk.cancelRiskPct
    },
    applied_count: applied.length,
    applied
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

/* ============================================================
   GET HR OPERATIONAL RISK
   ============================================================ */

router.get("/hr/ops-risk/:airlineId", async (req, res) => {
  const airlineId = Number(req.params.airlineId);

  try {
    const risk = await resolveHROperationalRisk(airlineId);
    res.json(risk);
  } catch (err) {
    console.error("HR OPS RISK ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ============================================================
   GET HR → SKYTRACK PERSONNEL RISK FEED
   ============================================================ */

router.get("/hr/skytrack-risk/:airlineId", async (req, res) => {
  const airlineId = Number(req.params.airlineId);

  try {
    const feed = await resolveHRSkyTrackRiskFeed(airlineId);
    res.json(feed);
  } catch (err) {
    console.error("HR SKYTRACK RISK FEED ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ============================================================
   APPLY HR OPS IMPACT — MANUAL TEST / PHASE 3E
   ============================================================ */

router.post("/hr/ops-impact/apply/:airlineId", async (req, res) => {
  const airlineId = Number(req.params.airlineId);

  try {
    const result = await applyHROpsImpactForAirline(airlineId);
    res.json(result);
  } catch (err) {
    console.error("HR OPS IMPACT APPLY ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ============================================================
   GET HR OPS IMPACTS FOR CURRENT SIM DAY
   ============================================================ */

router.get("/hr/ops-impact/:airlineId", async (req, res) => {
  const airlineId = Number(req.params.airlineId);

  try {
    const simResult = await pool.query(`
      SELECT
        EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year,
        EXTRACT(MONTH FROM acs_get_current_sim_time())::int AS sim_month,
        EXTRACT(DAY FROM acs_get_current_sim_time())::int AS sim_day
    `);

    const sim = simResult.rows[0];

    const result = await pool.query(
      `
      SELECT *
      FROM public.skytrack_ops_impacts
      WHERE airline_id = $1
        AND sim_year = $2
        AND sim_month = $3
        AND sim_day = $4
      ORDER BY aircraft_registration, id
      `,
      [airlineId, sim.sim_year, sim.sim_month, sim.sim_day]
    );

    res.json({
      ok: true,
      airline_id: airlineId,
      sim,
      impacts: result.rows
    });
  } catch (err) {
    console.error("HR OPS IMPACT FETCH ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

export default router;
