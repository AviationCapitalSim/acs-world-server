import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();


// 🔧 ESTE BLOQUE SE REEMPLAZA
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

  } catch (err) {

    console.error("FLIGHTS QUERY ERROR:", err);

    res.status(500).json({
      status: "error",
      msg: "database failure",
      error: err.message
    });

  }
});


// ⬇️ TU router.post("/flight/departure") sigue igual
router.post("/flight/departure", async (req, res) => {
