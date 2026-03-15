router.post("/airlines/create", async (req, res) => {

  const body = req.body;
  const userUUID = body.user_id;

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    /* ============================================================
       1️⃣ Check if user already has an airline
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

      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "USER_ALREADY_HAS_AIRLINE"
      });

    }

    /* ============================================================
       2️⃣ Create airline
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
       3️⃣ Link airline to user
    ============================================================ */

    await client.query(
      `
      UPDATE users
      SET airline_id = $1
      WHERE user_id = $2
      `,
      [airlineId, userUUID]
    );

    /* ============================================================
       4️⃣ Initialize HR Departments
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
      linked: true,
      hrInitialized: true
    });

    res.json({
      ok: true,
      airline_id: airlineId
    });

  } catch (err) {

    await client.query("ROLLBACK");

    console.error("CREATE AIRLINE ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });

  } finally {

    client.release();

  }

});
