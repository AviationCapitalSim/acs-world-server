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

export default router;
