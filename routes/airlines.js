import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js"; // 🔥 NUEVO

const router = express.Router();

/* ============================================================
   CREATE AIRLINE
   ------------------------------------------------------------
   Production-grade flow:
   - Session user is authority
   - Prevent duplicate airline per user
   - Repair user/session airline link if airline already exists
   - Create airline transactionally
   - Link users.airline_id
   - Link active sessions.airline_id
   - Initialize HR
============================================================ */

router.post("/airlines/create", requireAuth, async (req, res) => {

  const body = req.body;
  const userUUID = req.user_id;

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    /* ============================================================
       1️⃣ Validate required fields
    ============================================================ */

    const requiredFields = [
      "airline_name",
      "airline_iata",
      "airline_icao",
      "country",
      "region",
      "business_model",
      "operation_mode"
    ];

    for (const field of requiredFields) {
      if (!body[field]) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          ok: false,
          error: "MISSING_REQUIRED_FIELD",
          field
        });
      }
    }

    /* ============================================================
       2️⃣ Check if user already has an airline
       ------------------------------------------------------------
       If airline exists but users/sessions are desynchronized,
       repair links instead of allowing duplicate creation.
    ============================================================ */

    const existing = await client.query(
      `
      SELECT airline_id
      FROM airlines
      WHERE user_id = $1
      LIMIT 1
      `,
      [userUUID]
    );

    if (existing.rows.length > 0) {

      const existingAirlineId = existing.rows[0].airline_id;

      await client.query(
        `
        UPDATE users
        SET airline_id = $1
        WHERE user_id = $2
          AND (
            airline_id IS NULL
            OR airline_id <> $1
          )
        `,
        [existingAirlineId, userUUID]
      );

      await client.query(
        `
        UPDATE sessions
        SET airline_id = $1
        WHERE user_id = $2
          AND active = true
          AND (
            airline_id IS NULL
            OR airline_id <> $1
          )
        `,
        [existingAirlineId, userUUID]
      );

      await client.query("COMMIT");

      return res.status(200).json({
        ok: true,
        status: "AIRLINE_ALREADY_EXISTS_LINK_REPAIRED",
        airline_id: existingAirlineId
      });

    }

    /* ============================================================
       3️⃣ Check duplicate airline name
    ============================================================ */

    const nameCheck = await client.query(
      `
      SELECT 1
      FROM airlines
      WHERE LOWER(airline_name) = LOWER($1)
      LIMIT 1
      `,
      [body.airline_name]
    );

    if (nameCheck.rows.length > 0) {

      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "AIRLINE_NAME_ALREADY_EXISTS"
      });

    }

    /* ============================================================
       4️⃣ Create airline
    ============================================================ */

    const insertAirline = await client.query(
      `
      INSERT INTO airlines
      (
        user_id,
        airline_name,
        iata,
        icao,
        country,
        region,
        business_model,
        operation_mode
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING airline_id
      `,
      [
        userUUID,
        body.airline_name,
        body.airline_iata,
        body.airline_icao,
        body.country,
        body.region,
        body.business_model,
        body.operation_mode
      ]
    );

    const airlineId = insertAirline.rows[0].airline_id;

    /* ============================================================
       5️⃣ Link airline to user
    ============================================================ */

    const userUpdate = await client.query(
      `
      UPDATE users
      SET airline_id = $1
      WHERE user_id = $2
      RETURNING user_id, airline_id
      `,
      [airlineId, userUUID]
    );

    if (!userUpdate.rows.length) {
      throw new Error("USER_LINK_FAILED");
    }

    /* ============================================================
       6️⃣ Link active sessions to airline
    ============================================================ */

    await client.query(
      `
      UPDATE sessions
      SET airline_id = $1
      WHERE user_id = $2
        AND active = true
      `,
      [airlineId, userUUID]
    );

    /* ============================================================
       7️⃣ Initialize HR Departments
    ============================================================ */

    await client.query(
      `
      SELECT init_airline_hr($1)
      `,
      [airlineId]
    );

    console.log("HR INITIALIZED FOR AIRLINE", airlineId);

    /* ============================================================
       COMMIT
    ============================================================ */

    await client.query("COMMIT");

    console.log("DEBUG CREATE AIRLINE", {
      airlineId,
      userUUID,
      linkedUser: true,
      linkedSession: true,
      hrInitialized: true
    });

    return res.json({
      ok: true,
      airline_id: airlineId
    });

  } catch (err) {

    await client.query("ROLLBACK");

    console.error("CREATE AIRLINE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "CREATE_AIRLINE_FAILED",
      message: err.message
    });

  } finally {

    client.release();

  }

});

/* ============================================================
   SET BASE — POSTGRESQL AIRPORT AUTHORITY
   ============================================================ */

router.post("/users/set-base", requireAuth, async (req, res) => {
  const baseIcao = String(
    req.body?.base_icao || ""
  )
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{4}$/.test(baseIcao)) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_BASE_ICAO"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const airportResult = await client.query(
      `
      SELECT
        icao,
        iata,
        city,
        country,
        continent,
        category,
        availability_basis,
        commercial_open_year,
        base_operation_allowed
      FROM public.v_acs_airport_authority_current
      WHERE icao = $1
        AND base_operation_allowed = TRUE
      LIMIT 1
      `,
      [baseIcao]
    );

    if (!airportResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "BASE_AIRPORT_NOT_ALLOWED",
        base_icao: baseIcao
      });
    }

    const userResult = await client.query(
      `
      UPDATE public.users
      SET base_icao = $1
      WHERE user_id = $2
      RETURNING
        user_id,
        base_icao
      `,
      [
        baseIcao,
        req.user_id
      ]
    );

    if (!userResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "USER_NOT_FOUND"
      });
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      authority:
        "POSTGRESQL_ACS_AIRPORT_AUTHORITY",
      user_id:
        userResult.rows[0].user_id,
      base_icao:
        userResult.rows[0].base_icao,
      airport:
        airportResult.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(
      "SET BASE ERROR:",
      err
    );

    return res.status(500).json({
      ok: false,
      error: "SET_BASE_FAILED"
    });
  } finally {
    client.release();
  }
});

export default router;
