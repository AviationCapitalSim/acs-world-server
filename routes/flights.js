import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

// =============================================
// TEMP RESET GLOBAL FLIGHTS (REMOVE AFTER USE)
// =============================================

(async () => {
  try {
    await pool.query("TRUNCATE TABLE global_flights");
    console.log("✈️ GLOBAL_FLIGHTS TABLE RESET");
  } catch (err) {
    console.error("RESET ERROR:", err);
  }
})();

// =============================================
// TEMP RESET GLOBAL FLIGHTS (REMOVE AFTER USE)
// =============================================

(async () => {
  try {
    await pool.query("TRUNCATE TABLE global_flights");
    console.log("✈️ GLOBAL_FLIGHTS TABLE RESET");
  } catch (err) {
    console.error("RESET ERROR:", err);
  }
})();

// =============================================
// GET FLIGHTS
// =============================================
router.get("/flights", async (req, res) => {

  try {

    const minLat = Number(req.query.minLat);
    const maxLat = Number(req.query.maxLat);
    const minLng = Number(req.query.minLng);
    const maxLng = Number(req.query.maxLng);

    if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) {
      return res.status(400).json({ status: "error", msg: "bbox required" });
    }

    const airlinesParam = (req.query.airlines || "").trim();
    const all = String(req.query.all || "") === "1";

let sql = `
SELECT
  flight_id,
  airline_id,
  flight_number,
  aircraft_type,
  origin,
  destination,
  latitude,
  longitude,
  speed,
  dep_time,
  arr_time,
  status,
  updated_at
FROM global_flights
WHERE
  latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND latitude BETWEEN $1 AND $2
  AND longitude BETWEEN $3 AND $4
ORDER BY updated_at DESC
LIMIT 5000
`;
        
    const params = [minLat, maxLat, minLng, maxLng];

    const { rows } = await pool.query(sql, params);

    res.json({
      server_time: Date.now(),
      count: rows.length,
      flights: rows
    });

  } catch (err) {

    console.error("FLIGHTS QUERY ERROR:", err);

    res.status(500).json({
      status: "error",
      msg: "database failure",
      error: err.message
    });

  }

});


// =============================================
// FLIGHT DEPARTURE
// =============================================
router.post("/flight/departure", async (req, res) => {

  try {

    const b = req.body || {};
    const now = Date.now();

    if (!b.flight_id || !b.airline_id || !b.origin || !b.destination) {
      return res.status(400).json({ status: "error", msg: "missing fields" });
    }

    await pool.query(`
      INSERT INTO global_flights (
        flight_id,
        airline_id,
        flight_number,
        aircraft_type,
        origin,
        destination,
        latitude,
        longitude,
        speed,
        dep_time,
        arr_time,
        status,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,
        $7,$8,$9,
        $10,$11,$12,$13
      )
      ON CONFLICT (flight_id) DO UPDATE SET
        airline_id=EXCLUDED.airline_id,
        flight_number=EXCLUDED.flight_number,
        aircraft_type=EXCLUDED.aircraft_type,
        origin=EXCLUDED.origin,
        destination=EXCLUDED.destination,
        latitude=EXCLUDED.latitude,
        longitude=EXCLUDED.longitude,
        speed=EXCLUDED.speed,
        dep_time=EXCLUDED.dep_time,
        arr_time=EXCLUDED.arr_time,
        status=EXCLUDED.status,
        updated_at=EXCLUDED.updated_at
    `,[
      b.flight_id,
      b.airline_id,
      b.flight_number || null,
      b.aircraft_type || null,
      b.origin,
      b.destination,
      Number.isFinite(Number(b.latitude)) && Number(b.latitude) !== 0 ? Number(b.latitude) : null,
      Number.isFinite(Number(b.longitude)) && Number(b.longitude) !== 0 ? Number(b.longitude) : null,
      Number.isFinite(Number(b.speed)) ? Number(b.speed) : null,
      Number(b.dep_time) || null,
      Number(b.arr_time) || null,
      Number(b.status) || 1,
      now
    ]);

    res.json({ status:"ok", server_time:now });

  } catch(err){

    console.error("DEPARTURE ERROR:",err);

    res.status(500).json({
      status:"error",
      msg:"departure failure",
      error:err.message
    });

  }

});


// =============================================
// FLIGHT ARRIVAL
// =============================================
router.post("/flight/arrival", async (req,res)=>{

  try{

    const { flight_id } = req.body || {};

    if(!flight_id){
      return res.status(400).json({ status:"error", msg:"flight_id required" });
    }

    await pool.query(
      `DELETE FROM global_flights WHERE flight_id=$1`,
      [flight_id]
    );

    res.json({ status:"ok", server_time:Date.now() });

  }catch(err){

    console.error("ARRIVAL ERROR:",err);

    res.status(500).json({
      status:"error",
      msg:"arrival failure",
      error:err.message
    });

  }

});


export default router;
