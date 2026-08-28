import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   HR SEMESTRAL SALARY AUTHORITY — POSTGRESQL
   ------------------------------------------------------------
   • public.hr_salary_standards is the only salary authority
   • H1 = January through June; H2 = July through December
   • Pilot salary is Captain + F/O for the standard two-seat crew
   • Every additional technical cockpit member is paid as F/O
   ============================================================ */

const HR_DEPARTMENT_IDS = new Set([
  "ceo", "vp", "middle", "economics", "comms", "hr", "quality",
  "security", "customers", "flightops", "maintenance", "ground",
  "routes", "pilots_small", "pilots_medium", "pilots_large",
  "pilots_vlarge", "cabin"
]);

function isHRPilotDepartment(deptId) {
  return String(deptId || "").startsWith("pilots_");
}

function getHRSalaryCycle(year, month) {
  const cycleYear = Number(year);
  const simMonth = Number(month);

  if (!Number.isInteger(cycleYear) || cycleYear < 1940 || cycleYear > 2028) {
    throw new Error("INVALID_HR_SIM_YEAR");
  }

  if (!Number.isInteger(simMonth) || simMonth < 1 || simMonth > 12) {
    throw new Error("INVALID_HR_SIM_MONTH");
  }

  return {
    year: cycleYear,
    half: simMonth <= 6 ? 1 : 2,
    key: `${cycleYear}-H${simMonth <= 6 ? 1 : 2}`
  };
}

async function getHRSalaryStandard(client, deptId, cycleYear, cycleHalf) {
  if (!HR_DEPARTMENT_IDS.has(deptId)) {
    throw new Error(`UNKNOWN_HR_DEPARTMENT:${deptId}`);
  }

  const result = await client.query(
    `
    SELECT
      cycle_year,
      cycle_half,
      dept_id,
      monthly_salary,
      captain_salary,
      first_officer_salary,
      standard_two_crew_cost,
      source_class
    FROM public.hr_salary_standards
    WHERE cycle_year = $1
      AND cycle_half = $2
      AND dept_id = $3
    LIMIT 1
    `,
    [cycleYear, cycleHalf, deptId]
  );

  if (result.rowCount !== 1) {
    throw new Error(`HR_SALARY_STANDARD_NOT_FOUND:${cycleYear}-H${cycleHalf}:${deptId}`);
  }

  const row = result.rows[0];
  const pilot = isHRPilotDepartment(deptId);
  const baseSalary = pilot
    ? Number(row.standard_two_crew_cost)
    : Number(row.monthly_salary);

  if (!Number.isFinite(baseSalary) || baseSalary <= 0) {
    throw new Error(`INVALID_HR_SALARY_STANDARD:${deptId}`);
  }

  return {
    cycleYear: Number(row.cycle_year),
    cycleHalf: Number(row.cycle_half),
    cycleKey: `${row.cycle_year}-H${row.cycle_half}`,
    salary: Math.round(baseSalary),
    captainSalary: pilot ? Number(row.captain_salary) : null,
    firstOfficerSalary: pilot ? Number(row.first_officer_salary) : null,
    sourceClass: String(row.source_class)
  };
}

function applyHRSalaryPercent(value, percent) {
  if (value === null || value === undefined) return null;
  return Math.max(1, Math.round(Number(value) * (Number(percent) / 100)));
}

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
   HR BOOTSTRAP — BACKEND AUTHORITY
   ------------------------------------------------------------
   • Creates missing departments without overwriting existing HR
   • New companies start with the official minimum staff
   • New companies start with the current simulated semester salary
   • Auto Hire and Auto Salary start enabled
   • CEO always remains at least 1
   ============================================================ */

async function ensureHRInitialized(airlineId) {
  const normalizedAirlineId = Number(airlineId);

  if (!Number.isInteger(normalizedAirlineId) || normalizedAirlineId <= 0) {
    throw new Error("INVALID_AIRLINE_ID");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO public.company_settings (
        airline_id,
        auto_hire,
        auto_salary,
        manual_salary_override,
        auto_c_check,
        auto_d_check
      )
      VALUES ($1, true, true, false, false, false)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [normalizedAirlineId]
    );

        const existingDepartmentsResult = await client.query(
      `
      SELECT dept_id
      FROM public.hr_departments
      WHERE airline_id = $1
      `,
      [normalizedAirlineId]
    );

    const existingDepartmentIds = new Set(
      existingDepartmentsResult.rows.map(
        row => String(row.dept_id)
      )
    );

    const simResult = await client.query(
      `
      SELECT
        EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year,
        EXTRACT(MONTH FROM acs_get_current_sim_time())::int AS sim_month
      `
    );

    const salaryCycle = getHRSalaryCycle(
      Number(simResult.rows[0]?.sim_year),
      Number(simResult.rows[0]?.sim_month)
    );
     
    for (const department of HR_DEFAULT) {
       
      if (existingDepartmentIds.has(department.id)) {
        continue;
      }
       
       const standard = await getHRSalaryStandard(
        client,
        department.id,
        salaryCycle.year,
        salaryCycle.half
      );

      await client.query(
        `
        INSERT INTO public.hr_departments (
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
          years,
          salary_percent,
          salary_decade,
          salary_cycle_year,
          salary_cycle_half,
          captain_salary,
          first_officer_salary
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::INTEGER,
          $6::INTEGER,
          100,
          $7::NUMERIC,
          ROUND(
            ($5::INTEGER)::NUMERIC *
            $7::NUMERIC
          )::BIGINT,
          0,
          0,
          100,
          $8::INTEGER,
          $8::SMALLINT,
          $9::SMALLINT,
          $10::INTEGER,
          $11::INTEGER
        )
        ON CONFLICT (airline_id, dept_id)
        DO NOTHING
        `,
        [
          normalizedAirlineId,
          department.id,
          department.name,
          department.role,
          department.staff,
          department.required,
          standard.salary,
          salaryCycle.year,
          salaryCycle.half,
          standard.captainSalary,
          standard.firstOfficerSalary
        ]
      );
    }

    await client.query(
      `
      UPDATE public.hr_departments
      SET
        staff = GREATEST(COALESCE(staff, 0), 1),
        required = GREATEST(COALESCE(required, 0), 1),
        payroll = ROUND(
          GREATEST(COALESCE(staff, 0), 1)::NUMERIC *
          COALESCE(salary, 0)::NUMERIC
        )::BIGINT,
        updated_at = NOW()
      WHERE airline_id = $1
        AND dept_id = 'ceo'
      `,
      [normalizedAirlineId]
    );

    await client.query("COMMIT");

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;

  } finally {
    client.release();
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

CASE
  WHEN COUNT(*) = 0 THEN 0
  ELSE GREATEST(1, CEIL(COUNT(*) * 1.2))
END::int AS maintenance,

CASE
  WHEN COUNT(*) = 0 THEN 0
  ELSE GREATEST(1, CEIL(COUNT(*) * 2.0))
END::int AS ground,

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

    const requiredRows = Object.entries(required).map(
    ([deptId, requiredStaff]) => ({
      dept_id: deptId,
      required: requiredStaff
    })
  );

  await pool.query(
    `
    UPDATE public.hr_departments AS department
    SET
      required = incoming.required,
      updated_at = NOW()
    FROM jsonb_to_recordset($2::jsonb) AS incoming(
      dept_id TEXT,
      required INTEGER
    )
    WHERE department.airline_id = $1
      AND department.dept_id = incoming.dept_id
    `,
    [
      airlineId,
      JSON.stringify(requiredRows)
    ]
  );

  return required;
}

/* ============================================================
   HR AUTOMATION RESOLVER — BACKEND AUTHORITY
   ------------------------------------------------------------
   • Reads company_settings from PostgreSQL
   • Auto Hire fills deficits but never dismisses staff
   • Auto Salary applies each semester exactly once
   • Manual salary mode freezes stored salaries
   • Auto Hire never dismisses surplus staff
   ============================================================ */

async function applyHRAutomation(airlineId) {
  const normalizedAirlineId = Number(airlineId);

  if (!Number.isInteger(normalizedAirlineId) || normalizedAirlineId <= 0) {
    throw new Error("INVALID_AIRLINE_ID");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const settingsResult = await client.query(
      `
      SELECT
        auto_hire,
        auto_salary,
        manual_salary_override
      FROM public.company_settings
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [normalizedAirlineId]
    );

    if (settingsResult.rowCount !== 1) {
      throw new Error("HR_COMPANY_SETTINGS_NOT_FOUND");
    }

    const settings = settingsResult.rows[0];

    const simResult = await client.query(
      `
      SELECT
        EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year,
        EXTRACT(MONTH FROM acs_get_current_sim_time())::int AS sim_month
      `
    );

    const salaryCycle = getHRSalaryCycle(
      Number(simResult.rows[0]?.sim_year),
      Number(simResult.rows[0]?.sim_month)
    );

    const departmentsResult = await client.query(
      `
      SELECT
        dept_id,
        staff,
        required,
        salary,
        salary_percent,
        salary_decade,
        salary_cycle_year,
        salary_cycle_half,
        captain_salary,
        first_officer_salary
      FROM public.hr_departments
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [normalizedAirlineId]
    );

    const autoHireEnabled = settings.auto_hire === true;

    const autoSalaryEnabled =
      settings.auto_salary === true &&
      settings.manual_salary_override !== true;

    for (const department of departmentsResult.rows) {
      const deptId = String(department.dept_id || "");

      if (!HR_DEPARTMENT_IDS.has(deptId)) {
        throw new Error(`UNKNOWN_HR_DEPARTMENT:${deptId}`);
      }

      const currentStaff = Math.max(
        0,
        Math.trunc(Number(department.staff || 0))
      );

      const requiredStaff = Math.max(
        0,
        Math.trunc(Number(department.required || 0))
      );

      const resolvedStaff = autoHireEnabled
        ? Math.max(currentStaff, requiredStaff)
        : currentStaff;

      let resolvedSalary = Number(department.salary || 0);
      let resolvedPercent = Number(department.salary_percent || 100);

      let resolvedCaptainSalary =
        department.captain_salary === null
          ? null
          : Number(department.captain_salary);

      let resolvedFirstOfficerSalary =
        department.first_officer_salary === null
          ? null
          : Number(department.first_officer_salary);

      let resolvedDecade =
        department.salary_decade === null
          ? null
          : Number(department.salary_decade);

      let resolvedCycleYear =
        department.salary_cycle_year === null
          ? null
          : Number(department.salary_cycle_year);

      let resolvedCycleHalf =
        department.salary_cycle_half === null
          ? null
          : Number(department.salary_cycle_half);

      if (
        !Number.isFinite(resolvedPercent) ||
        resolvedPercent <= 0
      ) {
        resolvedPercent = 100;
      }

      const cycleAlreadyApplied =
        resolvedCycleYear === salaryCycle.year &&
        resolvedCycleHalf === salaryCycle.half;

      if (
        autoSalaryEnabled &&
        !cycleAlreadyApplied
      ) {
        const standard = await getHRSalaryStandard(
          client,
          deptId,
          salaryCycle.year,
          salaryCycle.half
        );

        resolvedSalary = applyHRSalaryPercent(
          standard.salary,
          resolvedPercent
        );

        resolvedCaptainSalary = applyHRSalaryPercent(
          standard.captainSalary,
          resolvedPercent
        );

        resolvedFirstOfficerSalary = applyHRSalaryPercent(
          standard.firstOfficerSalary,
          resolvedPercent
        );

        resolvedDecade = salaryCycle.year;
        resolvedCycleYear = salaryCycle.year;
        resolvedCycleHalf = salaryCycle.half;
      }

      if (
        !Number.isFinite(resolvedSalary) ||
        resolvedSalary <= 0
      ) {
        throw new Error(
          `INVALID_STORED_HR_SALARY:${deptId}`
        );
      }

      await client.query(
        `
        UPDATE public.hr_departments
        SET
          staff = $3::INTEGER,

          salary = $4::NUMERIC,

          payroll = ROUND(
            ($3::INTEGER)::NUMERIC *
            $4::NUMERIC
          )::BIGINT,

          salary_percent = $5::NUMERIC,
          salary_decade = $6::INTEGER,

          salary_cycle_year = $7::SMALLINT,
          salary_cycle_half = $8::SMALLINT,

          captain_salary = $9::INTEGER,
          first_officer_salary = $10::INTEGER,

          updated_at = NOW()

        WHERE airline_id = $1
          AND dept_id = $2
        `,
        [
          normalizedAirlineId,
          deptId,
          resolvedStaff,
          resolvedSalary,
          resolvedPercent,
          resolvedDecade,
          resolvedCycleYear,
          resolvedCycleHalf,
          resolvedCaptainSalary,
          resolvedFirstOfficerSalary
        ]
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      sim_year: salaryCycle.year,
      salary_cycle_year: salaryCycle.year,
      salary_cycle_half: salaryCycle.half,
      salary_cycle_key: salaryCycle.key,
      auto_hire: autoHireEnabled,
      auto_salary: autoSalaryEnabled,
      manual_salary_override:
        settings.manual_salary_override === true
    };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;

  } finally {
    client.release();
  }
}

/* ============================================================
   ACS HR MORALE MONTHLY RESOLVER — BACKEND AUTHORITY
   ------------------------------------------------------------
   - PostgreSQL authority
   - Runs once per sim month per department
   - Penalizes understaffing and salary below the current standard
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

  const salaryCycle = getHRSalaryCycle(simYear, simMonth);

  const departmentsResult = await pool.query(
    `
    SELECT
     department.dept_id,
     department.dept_name,
     department.staff,
     department.required,
     department.morale,
     department.salary,
     department.morale_last_sim_year,
     department.morale_last_sim_month,
      CASE
        WHEN department.dept_id LIKE 'pilots\_%' ESCAPE '\'
          THEN standard.standard_two_crew_cost
        ELSE standard.monthly_salary
      END AS standard_salary
    FROM public.hr_departments department
    JOIN public.hr_salary_standards standard
      ON standard.dept_id = department.dept_id
     AND standard.cycle_year = $2
     AND standard.cycle_half = $3
    WHERE department.airline_id = $1
    FOR UPDATE
    `,
    [airlineId, salaryCycle.year, salaryCycle.half]
  );

  const updates = [];

  for (const dep of departmentsResult.rows) {

    const staff = Number(dep.staff || 0);
    const required = Number(dep.required || 0);
    const morale = Number(dep.morale || 100);
    const salary = Number(dep.salary || 0);
    const standardSalary = Number(dep.standard_salary || 0);

    if (
      Number(dep.morale_last_sim_year) === simYear &&
      Number(dep.morale_last_sim_month) === simMonth
    ) {
      continue;
    }

    const deficit = Math.max(0, required - staff);

    let staffingDelta = 0;
    let salaryDelta = 0;

    if (required > 0 && deficit > 0) {
      const ratio = deficit / required;

      if (ratio >= 1) staffingDelta = -8;
      else if (ratio >= 0.76) staffingDelta = -6;
      else if (ratio >= 0.51) staffingDelta = -4;
      else if (ratio >= 0.26) staffingDelta = -2;
      else staffingDelta = -1;
    }

    const salaryShortfall = Math.max(0, standardSalary - salary);
    const salaryShortfallRatio = standardSalary > 0
      ? salaryShortfall / standardSalary
      : 0;

    if (salaryShortfallRatio > 0) {
      if (salaryShortfallRatio >= 0.5) salaryDelta = -5;
      else if (salaryShortfallRatio >= 0.3) salaryDelta = -4;
      else if (salaryShortfallRatio >= 0.15) salaryDelta = -3;
      else if (salaryShortfallRatio >= 0.05) salaryDelta = -2;
      else salaryDelta = -1;
    }

    let moraleDelta = Math.max(-10, staffingDelta + salaryDelta);

    if (deficit === 0 && salaryShortfall === 0 && morale < 100) {
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
      salary,
      standard_salary: standardSalary,
      salary_shortfall: salaryShortfall,
      staffing_morale_delta: staffingDelta,
      salary_morale_delta: salaryDelta,
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

const HR_OPERATIONAL_DEPARTMENT_IDS = new Set([
  "pilots_small",
  "pilots_medium",
  "pilots_large",
  "pilots_vlarge",
  "cabin",
  "flightops",
  "maintenance",
  "ground"
]);

const HR_MORALE_OPERATIONAL_LEVELS = {
  INFO: {
    delayRiskPct: 0,
    cancelRiskPct: 0,
    paxLossMinPct: 1,
    paxLossMaxPct: 1,
    routeImagePenalty: 0
  },

  WARNING: {
    delayRiskPct: 10,
    cancelRiskPct: 0,
    paxLossMinPct: 2,
    paxLossMaxPct: 5,
    routeImagePenalty: -1
  },

  CRITICAL: {
    delayRiskPct: 50,
    cancelRiskPct: 0,
    paxLossMinPct: 8,
    paxLossMaxPct: 15,
    routeImagePenalty: -3
  },

  SEVERE: {
    delayRiskPct: 60,
    cancelRiskPct: 15,
    paxLossMinPct: 20,
    paxLossMaxPct: 35,
    routeImagePenalty: -5
  }
};

function ACS_HR_getMoraleOperationalLevel(value) {
  const morale = Math.max(
    40,
    Math.min(100, Number(value || 100))
  );

  if (morale <= 55) return "SEVERE";
  if (morale <= 70) return "CRITICAL";
  if (morale <= 80) return "WARNING";

  return "INFO";
}

function ACS_HR_classifyDepartmentRisk(dept) {
  const deptId = String(dept.dept_id || "");

  const rule = HR_OPERATIONAL_RULES[deptId] || {
    area: "general",
    critical: false,
    hardBlock: false,
    weight: 5
  };

  const staff = Math.max(
    0,
    Number(dept.staff || 0)
  );

  const required = Math.max(
    0,
    Number(dept.required || 0)
  );

  const deficit = Math.max(
    0,
    required - staff
  );

  const morale = Math.max(
    40,
    Math.min(100, Number(dept.morale || 100))
  );

  const salary = Math.max(
    0,
    Number(dept.salary || 0)
  );

  const standardSalary = Math.max(
    0,
    Number(dept.standard_salary || 0)
  );

  const salaryShortfall = Math.max(
    0,
    standardSalary - salary
  );

  const salaryShortfallPct =
    standardSalary > 0
      ? Math.round(
          (salaryShortfall / standardSalary) * 10000
        ) / 100
      : 0;

  const moraleLevel =
    ACS_HR_getMoraleOperationalLevel(morale);

  const moraleRule =
    HR_MORALE_OPERATIONAL_LEVELS[moraleLevel];

  const affectsFlights =
    HR_OPERATIONAL_DEPARTMENT_IDS.has(deptId);

  if (required <= 0 || deficit <= 0) {
    return {
      dept_id: deptId,
      dept_name: dept.dept_name,
      area: rule.area,

      staff,
      required,
      deficit: 0,
      coveragePct: 100,

      morale,
      moraleLevel,

      salary,
      standardSalary,
      salaryShortfall,
      salaryShortfallPct,
      salaryCurrent: salaryShortfall === 0,

      affectsFlights,

      moraleOperationalRisk: {
        ...moraleRule
      },

      severity: "OK",
      hardBlock: false,
      riskPoints: 0
    };
  }

  const coverage = staff / required;

  const coveragePct = Math.round(
    coverage * 100
  );

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

  const riskPoints = Math.round(
    rule.weight * deficitRatio
  );

  return {
    dept_id: deptId,
    dept_name: dept.dept_name,
    area: rule.area,

    staff,
    required,
    deficit,
    coveragePct,

    morale,
    moraleLevel,

    salary,
    standardSalary,
    salaryShortfall,
    salaryShortfallPct,
    salaryCurrent: salaryShortfall === 0,

    affectsFlights,

    moraleOperationalRisk: {
      ...moraleRule
    },

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

  await applyHRAutomation(airlineId);

  const simResult = await pool.query(
    `
    SELECT
      EXTRACT(
        YEAR FROM acs_get_current_sim_time()
      )::int AS sim_year,

      EXTRACT(
        MONTH FROM acs_get_current_sim_time()
      )::int AS sim_month
    `
  );

  const salaryCycle = getHRSalaryCycle(
    Number(simResult.rows[0]?.sim_year),
    Number(simResult.rows[0]?.sim_month)
  );

  const result = await pool.query(
    `
    SELECT
      department.dept_id,
      department.dept_name,
      department.staff,
      department.required,
      department.morale,
      department.salary,

      CASE
        WHEN LEFT(
          department.dept_id,
          7
        ) = 'pilots_'
          THEN standard.standard_two_crew_cost

        ELSE standard.monthly_salary
      END AS standard_salary

    FROM public.hr_departments department

    JOIN public.hr_salary_standards standard
      ON standard.dept_id =
         department.dept_id

     AND standard.cycle_year = $2
     AND standard.cycle_half = $3

    WHERE department.airline_id = $1

    ORDER BY department.dept_id
    `,
    [
      airlineId,
      salaryCycle.year,
      salaryCycle.half
    ]
  );

  const departments = result.rows.map(
    ACS_HR_classifyDepartmentRisk
  );

  const operationalDepartments =
    departments.filter(
      department =>
        department.affectsFlights === true
    );

  const totalRiskPoints = departments.reduce(
    (sum, department) =>
      sum + Number(department.riskPoints || 0),
    0
  );

  const blockedDepartments =
    departments.filter(
      department =>
        department.severity === "BLOCKED"
    );

  const criticalDepartments =
    departments.filter(
      department =>
        department.severity === "CRITICAL"
    );

  const warningDepartments =
    departments.filter(
      department =>
        department.severity === "WARNING"
    );

  const salaryAffectedDepartments =
    departments.filter(
      department =>
        department.salaryCurrent !== true
    );

  const moraleAffectedDepartments =
    operationalDepartments.filter(
      department =>
        department.moraleLevel !== "INFO"
    );

  const moraleRank = {
    INFO: 0,
    WARNING: 1,
    CRITICAL: 2,
    SEVERE: 3
  };

  const proposedMoraleLevel =
    operationalDepartments.reduce(
      (current, department) =>
        moraleRank[department.moraleLevel] >
        moraleRank[current]
          ? department.moraleLevel
          : current,
      "INFO"
    );

  const proposedMoraleRule =
    HR_MORALE_OPERATIONAL_LEVELS[
      proposedMoraleLevel
    ];

  const dispatchBlocked =
    blockedDepartments.length > 0;

  let operationalStatus = "OK";

  if (dispatchBlocked) {
    operationalStatus = "BLOCKED";

  } else if (criticalDepartments.length > 0) {
    operationalStatus = "CRITICAL";

  } else if (warningDepartments.length > 0) {
    operationalStatus = "WARNING";
  }

  const delayRiskPct = Math.min(
    95,
    Math.max(0, totalRiskPoints)
  );

  const cancelRiskPct = dispatchBlocked
    ? Math.min(
        85,
        Math.max(
          35,
          Math.round(totalRiskPoints * 0.75)
        )
      )
    : Math.min(
        70,
        Math.max(
          0,
          Math.round(totalRiskPoints * 0.45)
        )
      );

  return {
    ok: true,

    airline_id: Number(airlineId),

    salary_cycle_year:
      salaryCycle.year,

    salary_cycle_half:
      salaryCycle.half,

    salary_cycle_key:
      salaryCycle.key,

    operationalStatus,
    dispatchBlocked,
    delayRiskPct,
    cancelRiskPct,

    proposedMoraleLevel,

    proposedMoraleOperationalRisk: {
      ...proposedMoraleRule
    },

    salaryAffectedDepartments,
    moraleAffectedDepartments,

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

const HR_LEVEL_RANK = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
  SEVERE: 3
};

const HR_DELAY_MINUTES_BY_LEVEL = {
  INFO: [0, 0],
  WARNING: [15, 45],
  CRITICAL: [45, 120],
  SEVERE: [90, 240]
};

function ACS_HR_deterministicInteger(
  key,
  minimum,
  maximum
) {
  const text = String(key || "ACS_HR");

  let hash = 2166136261;

  for (
    let index = 0;
    index < text.length;
    index += 1
  ) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const min = Math.ceil(Number(minimum));
  const max = Math.floor(Number(maximum));
  const span = Math.max(1, max - min + 1);

  return min + ((hash >>> 0) % span);
}

function ACS_HR_getRelevantDepartments(
  flight,
  riskByDept
) {
  const seats = Math.max(
    0,
    Number(flight.seats || 0)
  );

  const departmentIds = [
    ACS_HR_getPilotDeptForSeats(seats),
    "flightops",
    "maintenance",
    "ground"
  ];

  if (seats > 9) {
    departmentIds.push("cabin");
  }

  return departmentIds
    .map(
      departmentId =>
        riskByDept.get(departmentId)
    )
    .filter(Boolean);
}

function ACS_HR_resolveOccurrenceDecision(
  flight,
  riskByDept
) {
  const relevantDepartments =
    ACS_HR_getRelevantDepartments(
      flight,
      riskByDept
    );

  const staffProblems =
    relevantDepartments.filter(
      department =>
        Number(department.deficit || 0) > 0
    );

  const salaryProblems =
    relevantDepartments.filter(
      department =>
        Number(
          department.salaryShortfall || 0
        ) > 0
    );

  const hardBlocked =
    staffProblems.some(
      department =>
        department.hardBlock === true
    );

  const moraleLevel =
    relevantDepartments.reduce(
      (current, department) =>
        HR_LEVEL_RANK[
          department.moraleLevel
        ] > HR_LEVEL_RANK[current]
          ? department.moraleLevel
          : current,
      "INFO"
    );

  let effectiveLevel = moraleLevel;

  if (
    staffProblems.some(
      department =>
        department.severity === "CRITICAL"
    )
  ) {
    if (
      HR_LEVEL_RANK[effectiveLevel] <
      HR_LEVEL_RANK.CRITICAL
    ) {
      effectiveLevel = "CRITICAL";
    }

  } else if (staffProblems.length > 0) {
    if (
      HR_LEVEL_RANK[effectiveLevel] <
      HR_LEVEL_RANK.WARNING
    ) {
      effectiveLevel = "WARNING";
    }
  }

  if (hardBlocked) {
    effectiveLevel = "SEVERE";
  }

  const levelRule =
    HR_MORALE_OPERATIONAL_LEVELS[
      effectiveLevel
    ];

  const decisionKey =
    `HR_OCCURRENCE:${flight.id}`;

  const cancelRoll =
    ACS_HR_deterministicInteger(
      `${decisionKey}:CANCEL`,
      1,
      100
    );

  const delayRoll =
    ACS_HR_deterministicInteger(
      `${decisionKey}:DELAY`,
      1,
      100
    );

  const cancelRiskPct = hardBlocked
    ? 100
    : Number(levelRule.cancelRiskPct || 0);

  /*
   * Cualquier déficit de personal operacional
   * obliga a generar retraso si el vuelo no fue
   * cancelado primero.
   */
  const delayRiskPct =
    staffProblems.length > 0
      ? 100
      : Number(levelRule.delayRiskPct || 0);

  let outcome = "ON_TIME";

  /*
   * La cancelación siempre se decide primero.
   */
  if (cancelRoll <= cancelRiskPct) {
    outcome = "CANCELLED";

  } else if (delayRoll <= delayRiskPct) {
    outcome = "DELAYED";
  }

  const delayRange =
    HR_DELAY_MINUTES_BY_LEVEL[
      effectiveLevel
    ];

  const delayMinutes =
    outcome === "DELAYED"
      ? ACS_HR_deterministicInteger(
          `${decisionKey}:MINUTES`,
          delayRange[0],
          delayRange[1]
        )
      : 0;

  /*
   * Un vuelo cancelado pierde el 100% de PAX.
   * Los demás usan el rango correspondiente.
   */
  const paxReductionPct =
    outcome === "CANCELLED"
      ? 1
      : ACS_HR_deterministicInteger(
          `${decisionKey}:PAX`,
          levelRule.paxLossMinPct,
          levelRule.paxLossMaxPct
        ) / 100;

  const routeImagePenalty =
    outcome === "CANCELLED"
      ? -5
      : outcome === "DELAYED"
        ? Number(
            levelRule.routeImagePenalty || 0
          )
        : 0;

  let cause = "NONE";

  if (
    staffProblems.length > 0 &&
    salaryProblems.length > 0
  ) {
    cause = "STAFF_AND_SALARY";

  } else if (staffProblems.length > 0) {
    cause = "STAFF_SHORTAGE";

  } else if (salaryProblems.length > 0) {
    cause = "SALARY_SHORTFALL";

  } else if (moraleLevel !== "INFO") {
    cause = "LOW_MORALE";
  }

  const cancelReason =
    outcome === "CANCELLED"
      ? hardBlocked
        ? "HR_CRITICAL_STAFF_SHORTAGE"
        : "HR_LOW_MORALE"
      : null;

  return {
    decisionKey,
    outcome,
    effectiveLevel,
    cause,

    delayMinutes,
    paxReductionPct,
    routeImagePenalty,
    cancelReason,

    cancelRoll,
    cancelRiskPct,
    delayRoll,
    delayRiskPct,

    relevantDepartments,
    staffProblems,
    salaryProblems
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
   GET HR DEPARTMENTS — BACKEND AUTHORITY
   ------------------------------------------------------------
   • Uses authenticated airline
   • Ensures the complete 18-department structure
   • Recalculates operational demand
   • Applies Auto Hire and Auto Salary when enabled
   • Returns PostgreSQL values without frontend fallbacks
   ============================================================ */

router.get(
  "/hr/departments/:airlineId",
  requireAuth,
  async (req, res) => {
    const sessionAirlineId = Number(req.airline_id);
    const requestedAirlineId = Number(req.params.airlineId);

    if (
      !Number.isInteger(sessionAirlineId) ||
      sessionAirlineId <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "NO_AIRLINE_ID"
      });
    }

    if (
      !Number.isInteger(requestedAirlineId) ||
      requestedAirlineId !== sessionAirlineId
    ) {
      return res.status(403).json({
        ok: false,
        error: "AIRLINE_ACCESS_DENIED"
      });
    }

    try {
      await ensureHRInitialized(sessionAirlineId);
      await recalculateHRRequired(sessionAirlineId);

      const automation = await applyHRAutomation(
        sessionAirlineId
      );

      await applyHRMoraleMonthlyResolver(
        sessionAirlineId
      );

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
          ROUND(
            COALESCE(staff, 0)::NUMERIC *
            COALESCE(salary, 0)::NUMERIC
          )::BIGINT AS payroll,
          bonus,
          years,
          salary_percent,
          salary_decade,
          salary_cycle_year,
          salary_cycle_half,
          captain_salary,
          first_officer_salary
        FROM public.hr_departments
        WHERE airline_id = $1
        ORDER BY dept_id
        `,
        [sessionAirlineId]
      );

      return res.json({
        ok: true,
        automation,
        departments: result.rows
      });

    } catch (err) {
      console.error("HR FETCH ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* ============================================================
   PATCH HR STAFF — MANUAL STAFF OPERATION
   ------------------------------------------------------------
   • Uses authenticated airline
   • Receives a staff delta, never a browser-calculated total
   • Never accepts or changes salary
   • Disables Auto Hire after a manual staff decision
   • Does not change Auto Salary or manual salary protection
   ============================================================ */

router.patch(
  "/hr/staff",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);
    const deptId = String(req.body?.dept_id || "").trim();
    const delta = Number(req.body?.delta);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "NO_AIRLINE_ID"
      });
    }

    if (!HR_DEPARTMENT_IDS.has(deptId)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_HR_DEPARTMENT"
      });
    }

    if (
      !Number.isInteger(delta) ||
      delta === 0 ||
      Math.abs(delta) > 10000
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_STAFF_DELTA"
      });
    }

    if (deptId === "ceo") {
      return res.status(409).json({
        ok: false,
        error: "CEO_STAFF_IS_FIXED"
      });
    }

    try {
      await ensureHRInitialized(airlineId);

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const departmentResult = await client.query(
          `
          SELECT
            dept_id,
            staff,
            required,
            morale,
            salary
          FROM public.hr_departments
          WHERE airline_id = $1
            AND dept_id = $2
          FOR UPDATE
          `,
          [airlineId, deptId]
        );

        if (departmentResult.rowCount !== 1) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            ok: false,
            error: "HR_DEPARTMENT_NOT_FOUND"
          });
        }

        const department = departmentResult.rows[0];

        const currentStaff = Math.max(
          0,
          Math.trunc(Number(department.staff || 0))
        );

        const nextStaff = Math.max(
          0,
          currentStaff + delta
        );

        const removedStaff = Math.max(
          0,
          currentStaff - nextStaff
        );

        let nextMorale = Number(department.morale || 100);

        if (removedStaff > 0) {
          let moraleDrop = 5;

          if (removedStaff >= 3) moraleDrop = 10;
          if (removedStaff >= 6) moraleDrop = 20;

          nextMorale = Math.max(
            40,
            nextMorale - moraleDrop
          );
        }

        const updateResult = await client.query(
          `
         UPDATE public.hr_departments
          SET
            staff = $3::INTEGER,
            morale = $4::NUMERIC,
            payroll = ROUND(
              ($3::INTEGER)::NUMERIC *
              salary::NUMERIC
            )::BIGINT,
            updated_at = NOW()
          WHERE airline_id = $1
            AND dept_id = $2
          RETURNING
            dept_id,
            dept_name,
            base_role,
            staff,
            required,
            morale,
            salary,
            payroll,
            bonus,
            years,
            salary_percent,
            salary_decade,
            salary_cycle_year,
            salary_cycle_half,
            captain_salary,
            first_officer_salary
          `,
          [
            airlineId,
            deptId,
            nextStaff,
            nextMorale
          ]
        );

        await client.query(
          `
          UPDATE public.company_settings
          SET
            auto_hire = false,
            updated_at = NOW()
          WHERE airline_id = $1
          `,
          [airlineId]
        );

        await client.query("COMMIT");

        return res.json({
          ok: true,
          auto_hire: false,
          department: updateResult.rows[0]
        });

      } catch (err) {
        await client.query("ROLLBACK");
        throw err;

      } finally {
        client.release();
      }

    } catch (err) {
      console.error("HR STAFF UPDATE ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* ============================================================
   PATCH HR SALARY — MANUAL SALARY OPERATION
   ------------------------------------------------------------
   • Uses authenticated airline
   • Persists salary and company mode atomically
   • Disables Auto Salary
   • Enables manual salary protection
   • Calculates salary_percent against the current semester standard
   • Never changes staff
   ============================================================ */

router.patch(
  "/hr/salary",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);
    const deptId = String(req.body?.dept_id || "").trim();
    const requestedSalary = Number(req.body?.salary);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "NO_AIRLINE_ID"
      });
    }

    if (!HR_DEPARTMENT_IDS.has(deptId)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_HR_DEPARTMENT"
      });
    }

    if (
      !Number.isFinite(requestedSalary) ||
      requestedSalary <= 0 ||
      requestedSalary > 10000000
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_HR_SALARY"
      });
    }

    const newSalary = Math.round(requestedSalary);

    try {
      await ensureHRInitialized(airlineId);

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const simResult = await client.query(
          `
          SELECT
            EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year,
            EXTRACT(MONTH FROM acs_get_current_sim_time())::int AS sim_month
          `
        );

        const salaryCycle = getHRSalaryCycle(
          Number(simResult.rows[0]?.sim_year),
          Number(simResult.rows[0]?.sim_month)
        );

        const standard = await getHRSalaryStandard(
          client,
          deptId,
          salaryCycle.year,
          salaryCycle.half
        );

        const salaryPercent = Number(
          (
            (newSalary / standard.salary) *
            100
          ).toFixed(2)
        );

        const departmentResult = await client.query(
          `
          SELECT
            staff,
            morale,
            salary
          FROM public.hr_departments
          WHERE airline_id = $1
            AND dept_id = $2
          FOR UPDATE
          `,
          [airlineId, deptId]
        );

        if (departmentResult.rowCount !== 1) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            ok: false,
            error: "HR_DEPARTMENT_NOT_FOUND"
          });
        }

        const department = departmentResult.rows[0];

        const staff = Math.max(
          0,
          Math.trunc(Number(department.staff || 0))
        );

         const nextMorale = Math.max(
          40,
          Math.min(
            100,
            Number(department.morale || 100)
          )
        );
         
        await client.query(
          `
          UPDATE public.company_settings
          SET
            auto_salary = false,
            manual_salary_override = true,
            updated_at = NOW()
          WHERE airline_id = $1
          `,
          [airlineId]
        );

        const updateResult = await client.query(
          `
         UPDATE public.hr_departments
          SET
            salary = $3::NUMERIC,
            payroll = ROUND(
              staff::NUMERIC *
              $3::NUMERIC
            )::BIGINT,
            morale = $4::NUMERIC,
            salary_percent = $5::NUMERIC,
            captain_salary = $6::INTEGER,
            first_officer_salary = $7::INTEGER,
            salary_cycle_year = NULL,
            salary_cycle_half = NULL,
            updated_at = NOW()
          WHERE airline_id = $1
            AND dept_id = $2
          RETURNING
            dept_id,
            dept_name,
            base_role,
            staff,
            required,
            morale,
            salary,
            payroll,
            bonus,
            years,
            salary_percent,
            salary_decade,
            salary_cycle_year,
            salary_cycle_half,
            captain_salary,
            first_officer_salary
          `,
          [
            airlineId,
            deptId,
            newSalary,
            nextMorale,
            salaryPercent,
            applyHRSalaryPercent(standard.captainSalary, salaryPercent),
            applyHRSalaryPercent(standard.firstOfficerSalary, salaryPercent)
          ]
        );

        await client.query("COMMIT");

        return res.json({
          ok: true,
          settings: {
            auto_salary: false,
            manual_salary_override: true
          },
          department: updateResult.rows[0]
        });

      } catch (err) {
        await client.query("ROLLBACK");
        throw err;

      } finally {
        client.release();
      }

    } catch (err) {
      console.error("HR SALARY UPDATE ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* ============================================================
   GET HR PAYROLL TOTAL — BACKEND AUTHORITY
   ============================================================ */

router.get(
  "/hr/payroll/:airlineId",
  requireAuth,
  async (req, res) => {
    const sessionAirlineId = Number(req.airline_id);
    const requestedAirlineId = Number(req.params.airlineId);

    if (
      !Number.isInteger(sessionAirlineId) ||
      sessionAirlineId <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "NO_AIRLINE_ID"
      });
    }

    if (
      !Number.isInteger(requestedAirlineId) ||
      requestedAirlineId !== sessionAirlineId
    ) {
      return res.status(403).json({
        ok: false,
        error: "AIRLINE_ACCESS_DENIED"
      });
    }

    try {
      await ensureHRInitialized(sessionAirlineId);

      const result = await pool.query(
        `
        SELECT
          COALESCE(
            SUM(
              ROUND(
                COALESCE(staff, 0)::NUMERIC *
                COALESCE(salary, 0)::NUMERIC
              )
            ),
            0
          )::BIGINT AS total
        FROM public.hr_departments
        WHERE airline_id = $1
        `,
        [sessionAirlineId]
      );

      return res.json({
        ok: true,
        payroll: Number(result.rows[0].total)
      });

    } catch (err) {
      console.error("HR PAYROLL ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* ============================================================
   POST HR AUTOMATION APPLY
   ------------------------------------------------------------
   • Used after saving Auto Hire or Auto Salary in Settings
   • Applies current backend settings immediately
   • Uses authenticated airline only
   ============================================================ */

router.post(
  "/hr/automation/apply",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "NO_AIRLINE_ID"
      });
    }

    try {
      await ensureHRInitialized(airlineId);
      await recalculateHRRequired(airlineId);

      const automation = await applyHRAutomation(
        airlineId
      );

      await applyHRMoraleMonthlyResolver(
        airlineId
      );

      return res.json({
        ok: true,
        automation
      });

    } catch (err) {
      console.error("HR AUTOMATION APPLY ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

let HR_MORALE_SCHEDULER = null;
let HR_MORALE_RUNNING = false;

async function runHRMoraleSchedulerTick() {
  if (HR_MORALE_RUNNING) return;

  HR_MORALE_RUNNING = true;

  let client = null;

  try {
    client = await pool.connect();

    const lock = await client.query(
      "SELECT pg_try_advisory_lock(35702026) AS locked"
    );

    if (lock.rows[0]?.locked !== true) {
      return;
    }

    const airlinesResult = await client.query(`
      SELECT DISTINCT airline_id
      FROM public.hr_departments
      ORDER BY airline_id
    `);

    for (const row of airlinesResult.rows) {
      const airlineId = Number(row.airline_id);

      if (!Number.isInteger(airlineId)) {
        continue;
      }

      await ensureHRInitialized(airlineId);
      await recalculateHRRequired(airlineId);
      await applyHRAutomation(airlineId);
      await applyHRMoraleMonthlyResolver(airlineId);
    }

  } catch (error) {
    console.error(
      "HR MORALE SCHEDULER ERROR:",
      error
    );

  } finally {
    if (client) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(35702026)"
        );
      } catch (_) {}

      client.release();
    }

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

router.get(
  "/hr/ops-risk/:airlineId",
  requireAuth,
  async (req, res) => {
    const sessionAirlineId = Number(req.airline_id);
    const requestedAirlineId = Number(req.params.airlineId);

    if (
      !Number.isInteger(sessionAirlineId) ||
      requestedAirlineId !== sessionAirlineId
    ) {
      return res.status(403).json({
        ok: false,
        error: "AIRLINE_ACCESS_DENIED"
      });
    }

    try {
      const risk = await resolveHROperationalRisk(
        sessionAirlineId
      );

      return res.json(risk);

    } catch (err) {
      console.error("HR OPS RISK ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* ============================================================
   GET HR → SKYTRACK PERSONNEL RISK FEED
   ============================================================ */

router.get(
  "/hr/skytrack-risk/:airlineId",
  requireAuth,
  async (req, res) => {
    const sessionAirlineId = Number(req.airline_id);
    const requestedAirlineId = Number(req.params.airlineId);

    if (
      !Number.isInteger(sessionAirlineId) ||
      requestedAirlineId !== sessionAirlineId
    ) {
      return res.status(403).json({
        ok: false,
        error: "AIRLINE_ACCESS_DENIED"
      });
    }

    try {
      const feed = await resolveHRSkyTrackRiskFeed(
        sessionAirlineId
      );

      return res.json(feed);

    } catch (err) {
      console.error("HR SKYTRACK RISK FEED ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

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
  const startedAt = Date.now();

  try {
    const simResult = await pool.query(`
      SELECT
        EXTRACT(YEAR FROM acs_get_current_sim_time())::int AS sim_year,
        EXTRACT(MONTH FROM acs_get_current_sim_time())::int AS sim_month,
        EXTRACT(DAY FROM acs_get_current_sim_time())::int AS sim_day
    `);

    const sim = simResult.rows[0];
    const simKey = `${sim.sim_year}-${sim.sim_month}-${sim.sim_day}`;

    const countResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM public.skytrack_ops_impacts
      WHERE airline_id = $1
        AND sim_year = $2
        AND sim_month = $3
        AND sim_day = $4
      `,
      [airlineId, sim.sim_year, sim.sim_month, sim.sim_day]
    );

    const existingBefore = Number(countResult.rows[0]?.count || 0);

    let autoApply = null;
    let occReason = "EXISTING_IMPACTS";
    let lockUsed = false;

    if (existingBefore === 0) {
      lockUsed = true;

      const lockName = `hr_ops_impact:${airlineId}:${simKey}`;
      const lockClient = await pool.connect();

      try {
        await lockClient.query(
          `SELECT pg_advisory_lock(hashtext($1)::bigint)`,
          [lockName]
        );

        const recheckResult = await pool.query(
          `
          SELECT COUNT(*)::int AS count
          FROM public.skytrack_ops_impacts
          WHERE airline_id = $1
            AND sim_year = $2
            AND sim_month = $3
            AND sim_day = $4
          `,
          [airlineId, sim.sim_year, sim.sim_month, sim.sim_day]
        );

        const existingAfterLock = Number(recheckResult.rows[0]?.count || 0);

        if (existingAfterLock === 0) {
          autoApply = await applyHROpsImpactForAirline(airlineId);
          occReason = "CREATED_BY_OCC_AUTO_ENSURE";
        } else {
          occReason = "ALREADY_CREATED_BY_ANOTHER_OCC_REQUEST";
        }
      } finally {
        await lockClient.query(
          `SELECT pg_advisory_unlock(hashtext($1)::bigint)`,
          [lockName]
        );

        lockClient.release();
      }
    }

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

    const createdNow =
      occReason === "CREATED_BY_OCC_AUTO_ENSURE" &&
      Number(autoApply?.applied_count || 0) > 0;

    res.json({
      ok: true,
      airline_id: airlineId,
      sim,
      occ_auto_ensure: {
        checked: true,
        sim_key: simKey,
        reason: occReason,
        lock_used: lockUsed,
        existing_before: existingBefore,
        existing_after: result.rows.length,
        created_now: createdNow,
        applied_count: Number(autoApply?.applied_count || 0),
        globalRisk: autoApply?.globalRisk || null,
        elapsed_ms: Date.now() - startedAt
      },
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
