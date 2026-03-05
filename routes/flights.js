import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();

router.get("/flights", async (req, res) => {
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
    WHERE latitude BETWEEN $1 AND $2
      AND longitude BETWEEN $3 AND $4
  `;

  const params = [minLat, maxLat, minLng, maxLng];

  if (!all && airlinesParam) {
    const list = airlinesParam.split(",").map(s => s.trim()).filter(Boolean);
    if (list.length > 0) {
      params.push(list);
      sql += ` AND airline_id = ANY($5)`;
    }
  }

  sql += ` ORDER BY updated_at DESC LIMIT 5000`;

  const { rows } = await pool.query(sql, params);

  res.json({
    server_time: Date.now(),
    count: rows.length,
    flights: rows
  });
});


router.post("/flight/departure", async (req, res) => {

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
    Number(b.latitude) || null,
    Number(b.longitude) || null,
    Number(b.speed) || null,
    Number(b.dep_time) || null,
    Number(b.arr_time) || null,
    Number(b.status) || 1,
    now
  ]);

  res.json({ status:"ok", server_time:now });

});


router.post("/flight/arrival", async (req,res)=>{

  const { flight_id } = req.body || {};

  if(!flight_id){
    return res.status(400).json({ status:"error", msg:"flight_id required" });
  }

  await pool.query(
    `DELETE FROM global_flights WHERE flight_id=$1`,
    [flight_id]
  );

  res.json({ status:"ok", server_time:Date.now() });

});

export default router;
