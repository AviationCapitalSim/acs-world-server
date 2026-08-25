import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js"; // 🔥 NUEVO

const router = express.Router();

/* ============================================================
   ACS AIRLINE DESIGNATOR AUTHORITY
   ------------------------------------------------------------
   - IATA: 2 uppercase alphanumeric characters
   - ICAO: 3 uppercase alphabetic characters
   - Prefers combinations related to airline name
   - PostgreSQL remains final uniqueness authority
   ============================================================ */

const DESIGNATOR_IGNORED_WORDS = new Set([
  "AIR",
  "AIRLINE",
  "AIRLINES",
  "AIRWAY",
  "AIRWAYS",
  "AVIATION",
  "THE"
]);

function normalizeDesignatorName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getDesignatorWords(airlineName) {
  const allWords =
    normalizeDesignatorName(airlineName)
      .split(" ")
      .filter(Boolean);

  const meaningfulWords =
    allWords.filter(
      word =>
        !DESIGNATOR_IGNORED_WORDS.has(word)
    );

  return meaningfulWords.length
    ? meaningfulWords
    : allWords;
}

function buildPreferredIataCodes(airlineName) {
  const words = getDesignatorWords(airlineName);
  const compact = words.join("");
  const candidates = new Set();

  const add = value => {
    const code = String(value || "").toUpperCase();

    if (/^[A-Z0-9]{2}$/.test(code)) {
      candidates.add(code);
    }
  };

  if (words.length >= 2) {
    add(words[0][0] + words[1][0]);
  }

  add(compact.slice(0, 2));
  add(compact[0] + compact.at(-1));

  for (
    let index = 1;
    index < compact.length;
    index += 1
  ) {
    add(compact[0] + compact[index]);
  }

  return [...candidates];
}

function buildPreferredIcaoCodes(airlineName) {
  const words = getDesignatorWords(airlineName);
  const compact = words.join("");
  const candidates = new Set();

  const add = value => {
    const code = String(value || "").toUpperCase();

    if (/^[A-Z]{3}$/.test(code)) {
      candidates.add(code);
    }
  };

  if (words.length >= 3) {
    add(
      words[0][0] +
      words[1][0] +
      words[2][0]
    );
  }

  if (words.length >= 2) {
    add(
      words[0][0] +
      words[1].slice(0, 2)
    );

    add(
      words[0].slice(0, 2) +
      words[1][0]
    );
  }

  add(compact.slice(0, 3));

  for (
    let second = 1;
    second < compact.length;
    second += 1
  ) {
    for (
      let third = second + 1;
      third < compact.length;
      third += 1
    ) {
      add(
        compact[0] +
        compact[second] +
        compact[third]
      );
    }
  }

  return [...candidates];
}

function findAvailableIata(
  preferredCodes,
  occupiedCodes
) {
  for (const code of preferredCodes) {
    if (!occupiedCodes.has(code)) {
      return code;
    }
  }

  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  for (const first of characters) {
    for (const second of characters) {
      const code = first + second;

      if (!occupiedCodes.has(code)) {
        return code;
      }
    }
  }

  return null;
}

function findAvailableIcao(
  preferredCodes,
  occupiedCodes
) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  for (const code of preferredCodes) {
    if (!occupiedCodes.has(code)) {
      return code;
    }
  }

  for (const first of letters) {
    for (const second of letters) {
      for (const third of letters) {
        const code =
          first + second + third;

        if (!occupiedCodes.has(code)) {
          return code;
        }
      }
    }
  }

  return null;
}

async function generateAvailableDesignators(
  client,
  airlineName
) {
  const result = await client.query(
    `
    SELECT
      UPPER(BTRIM(iata)) AS iata,
      UPPER(BTRIM(icao)) AS icao
    FROM public.airlines
    `
  );

  const occupiedIata = new Set(
    result.rows
      .map(row => row.iata)
      .filter(Boolean)
  );

  const occupiedIcao = new Set(
    result.rows
      .map(row => row.icao)
      .filter(Boolean)
  );

  const iata = findAvailableIata(
    buildPreferredIataCodes(airlineName),
    occupiedIata
  );

  const icao = findAvailableIcao(
    buildPreferredIcaoCodes(airlineName),
    occupiedIcao
  );

  if (!iata || !icao) {
    throw new Error(
      "AIRLINE_DESIGNATORS_EXHAUSTED"
    );
  }

  return {
    iata,
    icao
  };
}

/* ============================================================
   ACS CREATE AIRLINE VALIDATION AUTHORITY
   ============================================================ */

const ALLOWED_BUSINESS_MODELS = new Set([
  "Regional",
  "International"
]);

const ALLOWED_OPERATION_MODES = new Set([
  "Passenger"
]);

function normalizeRequiredText(value) {
  if (typeof value !== "string") {
    return null;
  }

  return value
    .replace(/\s+/g, " ")
    .trim();
}

function validateCreateAirlinePayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return {
      ok: false,
      error: "INVALID_REQUEST_BODY"
    };
  }

  const airlineName =
    normalizeRequiredText(
      payload.airline_name
    );

  const country =
    normalizeRequiredText(
      payload.country
    );

  const region =
    normalizeRequiredText(
      payload.region
    );

  const businessModel =
    normalizeRequiredText(
      payload.business_model
    );

  const operationMode =
    normalizeRequiredText(
      payload.operation_mode
    );

  const requiredValues = {
    airline_name: airlineName,
    country,
    region,
    business_model: businessModel,
    operation_mode: operationMode
  };

  for (
    const [field, value]
    of Object.entries(requiredValues)
  ) {
    if (!value) {
      return {
        ok: false,
        error: "MISSING_REQUIRED_FIELD",
        field
      };
    }
  }

  if (
    airlineName.length < 2 ||
    airlineName.length > 80
  ) {
    return {
      ok: false,
      error: "INVALID_AIRLINE_NAME_LENGTH",
      field: "airline_name"
    };
  }

  if (/[\u0000-\u001F\u007F]/.test(airlineName)) {
    return {
      ok: false,
      error: "INVALID_AIRLINE_NAME_CHARACTERS",
      field: "airline_name"
    };
  }

  if (
    country.length > 100 ||
    region.length > 100
  ) {
    return {
      ok: false,
      error: "INVALID_LOCATION_VALUE"
    };
  }

  if (
    !ALLOWED_BUSINESS_MODELS.has(
      businessModel
    )
  ) {
    return {
      ok: false,
      error: "INVALID_BUSINESS_MODEL",
      field: "business_model",
      allowed_values: [
        ...ALLOWED_BUSINESS_MODELS
      ]
    };
  }

  if (
    !ALLOWED_OPERATION_MODES.has(
      operationMode
    )
  ) {
    return {
      ok: false,
      error: "INVALID_OPERATION_MODE",
      field: "operation_mode",
      allowed_values: [
        ...ALLOWED_OPERATION_MODES
      ]
    };
  }

  return {
    ok: true,
    data: {
      airlineName,
      country,
      region,
      businessModel,
      operationMode
    }
  };
}

/* ============================================================
   GET ACTIVE AIRLINES
   ------------------------------------------------------------
   Public player directory for authenticated ACS users.

   An airline is considered active when:
   - The airline exists.
   - It is linked to its user.
   - The user has completed base assignment.

   Exposes only:
   - Airline name.
   - Country.
   - Base ICAO.

   No passenger data.
   No user data.
   No image data.
   ============================================================ */

router.get(
  "/airlines/active",
  requireAuth,
  async (req, res) => {
    try {
   const result = await pool.query(
  `
  SELECT
    a.airline_id,
    a.airline_name,
    a.country,
    a.business_model,

    UPPER(BTRIM(u.base_icao))
      AS base_icao,

    UPPER(BTRIM(airport.country))
      AS country_code,

    (
      SELECT COUNT(*)::INTEGER
      FROM public.aircraft_fleet af
      WHERE af.airline_id = a.airline_id
    ) AS active_aircraft,

    (
      SELECT COUNT(*)::INTEGER
      FROM public.route_plans rp
      WHERE rp.airline_id = a.airline_id
        AND UPPER(
          COALESCE(
            rp.route_state,
            'ACTIVE'
          )
        ) = 'ACTIVE'
    ) AS active_routes,

    NULL::NUMERIC
      AS company_value,

    NULL::INTEGER
      AS global_rank

  FROM public.airlines a

  INNER JOIN public.users u
    ON u.airline_id = a.airline_id

  LEFT JOIN
    public.v_acs_airport_authority_current
      airport
    ON UPPER(airport.icao) =
       UPPER(BTRIM(u.base_icao))

  WHERE u.base_icao IS NOT NULL
    AND BTRIM(u.base_icao) <> ''

  ORDER BY
    LOWER(a.airline_name),
    a.airline_id
  `
);

      return res.json({
        ok: true,
        count: result.rows.length,
        airlines: result.rows
      });
    } catch (err) {
      console.error(
        "GET ACTIVE AIRLINES ERROR:",
        err
      );

      return res.status(500).json({
        ok: false,
        error: "ACTIVE_AIRLINES_FAILED"
      });
    }
  }
);

/* ============================================================
   GET ONBOARDING BASE CONTEXT
   ------------------------------------------------------------
   Railway authority:
   - Reads users.base_icao
   - Derives World Area and Country from PostgreSQL
   - No frontend storage authority
   ============================================================ */

router.get(
  "/users/base-context",
  requireAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          UPPER(BTRIM(u.base_icao))
            AS base_icao,

          CASE
            WHEN UPPER(airport.country) IN (
              'AE',
              'BH',
              'IQ',
              'IR',
              'IL',
              'JO',
              'KW',
              'LB',
              'OM',
              'PS',
              'QA',
              'SA',
              'SY',
              'TR',
              'YE'
            )
            THEN 'Middle East'
            ELSE airport.continent
          END AS region,

          airport.region AS country

        FROM public.users u

        INNER JOIN
          public.v_acs_airport_authority_current
            airport
          ON UPPER(airport.icao) =
             UPPER(BTRIM(u.base_icao))

        WHERE u.user_id = $1
          AND u.base_icao IS NOT NULL
          AND BTRIM(u.base_icao) <> ''

        LIMIT 1
        `,
        [req.user_id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error: "ONBOARDING_BASE_NOT_FOUND"
        });
      }

      return res.json({
        ok: true,
        base: result.rows[0]
      });

    } catch (err) {
      console.error(
        "GET ONBOARDING BASE CONTEXT ERROR:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "ONBOARDING_BASE_CONTEXT_FAILED"
      });
    }
  }
);

/* ============================================================
   PREVIEW AIRLINE DESIGNATORS
   ------------------------------------------------------------
   Preview only. Final assignment occurs transactionally
   during airline creation.
   ============================================================ */

router.get(
  "/airlines/designators/preview",
  requireAuth,
  async (req, res) => {
    const airlineName =
      String(req.query?.name || "").trim();

    if (airlineName.length < 2) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AIRLINE_NAME"
      });
    }

    try {
      const designators =
        await generateAvailableDesignators(
          pool,
          airlineName
        );

      return res.json({
        ok: true,
        airline_iata: designators.iata,
        airline_icao: designators.icao,
        status: "PREVIEW"
      });
    } catch (err) {
      console.error(
        "AIRLINE DESIGNATOR PREVIEW ERROR:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRLINE_DESIGNATOR_PREVIEW_FAILED"
      });
    }
  }
);

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

  const body = req.body || {};
const userUUID = req.user_id;

const client = await pool.connect();

try {

  await client.query("BEGIN");

  /* ============================================================
     1️⃣ Check if user already has an airline
     ------------------------------------------------------------
     Repair links before requiring a new creation payload.
  ============================================================ */

  const existing = await client.query(
    `
    SELECT airline_id
    FROM public.airlines
    WHERE user_id = $1
    LIMIT 1
    `,
    [userUUID]
  );

  if (existing.rows.length > 0) {

    const existingAirlineId =
      existing.rows[0].airline_id;

    await client.query(
      `
      UPDATE public.users
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
      UPDATE public.sessions
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
      status:
        "AIRLINE_ALREADY_EXISTS_LINK_REPAIRED",
      airline_id: existingAirlineId
    });
  }

  /* ============================================================
     2️⃣ Validate and normalize creation payload
  ============================================================ */

  const validation =
    validateCreateAirlinePayload(body);

  if (!validation.ok) {
    await client.query("ROLLBACK");

    return res.status(400).json(
      validation
    );
  }

  const {
    airlineName,
    country,
    region,
    businessModel,
    operationMode
  } = validation.data;

    /* ============================================================
       3️⃣ Check duplicate airline name
    ============================================================ */

    const nameCheck = await client.query(
      `
      SELECT 1
      FROM airlines
      WHERE LOWER(BTRIM(airline_name)) =
      LOWER($1)
      LIMIT 1
      `,
      [airlineName]
    );

    if (nameCheck.rows.length > 0) {

      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "AIRLINE_NAME_ALREADY_EXISTS"
      });

    }

   /* ============================================================
   SERIALIZE DESIGNATOR ASSIGNMENT
   ============================================================ */

await client.query(
  `
  SELECT pg_advisory_xact_lock(
    hashtext($1)
  )
  `,
  ["ACS_AIRLINE_DESIGNATOR_ALLOCATION"]
);

const assignedDesignators =
  await generateAvailableDesignators(
    client,
    airlineName
  );
  
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
  airlineName,
  assignedDesignators.iata,
  assignedDesignators.icao,
  country,
  region,
  businessModel,
  operationMode
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
  airline_id: airlineId,
  airline_iata:
    assignedDesignators.iata,
  airline_icao:
    assignedDesignators.icao
});

  } catch (err) {

  await client.query("ROLLBACK");

  console.error(
    "CREATE AIRLINE ERROR:",
    err
  );

  if (err.code === "23505") {
    const constraint =
      String(err.constraint || "");

    if (
      constraint.includes("iata") ||
      constraint.includes("icao")
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "AIRLINE_DESIGNATOR_CONFLICT"
      });
    }

    return res.status(409).json({
      ok: false,
      error: "AIRLINE_CONFLICT"
    });
  }

  return res.status(500).json({
    ok: false,
    error: "CREATE_AIRLINE_FAILED"
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
