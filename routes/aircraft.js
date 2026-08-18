/* ============================================================
   🟦 ACS AIRCRAFT BACKEND AUTHORITY —READ API v1.1
   ------------------------------------------------------------
   File: routes/aircraft.js
   Purpose:
   - Backend authority for Aircraft systems
   - Read aircraft fleet, new aircraft orders, factory slots,
     and used aircraft market from PostgreSQL
   - No localStorage authority
   - No Finance frontend mutation
   - No Time Engine interaction
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import {
  ACS_INSURANCE_PLANS,
  ACS_calculateInsurancePremium
} from "./finance_core.js";

import {
  ACS_unassignAircraftForCommercialAction
} from "./schedule.js";

const router = express.Router();

function ACS_maintenanceCheckLabel(checkType) {
  const normalized = String(checkType || "").trim().toUpperCase();

  if (normalized === "D_CHECK") return "D Check";
  if (normalized === "C_CHECK") return "C Check";

  return "Maintenance Check";
}

function ACS_maintenanceCheckCode(checkType) {
  const normalized = String(checkType || "").trim().toUpperCase();

  if (normalized === "D_CHECK") return "D";
  if (normalized === "C_CHECK") return "C";

  return "UNKNOWN";
}

function ACS_isAutomaticMaintenanceEvent(event) {
  try {
    const rawNotes = event?.notes || null;
    const notes =
      typeof rawNotes === "string"
        ? JSON.parse(rawNotes)
        : rawNotes;

    const source = String(notes?.source || "").trim().toUpperCase();
    const startSource = String(notes?.start_source || "").trim().toUpperCase();

    return (
      startSource === "AUTOMATIC" ||
      source.includes("AUTO_CD_MAINTENANCE") ||
      source.includes("AUTOMATIC_CD_MAINTENANCE")
    );
  } catch (_) {
    return false;
  }
}

async function ACS_getAircraftAutomationSettings(db, airlineId) {
  try {
    const result = await db.query(
      `
      SELECT
        COALESCE(auto_c_check, FALSE) AS auto_c_check,
        COALESCE(auto_d_check, FALSE) AS auto_d_check
      FROM public.company_settings
      WHERE airline_id = $1
      LIMIT 1
      `,
      [airlineId]
    );

    if (!result.rows.length) {
      return {
        autoCcheck: false,
        autoDcheck: false
      };
    }

    return {
      autoCcheck: result.rows[0].auto_c_check === true,
      autoDcheck: result.rows[0].auto_d_check === true
    };

  } catch (error) {
    console.error("ACS OCC AUTOMATION SETTINGS ERROR:", error);

      return {
      autoCcheck: false,
      autoDcheck: false
    };
  }
}

async function ACS_getCurrentSimTimeForOcc(db) {
  try {
    const result = await db.query(
      `
      SELECT acs_get_current_sim_time() AS current_sim_time
      `
    );

    return result.rows[0]?.current_sim_time || null;

  } catch (error) {
    console.error("ACS OCC CURRENT SIM TIME ERROR:", error);
    return null;
  }
}

async function ACS_canCreateMaintenanceOccAlert(db, airlineId, alertKey, currentSimTime) {
  try {
    const result = await db.query(
      `
      SELECT
        id,
        deleted_at,
        deleted_sim_time,
        event_sim_time
      FROM public.occ_alerts
      WHERE airline_id = $1
        AND alert_key = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [airlineId, alertKey]
    );

    if (!result.rows.length) {
      return true;
    }

    const last = result.rows[0];

    if (!last.deleted_at) {
      return false;
    }

    if (!last.deleted_sim_time || !currentSimTime) {
      return false;
    }

    const reAlertResult = await db.query(
      `
      SELECT
        CASE
          WHEN $1::TIMESTAMPTZ >= ($2::TIMESTAMPTZ + INTERVAL '7 days')
            THEN TRUE
          ELSE FALSE
        END AS can_realert
      `,
      [
        currentSimTime,
        last.deleted_sim_time
      ]
    );

    return reAlertResult.rows[0]?.can_realert === true;

  } catch (error) {
    console.error("ACS OCC RE-ALERT CHECK ERROR:", error);
    return false;
  }
}

async function ACS_createMaintenanceOccAlert(db, {
  airlineId,
  eventId,
  registration,
  checkType,
  action,
  eventSimTime
}) {
  try {
    const normalizedAction = String(action || "").trim().toUpperCase();

    if (!["STARTED", "COMPLETED"].includes(normalizedAction)) {
      return null;
    }

    const checkLabel = ACS_maintenanceCheckLabel(checkType);
    const checkCode = ACS_maintenanceCheckCode(checkType);

    if (!["C", "D"].includes(checkCode)) {
      return null;
    }

    const cleanRegistration = String(registration || "AIRCRAFT").trim();
    const isStarted = normalizedAction === "STARTED";

    const alertKey = `MAINTENANCE_${checkType}_${normalizedAction}:${eventId}`;
    const title = isStarted
      ? `${checkCode} CHECK STARTED`
      : `${checkCode} CHECK COMPLETED`;

    const message = isStarted
      ? `Aircraft ${cleanRegistration} entered ${checkLabel}.`
      : `Aircraft ${cleanRegistration} completed ${checkLabel}.`;

    const result = await db.query(
      `
      INSERT INTO public.occ_alerts (
        airline_id,
        alert_key,
        category,
        level,
        title,
        message,
        source,
        source_ref,
        event_sim_time,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'maintenance',
        $3,
        $4,
        $5,
        'aircraft_maintenance_events',
        $6,
        $7,
        NOW(),
        NOW()
      )
      ON CONFLICT (airline_id, alert_key) WHERE deleted_at IS NULL
      DO NOTHING
      RETURNING *
      `,
      [
        airlineId,
        alertKey,
        isStarted ? "warning" : "info",
        title,
        message,
        String(eventId),
        eventSimTime || null
      ]
    );

    return result.rows[0] || null;

  } catch (error) {
    console.error("ACS MAINTENANCE OCC ALERT ERROR:", error);
    return null;
  }
}

async function ACS_createMaintenanceOverdueOccAlert(db, {
  airlineId,
  aircraftId,
  registration,
  checkType,
  dueSimTime,
  currentSimTime
}) {
  try {
    const checkLabel = ACS_maintenanceCheckLabel(checkType);
    const checkCode = ACS_maintenanceCheckCode(checkType);

    if (!["C", "D"].includes(checkCode)) {
      return null;
    }

    const cleanRegistration = String(registration || "AIRCRAFT").trim();
    const alertKey = `MAINTENANCE_${checkType}_OVERDUE:${aircraftId}`;

    const canCreate = await ACS_canCreateMaintenanceOccAlert(
      db,
      airlineId,
      alertKey,
      currentSimTime
    );

    if (!canCreate) {
      return null;
    }

    const result = await db.query(
      `
      INSERT INTO public.occ_alerts (
        airline_id,
        alert_key,
        category,
        level,
        title,
        message,
        source,
        source_ref,
        event_sim_time,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'maintenance',
        $3,
        $4,
        $5,
        'aircraft_maintenance_status',
        $6,
        $7,
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        airlineId,
        alertKey,
        checkType === "D_CHECK" ? "critical" : "warning",
        `${checkCode} CHECK OVERDUE`,
        `Aircraft ${cleanRegistration} ${checkLabel} overdue.`,
        String(aircraftId),
        dueSimTime || currentSimTime || null
      ]
    );

    return result.rows[0] || null;

  } catch (error) {
    console.error("ACS MAINTENANCE OVERDUE OCC ALERT ERROR:", error);
    return null;
  }
}

/* ============================================================
   🟦 ACS-RA-BE1 — REGISTRATION AUTHORITY HELPERS
   ------------------------------------------------------------
   Purpose:
   - Resolve aircraft registration prefix from base ICAO
   - Generate unique aircraft registrations from PostgreSQL
   - Backend authority only
   - No localStorage
   - Safe for 700+ players
   ============================================================ */

function ACS_RA_normalizeIcao(value) {
  return String(value || "").trim().toUpperCase();
}

function ACS_RA_numberToLetters(num, length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let n = Math.max(0, Number(num || 0));
  let result = "";

  for (let i = 0; i < Number(length || 3); i++) {
    result = alphabet[n % 26] + result;
    n = Math.floor(n / 26);
  }

  return result;
}

function ACS_RA_getNumericStart(registrationLength) {
  const length = Number(registrationLength || 4);

  if (length <= 1) return 1;

  return Math.pow(10, length - 1) + 1;
}

async function ACS_RA_resolveRegistrationRule(client, baseIcao) {
  const normalizedBase = ACS_RA_normalizeIcao(baseIcao);

  if (!normalizedBase) {
    throw new Error("REGISTRATION_BASE_ICAO_REQUIRED");
  }

  /*
    Longest-prefix match:
    - LYPG resolves before LY
    - VHHH resolves before VH
    - SVMI resolves to SV
    - KJFK resolves to K
  */

  const result = await client.query(
    `
    SELECT
      id,
      country_name,
      country_iso2,
      icao_prefix,
      registration_prefix,
      registration_format,
      registration_length,
      separator,
      sample_registration
    FROM public.aircraft_registration_prefixes
    WHERE is_active = TRUE
      AND $1 LIKE (icao_prefix || '%')
    ORDER BY LENGTH(icao_prefix) DESC
    LIMIT 1
    `,
    [normalizedBase]
  );

  if (!result.rows.length) {
    throw new Error(`REGISTRATION_RULE_NOT_FOUND_FOR_BASE_${normalizedBase}`);
  }

  return result.rows[0];
}

async function ACS_RA_generateCandidateFromRule(client, rule) {
   
  const prefix = String(rule.registration_prefix || "").trim().toUpperCase();
  const format = String(rule.registration_format || "NUMERIC").trim().toUpperCase();
  const length = Number(rule.registration_length || 4);

  if (!prefix) {
    throw new Error("REGISTRATION_PREFIX_REQUIRED");
  }

  const initialCounter =
    format === "LETTERS"
      ? 0
      : ACS_RA_getNumericStart(length);

  /*
    Counter is locked with FOR UPDATE to prevent two players/tabs
    generating the same registration at the same time.
  */

  await client.query(
    `
    INSERT INTO public.aircraft_registration_counters (
      registration_prefix,
      next_number,
      created_at,
      updated_at
    )
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (registration_prefix)
    DO NOTHING
    `,
    [prefix, initialCounter]
  );

  const counterResult = await client.query(
    `
    SELECT
      registration_prefix,
      next_number
    FROM public.aircraft_registration_counters
    WHERE registration_prefix = $1
    FOR UPDATE
    `,
    [prefix]
  );

  if (!counterResult.rows.length) {
    throw new Error(`REGISTRATION_COUNTER_NOT_FOUND_${prefix}`);
  }

  const currentCounter = Number(counterResult.rows[0].next_number || initialCounter);

  let registration;

  if (format === "LETTERS") {
    const letters = ACS_RA_numberToLetters(currentCounter, length);
    registration = `${prefix}${letters}`;
  } else {
    const numericPart = String(currentCounter).padStart(length, "0").slice(-length);
    registration = `${prefix}${numericPart}`;
  }

  await client.query(
    `
    UPDATE public.aircraft_registration_counters
    SET
      next_number = next_number + 1,
      updated_at = NOW()
    WHERE registration_prefix = $1
    `,
    [prefix]
  );

  return registration;
}

async function ACS_RA_generateUniqueRegistration(client, rule) {
  /*
    Safety loop:
    If a registration already exists because of old data or manual import,
    generate the next one.
  */

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = await ACS_RA_generateCandidateFromRule(client, rule);

    const existsResult = await client.query(
      `
      SELECT id
      FROM public.aircraft_fleet
      WHERE registration = $1
      LIMIT 1
      `,
      [candidate]
    );

    if (!existsResult.rows.length) {
      return candidate;
    }
  }

  throw new Error("REGISTRATION_GENERATION_EXHAUSTED");
}

function ACS_RA_registrationMatchesRule(registration, rule) {
  const reg = String(registration || "").trim().toUpperCase();
  const prefix = String(rule?.registration_prefix || "").trim().toUpperCase();

  if (!reg || !prefix) return false;

  return reg.startsWith(prefix);
}

async function ACS_ensureAircraftMaintenanceStatus(
  client,
  aircraftId,
  airlineId,
  options = {}
) {
  const baseSimTime = options.baseSimTime || null;

  await client.query(
    `
    WITH acs_base AS (
      SELECT COALESCE(
        $3::TIMESTAMPTZ,
        acs_get_current_sim_time()
      ) AS base_sim_time
    )

    INSERT INTO public.aircraft_maintenance_status (
      aircraft_id,
      airline_id,

      a_check_due_date,
      b_check_due_date,
      c_check_due_date,
      d_check_due_date,

      a_check_status,
      b_check_status,
      c_check_status,
      d_check_status,

      maintenance_control_status,
      maintenance_control_reason,

      created_at,
      updated_at
    )
    SELECT
      $1,
      $2,

      base_sim_time + INTERVAL '7 days',
      base_sim_time + INTERVAL '30 days',
      base_sim_time + INTERVAL '12 months',
      base_sim_time + INTERVAL '8 years',

      'OPEN',
      'OPEN',
      'OPEN',
      'OPEN',

      'SERVICEABLE',
      NULL,

      NOW(),
      NOW()
    FROM acs_base

    ON CONFLICT (aircraft_id)
    DO UPDATE SET
      a_check_due_date = COALESCE(public.aircraft_maintenance_status.a_check_due_date, EXCLUDED.a_check_due_date),
      b_check_due_date = COALESCE(public.aircraft_maintenance_status.b_check_due_date, EXCLUDED.b_check_due_date),
      c_check_due_date = COALESCE(public.aircraft_maintenance_status.c_check_due_date, EXCLUDED.c_check_due_date),
      d_check_due_date = COALESCE(public.aircraft_maintenance_status.d_check_due_date, EXCLUDED.d_check_due_date),

      a_check_status = COALESCE(public.aircraft_maintenance_status.a_check_status, EXCLUDED.a_check_status),
      b_check_status = COALESCE(public.aircraft_maintenance_status.b_check_status, EXCLUDED.b_check_status),
      c_check_status = COALESCE(public.aircraft_maintenance_status.c_check_status, EXCLUDED.c_check_status),
      d_check_status = COALESCE(public.aircraft_maintenance_status.d_check_status, EXCLUDED.d_check_status),

      maintenance_control_status = COALESCE(public.aircraft_maintenance_status.maintenance_control_status, EXCLUDED.maintenance_control_status),
      updated_at = NOW()
    `,
    [
      Number(aircraftId),
      Number(airlineId),
      baseSimTime
    ]
  );
}

/* ============================================================
   🟩 HEALTH CHECK
   ============================================================ */

router.get("/aircraft/health", requireAuth, async (req, res) => {
  return res.json({
    ok: true,
    module: "aircraft",
    airline_id: req.airline_id
  });
});

/* ============================================================
   🟦 GET MY AIRCRAFT FLEET — MAINTENANCE AUTHORITY v1.2
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/fleet

   Purpose:
   - Read aircraft fleet from PostgreSQL
   - Join aircraft_maintenance_status as technical authority
   - No localStorage authority
   - No frontend maintenance calculation
   - My Aircraft receives real C/D check status
   ============================================================ */

router.get("/aircraft/fleet", requireAuth, async (req, res) => {
  try {
    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION",
        details: "No airline_id found in authenticated session"
      });
    }

    const result = await pool.query(
      `
      SELECT
        af.id,
        af.aircraft_uid,
        af.airline_id,
        af.user_id,
        af.source,
        af.ownership_type,
        af.manufacturer,
        af.model_key,
        af.aircraft_name,
        af.registration,

        CASE
          WHEN af.status IN (
            'FOR_SALE',
            'FOR_LEASE'
          )
          THEN (
            SELECT
              arp.registration_prefix
            FROM public.aircraft_registration_prefixes arp
            WHERE arp.is_active = TRUE
              AND COALESCE(
                af.base_icao,
                af.current_airport,
                ''
              ) LIKE (arp.icao_prefix || '%')
            ORDER BY
              LENGTH(arp.icao_prefix) DESC
            LIMIT 1
          )
          ELSE NULL
        END AS market_registration_prefix,

        af.serial_number,
        af.line_number,
        af.new_aircraft_order_id,
        af.used_listing_id,
        af.status,
        af.operational_status,
        af.base_icao,
        af.current_airport,
        af.year_built,
        af.delivery_date,
        af.entry_into_service_date,
        af.total_hours,
        af.total_cycles,
        af.condition_pct,
        af.maintenance_status,
        af.purchase_price,
        af.current_value,
        af.currency,
        af.created_at,
        af.updated_at,

         /* =====================================================
           AIRCRAFT CATALOG — TECHNICAL REFERENCE
           Read-only information for My Aircraft.
           ===================================================== */

        ac.catalog_uid,
        ac.manufacturer AS catalog_manufacturer,
        ac.model AS catalog_model,
        ac.aircraft_name AS catalog_aircraft_name,
        ac.production_year AS catalog_production_year,
        ac.year AS catalog_reference_year,

        ac.aircraft_category,
        ac.seats,
        ac.range_nm,
        ac.speed_kts,
        ac.mtow_kg,
        ac.fuel_burn_kgph,
        ac.engines,
        ac.price_acs_usd,

        COALESCE(
          NULLIF(
            ac.raw_data ->> 'required_runway_m',
            ''
          )::INTEGER,
          0
        ) AS required_runway_m,

        ac.status AS catalog_status,
        ac.image_filename,

        ams.a_check_due_date,
        ams.a_check_status,

        ams.b_check_due_date,
        ams.b_check_status,

        ams.c_check_due_hours,
        ams.c_check_due_cycles,
        ams.c_check_due_date,
        ams.c_check_status,

        ams.d_check_due_date,
        ams.d_check_status,

        ams.maintenance_control_status,
        ams.maintenance_control_reason,

        acs_get_current_sim_time() AS current_sim_time

      FROM aircraft_fleet af

      LEFT JOIN aircraft_catalog ac
        ON ac.model_key = af.model_key

      LEFT JOIN aircraft_maintenance_status ams
        ON ams.aircraft_id = af.id

      WHERE af.airline_id = $1

      ORDER BY af.created_at DESC, af.id DESC
      `,
      [airlineId]
    );

    return res.json({
      ok: true,
      endpoint: "ACS_MY_AIRCRAFT_FLEET",
      version: "v1.2",
      authority: {
        fleet: "aircraft_fleet",
        maintenance: "aircraft_maintenance_status",
        time: "acs_get_current_sim_time"
      },
      airline_id: airlineId,
      fleet: result.rows
    });

  } catch (err) {
    console.error("ACS AIRCRAFT FLEET ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_FLEET_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟨 ACS AIRCRAFT SALE QUOTE — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/fleet/:id/sale/quote

   Purpose:
   - Validate aircraft ownership
   - Calculate authoritative ACS market valuation
   - Return four sale price levels
   - Lowest allowed is 5% below minimum market price
   - No frontend price authority
   - No finance mutation
   - No Used Market mutation
   - Special 20+ year rule will be added later
   ============================================================ */

const ACS_AIRCRAFT_SALE_POLICY = Object.freeze({
  brokerCommissionRate: 0.02,

  minimumMarketMultiplier: 0.90,
  maximumMarketMultiplier: 1.12,

  lowestAllowedDiscount: 0.05,

  maximumGeneralAgeYears: 20,
  annualAgeAdjustment: 0.0125,

  maximumHoursPenalty: 0.12,
  maximumCyclesPenalty: 0.12,

  hoursPenaltyReference: 60000,
  cyclesPenaltyReference: 30000
});

function ACS_saleClamp(
  value,
  minimum,
  maximum
) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return minimum;
  }

  return Math.min(
    maximum,
    Math.max(minimum, numericValue)
  );
}

function ACS_saleRoundMoney(value) {
  const numericValue = Number(value);

  if (
    !Number.isFinite(numericValue) ||
    numericValue <= 0
  ) {
    return 0;
  }

  /*
    ACS Market quotes are rounded to the nearest
    USD 1,000 to avoid artificial precision.
  */

  return Math.max(
    1000,
    Math.round(numericValue / 1000) * 1000
  );
}

function ACS_saleNormalizeStatus(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function ACS_saleResolveBaseValue(aircraft) {
  const candidates = [
    aircraft.current_value,
    aircraft.purchase_price,
    aircraft.price_acs_usd
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }

  return 0;
}

function ACS_saleResolveEligibility(aircraft) {
  const ownership =
    ACS_saleNormalizeStatus(
      aircraft.ownership_type
    );

  const fleetStatus =
    ACS_saleNormalizeStatus(
      aircraft.status
    );

  const operationalStatus =
    ACS_saleNormalizeStatus(
      aircraft.operational_status
    );

  const cCheckStatus =
    ACS_saleNormalizeStatus(
      aircraft.c_check_status
    );

  const dCheckStatus =
    ACS_saleNormalizeStatus(
      aircraft.d_check_status
    );

  if (ownership !== "OWNED") {
    return {
      eligible: false,
      code: "AIRCRAFT_NOT_OWNED",
      message:
        "Only airline-owned aircraft can be listed for sale."
    };
  }

  if (
    [
      "FOR_SALE",
      "SOLD",
      "SCRAPPED"
    ].includes(fleetStatus)
  ) {
    return {
      eligible: false,
      code: "AIRCRAFT_STATUS_NOT_ELIGIBLE",
      message:
        "Aircraft status does not permit a new sale listing."
    };
  }

  if (
    [
      "IN_FLIGHT",
      "FLYING"
    ].includes(operationalStatus)
  ) {
    return {
      eligible: false,
      code: "AIRCRAFT_IN_FLIGHT",
      message:
        "Aircraft cannot be listed while a flight is in progress."
    };
  }

  if (
    cCheckStatus === "IN_PROGRESS" ||
    dCheckStatus === "IN_PROGRESS"
  ) {
    return {
      eligible: false,
      code: "HEAVY_MAINTENANCE_IN_PROGRESS",
      message:
        "Aircraft cannot be listed during an active C or D Check."
    };
  }

  return {
    eligible: true,
    code: "SALE_ELIGIBLE",
    message:
      "Aircraft is eligible for an ACS Used Market sale listing."
  };
}

function ACS_calculateAircraftSaleQuote(
  aircraft
) {
  const baseValue =
    ACS_saleResolveBaseValue(aircraft);

  if (baseValue <= 0) {
    return {
      ok: false,
      error: "SALE_VALUATION_UNAVAILABLE",
      details:
        "Aircraft has no valid current, purchase, or catalog value."
    };
  }

  const conditionPct =
    ACS_saleClamp(
      aircraft.condition_pct,
      1,
      100
    );

  const totalHours = Math.max(
    0,
    Number(aircraft.total_hours) || 0
  );

  const totalCycles = Math.max(
    0,
    Number(aircraft.total_cycles) || 0
  );

  const aircraftAge = Math.max(
    0,
    Number(aircraft.aircraft_age) || 0
  );

  /*
    General age calculation is capped at 20 years.
    The special ACS rule for aircraft over 20 years
    will be implemented after the Sell system works.
  */

  const valuationAge = Math.min(
    aircraftAge,
    ACS_AIRCRAFT_SALE_POLICY
      .maximumGeneralAgeYears
  );

  /*
    Condition factor:
    1% condition  = approximately 65.35%
    100% condition = 100%
  */

  const conditionFactor =
    0.65 + (
      conditionPct / 100
    ) * 0.35;

  const ageFactor =
    1 - (
      valuationAge *
      ACS_AIRCRAFT_SALE_POLICY
        .annualAgeAdjustment
    );

  const hoursPenalty = Math.min(
    ACS_AIRCRAFT_SALE_POLICY
      .maximumHoursPenalty,

    (
      totalHours /
      ACS_AIRCRAFT_SALE_POLICY
        .hoursPenaltyReference
    ) *
    ACS_AIRCRAFT_SALE_POLICY
      .maximumHoursPenalty
  );

  const cyclesPenalty = Math.min(
    ACS_AIRCRAFT_SALE_POLICY
      .maximumCyclesPenalty,

    (
      totalCycles /
      ACS_AIRCRAFT_SALE_POLICY
        .cyclesPenaltyReference
    ) *
    ACS_AIRCRAFT_SALE_POLICY
      .maximumCyclesPenalty
  );

  const cCheckStatus =
    ACS_saleNormalizeStatus(
      aircraft.c_check_status
    );

  const dCheckStatus =
    ACS_saleNormalizeStatus(
      aircraft.d_check_status
    );

  const maintenanceControlStatus =
    ACS_saleNormalizeStatus(
      aircraft.maintenance_control_status
    );

  let maintenanceFactor = 1;

  if (
    cCheckStatus === "OVERDUE" ||
    dCheckStatus === "OVERDUE"
  ) {
    maintenanceFactor = 0.92;
  } else if (
    maintenanceControlStatus ===
      "MAINTENANCE_REQUIRED"
  ) {
    maintenanceFactor = 0.97;
  }

  const utilizationFactor =
    Math.max(
      0.70,
      1 - hoursPenalty - cyclesPenalty
    );

  const rawSuggestedPrice =
    baseValue *
    conditionFactor *
    ageFactor *
    utilizationFactor *
    maintenanceFactor;

  const suggestedPrice =
    ACS_saleRoundMoney(
      rawSuggestedPrice
    );

  const minimumPrice =
    ACS_saleRoundMoney(
      suggestedPrice *
      ACS_AIRCRAFT_SALE_POLICY
        .minimumMarketMultiplier
    );

  const maximumPrice =
    ACS_saleRoundMoney(
      suggestedPrice *
      ACS_AIRCRAFT_SALE_POLICY
        .maximumMarketMultiplier
    );

  const lowestAllowedPrice =
    ACS_saleRoundMoney(
      minimumPrice *
      (
        1 -
        ACS_AIRCRAFT_SALE_POLICY
          .lowestAllowedDiscount
      )
    );

  if (
    lowestAllowedPrice <= 0 ||
    minimumPrice <= 0 ||
    suggestedPrice <= 0 ||
    maximumPrice <= 0
  ) {
    return {
      ok: false,
      error: "INVALID_SALE_VALUATION",
      details:
        "ACS could not establish a positive aircraft valuation."
    };
  }

  const suggestedBrokerCommission =
    ACS_saleRoundMoney(
      suggestedPrice *
      ACS_AIRCRAFT_SALE_POLICY
        .brokerCommissionRate
    );

  const suggestedNetProceeds =
    Math.max(
      0,
      suggestedPrice -
      suggestedBrokerCommission
    );

  return {
    ok: true,

    currency:
      aircraft.currency || "USD",

    base_value:
      ACS_saleRoundMoney(baseValue),

    lowest_allowed_price:
      lowestAllowedPrice,

    minimum_price:
      minimumPrice,

    suggested_price:
      suggestedPrice,

    maximum_price:
      maximumPrice,

    broker_commission_rate:
      ACS_AIRCRAFT_SALE_POLICY
        .brokerCommissionRate,

    suggested_broker_commission:
      suggestedBrokerCommission,

    suggested_net_proceeds:
      suggestedNetProceeds,

    factors: {
      aircraft_age: aircraftAge,
      general_age_used: valuationAge,

      condition_pct: conditionPct,
      condition_factor:
        Number(conditionFactor.toFixed(4)),

      age_factor:
        Number(ageFactor.toFixed(4)),

      hours_penalty:
        Number(hoursPenalty.toFixed(4)),

      cycles_penalty:
        Number(cyclesPenalty.toFixed(4)),

      utilization_factor:
        Number(utilizationFactor.toFixed(4)),

      maintenance_factor:
        Number(maintenanceFactor.toFixed(4))
    }
  };
}

router.get(
  "/aircraft/fleet/:id/sale/quote",
  requireAuth,
  async (req, res) => {
    try {
      const airlineId =
        Number(req.airline_id);

      const aircraftId =
        Number(req.params.id);

      if (
        !Number.isInteger(aircraftId) ||
        aircraftId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_AIRCRAFT_ID"
        });
      }

      if (
        !Number.isInteger(airlineId) ||
        airlineId <= 0
      ) {
        return res.status(401).json({
          ok: false,
          error: "NO_AIRLINE_SESSION"
        });
      }

      const result = await pool.query(
        `
        SELECT
          af.id,
          af.aircraft_uid,
          af.airline_id,
          af.ownership_type,
          af.status,
          af.operational_status,
          af.maintenance_status,

          af.manufacturer,
          af.model_key,
          af.aircraft_name,
          af.registration,

          af.year_built,
          af.condition_pct,
          af.total_hours,
          af.total_cycles,

          af.purchase_price,
          af.current_value,
          af.currency,

          ac.aircraft_name
            AS catalog_aircraft_name,

          ac.price_acs_usd,

          ams.c_check_status,
          ams.d_check_status,

          ams.maintenance_control_status,
          ams.maintenance_control_reason,

          acs_get_current_sim_time()
            AS current_sim_time,

          GREATEST(
            0,
            EXTRACT(
              YEAR FROM AGE(
                acs_get_current_sim_time(),
                MAKE_DATE(
                  COALESCE(
                    af.year_built,
                    EXTRACT(
                      YEAR FROM
                      acs_get_current_sim_time()
                    )::INTEGER
                  ),
                  1,
                  1
                )
              )
            )::INTEGER
          ) AS aircraft_age

        FROM public.aircraft_fleet af

        LEFT JOIN public.aircraft_catalog ac
          ON ac.model_key = af.model_key

        LEFT JOIN
          public.aircraft_maintenance_status ams
          ON ams.aircraft_id = af.id

        WHERE af.id = $1
          AND af.airline_id = $2

        LIMIT 1
        `,
        [
          aircraftId,
          airlineId
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error: "AIRCRAFT_NOT_FOUND"
        });
      }

      const aircraft =
        result.rows[0];

      const eligibility =
        ACS_saleResolveEligibility(
          aircraft
        );

      if (!eligibility.eligible) {
        return res.status(409).json({
          ok: false,
          error: eligibility.code,
          details: eligibility.message,
          eligibility
        });
      }
const quote =
  ACS_calculateAircraftSaleQuote(
    aircraft
  );

if (!quote.ok) {
  return res.status(422).json(
    quote
  );
}

const schedule =
  await ACS_getAircraftSaleScheduleExposure(
    pool,
    airlineId,
    aircraftId
  );

if (schedule.has_active_operation) {
  return res.status(409).json({
    ok: false,

    error:
      "AIRCRAFT_OPERATION_IN_PROGRESS",

    details:
      "Aircraft cannot be listed while a flight operation is in progress.",

    schedule
  });
}

return res.json({
        ok: true,

        endpoint:
          "ACS_AIRCRAFT_SALE_QUOTE",

        version:
          "ACS_AIRCRAFT_SALE_QUOTE_V1_0",

        airline_id:
          airlineId,

        aircraft: {
          id: aircraft.id,

          aircraft_uid:
            aircraft.aircraft_uid,

          aircraft_name:
            aircraft.catalog_aircraft_name ||
            aircraft.aircraft_name,

          registration:
            aircraft.registration,

          model_key:
            aircraft.model_key,

          ownership_type:
            aircraft.ownership_type,

          year_built:
            aircraft.year_built,

          condition_pct:
            aircraft.condition_pct,

          total_hours:
            aircraft.total_hours,

          total_cycles:
            aircraft.total_cycles
        },

        eligibility,

        schedule,

        quote
      });

    } catch (error) {
      console.error(
        "ACS AIRCRAFT SALE QUOTE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRCRAFT_SALE_QUOTE_FAILED",
        details:
          error.message
      });
    }
  }
);

/* ============================================================
   ACS OCC — AIRCRAFT SALE SCHEDULE EXPOSURE
   ------------------------------------------------------------
   Schedule authority:
   - Future operations produce a confirmation warning.
   - An operation IN_PROGRESS blocks the listing.
   - Publishing never cancels scheduled operations.
   ============================================================ */

async function ACS_getAircraftSaleScheduleExposure(
  db,
  airlineId,
  aircraftId
) {
  const result = await db.query(
    `
    WITH acs_clock AS (
      SELECT
        acs_get_current_sim_time()
          AS current_sim_time
    ),

    assigned_routes AS (
      SELECT
        rp.id,
        rp.route_uid,
        rp.origin,
        rp.destination,
        rp.route_state
      FROM public.route_plans rp
      WHERE rp.airline_id = $1
        AND rp.aircraft_id = $2

        AND UPPER(
          COALESCE(
            rp.route_state,
            'ACTIVE'
          )
        ) <> 'CANCELLED'
    ),

    assigned_items AS (
      SELECT
        si.id,
        si.route_plan_id,
        si.status
      FROM public.schedule_items si
      WHERE si.airline_id = $1
        AND si.aircraft_id = $2
        AND si.item_type = 'flight'

        AND LOWER(
          COALESCE(
            si.status,
            'planned'
          )
        ) NOT IN (
          'cancelled',
          'completed'
        )
    )

    SELECT
      acs_clock.current_sim_time,

      (
        SELECT COUNT(*)::INTEGER
        FROM assigned_routes
      ) AS assigned_routes_count,

      (
        SELECT COUNT(*)::INTEGER
        FROM assigned_items
      ) AS assigned_schedule_items_count,

      (
        SELECT COUNT(*)::INTEGER
        FROM assigned_routes
        WHERE UPPER(
          COALESCE(
            route_state,
            ''
          )
        ) = 'IN_PROGRESS'
      ) AS active_routes_count,

      (
        SELECT COUNT(*)::INTEGER
        FROM assigned_items
        WHERE UPPER(
          COALESCE(
            status,
            ''
          )
        ) = 'IN_PROGRESS'
      ) AS active_schedule_items_count,

      (
        SELECT COUNT(*)::INTEGER
        FROM public.flight_occurrences fo
        WHERE fo.airline_id = $1
          AND fo.aircraft_id = $2

          AND UPPER(
            COALESCE(
              fo.operational_status,
              ''
            )
          ) = 'IN_PROGRESS'
      ) AS active_occurrences_count,

      (
        SELECT COUNT(*)::INTEGER
        FROM public.flight_occurrences fo
        WHERE fo.airline_id = $1
          AND fo.aircraft_id = $2

          AND fo.scheduled_departure_at >=
            acs_clock.current_sim_time

          AND UPPER(
            COALESCE(
              fo.operational_status,
              'SCHEDULED'
            )
          ) NOT IN (
            'CANCELLED',
            'COMPLETED'
          )
      ) AS future_occurrences_count,

      (
        SELECT MIN(
          fo.scheduled_departure_at
        )
        FROM public.flight_occurrences fo
        WHERE fo.airline_id = $1
          AND fo.aircraft_id = $2

          AND fo.scheduled_departure_at >=
            acs_clock.current_sim_time

          AND UPPER(
            COALESCE(
              fo.operational_status,
              'SCHEDULED'
            )
          ) NOT IN (
            'CANCELLED',
            'COMPLETED'
          )
      ) AS next_scheduled_departure,

      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'route_plan_id',
                assigned_routes.id,

              'route_uid',
                assigned_routes.route_uid,

              'origin',
                assigned_routes.origin,

              'destination',
                assigned_routes.destination,

              'route_state',
                assigned_routes.route_state
            )
            ORDER BY assigned_routes.id
          )
          FROM assigned_routes
        ),
        '[]'::JSONB
      ) AS assigned_routes

    FROM acs_clock
    `,
    [
      Number(airlineId),
      Number(aircraftId)
    ]
  );

  const row =
    result.rows[0] || {};

  const assignedRoutesCount =
    Math.max(
      0,
      Number(
        row.assigned_routes_count
      ) || 0
    );

  const assignedScheduleItemsCount =
    Math.max(
      0,
      Number(
        row.assigned_schedule_items_count
      ) || 0
    );

  const activeOperationsCount =
    (
      Number(
        row.active_routes_count
      ) || 0
    ) +
    (
      Number(
        row.active_schedule_items_count
      ) || 0
    ) +
    (
      Number(
        row.active_occurrences_count
      ) || 0
    );

  return {
    has_assigned_routes:
      assignedRoutesCount > 0,

    requires_confirmation:
      assignedRoutesCount > 0,

    has_active_operation:
      activeOperationsCount > 0,

    assigned_routes_count:
      assignedRoutesCount,

    assigned_schedule_items_count:
      assignedScheduleItemsCount,

    future_occurrences_count:
      Math.max(
        0,
        Number(
          row.future_occurrences_count
        ) || 0
      ),

    active_operations_count:
      activeOperationsCount,

    next_scheduled_departure:
      row.next_scheduled_departure ||
      null,

    current_sim_time:
      row.current_sim_time ||
      null,

    assigned_routes:
      Array.isArray(
        row.assigned_routes
      )
        ? row.assigned_routes
        : []
  };
}

/* ============================================================
   🟨 ACS AIRCRAFT SALE LISTING — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/fleet/:id/sale/listing

   Body:
   {
     "asking_price": 1015000
   }

   Purpose:
   - Lock aircraft during commercial validation
   - Recalculate authoritative sale valuation
   - Validate player asking price
   - Prevent duplicate open listings
   - Publish real aircraft to ACS Used Market
   - No sale completion
   - No ownership transfer
   - No finance mutation
   ============================================================ */

function ACS_resolveSaleMarketPosition(
  askingPrice,
  quote
) {
  const price =
    Number(askingPrice);

  if (
    price <
    Number(quote.minimum_price)
  ) {
    return "QUICK_SALE";
  }

  if (
    price <
    Number(quote.suggested_price)
  ) {
    return "COMPETITIVE";
  }

  if (
    price <=
    Number(quote.maximum_price)
  ) {
    return "MARKET_RANGE";
  }

  return "ABOVE_MARKET";
}

function ACS_roundSaleListingMoney(value) {
  const numericValue =
    Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  /*
    Listing calculations retain whole-dollar precision.
    Example:
    USD 914,000 × 2% = USD 18,280.
  */

  return Math.round(numericValue);
}

router.post(
  "/aircraft/fleet/:id/sale/listing",
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const airlineId =
        Number(req.airline_id);

      const aircraftId =
        Number(req.params.id);

      const askingPrice =
        Number(req.body?.asking_price);

      const scheduledOperationsConfirmed =
      req.body
      ?.confirm_scheduled_operations ===
      true;
       
      if (
        !Number.isInteger(airlineId) ||
        airlineId <= 0
      ) {
        return res.status(401).json({
          ok: false,
          error: "NO_AIRLINE_SESSION"
        });
      }

      if (
        !Number.isInteger(aircraftId) ||
        aircraftId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_AIRCRAFT_ID"
        });
      }

      if (
        !Number.isFinite(askingPrice) ||
        askingPrice <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_ASKING_PRICE",
          details:
            "Asking price must be greater than zero."
        });
      }

      /*
        Guard against accidental or manipulated
        values outside PostgreSQL NUMERIC policy.
      */

      if (askingPrice > 999999999999999) {
        return res.status(400).json({
          ok: false,
          error: "ASKING_PRICE_TOO_LARGE",
          details:
            "Asking price exceeds the ACS commercial limit."
        });
      }

      await client.query("BEGIN");

      /*
        Lock the real aircraft record.

        Two browser tabs cannot publish the same aircraft
        simultaneously without one transaction waiting
        for the other.
      */

      const aircraftResult =
        await client.query(
          `
          SELECT
            af.id,
            af.aircraft_uid,
            af.airline_id,
            af.ownership_type,
            af.status,
            af.operational_status,
            af.maintenance_status,

            af.manufacturer,
            af.model_key,
            af.aircraft_name,
            af.registration,

            af.year_built,
            af.condition_pct,
            af.total_hours,
            af.total_cycles,

            af.base_icao,
            af.current_airport,

            af.purchase_price,
            af.current_value,
            af.currency,

            ac.aircraft_name
              AS catalog_aircraft_name,

            ac.price_acs_usd,

            ams.c_check_status,
            ams.d_check_status,

            ams.maintenance_control_status,
            ams.maintenance_control_reason,

            acs_get_current_sim_time()
              AS current_sim_time,

            GREATEST(
              0,
              EXTRACT(
                YEAR FROM AGE(
                  acs_get_current_sim_time(),
                  MAKE_DATE(
                    COALESCE(
                      af.year_built,
                      EXTRACT(
                        YEAR FROM
                        acs_get_current_sim_time()
                      )::INTEGER
                    ),
                    1,
                    1
                  )
                )
              )::INTEGER
            ) AS aircraft_age

          FROM public.aircraft_fleet af

          LEFT JOIN
            public.aircraft_catalog ac
            ON ac.model_key = af.model_key

          LEFT JOIN
            public.aircraft_maintenance_status ams
            ON ams.aircraft_id = af.id

          WHERE af.id = $1
            AND af.airline_id = $2

          LIMIT 1

          FOR UPDATE OF af
          `,
          [
            aircraftId,
            airlineId
          ]
        );

      if (!aircraftResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "AIRCRAFT_NOT_FOUND"
        });
      }

      const aircraft =
        aircraftResult.rows[0];

      /*
        Backend ownership and operational authority.
      */

      const eligibility =
        ACS_saleResolveEligibility(
          aircraft
        );

      if (!eligibility.eligible) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: eligibility.code,
          details: eligibility.message,
          eligibility
        });
      }

      /*
        Check before INSERT to return a readable error.

        The partial unique index remains the final
        concurrency authority.
      */

      const existingListingResult =
        await client.query(
          `
          SELECT
            id,
            listing_type,
            status,
            asking_price,
            currency,
            listed_sim_time
          FROM
            public.aircraft_market_listings
          WHERE aircraft_id = $1
            AND status IN (
              'ACTIVE',
              'OFFER_RECEIVED',
              'SALE_PENDING'
            )
          ORDER BY id DESC
          LIMIT 1
          `,
          [aircraftId]
        );

      if (existingListingResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "AIRCRAFT_ALREADY_LISTED",

          details:
            "Aircraft already has an active commercial listing.",

          listing:
            existingListingResult.rows[0]
        });
      }

      /*
        Recalculate the full valuation inside the
        publication transaction.

        Values shown previously in the browser are
        never accepted as authority.
      */

      const quote =
  ACS_calculateAircraftSaleQuote(
    aircraft
  );

if (!quote.ok) {
  await client.query("ROLLBACK");

  return res.status(422).json(
    quote
  );
}

/*
  Schedule must be rechecked inside the same
  publication transaction.

  The quote shown in the browser is not authority.
*/

const schedule =
  await ACS_getAircraftSaleScheduleExposure(
    client,
    airlineId,
    aircraftId
  );

if (schedule.has_active_operation) {
  await client.query("ROLLBACK");

  return res.status(409).json({
    ok: false,

    error:
      "AIRCRAFT_OPERATION_IN_PROGRESS",

    details:
      "Aircraft cannot be listed while a flight operation is in progress.",

    schedule
  });
}

if (
  schedule.requires_confirmation &&
  !scheduledOperationsConfirmed
) {
  await client.query("ROLLBACK");

  return res.status(409).json({
    ok: false,

    error:
      "SCHEDULED_OPERATIONS_CONFIRMATION_REQUIRED",

    details:
      "Aircraft has scheduled operations. Explicit confirmation is required before publication.",

    schedule
  });
}

      const lowestAllowedPrice =
        Number(
          quote.lowest_allowed_price
        );

      if (
        askingPrice <
        lowestAllowedPrice
      ) {
        await client.query("ROLLBACK");

        return res.status(422).json({
          ok: false,

          error:
            "ASKING_PRICE_BELOW_ALLOWED_LIMIT",

          details:
            "Asking price is below the ACS authorized limit.",

          currency:
            quote.currency,

          asking_price:
            askingPrice,

          lowest_allowed_price:
            lowestAllowedPrice
        });
      }

      const commissionRate =
        Number(
          quote.broker_commission_rate
        );

      const brokerCommission =
        ACS_roundSaleListingMoney(
          askingPrice *
          commissionRate
        );

      const estimatedNetProceeds =
        Math.max(
          0,

          ACS_roundSaleListingMoney(
            askingPrice -
            brokerCommission
          )
        );

      const marketPosition =
        ACS_resolveSaleMarketPosition(
          askingPrice,
          quote
        );

      /*
  The player accepted the warning.

  Schedule unassignment and Used Market listing
  creation share this same PostgreSQL transaction.
*/

const scheduleUnassignment =
  await ACS_unassignAircraftForCommercialAction(
    client,
    {
      airlineId,
      aircraftId,

      source:
        "ACS_AIRCRAFT_SALE_LISTING"
    }
  );

     /*
  Withdraw the aircraft from active airline service.

  The previous registration remains preserved in the
  listing snapshot through aircraft.registration.
*/

const marketHoldResult =
  await client.query(
    `
    UPDATE public.aircraft_fleet
    SET
      status = 'FOR_SALE',
      operational_status = 'UNAVAILABLE',
      registration = NULL,
      updated_at = NOW()

    WHERE id = $1
      AND airline_id = $2
      AND ownership_type = 'OWNED'

    RETURNING
      id,
      status,
      operational_status,
      maintenance_status,
      registration,
      updated_at
    `,
    [
      aircraftId,
      airlineId
    ]
  );

if (!marketHoldResult.rows.length) {
  const error =
    new Error(
      "AIRCRAFT_MARKET_HOLD_FAILED"
    );

  error.code =
    "AIRCRAFT_MARKET_HOLD_FAILED";

  throw error;
}

const marketAircraft =
  marketHoldResult.rows[0];
       
      const aircraftName =
        String(
          aircraft.catalog_aircraft_name ||
          aircraft.aircraft_name ||
          aircraft.model_key ||
          "Aircraft"
        ).trim();

      const currency =
        String(
          quote.currency || "USD"
        )
          .trim()
          .toUpperCase();

      const listingResult =
  await client.query(
    `
    INSERT INTO
      public.aircraft_market_listings
    (
      aircraft_id,
      seller_airline_id,

      listing_type,
      listing_source,
      status,

      currency,

      base_value,
      lowest_allowed_price,
      minimum_market_price,
      suggested_market_price,
      maximum_market_price,

      asking_price,

      broker_commission_rate,
      broker_commission_amount,
      estimated_net_proceeds,

      market_position,

      aircraft_name,
      registration,
      model_key,
      year_built,
      condition_pct,
      total_hours,
      total_cycles,
      current_airport,

      scheduled_occurrences_count,
      next_scheduled_departure,
      schedule_warning_confirmed,

      assigned_routes_count,
      unassigned_schedule_items_count,
      removed_future_occurrences_count,
      affected_slot_bookings_count,

      listed_sim_time,

      created_at,
      updated_at,
      version
    )
    VALUES
    (
      $1,
      $2,

      'SALE',
      'AIRLINE',
      'ACTIVE',

      $3,

      $4,
      $5,
      $6,
      $7,
      $8,

      $9,

      $10,
      $11,
      $12,

      $13,

      $14,
      $15,
      $16,
      $17,
      $18,
      $19,
      $20,
      $21,

      $22,
      $23,
      $24,

      $25,
      $26,
      $27,
      $28,

      $29,

      NOW(),
      NOW(),
      1
    )
    RETURNING
      id,
      aircraft_id,
      seller_airline_id,

      listing_type,
      listing_source,
      status,

      currency,
      asking_price,

      broker_commission_amount,
      estimated_net_proceeds,

      market_position,

      scheduled_occurrences_count,
      assigned_routes_count,
      unassigned_schedule_items_count,
      removed_future_occurrences_count,
      affected_slot_bookings_count,

      listed_sim_time,
      version,
      created_at
    `,
    [
      aircraft.id,
      airlineId,

      currency,

      quote.base_value,
      quote.lowest_allowed_price,
      quote.minimum_price,
      quote.suggested_price,
      quote.maximum_price,

      askingPrice,

      commissionRate,
      brokerCommission,
      estimatedNetProceeds,

      marketPosition,

      aircraftName,
      aircraft.registration || null,
      aircraft.model_key || null,
      aircraft.year_built || null,
      aircraft.condition_pct ?? null,
      aircraft.total_hours ?? null,
      aircraft.total_cycles ?? null,

      aircraft.current_airport ||
        aircraft.base_icao ||
        null,

      schedule.future_occurrences_count,

      schedule.next_scheduled_departure,

      schedule.requires_confirmation
        ? scheduledOperationsConfirmed
        : false,

      scheduleUnassignment
        .assigned_routes_count,

      scheduleUnassignment
        .unassigned_schedule_items_count,

      scheduleUnassignment
        .removed_future_occurrences_count,

      scheduleUnassignment
        .released_slot_bookings_count,

      aircraft.current_sim_time
    ]
  );
       
      await client.query("COMMIT");

      const listing =
        listingResult.rows[0];

      console.log(
        "🟨 ACS AIRCRAFT SALE LISTING CREATED:",
        {
          listing_id: listing.id,
          aircraft_id: aircraft.id,
          airline_id: airlineId,
          asking_price:
            listing.asking_price,
          market_position:
            listing.market_position
        }
      );

      return res.status(201).json({
        ok: true,

        endpoint:
          "ACS_AIRCRAFT_SALE_LISTING",

        version:
          "ACS_AIRCRAFT_SALE_LISTING_V1_0",

        message:
          "Aircraft sale listing created successfully.",

        aircraft: {
  id: aircraft.id,

  aircraft_uid:
    aircraft.aircraft_uid,

  aircraft_name:
    aircraftName,

  registration: null,

  previous_registration:
    aircraft.registration,

  model_key:
    aircraft.model_key,

  ownership_type:
    aircraft.ownership_type,

  status:
    marketAircraft.status
},

        quote,

        schedule,

        schedule_unassignment:
        scheduleUnassignment,

        listing
      });

    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // Transaction may already be closed.
      }

      /*
        PostgreSQL unique violation.
        Protects against simultaneous duplicate listings.
      */

      if (error?.code === "23505") {
        return res.status(409).json({
          ok: false,

          error:
            "AIRCRAFT_ALREADY_LISTED",

          details:
            "Aircraft already has an active commercial listing."
        });
      }

      if (
        error?.code ===
        "AIRCRAFT_MAINTENANCE_IN_PROGRESS"
      ) {
        return res.status(409).json({
          ok: false,

          error:
            "AIRCRAFT_MAINTENANCE_IN_PROGRESS",

          details:
            "Aircraft cannot be listed while maintenance is in progress.",

          maintenance_event:
            error.maintenance_event || null,

          maintenance_plan:
            error.maintenance_plan || null
        });
      }

      console.error(
        "ACS CREATE SALE LISTING ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRCRAFT_SALE_LISTING_FAILED",
        details:
          error?.message ||
          "Aircraft sale listing failed."
      });
       
      console.error(
  "ACS AIRCRAFT SALE LISTING ERROR:",
  error
);

return res.status(500).json({
  ok: false,

  error:
    "AIRCRAFT_SALE_LISTING_FAILED",

  details:
    error?.message ||
    "Aircraft sale listing failed."
});

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   🟦 ACS MAINTENANCE QUOTE — SERVICE C & D CONTROL v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/fleet/:id/maintenance/quote

   Purpose:
   - Backend authority for C/D service duration and cost
   - Reads aircraft_maintenance_policy from PostgreSQL
   - No frontend cost calculation
   - No localStorage
   - No Date.now()
   - Uses acs_get_current_sim_time()
   ============================================================ */

router.get("/aircraft/fleet/:id/maintenance/quote", requireAuth, async (req, res) => {
  try {
    const airlineId = Number(req.airline_id);
    const aircraftId = Number(req.params.id);

    if (!airlineId || !Number.isInteger(airlineId)) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!aircraftId || !Number.isInteger(aircraftId)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AIRCRAFT_ID"
      });
    }

    const aircraftResult = await pool.query(
      `
      SELECT
        af.id,
        af.registration,
        af.aircraft_name,
        af.manufacturer,
        af.model_key,
        af.source,
        af.year_built,
        af.total_hours,
        af.total_cycles,
        af.condition_pct,
        af.current_value,
        af.purchase_price,
        af.currency,
        af.status,
        af.operational_status,
        af.maintenance_status,

        ac.aircraft_category,
        ac.seats,
        ac.price_acs_usd,

        ams.c_check_due_date,
        ams.c_check_status,
        ams.d_check_due_date,
        ams.d_check_status,
        ams.maintenance_control_status,
        ams.maintenance_control_reason,

        acs_get_current_sim_time() AS current_sim_time

      FROM aircraft_fleet af

      LEFT JOIN aircraft_catalog ac
        ON ac.model_key = af.model_key

      LEFT JOIN aircraft_maintenance_status ams
        ON ams.aircraft_id = af.id

      WHERE af.id = $1
        AND af.airline_id = $2

      LIMIT 1
      `,
      [aircraftId, airlineId]
    );

    if (!aircraftResult.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "AIRCRAFT_NOT_FOUND_OR_NOT_OWNED"
      });
    }

    const aircraft = aircraftResult.rows[0];

    const aircraftCategory = String(aircraft.aircraft_category || "").toUpperCase();
    const aircraftName = String(aircraft.aircraft_name || "").toUpperCase();
    const seats = Number(aircraft.seats || 0);

    let sizeClass = "LIGHT";

    if (
      aircraftCategory.includes("WIDEBODY") ||
      aircraftName.includes("747") ||
      aircraftName.includes("DC-10") ||
      aircraftName.includes("L-1011") ||
      aircraftName.includes("A300") ||
      aircraftName.includes("A310") ||
      seats >= 220
    ) {
      sizeClass = "HEAVY";
    } else if (
      aircraftCategory.includes("NARROWBODY") ||
      aircraftCategory.includes("REGIONAL") ||
      aircraftName.includes("707") ||
      aircraftName.includes("720") ||
      aircraftName.includes("727") ||
      aircraftName.includes("737") ||
      aircraftName.includes("DC-8") ||
      aircraftName.includes("DC-9") ||
      aircraftName.includes("CONSTELLATION") ||
      aircraftName.includes("DC-6") ||
      aircraftName.includes("DC-7") ||
      seats >= 80
    ) {
      sizeClass = "MEDIUM";
    }

    const simYearResult = await pool.query(
      `
      SELECT EXTRACT(YEAR FROM acs_get_current_sim_time())::INTEGER AS sim_year
      `
    );

    const simYear = Number(simYearResult.rows[0]?.sim_year || 1940);

    const policyResult = await pool.query(
      `
      SELECT
        policy_code,
        aircraft_size_class,
        aircraft_category,
        era_start_year,
        era_end_year,
        c_check_duration_days,
        d_check_duration_days,
        c_check_cost_rate,
        d_check_cost_rate,
        condition_factor_low,
        condition_factor_medium,
        condition_factor_good,
        usage_factor_high,
        usage_factor_medium,
        usage_factor_normal
      FROM aircraft_maintenance_policy
      WHERE is_active = TRUE
        AND aircraft_size_class = $1
        AND aircraft_category = 'ANY'
        AND era_start_year <= $2
        AND era_end_year >= $2
      ORDER BY era_start_year DESC
      LIMIT 1
      `,
      [sizeClass, simYear]
    );

    if (!policyResult.rows.length) {
      return res.status(409).json({
        ok: false,
        error: "MAINTENANCE_POLICY_NOT_FOUND",
        size_class: sizeClass,
        sim_year: simYear
      });
    }

    const policy = policyResult.rows[0];

    const conditionPct = Number(aircraft.condition_pct || 80);
    const totalHours = Number(aircraft.total_hours || 0);
    const totalCycles = Number(aircraft.total_cycles || 0);

    const aircraftValue = Math.round(
      Number(
        aircraft.current_value ||
        aircraft.purchase_price ||
        aircraft.price_acs_usd ||
        0
      )
    );

    const currency = aircraft.currency || "USD";

    let conditionFactor = Number(policy.condition_factor_good || 1);

    if (conditionPct < 70) {
      conditionFactor = Number(policy.condition_factor_low || 1.25);
    } else if (conditionPct < 85) {
      conditionFactor = Number(policy.condition_factor_medium || 1.12);
    }

    let usageFactor = Number(policy.usage_factor_normal || 1);

    if (totalHours > 20000 || totalCycles > 12000) {
      usageFactor = Number(policy.usage_factor_high || 1.18);
    } else if (totalHours > 10000 || totalCycles > 6000) {
      usageFactor = Number(policy.usage_factor_medium || 1.10);
    }

    const cEstimatedCost = aircraftValue > 0
      ? Math.round(
          aircraftValue *
          Number(policy.c_check_cost_rate) *
          conditionFactor *
          usageFactor
        )
      : null;

    const dEstimatedCost = aircraftValue > 0
      ? Math.round(
          aircraftValue *
          Number(policy.d_check_cost_rate) *
          conditionFactor *
          usageFactor
        )
      : null;

    return res.json({
      ok: true,
      endpoint: "ACS_MAINTENANCE_QUOTE",
      version: "v1.0",
      authority: {
        time: "acs_get_current_sim_time",
        fleet: "aircraft_fleet",
        maintenance: "aircraft_maintenance_status",
        catalog: "aircraft_catalog",
        policy: "aircraft_maintenance_policy"
      },
      aircraft: {
        id: aircraft.id,
        registration: aircraft.registration,
        aircraft_name: aircraft.aircraft_name,
        model_key: aircraft.model_key,
        source: aircraft.source,
        size_class: sizeClass,
        condition_pct: conditionPct,
        total_hours: totalHours,
        total_cycles: totalCycles,
        current_value: aircraftValue,
        currency
      },
      current_sim_time: aircraft.current_sim_time,
      policy: {
        policy_code: policy.policy_code,
        aircraft_size_class: policy.aircraft_size_class
      },
      c_check: {
        status: aircraft.c_check_status || "NOT_ESTABLISHED",
        due_date: aircraft.c_check_due_date,
        duration_days: Number(policy.c_check_duration_days),
        estimated_cost: cEstimatedCost,
        currency
      },
      d_check: {
        status: aircraft.d_check_status || "NOT_ESTABLISHED",
        due_date: aircraft.d_check_due_date,
        duration_days: Number(policy.d_check_duration_days),
        estimated_cost: dEstimatedCost,
        currency
      }
    });

  } catch (err) {
    console.error("ACS MAINTENANCE QUOTE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "MAINTENANCE_QUOTE_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 ACS START MAINTENANCE EVENT — SERVICE C & D CONTROL v1.0
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/fleet/:id/maintenance/start

   Body:
   {
     "check_type": "C_CHECK" | "D_CHECK"
   }

   Purpose:
   - Start real C/D maintenance event by player action
   - Charge company_finance.cost_maintenance
   - Register finance_log
   - Create aircraft_maintenance_events row
   - Move aircraft to MAINTENANCE / IN_MAINTENANCE
   - No frontend finance mutation
   - No localStorage
   - No Date.now()
   - Uses acs_get_current_sim_time()
   ============================================================ */

async function ACS_startCDMaintenance(req, res) {
   
  const client = await pool.connect();

  try {
    const airlineId = Number(req.airline_id);
    const aircraftId = Number(req.params.id);
    const checkType = String(req.body?.check_type || "").trim().toUpperCase();
    
    const startSource =
    req.acs_start_source === "AUTOMATIC"
    ? "AUTOMATIC"
    : "MANUAL";
     
    if (!airlineId || !Number.isInteger(airlineId)) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!aircraftId || !Number.isInteger(aircraftId)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AIRCRAFT_ID"
      });
    }

    if (!["C_CHECK", "D_CHECK"].includes(checkType)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CHECK_TYPE",
        allowed_values: ["C_CHECK", "D_CHECK"]
      });
    }

    await client.query("BEGIN");

    const aircraftResult = await client.query(
      `
      SELECT
        af.id,
        af.airline_id,
        af.registration,
        af.aircraft_name,
        af.manufacturer,
        af.model_key,
        af.source,
        af.ownership_type,
        af.year_built,
        af.total_hours,
        af.total_cycles,
        af.condition_pct,
        af.current_value,
        af.purchase_price,
        af.currency,
        af.status,
        af.operational_status,
        af.maintenance_status,

        ac.aircraft_category,
        ac.seats,
        ac.price_acs_usd,

        ams.c_check_status,
        ams.c_check_due_date,
        ams.d_check_status,
        ams.d_check_due_date,
        ams.maintenance_control_status,
        ams.maintenance_control_reason,

        acs_get_current_sim_time() AS current_sim_time,
        EXTRACT(YEAR FROM acs_get_current_sim_time())::INTEGER AS sim_year

      FROM aircraft_fleet af

      LEFT JOIN aircraft_catalog ac
        ON ac.model_key = af.model_key

      LEFT JOIN aircraft_maintenance_status ams
        ON ams.aircraft_id = af.id

      WHERE af.id = $1
        AND af.airline_id = $2

      LIMIT 1

      FOR UPDATE OF af
      `,
      [aircraftId, airlineId]
    );

    if (!aircraftResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "AIRCRAFT_NOT_FOUND_OR_NOT_OWNED"
      });
    }

    const aircraft = aircraftResult.rows[0];

    /*
      ACS ON SALE AUTHORITY

      The existing manual C/D flow remains available to the
      seller while the aircraft is ON SALE.

      Every other active commercial listing remains blocked.
    */

    const commercialListingResult =
      await client.query(
        `
        SELECT
          id,
          aircraft_id,
          seller_airline_id,
          listing_type,
          status
        FROM public.aircraft_market_listings
        WHERE aircraft_id = $1
          AND status IN (
            'ACTIVE',
            'OFFER_RECEIVED',
            'SALE_PENDING'
          )
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
        `,
        [aircraftId]
      );

    const commercialListing =
      commercialListingResult.rows[0] || null;

    const isManualOnSaleCD =
      startSource === "MANUAL" &&
      commercialListing !== null &&
      String(
        commercialListing.listing_type || ""
      ).trim().toUpperCase() === "SALE" &&
      Number(
        commercialListing.seller_airline_id
      ) === airlineId &&
      String(
        aircraft.status || ""
      ).trim().toUpperCase() === "FOR_SALE" &&
      String(
        aircraft.operational_status || ""
      ).trim().toUpperCase() === "UNAVAILABLE" &&
      String(
        aircraft.ownership_type || ""
      ).trim().toUpperCase() === "OWNED";

    if (
      commercialListing &&
      !isManualOnSaleCD
    ) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "AIRCRAFT_COMMERCIAL_HOLD",
        message:
          "Maintenance cannot be started for this commercial aircraft state.",
        listing: commercialListing
      });
    }
  
    const aircraftStatus = String(aircraft.status || "").toUpperCase();
    const operationalStatus = String(aircraft.operational_status || "").toUpperCase();

    if (
      aircraftStatus === "MAINTENANCE" ||
      aircraftStatus === "IN_MAINTENANCE" ||
      operationalStatus === "IN_MAINTENANCE"
    ) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "AIRCRAFT_ALREADY_IN_MAINTENANCE"
      });
    }

    const activeEventResult = await client.query(
      `
      SELECT
        id,
        check_type,
        event_status,
        started_at,
        expected_completion_at
      FROM aircraft_maintenance_events
      WHERE aircraft_id = $1
        AND event_status = 'IN_PROGRESS'
      LIMIT 1
      FOR UPDATE
      `,
      [aircraftId]
    );

    if (activeEventResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "MAINTENANCE_EVENT_ALREADY_IN_PROGRESS",
        event: activeEventResult.rows[0]
      });
    }

    const selectedCheckStatus =
      checkType === "C_CHECK"
        ? String(aircraft.c_check_status || "NOT_ESTABLISHED").toUpperCase()
        : String(aircraft.d_check_status || "NOT_ESTABLISHED").toUpperCase();

    if (selectedCheckStatus === "NOT_ESTABLISHED") {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "CHECK_NOT_ESTABLISHED",
        check_type: checkType
      });
    }

    const aircraftCategory = String(aircraft.aircraft_category || "").toUpperCase();
    const aircraftName = String(aircraft.aircraft_name || "").toUpperCase();
    const seats = Number(aircraft.seats || 0);

    let sizeClass = "LIGHT";

    if (
      aircraftCategory.includes("WIDEBODY") ||
      aircraftName.includes("747") ||
      aircraftName.includes("DC-10") ||
      aircraftName.includes("L-1011") ||
      aircraftName.includes("A300") ||
      aircraftName.includes("A310") ||
      seats >= 220
    ) {
      sizeClass = "HEAVY";
    } else if (
      aircraftCategory.includes("NARROWBODY") ||
      aircraftCategory.includes("REGIONAL") ||
      aircraftName.includes("707") ||
      aircraftName.includes("720") ||
      aircraftName.includes("727") ||
      aircraftName.includes("737") ||
      aircraftName.includes("DC-8") ||
      aircraftName.includes("DC-9") ||
      aircraftName.includes("CONSTELLATION") ||
      aircraftName.includes("DC-6") ||
      aircraftName.includes("DC-7") ||
      seats >= 80
    ) {
      sizeClass = "MEDIUM";
    }

    const policyResult = await client.query(
      `
      SELECT
        policy_code,
        aircraft_size_class,
        c_check_duration_days,
        d_check_duration_days,
        c_check_cost_rate,
        d_check_cost_rate,
        condition_factor_low,
        condition_factor_medium,
        condition_factor_good,
        usage_factor_high,
        usage_factor_medium,
        usage_factor_normal
      FROM aircraft_maintenance_policy
      WHERE is_active = TRUE
        AND aircraft_size_class = $1
        AND aircraft_category = 'ANY'
        AND era_start_year <= $2
        AND era_end_year >= $2
      ORDER BY era_start_year DESC
      LIMIT 1
      `,
      [sizeClass, Number(aircraft.sim_year || 1940)]
    );

    if (!policyResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "MAINTENANCE_POLICY_NOT_FOUND",
        size_class: sizeClass,
        sim_year: aircraft.sim_year
      });
    }

    const policy = policyResult.rows[0];

    const conditionPct = Number(aircraft.condition_pct || 80);
    const totalHours = Number(aircraft.total_hours || 0);
    const totalCycles = Number(aircraft.total_cycles || 0);

    const aircraftValue = Math.round(
      Number(
        aircraft.current_value ||
        aircraft.purchase_price ||
        aircraft.price_acs_usd ||
        0
      )
    );

    const currency = aircraft.currency || "USD";

    let conditionFactor = Number(policy.condition_factor_good || 1);

    if (conditionPct < 70) {
      conditionFactor = Number(policy.condition_factor_low || 1.25);
    } else if (conditionPct < 85) {
      conditionFactor = Number(policy.condition_factor_medium || 1.12);
    }

    let usageFactor = Number(policy.usage_factor_normal || 1);

    if (totalHours > 20000 || totalCycles > 12000) {
      usageFactor = Number(policy.usage_factor_high || 1.18);
    } else if (totalHours > 10000 || totalCycles > 6000) {
      usageFactor = Number(policy.usage_factor_medium || 1.10);
    }

    const durationDays =
      checkType === "D_CHECK"
        ? Number(policy.d_check_duration_days)
        : Number(policy.c_check_duration_days);

    const costRate =
      checkType === "D_CHECK"
        ? Number(policy.d_check_cost_rate)
        : Number(policy.c_check_cost_rate);

    const serviceCost = aircraftValue > 0
      ? Math.round(aircraftValue * costRate * conditionFactor * usageFactor)
      : 0;

    if (!serviceCost || serviceCost <= 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "INVALID_MAINTENANCE_COST",
        aircraft_value: aircraftValue,
        check_type: checkType
      });
    }

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 700000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airlineId]
    );

    const financeBeforeResult = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airlineId]
    );

    const financeBefore = financeBeforeResult.rows[0];
    const currentCapital = Math.round(Number(financeBefore?.capital || 0));

    if (currentCapital < serviceCost) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INSUFFICIENT_CAPITAL_FOR_MAINTENANCE",
        capital: currentCapital,
        required: serviceCost,
        check_type: checkType
      });
    }

    const financeLogResult = await client.query(
      `
      INSERT INTO finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp
      )
      VALUES (
        $1,
        'EXPENSE',
        $2,
        $3,
        (EXTRACT(EPOCH FROM acs_get_current_sim_time()) * 1000)::BIGINT
      )
      RETURNING id
      `,
      [
        airlineId,
        `AIRCRAFT ${checkType} — ${aircraft.registration || "UNREGISTERED"} ${aircraft.aircraft_name}`,
        serviceCost
      ]
    );

    const financeLogId = financeLogResult.rows[0].id;
     
const financeAfterResult = await client.query(
  `
  UPDATE company_finance
  SET
    capital = COALESCE(capital, 0) - $2,
    expenses = COALESCE(expenses, 0) + $2,
    profit = COALESCE(profit, 0) - $2,
    cost_maintenance = COALESCE(cost_maintenance, 0) + $2,
    updated_at = NOW()
  WHERE airline_id = $1
  RETURNING *
  `,
  [airlineId, serviceCost]
);

    const eventResult = await client.query(
      `
      INSERT INTO aircraft_maintenance_events (
        airline_id,
        aircraft_id,
        check_type,
        event_status,
        started_at,
        expected_completion_at,
        duration_days,
        estimated_cost,
        final_cost,
        currency,
        finance_charged,
        finance_log_id,
        notes,
        start_source,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'IN_PROGRESS',
        acs_get_current_sim_time(),
        acs_get_current_sim_time() + ($4::INTEGER * INTERVAL '1 day'),
        $4,
        $5,
        $5,
        $6,
        TRUE,
        $7,
        $8,
        $9,
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      )
      RETURNING *
      `,
      [
        airlineId,
        aircraftId,
        checkType,
        durationDays,
        serviceCost,
        currency,
        financeLogId,
        JSON.stringify({
          source:
          startSource === "AUTOMATIC"
          ? "ACS_AUTOMATIC_CD_MAINTENANCE_V1"
          : "ACS_SERVICE_CD_CONTROL_START_V1",

          start_source: startSource,
          policy_code: policy.policy_code,
          size_class: sizeClass,
          condition_pct: conditionPct,
          total_hours: totalHours,
          total_cycles: totalCycles,
          aircraft_value: aircraftValue,
          cost_rate: costRate,
          condition_factor: conditionFactor,
          usage_factor: usageFactor
        }),
        startSource
      ]
    );
     
  await client.query(
  `
  UPDATE public.aircraft_maintenance_status
  SET
    c_check_status = CASE
      WHEN $3 = 'C_CHECK'
        THEN 'IN_PROGRESS'
      ELSE c_check_status
    END,

    d_check_status = CASE
      WHEN $3 = 'D_CHECK'
        THEN 'IN_PROGRESS'
      ELSE d_check_status
    END,

    maintenance_control_status = 'IN_MAINTENANCE',

    maintenance_control_reason = CASE
      WHEN $3 = 'C_CHECK'
        THEN 'C_CHECK'
      WHEN $3 = 'D_CHECK'
        THEN 'D_CHECK'
      ELSE maintenance_control_reason
    END,

    updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

  WHERE aircraft_id = $1
    AND airline_id = $2
  `,
  [
    aircraftId,
    airlineId,
    checkType
  ]
);
     
        const updatedAircraftResult = await client.query(
      `
      UPDATE public.aircraft_fleet
      SET
        status = CASE
          WHEN $3::BOOLEAN = TRUE
            THEN 'FOR_SALE'
          ELSE 'MAINTENANCE'
        END,

        operational_status = CASE
          WHEN $3::BOOLEAN = TRUE
            THEN 'UNAVAILABLE'
          ELSE 'IN_MAINTENANCE'
        END,

        maintenance_status = 'CHECK_REQUIRED',
        updated_at =
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

      WHERE id = $1
        AND airline_id = $2

      RETURNING *
      `,
      [
        aircraftId,
        airlineId,
        isManualOnSaleCD
      ]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      endpoint: "ACS_START_MAINTENANCE_EVENT",
      version: "v1.0",
      message: "MAINTENANCE_EVENT_STARTED",
      check_type: checkType,
      aircraft: updatedAircraftResult.rows[0],
      event: eventResult.rows[0],
      finance: {
        before_capital: currentCapital,
        charged_amount: serviceCost,
        after: financeAfterResult.rows[0],
        finance_log_id: financeLogId
      },
      policy: {
        policy_code: policy.policy_code,
        size_class: sizeClass,
        duration_days: durationDays,
        cost_rate: costRate,
        condition_factor: conditionFactor,
        usage_factor: usageFactor
      }
    });

    } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    if (
      err?.message === "AIRCRAFT_COMMERCIAL_HOLD" ||
      (
        err?.code === "23514" &&
        String(
          err?.message || ""
        ).includes(
          "AIRCRAFT_COMMERCIAL_HOLD"
        )
      )
    ) {
      return res.status(409).json({
        ok: false,

        error:
          "AIRCRAFT_COMMERCIAL_HOLD",

        message:
          "Maintenance cannot be started while the aircraft is ON SALE or ON LEASE."
      });
    }

    console.error(
      "ACS START MAINTENANCE ERROR:",
      err
    );

    return res.status(500).json({
      ok: false,

      error:
        "START_MAINTENANCE_FAILED",

      details:
        err?.message ||
        "Maintenance could not be started."
    });

  } finally {
    client.release();
  }
}

router.post(
  "/aircraft/fleet/:id/maintenance/start",
  requireAuth,
  ACS_startCDMaintenance
);

async function ACS_startAutomaticCDMaintenance({
  airlineId,
  aircraftId,
  checkType
}) {
  let statusCode = 200;
  let payload = null;

  const response = {
    status(code) {
      statusCode = Number(code) || 500;
      return this;
    },

    json(body) {
      payload = body;
      return body;
    }
  };

  await ACS_startCDMaintenance(
    {
      airline_id: airlineId,
      params: {
        id: String(aircraftId)
      },
      body: {
        check_type: checkType
      },
      acs_start_source: "AUTOMATIC"
    },
    response
  );

  return {
    ok:
      statusCode >= 200 &&
      statusCode < 300 &&
      payload?.ok === true,

    status: statusCode,
    ...payload
  };
}

/* ============================================================
   🟦 ACS MAINTENANCE RESOLVER — C/D AUTHORITY v1.2
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/maintenance/resolver

   Scope:
   - Complete expired C_CHECK and D_CHECK events only
   - Resolve C/D overdue authority only
   - Preserve Schedule as the only A/B lifecycle authority
   - Preserve D > C > B > A operational hierarchy
   - Use authenticated airline isolation
   - Use ACS simulated time only
   - No localStorage
   - No browser clock
   - No Date.now()

   Important:
   - C completion resets C + B + A technical cycles.
   - D completion resets D + C + B + A technical cycles.
   - This resolver never completes A/B events.
   - This resolver never calculates A/B overdue states.
   ============================================================ */

export async function ACS_runCDMaintenanceResolverForAirline(
  airlineId
) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    if (
      !airlineId ||
      !Number.isInteger(airlineId)
    ) {
      const error = new Error(
        "INVALID_AIRLINE_ID"
      );

      error.code = "INVALID_AIRLINE_ID";

      throw error;
    }
     
    await client.query("BEGIN");
    transactionStarted = true;

    /* ============================================================
       1. COMPLETE FINISHED C/D MAINTENANCE EVENTS ONLY
       ------------------------------------------------------------
       D resets D + C + B + A
       C resets C + B + A
       ============================================================ */

    const eventsResult = await client.query(
      `
      SELECT
        ame.id,
        ame.airline_id,
        ame.aircraft_id,
        ame.check_type,
        ame.event_status,
        ame.started_at,
        ame.expected_completion_at,
        ame.scheduled_start_at,
        ame.scheduled_end_at,
        ame.duration_days,
        ame.duration_minutes,
        ame.final_cost,
        ame.currency,

        af.registration,
        af.aircraft_name,
        af.status,
        af.operational_status,

        acs_get_current_sim_time() AS current_sim_time

      FROM public.aircraft_maintenance_events ame

      JOIN public.aircraft_fleet af
        ON af.id = ame.aircraft_id
       AND af.airline_id = ame.airline_id

      WHERE ame.airline_id = $1
        AND ame.event_status = 'IN_PROGRESS'
        AND ame.check_type IN ('C_CHECK', 'D_CHECK')
        AND COALESCE(
              ame.scheduled_end_at,
              ame.expected_completion_at
            ) <= acs_get_current_sim_time()

      ORDER BY
        COALESCE(
          ame.scheduled_end_at,
          ame.expected_completion_at
        ) ASC

      FOR UPDATE OF ame, af
      `,
      [airlineId]
    );

    const completedEvents = [];

    for (const event of eventsResult.rows) {
      const checkType = String(event.check_type || "")
        .trim()
        .toUpperCase();

      const aircraftId = Number(event.aircraft_id);
      const completionTime = event.current_sim_time;

      const completedEventResult = await client.query(
        `
        UPDATE public.aircraft_maintenance_events
        SET
          event_status = 'COMPLETED',
          completed_at = $2,
          updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        WHERE id = $1
          AND airline_id = $3
          AND check_type IN ('C_CHECK', 'D_CHECK')
          AND event_status = 'IN_PROGRESS'
        RETURNING id
        `,
        [
          event.id,
          completionTime,
          airlineId
        ]
      );

      if (!completedEventResult.rows.length) {
        continue;
      }

      if (checkType === "D_CHECK") {
        await client.query(
          `
          UPDATE public.aircraft_maintenance_status
          SET
            a_check_due_date = $2::TIMESTAMP + INTERVAL '7 days',
            a_check_status = 'OPEN',

            b_check_due_date = $2::TIMESTAMP + INTERVAL '30 days',
            b_check_status = 'OPEN',

            c_check_due_date = $2::TIMESTAMP + INTERVAL '12 months',
            c_check_status = 'OPEN',

            d_check_due_date = $2::TIMESTAMP + INTERVAL '8 years',
            d_check_status = 'OPEN',

            maintenance_control_status = 'SERVICEABLE',
            maintenance_control_reason = NULL,

            updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

          WHERE aircraft_id = $1
            AND airline_id = $3
          `,
          [
            aircraftId,
            completionTime,
            airlineId
          ]
        );
      }

      if (checkType === "C_CHECK") {
        await client.query(
          `
          UPDATE public.aircraft_maintenance_status
          SET
            a_check_due_date = $2::TIMESTAMP + INTERVAL '7 days',
            a_check_status = 'OPEN',

            b_check_due_date = $2::TIMESTAMP + INTERVAL '30 days',
            b_check_status = 'OPEN',

            c_check_due_date = $2::TIMESTAMP + INTERVAL '12 months',
            c_check_status = 'OPEN',

            maintenance_control_status = 'SERVICEABLE',
            maintenance_control_reason = NULL,

            updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

          WHERE aircraft_id = $1
            AND airline_id = $3
          `,
          [
            aircraftId,
            completionTime,
            airlineId
          ]
        );
      }

      /*
       * C/D completion may release the aircraft only when no other
       * maintenance event remains IN_PROGRESS.
       * A/B lifecycle remains owned by routes/schedule.js.
       */
      const remainingActiveResult = await client.query(
        `
        SELECT
          check_type
        FROM public.aircraft_maintenance_events
        WHERE airline_id = $1
          AND aircraft_id = $2
          AND event_status = 'IN_PROGRESS'
        ORDER BY
          CASE check_type
            WHEN 'D_CHECK' THEN 1
            WHEN 'C_CHECK' THEN 2
            WHEN 'B_CHECK' THEN 3
            WHEN 'A_CHECK' THEN 4
            ELSE 5
          END,
          id
        LIMIT 1
        `,
        [airlineId, aircraftId]
      );

            if (!remainingActiveResult.rows.length) {
        await client.query(
          `
          UPDATE public.aircraft_fleet af
          SET
            status = CASE
              WHEN EXISTS (
                SELECT 1
                FROM public.aircraft_market_listings aml
                WHERE aml.aircraft_id = af.id
                  AND aml.seller_airline_id = af.airline_id
                  AND aml.listing_type = 'SALE'
                  AND aml.status IN (
                    'ACTIVE',
                    'OFFER_RECEIVED',
                    'SALE_PENDING'
                  )
              )
                THEN 'FOR_SALE'
              ELSE 'ACTIVE'
            END,

            operational_status = CASE
              WHEN EXISTS (
                SELECT 1
                FROM public.aircraft_market_listings aml
                WHERE aml.aircraft_id = af.id
                  AND aml.seller_airline_id = af.airline_id
                  AND aml.listing_type = 'SALE'
                  AND aml.status IN (
                    'ACTIVE',
                    'OFFER_RECEIVED',
                    'SALE_PENDING'
                  )
              )
                THEN 'UNAVAILABLE'
              ELSE 'AVAILABLE'
            END,

            maintenance_status = 'SERVICEABLE',

            condition_pct = CASE
              WHEN $3 = 'D_CHECK'
                THEN 100
              WHEN $3 = 'C_CHECK'
                THEN GREATEST(condition_pct, 95)
              ELSE condition_pct
            END,

            updated_at =
              (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

          WHERE af.id = $1
            AND af.airline_id = $2
          `,
          [
            aircraftId,
            airlineId,
            checkType
          ]
        );
      }
       
      completedEvents.push({
        event_id: event.id,
        aircraft_id: aircraftId,
        registration: event.registration,
        aircraft_name: event.aircraft_name,
        check_type: checkType,
        completed_at: completionTime
      });
    }

    /* ============================================================
       2. RESOLVE C/D AUTHORITY ONLY
       ------------------------------------------------------------
       - D has priority over C.
       - A/B statuses are preserved exactly as written by Schedule.
       - A/B events may still be read to preserve the final hierarchy.
       ============================================================ */

    const cdStatusResult = await client.query(
      `
      WITH active_events AS (
        SELECT
          ame.aircraft_id,

          BOOL_OR(
            ame.event_status = 'IN_PROGRESS'
            AND ame.check_type = 'D_CHECK'
          ) AS d_in_progress,

          BOOL_OR(
            ame.event_status = 'IN_PROGRESS'
            AND ame.check_type = 'C_CHECK'
          ) AS c_in_progress,

          BOOL_OR(
            ame.event_status = 'IN_PROGRESS'
            AND ame.check_type = 'B_CHECK'
          ) AS b_in_progress,

          BOOL_OR(
            ame.event_status = 'IN_PROGRESS'
            AND ame.check_type = 'A_CHECK'
          ) AS a_in_progress

        FROM public.aircraft_maintenance_events ame

        WHERE ame.airline_id = $1
          AND ame.event_status = 'IN_PROGRESS'

        GROUP BY ame.aircraft_id
      ),

      cd_state AS (
        SELECT
          ams.aircraft_id,
          ams.airline_id,

          COALESCE(ae.d_in_progress, FALSE) AS d_in_progress,
          COALESCE(ae.c_in_progress, FALSE) AS c_in_progress,
          COALESCE(ae.b_in_progress, FALSE) AS b_in_progress,
          COALESCE(ae.a_in_progress, FALSE) AS a_in_progress,

     CASE
  WHEN COALESCE(ae.d_in_progress, FALSE)
    THEN FALSE

  WHEN ams.d_check_due_date IS NOT NULL
   AND ams.d_check_due_date <= acs_get_current_sim_time()

   AND acs_get_current_sim_time() >= GREATEST(
     ams.d_check_due_date,

     COALESCE(
       (
         SELECT MAX(day_rotation.rotation_end_at)

         FROM (
           SELECT
             COALESCE(
               return_leg.scheduled_arrival_at,
               outbound.scheduled_arrival_at
             ) AS rotation_end_at

           FROM public.flight_occurrences outbound

           LEFT JOIN LATERAL (
             SELECT
               return_occurrence.scheduled_arrival_at

             FROM public.flight_occurrences
               AS return_occurrence

             WHERE return_occurrence.airline_id =
                     outbound.airline_id
               AND return_occurrence.aircraft_id =
                     outbound.aircraft_id
               AND return_occurrence.schedule_item_id =
                     outbound.schedule_item_id
               AND return_occurrence.flight_direction =
                     'RETURN'
               AND return_occurrence.scheduled_departure_at >=
                     outbound.scheduled_arrival_at
               AND return_occurrence.scheduled_departure_at <
                     outbound.scheduled_departure_at
                     + INTERVAL '2 days'
               AND return_occurrence.operational_status <>
                     'CANCELLED'

             ORDER BY
               return_occurrence.scheduled_departure_at

             LIMIT 1
           ) return_leg ON TRUE

           WHERE outbound.airline_id = ams.airline_id
             AND outbound.aircraft_id = ams.aircraft_id
             AND outbound.flight_direction = 'OUTBOUND'
             AND outbound.operational_status <> 'CANCELLED'
             AND outbound.scheduled_departure_at >=
                   date_trunc(
                     'day',
                     ams.d_check_due_date
                   )
             AND outbound.scheduled_departure_at <
                   date_trunc(
                     'day',
                     ams.d_check_due_date
                   ) + INTERVAL '1 day'
         ) day_rotation
       ),
       ams.d_check_due_date
     )
   )
    THEN TRUE

  ELSE FALSE
END AS d_overdue,

CASE
  WHEN COALESCE(ae.d_in_progress, FALSE)
    THEN FALSE

  WHEN COALESCE(ae.c_in_progress, FALSE)
    THEN FALSE

  WHEN ams.c_check_due_date IS NOT NULL
   AND ams.c_check_due_date <= acs_get_current_sim_time()

   AND acs_get_current_sim_time() >= GREATEST(
     ams.c_check_due_date,

     COALESCE(
       (
         SELECT MAX(day_rotation.rotation_end_at)

         FROM (
           SELECT
             COALESCE(
               return_leg.scheduled_arrival_at,
               outbound.scheduled_arrival_at
             ) AS rotation_end_at

           FROM public.flight_occurrences outbound

           LEFT JOIN LATERAL (
             SELECT
               return_occurrence.scheduled_arrival_at

             FROM public.flight_occurrences
               AS return_occurrence

             WHERE return_occurrence.airline_id =
                     outbound.airline_id
               AND return_occurrence.aircraft_id =
                     outbound.aircraft_id
               AND return_occurrence.schedule_item_id =
                     outbound.schedule_item_id
               AND return_occurrence.flight_direction =
                     'RETURN'
               AND return_occurrence.scheduled_departure_at >=
                     outbound.scheduled_arrival_at
               AND return_occurrence.scheduled_departure_at <
                     outbound.scheduled_departure_at
                     + INTERVAL '2 days'
               AND return_occurrence.operational_status <>
                     'CANCELLED'

             ORDER BY
               return_occurrence.scheduled_departure_at

             LIMIT 1
           ) return_leg ON TRUE

           WHERE outbound.airline_id = ams.airline_id
             AND outbound.aircraft_id = ams.aircraft_id
             AND outbound.flight_direction = 'OUTBOUND'
             AND outbound.operational_status <> 'CANCELLED'
             AND outbound.scheduled_departure_at >=
                   date_trunc(
                     'day',
                     ams.c_check_due_date
                   )
             AND outbound.scheduled_departure_at <
                   date_trunc(
                     'day',
                     ams.c_check_due_date
                   ) + INTERVAL '1 day'
         ) day_rotation
       ),
       ams.c_check_due_date
     )
   )
    THEN TRUE

  ELSE FALSE
END AS c_overdue

        FROM public.aircraft_maintenance_status ams

        LEFT JOIN active_events ae
          ON ae.aircraft_id = ams.aircraft_id

             WHERE ams.airline_id = $1
          AND (
            COALESCE(
              ae.d_in_progress,
              FALSE
            )
            OR COALESCE(
              ae.c_in_progress,
              FALSE
            )
            OR (
              ams.d_check_due_date IS NOT NULL
              AND ams.d_check_due_date
                  <= acs_get_current_sim_time()
            )
            OR (
              ams.c_check_due_date IS NOT NULL
              AND ams.c_check_due_date
                  <= acs_get_current_sim_time()
            )
            OR UPPER(
              COALESCE(
                ams.d_check_status,
                ''
              )
            ) IN (
              'OVERDUE',
              'IN_PROGRESS'
            )
            OR UPPER(
              COALESCE(
                ams.c_check_status,
                ''
              )
            ) IN (
              'OVERDUE',
              'IN_PROGRESS'
            )
          )
      )

      UPDATE public.aircraft_maintenance_status ams

      SET
        d_check_status = CASE
          WHEN state.d_in_progress THEN 'IN_PROGRESS'
          WHEN state.d_overdue THEN 'OVERDUE'
          WHEN UPPER(COALESCE(ams.d_check_status, '')) IN (
            'OVERDUE',
            'IN_PROGRESS'
          )
            THEN 'OPEN'
          ELSE ams.d_check_status
        END,

        c_check_status = CASE
          WHEN state.d_in_progress THEN ams.c_check_status
          WHEN state.c_in_progress THEN 'IN_PROGRESS'
          WHEN state.c_overdue THEN 'OVERDUE'
          WHEN UPPER(COALESCE(ams.c_check_status, '')) IN (
            'OVERDUE',
            'IN_PROGRESS'
          )
            THEN 'OPEN'
          ELSE ams.c_check_status
        END,

        maintenance_control_status = CASE
          WHEN state.d_in_progress
            OR state.c_in_progress
            THEN 'IN_MAINTENANCE'

          WHEN state.d_overdue
            OR state.c_overdue
            THEN 'MAINTENANCE_REQUIRED'

          WHEN state.b_in_progress
            OR state.a_in_progress
            THEN 'IN_MAINTENANCE'

          ELSE ams.maintenance_control_status
        END,

        maintenance_control_reason = CASE
          WHEN state.d_in_progress THEN 'D_CHECK'
          WHEN state.c_in_progress THEN 'C_CHECK'
          WHEN state.d_overdue THEN 'D_CHECK_OVERDUE'
          WHEN state.c_overdue THEN 'C_CHECK_OVERDUE'

          WHEN state.b_in_progress THEN 'B_CHECK'
          WHEN state.a_in_progress THEN 'A_CHECK'

          ELSE ams.maintenance_control_reason
        END,

        updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

      FROM cd_state state

            WHERE ams.aircraft_id = state.aircraft_id
        AND ams.airline_id = state.airline_id
        AND ROW(
          ams.d_check_status,
          ams.c_check_status,
          ams.maintenance_control_status,
          ams.maintenance_control_reason
        ) IS DISTINCT FROM ROW(
          CASE
            WHEN state.d_in_progress
              THEN 'IN_PROGRESS'
            WHEN state.d_overdue
              THEN 'OVERDUE'
            WHEN UPPER(
              COALESCE(
                ams.d_check_status,
                ''
              )
            ) IN (
              'OVERDUE',
              'IN_PROGRESS'
            )
              THEN 'OPEN'
            ELSE ams.d_check_status
          END,
          CASE
            WHEN state.d_in_progress
              THEN ams.c_check_status
            WHEN state.c_in_progress
              THEN 'IN_PROGRESS'
            WHEN state.c_overdue
              THEN 'OVERDUE'
            WHEN UPPER(
              COALESCE(
                ams.c_check_status,
                ''
              )
            ) IN (
              'OVERDUE',
              'IN_PROGRESS'
            )
              THEN 'OPEN'
            ELSE ams.c_check_status
          END,
          CASE
            WHEN state.d_in_progress
              OR state.c_in_progress
              THEN 'IN_MAINTENANCE'
            WHEN state.d_overdue
              OR state.c_overdue
              THEN 'MAINTENANCE_REQUIRED'
            WHEN state.b_in_progress
              OR state.a_in_progress
              THEN 'IN_MAINTENANCE'
            ELSE
              ams.maintenance_control_status
          END,
          CASE
            WHEN state.d_in_progress
              THEN 'D_CHECK'
            WHEN state.c_in_progress
              THEN 'C_CHECK'
            WHEN state.d_overdue
              THEN 'D_CHECK_OVERDUE'
            WHEN state.c_overdue
              THEN 'C_CHECK_OVERDUE'
            WHEN state.b_in_progress
              THEN 'B_CHECK'
            WHEN state.a_in_progress
              THEN 'A_CHECK'
            ELSE
              ams.maintenance_control_reason
          END
        )

      RETURNING
        ams.aircraft_id,
        ams.airline_id,
        ams.registration,
        ams.aircraft_name,

        ams.a_check_status,
        ams.b_check_status,
        ams.c_check_status,
        ams.c_check_due_date,
        ams.d_check_status,
        ams.d_check_due_date,

        ams.maintenance_control_status,
        ams.maintenance_control_reason
      `,
      [airlineId]
    );
     
    /* ============================================================
       3. SYNCHRONIZE FLEET FROM FINAL AUTHORITY
       ------------------------------------------------------------
       This endpoint does not invent or recalculate A/B status.
       It only publishes the already-resolved dominant authority.
       ============================================================ */

    const fleetSyncResult = await client.query(
      `
      UPDATE public.aircraft_fleet af

           SET
        status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM public.aircraft_market_listings aml
            WHERE aml.aircraft_id = af.id
              AND aml.seller_airline_id = af.airline_id
              AND aml.listing_type = 'SALE'
              AND aml.status IN (
                'ACTIVE',
                'OFFER_RECEIVED',
                'SALE_PENDING'
              )
          )
            THEN 'FOR_SALE'

          WHEN ams.maintenance_control_status =
            'IN_MAINTENANCE'
            THEN 'MAINTENANCE'

          ELSE af.status
        END,

        operational_status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM public.aircraft_market_listings aml
            WHERE aml.aircraft_id = af.id
              AND aml.seller_airline_id = af.airline_id
              AND aml.listing_type = 'SALE'
              AND aml.status IN (
                'ACTIVE',
                'OFFER_RECEIVED',
                'SALE_PENDING'
              )
          )
            THEN 'UNAVAILABLE'

          WHEN ams.maintenance_control_status =
            'IN_MAINTENANCE'
            THEN 'IN_MAINTENANCE'

          WHEN ams.maintenance_control_status =
            'MAINTENANCE_REQUIRED'
            THEN 'UNAVAILABLE'

          WHEN ams.maintenance_control_status =
            'SERVICEABLE'
            THEN 'AVAILABLE'

          ELSE af.operational_status
        END,

        maintenance_status = CASE
          WHEN ams.maintenance_control_status IN (
            'MAINTENANCE_REQUIRED',
            'IN_MAINTENANCE'
          )
            THEN 'CHECK_REQUIRED'

          WHEN ams.maintenance_control_status =
            'SERVICEABLE'
            THEN 'SERVICEABLE'

          ELSE af.maintenance_status
        END,


        updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')

      FROM public.aircraft_maintenance_status ams

      WHERE af.id = ams.aircraft_id
        AND af.airline_id = $1
        AND ams.airline_id = $1

      RETURNING
        af.id AS aircraft_id,
        af.airline_id,
        af.registration,
        af.aircraft_name,
        af.status,
        af.operational_status,
        af.maintenance_status
      `,
      [airlineId]
    );

        await client.query("COMMIT");
        transactionStarted = false;

        const completedMaintenanceOccAlerts = [];

       for (const completedEvent of completedEvents) {
       const alert = await ACS_createMaintenanceOccAlert(pool, {
        airlineId,
        eventId: completedEvent.event_id,
        registration: completedEvent.registration,
        checkType: completedEvent.check_type,
        action: "COMPLETED",
        eventSimTime: completedEvent.completed_at
      });

      if (alert) {
        completedMaintenanceOccAlerts.push(alert);
      }
    }

       const aircraftAutomationSettings =
  await ACS_getAircraftAutomationSettings(pool, airlineId);

const automaticCandidatesResult = await pool.query(
  `
  SELECT
    ams.aircraft_id,
    ams.registration,
    ams.aircraft_name,

    CASE
      WHEN UPPER(COALESCE(ams.d_check_status, '')) = 'OVERDUE'
        AND $2::BOOLEAN = TRUE
        THEN 'D_CHECK'

      WHEN UPPER(COALESCE(ams.d_check_status, '')) <> 'OVERDUE'
        AND UPPER(COALESCE(ams.c_check_status, '')) = 'OVERDUE'
        AND $3::BOOLEAN = TRUE
        THEN 'C_CHECK'

      ELSE NULL
    END AS check_type

  FROM public.aircraft_maintenance_status ams

  WHERE ams.airline_id = $1

    AND NOT EXISTS (
      SELECT 1
      FROM public.aircraft_maintenance_events ame
      WHERE ame.airline_id = ams.airline_id
        AND ame.aircraft_id = ams.aircraft_id
        AND ame.event_status = 'IN_PROGRESS'
    )

    AND (
      (
        UPPER(COALESCE(ams.d_check_status, '')) = 'OVERDUE'
        AND $2::BOOLEAN = TRUE
      )
      OR (
        UPPER(COALESCE(ams.d_check_status, '')) <> 'OVERDUE'
        AND UPPER(COALESCE(ams.c_check_status, '')) = 'OVERDUE'
        AND $3::BOOLEAN = TRUE
      )
    )

  ORDER BY ams.aircraft_id
  `,
  [
    airlineId,
    aircraftAutomationSettings.autoDcheck === true,
    aircraftAutomationSettings.autoCcheck === true
  ]
);

for (const candidate of automaticCandidatesResult.rows) {
  const automaticResult =
    await ACS_startAutomaticCDMaintenance({
      airlineId,
      aircraftId: Number(candidate.aircraft_id),
      checkType: candidate.check_type
    });

  if (automaticResult.ok === true) {
    await ACS_createMaintenanceOccAlert(pool, {
      airlineId,
      eventId: automaticResult.event.id,
      registration:
        candidate.registration ||
        candidate.aircraft_name ||
        "AIRCRAFT",
      checkType: candidate.check_type,
      action: "STARTED",
      eventSimTime: automaticResult.event.started_at
    });
  }
}

const currentSimTime =
  await ACS_getCurrentSimTimeForOcc(pool);

    const overdueMaintenanceOccAlerts = [];

    for (const row of cdStatusResult.rows) {
      const rowAircraftId = Number(row.aircraft_id);
      const registration = row.registration || row.aircraft_name || "AIRCRAFT";

      if (
        String(row.d_check_status || "").toUpperCase() === "OVERDUE" &&
        aircraftAutomationSettings.autoDcheck !== true
      ) {
        const alert = await ACS_createMaintenanceOverdueOccAlert(pool, {
          airlineId,
          aircraftId: rowAircraftId,
          registration,
          checkType: "D_CHECK",
          dueSimTime: row.d_check_due_date,
          currentSimTime
        });

        if (alert) {
          overdueMaintenanceOccAlerts.push(alert);
        }
      }

      if (
        String(row.c_check_status || "").toUpperCase() === "OVERDUE" &&
        aircraftAutomationSettings.autoCcheck !== true
      ) {
        const alert = await ACS_createMaintenanceOverdueOccAlert(pool, {
          airlineId,
          aircraftId: rowAircraftId,
          registration,
          checkType: "C_CHECK",
          dueSimTime: row.c_check_due_date,
          currentSimTime
        });

        if (alert) {
          overdueMaintenanceOccAlerts.push(alert);
        }
      }
    }
   
      return {
      ok: true,
      endpoint: "ACS_CD_MAINTENANCE_RESOLVER",
      version: "v1.2",

      authority: {
        time: "acs_get_current_sim_time",
        c_d: "routes/aircraft.js",
        a_b: "routes/schedule.js",
        maintenance_status: "aircraft_maintenance_status",
        maintenance_events: "aircraft_maintenance_events",
        fleet: "aircraft_fleet"
      },

      airline_id: airlineId,

      cd_sync_count: cdStatusResult.rows.length,
      cd_sync: cdStatusResult.rows,

      fleet_sync_count: fleetSyncResult.rows.length,
      fleet_sync: fleetSyncResult.rows,

      completed_count: completedEvents.length,
      completed_events: completedEvents,
      occ_completed_alerts: completedMaintenanceOccAlerts,
      occ_overdue_alerts: overdueMaintenanceOccAlerts
    };

  } catch (err) {
    if (transactionStarted) {
      try {
         
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "ACS C/D MAINTENANCE RESOLVER ROLLBACK ERROR:",
          rollbackError
        );
      }
    }

    console.error("ACS C/D MAINTENANCE RESOLVER ERROR:", err);

    throw err;

    } finally {
    client.release();
  }
}

router.post(
  "/aircraft/maintenance/resolver",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);

    if (
      !airlineId ||
      !Number.isInteger(airlineId)
    ) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    try {
      const result =
        await ACS_runCDMaintenanceResolverForAirline(
          airlineId
        );

      return res.json(result);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error:
          "CD_MAINTENANCE_RESOLVER_FAILED",
        details: err.message
      });
    }
  }
);

export async function ACS_runCDMaintenanceResolver({
  allAirlines = false,
  airlineId = null
} = {}) {
  if (!allAirlines) {
    const scopedAirlineId =
      Number(airlineId);

    if (
      !Number.isInteger(scopedAirlineId) ||
      scopedAirlineId <= 0
    ) {
      const error = new Error(
        "CD_MAINTENANCE_RESOLVER_SCOPE_REQUIRED"
      );

      error.code =
        "CD_MAINTENANCE_RESOLVER_SCOPE_REQUIRED";

      throw error;
    }

    return ACS_runCDMaintenanceResolverForAirline(
      scopedAirlineId
    );
  }

  const airlinesResult = await pool.query(
    `
    WITH candidate_airlines AS (
      SELECT ams.airline_id
      FROM public.aircraft_maintenance_status ams
      WHERE ams.airline_id IS NOT NULL
        AND (
          (
            ams.d_check_due_date IS NOT NULL
            AND ams.d_check_due_date
                <= acs_get_current_sim_time()
          )
          OR (
            ams.c_check_due_date IS NOT NULL
            AND ams.c_check_due_date
                <= acs_get_current_sim_time()
          )
          OR UPPER(
            COALESCE(
              ams.d_check_status,
              ''
            )
          ) IN (
            'OVERDUE',
            'IN_PROGRESS'
          )
          OR UPPER(
            COALESCE(
              ams.c_check_status,
              ''
            )
          ) IN (
            'OVERDUE',
            'IN_PROGRESS'
          )
        )

      UNION

      SELECT ame.airline_id
      FROM public.aircraft_maintenance_events ame
      WHERE ame.airline_id IS NOT NULL
        AND ame.event_status = 'IN_PROGRESS'
        AND ame.check_type IN (
          'C_CHECK',
          'D_CHECK'
        )
    )
    SELECT DISTINCT airline_id
    FROM candidate_airlines
    ORDER BY airline_id
    `
  );

  const errors = [];

  let completedCount = 0;
  let cdSyncCount = 0;
  let fleetSyncCount = 0;

  for (const row of airlinesResult.rows) {
    const currentAirlineId =
      Number(row.airline_id);

    if (
      !Number.isInteger(currentAirlineId) ||
      currentAirlineId <= 0
    ) {
      continue;
    }

    try {
      const result =
        await ACS_runCDMaintenanceResolverForAirline(
          currentAirlineId
        );

      completedCount += Number(
        result?.completed_count || 0
      );

      cdSyncCount += Number(
        result?.cd_sync_count || 0
      );

      fleetSyncCount += Number(
        result?.fleet_sync_count || 0
      );
    } catch (error) {
      errors.push({
        airline_id: currentAirlineId,
        error:
          error?.code ||
          error?.message ||
          "CD_RESOLVER_FAILED"
      });
    }
  }

  return {
    ok: errors.length === 0,
    endpoint:
      "ACS_GLOBAL_CD_MAINTENANCE_RESOLVER",
    all_airlines: true,
    airline_count:
      airlinesResult.rows.length,
    completed_count: completedCount,
    cd_sync_count: cdSyncCount,
    fleet_sync_count: fleetSyncCount,
    error_count: errors.length,
    errors
  };
}

/* ============================================================
   🟦 ACS-RA-BE2 — AUTO ASSIGN AIRCRAFT REGISTRATION
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/fleet/:id/registration/auto-assign

   Purpose:
   - Assign or correct aircraft registration from backend authority
   - Uses aircraft base_icao/current_airport to resolve country rule
   - Prevents duplicated registrations globally
   - Allows replacing old previous_registration like N434RT when
     airline base requires YV-, EC-, HK-, etc.
   ============================================================ */

router.post("/aircraft/fleet/:id/registration/auto-assign", requireAuth, async (req, res) => {
   
  const client = await pool.connect();

  try {
    const airlineId = Number(req.airline_id);
    const aircraftId = Number(req.params.id);

    if (!airlineId || !Number.isInteger(airlineId)) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!aircraftId || !Number.isInteger(aircraftId)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AIRCRAFT_ID"
      });
    }

    await client.query("BEGIN");

    const aircraftResult = await client.query(
      `
      SELECT
        *
      FROM public.aircraft_fleet
      WHERE id = $1
        AND airline_id = $2
      FOR UPDATE
      `,
      [aircraftId, airlineId]
    );

    if (!aircraftResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "AIRCRAFT_NOT_FOUND_OR_NOT_OWNED"
      });
    }

        const aircraft = aircraftResult.rows[0];

    const aircraftStatus =
      String(aircraft.status || "")
        .trim()
        .toUpperCase();

    const registrationBlockedStatuses =
      new Set([
        "FOR_SALE",
        "FOR_LEASE",
        "SOLD",
        "RETIRED"
      ]);

    if (
      registrationBlockedStatuses.has(
        aircraftStatus
      )
    ) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error:
          "REGISTRATION_BLOCKED_BY_AIRCRAFT_STATUS",
        aircraft_id: aircraft.id,
        aircraft_status: aircraftStatus,
        registration: null
      });
    }

      const baseIcao =
      aircraft.base_icao ||
      aircraft.current_airport ||
      null;

    if (!baseIcao) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "AIRCRAFT_BASE_ICAO_REQUIRED",
        message: "Aircraft must have base_icao or current_airport before registration assignment."
      });
    }

    const rule = await ACS_RA_resolveRegistrationRule(client, baseIcao);

    const currentRegistration = String(aircraft.registration || "").trim();

    const forceReassign =
      req.body?.force === true ||
      req.body?.force_reassign === true;

    const alreadyValid =
      ACS_RA_registrationMatchesRule(currentRegistration, rule);

    if (currentRegistration && alreadyValid && !forceReassign) {
      await client.query("COMMIT");

      return res.json({
        ok: true,
        endpoint: "ACS_RA_AUTO_ASSIGN_REGISTRATION",
        version: "v1.0",
        action: "REGISTRATION_ALREADY_VALID",
        registration: currentRegistration,
        rule,
        aircraft
      });
    }

    const newRegistration = await ACS_RA_generateUniqueRegistration(client, rule);

    const updatedResult = await client.query(
      `
      UPDATE public.aircraft_fleet
      SET
        registration = $3,
        updated_at = NOW()
      WHERE id = $1
        AND airline_id = $2
      RETURNING *
      `,
      [
        aircraftId,
        airlineId,
        newRegistration
      ]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      endpoint: "ACS_RA_AUTO_ASSIGN_REGISTRATION",
      version: "v1.0",
      action: currentRegistration
        ? "REGISTRATION_REASSIGNED"
        : "REGISTRATION_ASSIGNED",
      previous_registration: currentRegistration || null,
      registration: newRegistration,
      rule: {
        country_name: rule.country_name,
        country_iso2: rule.country_iso2,
        icao_prefix: rule.icao_prefix,
        registration_prefix: rule.registration_prefix,
        registration_format: rule.registration_format,
        registration_length: rule.registration_length,
        sample_registration: rule.sample_registration
      },
      aircraft: updatedResult.rows[0]
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS RA AUTO ASSIGN REGISTRATION ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "REGISTRATION_AUTO_ASSIGN_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

/* ============================================================
   🟦 GET NEW AIRCRAFT ORDERS
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/orders
   ============================================================ */

router.get("/aircraft/orders", requireAuth, async (req, res) => {
  try {
    const airlineId = req.airline_id;

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION",
        details: "No airline_id found in authenticated session"
      });
    }

 const result = await pool.query(
  `
  SELECT
    id,
    order_uid,
    airline_id,
    user_id,
    source,
    manufacturer,
    model_key,
    aircraft_name,
    factory_slot_id,
    quantity,
    unit_price,
    total_price,
    initial_payment_amount,
    final_payment_amount,
    currency,
    ownership_type,
    payment_status,
    final_payment_status,
    order_status,
    delivery_status,
    order_date,
    estimated_delivery_date,
    actual_delivery_date,
    payment_hold_started_at,
    payment_hold_until,
    default_penalty_amount,
    refund_amount,
    delivery_resolved_at,
    notes,
    created_at,
    updated_at
  FROM new_aircraft_orders
  WHERE airline_id = $1
  ORDER BY created_at DESC, id DESC
  `,
  [airlineId]
);

    return res.json({
      ok: true,
      airline_id: airlineId,
      orders: result.rows
    });

  } catch (err) {
    console.error("ACS NEW AIRCRAFT ORDERS ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "NEW_AIRCRAFT_ORDERS_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 CREATE NEW AIRCRAFT ORDER — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/orders

   Purpose:
   - Create OEM aircraft order from Buy New
   - PostgreSQL authority only
   - Validate aircraft from aircraft_catalog
   - Validate factory availability from aircraft_production_rules
   - Validate capital from company_finance
   - Apply initial payment to company_finance
   - Register finance_log entry
   - Insert new_aircraft_orders record
   - No localStorage authority
   - No frontend finance mutation
   ============================================================ */

const ACS_ORDER_CABIN_PRODUCTS = Object.freeze({
  Y_SMART: 1,
  Y_CLASSIC: 1.25,
  Y_COMFORT: 1.5,
  Y_PLUS: 1.75,
  C_SMART: 2,
  C_EXECUTIVE: 2.5,
  C_PREMIER: 3,
  C_SUPERIOR: 3.5,
  F_SILVER: 4,
  F_GOLD: 4.5,
  F_PLATINUM: 5,
  F_DIAMOND: 6
});

function ACS_buildOrderCabinConfiguration({
  rawConfiguration,
  catalogCapacity,
  simYear
}) {
  const maximumCapacity = Number(catalogCapacity || 0);

  const hasConfiguration = Boolean(
    rawConfiguration &&
    typeof rawConfiguration === "object" &&
    !Array.isArray(rawConfiguration)
  );

  const readClass = (cabinClass, defaultProduct, defaultSeats = 0) => {
    const source = hasConfiguration
      ? rawConfiguration[cabinClass] || {}
      : {};
    const product = String(source.product || defaultProduct)
      .trim()
      .toUpperCase();
    const seats = hasConfiguration
      ? Number(source.seats ?? 0)
      : defaultSeats;

    if (
      !Object.prototype.hasOwnProperty.call(
        ACS_ORDER_CABIN_PRODUCTS,
        product
      ) ||
      !product.startsWith(`${cabinClass}_`) ||
      !Number.isInteger(seats) ||
      seats < 0
    ) {
      const error = new Error("INVALID_CABIN_CONFIGURATION");
      error.code = "INVALID_CABIN_CONFIGURATION";
      throw error;
    }

    return { product, seats };
  };

  if (!Number.isFinite(maximumCapacity) || maximumCapacity <= 0) {
    if (hasConfiguration) {
      const requestedSeats = ["Y", "C", "F"].reduce(
        (total, cabinClass) =>
          total + Number(rawConfiguration?.[cabinClass]?.seats || 0),
        0
      );
      if (requestedSeats > 0) {
        const error = new Error("AIRCRAFT_HAS_NO_PASSENGER_CABIN");
        error.code = "AIRCRAFT_HAS_NO_PASSENGER_CABIN";
        throw error;
      }
    }

    return {
      rulesVersion: "ACS_CABIN_V1",
      source: "NON_PASSENGER_AIRCRAFT",
      economy: { product: "Y_SMART", seats: 0 },
      business: { product: "C_SMART", seats: 0 },
      first: { product: "F_SILVER", seats: 0 },
      usedCapacity: 0
    };
  }

  const economy = readClass(
    "Y",
    "Y_SMART",
    Math.floor(maximumCapacity)
  );
  const business = readClass("C", "C_SMART", 0);
  const first = readClass("F", "F_SILVER", 0);

  if (business.seats > 0 && Number(simYear) < 1979) {
    const error = new Error("BUSINESS_CLASS_NOT_HISTORICALLY_AVAILABLE");
    error.code = "BUSINESS_CLASS_NOT_HISTORICALLY_AVAILABLE";
    throw error;
  }

  const totalSeats = economy.seats + business.seats + first.seats;
  const usedCapacity =
    economy.seats * ACS_ORDER_CABIN_PRODUCTS[economy.product] +
    business.seats * ACS_ORDER_CABIN_PRODUCTS[business.product] +
    first.seats * ACS_ORDER_CABIN_PRODUCTS[first.product];

  if (totalSeats <= 0) {
    const error = new Error("EMPTY_CABIN_CONFIGURATION");
    error.code = "EMPTY_CABIN_CONFIGURATION";
    throw error;
  }

  if (usedCapacity > maximumCapacity + 0.0001) {
    const error = new Error("CABIN_CONFIGURATION_EXCEEDS_CAPACITY");
    error.code = "CABIN_CONFIGURATION_EXCEEDS_CAPACITY";
    error.details = {
      used_capacity_units: usedCapacity,
      maximum_capacity_units: maximumCapacity
    };
    throw error;
  }

  return {
    rulesVersion: "ACS_CABIN_V1",
    source: hasConfiguration
      ? "FACTORY_ORDER_CONFIRMED"
      : "CATALOG_DEFAULT",
    economy,
    business,
    first,
    usedCapacity
  };
}

router.post("/aircraft/orders", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const airlineId = Number(req.airline_id);
    const userId = req.user_id || null;

    const modelKey = String(req.body?.model_key || "").trim();
const quantity = Number(req.body?.quantity || 1);

const ownershipType = String(req.body?.ownership_type || "BUY").toUpperCase();

const dbOwnershipType =
  ownershipType === "LEASE"
    ? "LEASED"
    : "OWNED";

/* ============================================================
   🟦 ACS LEASE NEW OCC POLICY — SERVER AUTHORITY v1.0
   ------------------------------------------------------------
   The frontend may send lease metadata, but backend remains the
   authority for:
   - lease initial commitment
   - lease duration
   - monthly lease rate
   - lessor / broker naming
   ============================================================ */

const requestedInitialPaymentPct =
  Number(req.body?.initial_payment_pct || 100);

const requestedLeaseYears =
  Number(req.body?.lease_years || 10);

const leaseYears =
  ownershipType === "LEASE"
    ? requestedLeaseYears
    : null;

const leaseTermMonths =
  ownershipType === "LEASE"
    ? leaseYears * 12
    : null;

const leaseRatePctMonthly =
  ownershipType === "LEASE"
    ? leaseYears === 5
      ? 0.0125
      : leaseYears === 10
        ? 0.0095
        : leaseYears === 15
          ? 0.0075
          : 0.0095
    : null;

const lessorName =
  ownershipType === "LEASE"
    ? "Eagle Aviation Capital"
    : null;

const remarketingAgent =
  ownershipType === "LEASE"
    ? "Eagle Broker"
    : null;

const leasePolicyVersion =
  ownershipType === "LEASE"
    ? "ACS_LEASE_NEW_OCC_V1"
    : null;

/*
  BUY uses selected initial payment.
  LEASE always uses 15% initial lease commitment.
*/
const initialPaymentPct =
  ownershipType === "LEASE"
    ? 15
    : requestedInitialPaymentPct;

const simYear = Number(req.body?.sim_year || new Date().getUTCFullYear());
     
    if (!airlineId || !Number.isInteger(airlineId)) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!modelKey) {
      return res.status(400).json({
        ok: false,
        error: "MODEL_KEY_REQUIRED"
      });
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_QUANTITY"
      });
    }

    if (!["BUY", "LEASE"].includes(ownershipType)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_OWNERSHIP_TYPE"
      });
    }
if (
  !Number.isFinite(initialPaymentPct) ||
  initialPaymentPct <= 0 ||
  initialPaymentPct > 100
) {
  return res.status(400).json({
    ok: false,
    error: "INVALID_INITIAL_PAYMENT_PCT"
  });
}

if (
  ownershipType === "LEASE" &&
  ![5, 10, 15].includes(Number(leaseYears))
) {
  return res.status(400).json({
    ok: false,
    error: "INVALID_LEASE_YEARS",
    allowed_values: [5, 10, 15]
  });
}

if (!Number.isInteger(simYear) || simYear < 1900 || simYear > 2100) {
   
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_YEAR"
      });
    }

    await client.query("BEGIN");

    /* ============================================================
       1) ENSURE FINANCE ROW EXISTS
       ============================================================ */

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 700000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airlineId]
    );

    /* ============================================================
       2) LOAD AIRCRAFT + PRODUCTION RULE
       ============================================================ */

    const aircraftResult = await client.query(
      `
      SELECT
        ac.model_key,
        ac.manufacturer,
        ac.model,
        ac.aircraft_name,
        ac.year,
        ac.seats,
        ac.price_acs_usd,
        ac.image_filename,

        pr.production_start_year,
        pr.production_end_year,
        pr.first_delivery_year,
        pr.last_delivery_year,
        pr.monthly_min_units,
        pr.monthly_max_units,
        pr.is_factory_available,
        pr.is_active_rule

      FROM aircraft_catalog ac
      INNER JOIN aircraft_production_rules pr
        ON pr.model_key = ac.model_key

      WHERE ac.model_key = $1
        AND COALESCE(ac.is_active, true) = true
        AND pr.is_active_rule = true
        AND pr.is_factory_available = true
        AND COALESCE(pr.production_start_year, ac.production_year, ac.year) <= $2
        AND (
          pr.production_end_year IS NULL
          OR pr.production_end_year >= $2
        )
      LIMIT 1
      `,
      [modelKey, simYear]
    );

    if (!aircraftResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "AIRCRAFT_NOT_AVAILABLE_FROM_FACTORY"
      });
    }

    const aircraft = aircraftResult.rows[0];

    let orderCabin;
    try {
      orderCabin = ACS_buildOrderCabinConfiguration({
        rawConfiguration: req.body?.cabin_configuration,
        catalogCapacity: aircraft.seats,
        simYear
      });
    } catch (cabinError) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: cabinError?.code || "INVALID_CABIN_CONFIGURATION",
        details: cabinError?.details || null
      });
    }

    const unitPrice = Math.round(Number(aircraft.price_acs_usd || 0));
    const totalPrice = unitPrice * quantity;

    if (!unitPrice || unitPrice <= 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_AIRCRAFT_PRICE"
      });
    }

    /* ============================================================
   🟦 ACS BUY / LEASE PAYMENT SPLIT — BACKEND AUTHORITY v1.1
   ------------------------------------------------------------
   BUY:
   - initial_payment_pct defines upfront payment
   - remaining balance becomes final_payment_amount

   LEASE:
   - initial_payment_pct is forced to 15%
   - final_payment_amount must be 0
   - lease monthly payment is calculated from aircraft value
   ============================================================ */

const initialPaymentAmount = Math.round(
  totalPrice * (initialPaymentPct / 100)
);

const finalPaymentAmount =
  ownershipType === "LEASE"
    ? 0
    : Math.max(totalPrice - initialPaymentAmount, 0);

const monthlyLeasePayment =
  ownershipType === "LEASE"
    ? Math.round(totalPrice * Number(leaseRatePctMonthly || 0))
    : null;

const leaseInitialCommitmentAmount =
  ownershipType === "LEASE"
    ? initialPaymentAmount
    : null;
     
    /* ============================================================
       3) LOCK FINANCE ROW + VALIDATE CAPITAL
       ============================================================ */

    const financeBeforeResult = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airlineId]
    );

    const financeBefore = financeBeforeResult.rows[0];
    const currentCapital = Math.round(Number(financeBefore?.capital || 0));

    if (currentCapital < initialPaymentAmount) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INSUFFICIENT_CAPITAL",
        capital: currentCapital,
        required: initialPaymentAmount
      });
    }

       /* ============================================================
       4) RESERVE FACTORY SLOT + CALCULATE REAL DELIVERY DATE
       ------------------------------------------------------------
       Backend authority:
       - Lock available factory slots with FOR UPDATE
       - Reserve required quantity across one or more months
       - Preserve slot concurrency for 700+ players
       - Calculate delivery date from reserved slot position
       - Delivery date = max(projected slot date, current sim date)
         + base_delivery_days
       - Does NOT use Date.now() as delivery authority
       ============================================================ */

    const simMonth = Number(req.body?.sim_month || 1);
    const simDay = Number(req.body?.sim_day || 1);

    if (!Number.isInteger(simMonth) || simMonth < 1 || simMonth > 12) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_MONTH"
      });
    }

    if (!Number.isInteger(simDay) || simDay < 1 || simDay > 31) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_DAY"
      });
    }

    const currentSimDate = new Date(Date.UTC(
      simYear,
      simMonth - 1,
      simDay,
      12,
      0,
      0
    ));

    const availableSlotsResult = await client.query(
      `
      SELECT
        id,
        model_key,
        aircraft_name,
        slot_year,
        slot_month,
        COALESCE(max_quantity, 0) AS max_quantity,
        COALESCE(available_quantity, 0) AS available_quantity,
        COALESCE(reserved_quantity, 0) AS reserved_quantity,
        COALESCE(delivered_quantity, 0) AS delivered_quantity,
        COALESCE(base_delivery_days, 0) AS base_delivery_days
      FROM aircraft_factory_slots
      WHERE model_key = $1
        AND available_quantity > 0
        AND ((slot_year * 12) + slot_month) >= (($2::INTEGER * 12) + $3::INTEGER)
      ORDER BY slot_year ASC, slot_month ASC
      FOR UPDATE
      `,
      [modelKey, simYear, simMonth]
    );

    let remainingQuantityToReserve = quantity;
    const reservedFactorySlots = [];

    function ACS_getDaysInMonthUTC(year, month) {
      return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    }

    function ACS_getProjectedFactorySlotDate(slotYear, slotMonth, capacity, slotIndex) {
      const daysInMonth = ACS_getDaysInMonthUTC(slotYear, slotMonth);

      const projectedSlotDay = Math.max(
        1,
        Math.min(
          daysInMonth,
          Math.round((Number(slotIndex) / (Number(capacity) + 1)) * daysInMonth)
        )
      );

      return new Date(Date.UTC(
        Number(slotYear),
        Number(slotMonth) - 1,
        projectedSlotDay,
        12,
        0,
        0
      ));
    }

    function ACS_getEstimatedDeliveryDate(projectedSlotDate, currentSimDate, baseDeliveryDays) {
      const deliveryBaseDate =
        projectedSlotDate.getTime() < currentSimDate.getTime()
          ? currentSimDate
          : projectedSlotDate;

      return new Date(
        deliveryBaseDate.getTime() +
        Number(baseDeliveryDays || 0) * 24 * 60 * 60 * 1000
      );
    }

    for (const slot of availableSlotsResult.rows) {
      if (remainingQuantityToReserve <= 0) break;

      const slotAvailable = Number(slot.available_quantity || 0);
      const slotCapacity = Math.max(
        Number(slot.max_quantity || 0),
        slotAvailable + Number(slot.reserved_quantity || 0) + Number(slot.delivered_quantity || 0),
        1
      );

      if (slotAvailable <= 0) continue;

      const reserveQty = Math.min(remainingQuantityToReserve, slotAvailable);

      const reservedBefore = Number(slot.reserved_quantity || 0);
      const deliveredBefore = Number(slot.delivered_quantity || 0);
      const reservedAfter = reservedBefore + reserveQty;
      const availableAfter = Math.max(0, slotAvailable - reserveQty);

      const deliverySlotIndex = reservedAfter;

      const projectedSlotDate = ACS_getProjectedFactorySlotDate(
        Number(slot.slot_year),
        Number(slot.slot_month),
        slotCapacity,
        deliverySlotIndex
      );

      const slotDeliveryDate = ACS_getEstimatedDeliveryDate(
        projectedSlotDate,
        currentSimDate,
        Number(slot.base_delivery_days || 0)
      );

      await client.query(
        `
        UPDATE aircraft_factory_slots
        SET
          reserved_quantity = reserved_quantity + $2,
          available_quantity = GREATEST(0, available_quantity - $2),
          slot_status = CASE
            WHEN GREATEST(0, available_quantity - $2) <= 0
            THEN 'FULL'
            ELSE 'OPEN'
          END,
          utilization_pct = ROUND(
            (
              (
                COALESCE(reserved_quantity, 0)
                + $2
                + COALESCE(delivered_quantity, 0)
              )::NUMERIC
              /
              GREATEST(COALESCE(max_quantity, 0), 1)::NUMERIC
            ) * 100,
            2
          ),
          updated_at = NOW()
        WHERE id = $1
        `,
        [slot.id, reserveQty]
      );

      reservedFactorySlots.push({
        slot_id: slot.id,
        slot_year: Number(slot.slot_year),
        slot_month: Number(slot.slot_month),
        reserved_quantity: reserveQty,
        capacity: slotCapacity,
        reserved_before: reservedBefore,
        reserved_after: reservedAfter,
        available_after: availableAfter,
        delivered_before: deliveredBefore,
        base_delivery_days: Number(slot.base_delivery_days || 0),
        projected_slot_date: projectedSlotDate.toISOString(),
        estimated_delivery_date: slotDeliveryDate.toISOString()
      });

      remainingQuantityToReserve -= reserveQty;
    }

    if (remainingQuantityToReserve > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "FACTORY_SLOTS_UNAVAILABLE",
        model_key: modelKey,
        requested_quantity: quantity,
        reserved_quantity: quantity - remainingQuantityToReserve,
        missing_quantity: remainingQuantityToReserve,
        sim_year: simYear,
        sim_month: simMonth,
        sim_day: simDay
      });
    }

    const factorySlotId = reservedFactorySlots[0]?.slot_id || null;

    const estimatedDeliveryDate = new Date(
      reservedFactorySlots[reservedFactorySlots.length - 1].estimated_delivery_date
    );

    /* ============================================================
   5) INSERT ORDER
   ------------------------------------------------------------
   ACS OCC Rule:
   - Store Buy New financial state in real DB columns
   - notes remains secondary audit metadata only
   - Resolver must never depend only on notes JSON
   ============================================================ */

/* ============================================================
   🟦 ACS BUY / LEASE PAYMENT STATUS RULE — v1.1
   ------------------------------------------------------------
   LEASE:
   - Treated as paid for delivery purposes after lease commitment.
   - No final purchase balance exists.
   - Must never enter PAYMENT_HOLD due to final payment.
   ============================================================ */

const paymentStatus =
  ownershipType === "LEASE"
    ? "PAID"
    : initialPaymentPct >= 100
      ? "PAID"
      : "FINANCED";

const finalPaymentStatus =
  ownershipType === "LEASE"
    ? "PAID"
    : paymentStatus === "PAID"
      ? "PAID"
      : "NOT_DUE";

const orderResult = await client.query(
  `
  INSERT INTO new_aircraft_orders (
    order_uid,
    airline_id,
    user_id,
    source,
    manufacturer,
    model_key,
    aircraft_name,
    factory_slot_id,
    quantity,
    unit_price,
    total_price,
    initial_payment_amount,
    final_payment_amount,
    currency,
    ownership_type,
    payment_status,
    final_payment_status,
    order_status,
    delivery_status,
    order_date,
    estimated_delivery_date,
    actual_delivery_date,
    cabin_rules_version,
    cabin_configuration_source,
    y_product,
    y_seats,
    c_product,
    c_seats,
    f_product,
    f_seats,
    cabin_capacity_units,
    cabin_configured_at,
    notes,
    created_at,
    updated_at
  )
  VALUES (
    gen_random_uuid(),
    $1,
    $2,
    'FACTORY',
    $3,
    $4,
    $5,
    $15,
    $6,
    $7,
    $8,
    $9,
    $10,
    'USD',
    $11,
    $12,
    $13,
    'ORDERED',
    'PENDING_DELIVERY',
    NOW(),
    $14,
    NULL,
    $17,
    $18,
    $19,
    $20,
    $21,
    $22,
    $23,
    $24,
    $25,
    acs_get_current_sim_time(),
    $16,
    NOW(),
    NOW()
  )
  RETURNING *
  `,
  [
    airlineId,
    userId,
    aircraft.manufacturer,
    aircraft.model_key,
    aircraft.aircraft_name || `${aircraft.manufacturer} ${aircraft.model}`,
    quantity,
    unitPrice,
    totalPrice,
    initialPaymentAmount,
    finalPaymentAmount,
    dbOwnershipType,
    paymentStatus,
    finalPaymentStatus,
    estimatedDeliveryDate,
    factorySlotId,
    JSON.stringify({
      initial_payment_pct: initialPaymentPct,
      initial_payment_amount: initialPaymentAmount,
      final_payment_amount: finalPaymentAmount,
      final_payment_status: finalPaymentStatus,
      sim_year: simYear,
      sim_month: simMonth,
      sim_day: simDay,
      factory_slot_id: factorySlotId,
      factory_slots_reserved: reservedFactorySlots,

/* Lease New OCC metadata */
lease_years: ownershipType === "LEASE" ? leaseYears : null,
lease_term_months: ownershipType === "LEASE" ? leaseTermMonths : null,
monthly_lease_payment: ownershipType === "LEASE" ? monthlyLeasePayment : null,
lease_initial_commitment_pct: ownershipType === "LEASE" ? 15 : null,
lease_initial_commitment_amount: ownershipType === "LEASE" ? leaseInitialCommitmentAmount : null,
lease_rate_pct_monthly: ownershipType === "LEASE" ? leaseRatePctMonthly : null,
lessor_name: ownershipType === "LEASE" ? lessorName : null,
remarketing_agent: ownershipType === "LEASE" ? remarketingAgent : null,
lease_policy_version: ownershipType === "LEASE" ? leasePolicyVersion : null,
contract_lock: ownershipType === "LEASE" ? "NO_FREE_RETURN_BEFORE_CONTRACT_END" : null,
end_of_lease_options: ownershipType === "LEASE"
  ? ["EXTEND", "BUYOUT", "RETURN_AT_CONTRACT_END"]
  : null,

source: ownershipType === "LEASE"
  ? "ACS_LEASE_NEW_BACKEND_ORDER_OCC_V1"
  : "ACS_BUY_NEW_BACKEND_ORDER_V3_REAL_PAYMENT_COLUMNS"
    }),
    orderCabin.rulesVersion,
    orderCabin.source,
    orderCabin.economy.product,
    orderCabin.economy.seats,
    orderCabin.business.product,
    orderCabin.business.seats,
    orderCabin.first.product,
    orderCabin.first.seats,
    orderCabin.usedCapacity
  ]
);

const order = orderResult.rows[0];

        /* ============================================================
       6) APPLY FINANCE IMPACT
       ------------------------------------------------------------
       BUY   → cost_new_aircraft_purchase
       LEASE → cost_leasing
       ============================================================ */

    if (ownershipType === "LEASE") {
      await client.query(
        `
        UPDATE company_finance
        SET
          capital = COALESCE(capital,0) - $2,
          expenses = COALESCE(expenses,0) + $2,
          profit = COALESCE(profit,0) - $2,
          cost_leasing = COALESCE(cost_leasing,0) + $2,
          updated_at = NOW()
        WHERE airline_id = $1
        `,
        [airlineId, initialPaymentAmount]
      );
        } else {
      await client.query(
        `
        UPDATE company_finance
        SET
          capital =
            COALESCE(capital, 0) - $2,

          cost_new_aircraft_purchase =
            COALESCE(
              cost_new_aircraft_purchase,
              0
            ) + $2,

          updated_at = NOW()

        WHERE airline_id = $1
        `,
        [
          airlineId,
          initialPaymentAmount
        ]
      );
    }
     
    /* ============================================================
       7) FINANCE LOG
       ============================================================ */
     
    const aircraftLabel =
      aircraft.aircraft_name ||
      `${aircraft.manufacturer} ${aircraft.model}`;

        const financeSource =
      ownershipType === "LEASE"
        ? `OEM LEASE INITIAL — ${aircraftLabel}`
        : `OEM PURCHASE INITIAL — ${aircraftLabel}`;

    const financeType =
      ownershipType === "LEASE"
        ? "EXPENSE"
        : "INVESTMENT";

    const financeClockResult =
      await client.query(
        `
        SELECT
          FLOOR(
            EXTRACT(
              EPOCH FROM acs_get_current_sim_time()
            ) * 1000
          )::BIGINT AS timestamp_ms
        `
      );

    const financeTimestamp =
      Number(
        financeClockResult.rows[0]?.timestamp_ms
      );

    if (!Number.isFinite(financeTimestamp)) {
      throw new Error(
        "ACS_FINANCE_TIMESTAMP_UNAVAILABLE"
      );
    }

    await client.query(
      `
      INSERT INTO finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        airlineId,
        financeType,
        financeSource,
        initialPaymentAmount,
        financeTimestamp
      ]
    );
     
    /* ============================================================
       8) RETURN FINANCE SNAPSHOT
       ============================================================ */

    const financeAfterResult = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      `,
      [airlineId]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      endpoint: "ACS_CREATE_NEW_AIRCRAFT_ORDER",
      version: "v1.0",
      order,
      finance: financeAfterResult.rows[0],
      payment: {
  ownership_type: ownershipType,
  db_ownership_type: dbOwnershipType,
  initial_payment_pct: initialPaymentPct,
  initial_payment_amount: initialPaymentAmount,
  final_payment_amount: finalPaymentAmount,
  total_price: totalPrice,
  payment_status: paymentStatus,
  final_payment_status: finalPaymentStatus,

  lease: ownershipType === "LEASE"
    ? {
        lease_years: leaseYears,
        lease_term_months: leaseTermMonths,
        monthly_lease_payment: monthlyLeasePayment,
        lease_initial_commitment_pct: 15,
        lease_initial_commitment_amount: leaseInitialCommitmentAmount,
        lease_rate_pct_monthly: leaseRatePctMonthly,
        lessor_name: lessorName,
        remarketing_agent: remarketingAgent,
        lease_policy_version: leasePolicyVersion,
        contract_lock: "NO_FREE_RETURN_BEFORE_CONTRACT_END",
        end_of_lease_options: ["EXTEND", "BUYOUT", "RETURN_AT_CONTRACT_END"]
      }
    : null,

  currency: "USD"
}
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS CREATE NEW AIRCRAFT ORDER ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "CREATE_NEW_AIRCRAFT_ORDER_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

/* ============================================================
   🟦 ACS FACTORY SLOT AVAILABILITY — OEM BOARD v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/factory/slots/availability?model_key=lockheed_l_049_constellation&year=1951&month=9

   Purpose:
   - Read OEM slot availability for one aircraft model/month
   - Feed Buy New Factory Slots modal
   - Shows capacity, reserved, available, utilization
   - Shows next available delivery window
   - PostgreSQL authority only
   - No reservation
   - No Finance mutation
   - No localStorage authority
   ============================================================ */

router.get("/aircraft/factory/slots/availability", requireAuth, async (req, res) => {
  try {
    const modelKey = String(req.query.model_key || "").trim();
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!modelKey) {
      return res.status(400).json({
        ok: false,
        error: "MODEL_KEY_REQUIRED"
      });
    }

    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_YEAR"
      });
    }

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_MONTH"
      });
    }

    const previousMonthDate = new Date(Date.UTC(year, month - 2, 1));
    const nextMonthDate = new Date(Date.UTC(year, month, 1));

    const currentSlotResult = await pool.query(
      `
      SELECT
        id,
        slot_uid,
        manufacturer,
        model_key,
        aircraft_name,
        production_year,
        slot_year,
        slot_month,

        COALESCE(
          max_quantity,
          COALESCE(available_quantity, 0)
          + COALESCE(reserved_quantity, 0)
          + COALESCE(delivered_quantity, 0)
        ) AS capacity,

        COALESCE(reserved_quantity, 0) AS reserved,
        COALESCE(available_quantity, 0) AS available,
        COALESCE(delivered_quantity, 0) AS delivered,

        CASE
          WHEN COALESCE(
            max_quantity,
            COALESCE(available_quantity, 0)
            + COALESCE(reserved_quantity, 0)
            + COALESCE(delivered_quantity, 0)
          ) > 0
          THEN ROUND(
            (
              COALESCE(reserved_quantity, 0)::NUMERIC
              /
              COALESCE(
                max_quantity,
                COALESCE(available_quantity, 0)
                + COALESCE(reserved_quantity, 0)
                + COALESCE(delivered_quantity, 0)
              )::NUMERIC
            ) * 100,
            2
          )
          ELSE 0
        END AS utilization_pct,

        slot_units_per_aircraft,
        capacity_tier,
        aircraft_size_class,
        base_delivery_days,
        slot_status,
        created_at,
        updated_at
      FROM aircraft_factory_slots
      WHERE model_key = $1
        AND slot_year = $2
        AND slot_month = $3
      LIMIT 1
      `,
      [modelKey, year, month]
    );

    const nextAvailableResult = await pool.query(
      `
      SELECT
        id,
        slot_uid,
        manufacturer,
        model_key,
        aircraft_name,
        production_year,
        slot_year,
        slot_month,

        COALESCE(
          max_quantity,
          COALESCE(available_quantity, 0)
          + COALESCE(reserved_quantity, 0)
          + COALESCE(delivered_quantity, 0)
        ) AS capacity,

        COALESCE(reserved_quantity, 0) AS reserved,
        COALESCE(available_quantity, 0) AS available,
        COALESCE(delivered_quantity, 0) AS delivered,

        CASE
          WHEN COALESCE(
            max_quantity,
            COALESCE(available_quantity, 0)
            + COALESCE(reserved_quantity, 0)
            + COALESCE(delivered_quantity, 0)
          ) > 0
          THEN ROUND(
            (
              COALESCE(reserved_quantity, 0)::NUMERIC
              /
              COALESCE(
                max_quantity,
                COALESCE(available_quantity, 0)
                + COALESCE(reserved_quantity, 0)
                + COALESCE(delivered_quantity, 0)
              )::NUMERIC
            ) * 100,
            2
          )
          ELSE 0
        END AS utilization_pct,

        slot_units_per_aircraft,
        capacity_tier,
        aircraft_size_class,
        base_delivery_days,
        slot_status
      FROM aircraft_factory_slots
      WHERE model_key = $1
        AND available_quantity > 0
        AND ((slot_year * 12) + slot_month) >= (($2::INTEGER * 12) + $3::INTEGER)
      ORDER BY slot_year ASC, slot_month ASC
      LIMIT 1
      `,
      [modelKey, year, month]
    );

    const currentSlot = currentSlotResult.rows[0] || null;
    const nextAvailable = nextAvailableResult.rows[0] || null;

        let estimatedDeliveryPreview = null;
    let projectedSlotDatePreview = null;

    function ACS_getDaysInMonthUTC(year, month) {
      return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    }

    function ACS_getProjectedFactorySlotDate(slotYear, slotMonth, capacity, reserved) {
      const daysInMonth = ACS_getDaysInMonthUTC(slotYear, slotMonth);

      const nextSlotIndex = Number(reserved || 0) + 1;

      const projectedSlotDay = Math.max(
        1,
        Math.min(
          daysInMonth,
          Math.round((nextSlotIndex / (Number(capacity || 1) + 1)) * daysInMonth)
        )
      );

      return new Date(Date.UTC(
        Number(slotYear),
        Number(slotMonth) - 1,
        projectedSlotDay,
        12,
        0,
        0
      ));
    }

    if (nextAvailable) {
      const projectedSlotDate = ACS_getProjectedFactorySlotDate(
        Number(nextAvailable.slot_year),
        Number(nextAvailable.slot_month),
        Number(nextAvailable.capacity || 1),
        Number(nextAvailable.reserved || 0)
      );

      projectedSlotDatePreview = projectedSlotDate.toISOString();

      estimatedDeliveryPreview = new Date(
        projectedSlotDate.getTime() +
        Number(nextAvailable.base_delivery_days || 0) * 24 * 60 * 60 * 1000
      ).toISOString();
    }

    return res.json({
      ok: true,
      endpoint: "ACS_FACTORY_SLOT_AVAILABILITY",
      version: "v1.0",

      query: {
        model_key: modelKey,
        year,
        month
      },

      navigation: {
        previous: {
          year: previousMonthDate.getUTCFullYear(),
          month: previousMonthDate.getUTCMonth() + 1
        },
        current: {
          year,
          month
        },
        next: {
          year: nextMonthDate.getUTCFullYear(),
          month: nextMonthDate.getUTCMonth() + 1
        }
      },

      slot: currentSlot,

      next_available_delivery_window: nextAvailable
        ? {
            slot_id: nextAvailable.id,
            slot_year: nextAvailable.slot_year,
            slot_month: nextAvailable.slot_month,
            capacity: Number(nextAvailable.capacity || 0),
            reserved: Number(nextAvailable.reserved || 0),
            available: Number(nextAvailable.available || 0),
            utilization_pct: Number(nextAvailable.utilization_pct || 0),
            base_delivery_days: Number(nextAvailable.base_delivery_days || 0),
            projected_slot_date_preview: projectedSlotDatePreview,
            estimated_delivery_preview: estimatedDeliveryPreview
          }
        : null
    });

  } catch (err) {
    console.error("ACS FACTORY SLOT AVAILABILITY ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "FACTORY_SLOT_AVAILABILITY_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 GET AIRCRAFT FACTORY SLOTS
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/factory/slots
   ============================================================ */

router.get("/aircraft/factory/slots", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        slot_uid,
        manufacturer,
        model_key,
        aircraft_name,
        production_year,
        slot_year,
        slot_month,
        available_quantity,
        reserved_quantity,
        delivered_quantity,
        base_delivery_days,
        slot_status,
        created_at,
        updated_at
      FROM aircraft_factory_slots
      ORDER BY slot_year ASC, slot_month ASC, manufacturer ASC, model_key ASC
      `
    );

    return res.json({
      ok: true,
      slots: result.rows
    });

  } catch (err) {
    console.error("ACS AIRCRAFT FACTORY SLOTS ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_FACTORY_SLOTS_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 ACS USED AIRCRAFT MARKET — FINITE SEED ENGINE v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/used-market

   ACS Policy:
   - Backend authority only
   - No localStorage
   - Used Market seed exists only to start the world
   - System-generated seed allowed only from 1940 to 1950
   - From 1951 onward, ACS does not create artificial used aircraft
   - Purchased listings are NOT replaced automatically
   - Future supply must come from player sales, defaults,
     bankruptcies, lease returns, repossessions and remarketing
   ============================================================ */

const ACS_USED_MARKET_POLICY = Object.freeze({
  bootstrapStartYear: 1940,
  bootstrapEndYear: 1950,
  bootstrapSeedTotal: 300,
  policyVersion: "ACS_USED_MARKET_FINITE_SEED_V1",
  defaultBroker: "Eagle Broker",
  defaultLessor: "Eagle Aviation Capital"
});

function ACS_randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function ACS_pickRandom(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function ACS_clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function ACS_resolveAircraftTier(aircraft) {
  const seats = Number(aircraft.seats || 0);
  const price = Number(aircraft.price_acs_usd || 0);

  if (seats <= 30 || price <= 250000) return "COMMON";
  if (seats <= 60 || price <= 750000) return "STANDARD";
  if (seats <= 100 || price <= 1500000) return "PREMIUM";
  return "RARE";
}

function ACS_weightedAircraftPool(aircraftRows) {
  const weighted = [];

  for (const aircraft of aircraftRows) {
    const tier = ACS_resolveAircraftTier(aircraft);

    let weight = 1;

    if (tier === "COMMON") weight = 12;
    if (tier === "STANDARD") weight = 6;
    if (tier === "PREMIUM") weight = 3;
    if (tier === "RARE") weight = 1;

    for (let i = 0; i < weight; i++) {
      weighted.push(aircraft);
    }
  }

  return weighted;
}

function ACS_buildUsedSerialNumber(modelKey, index) {
  const prefix = String(modelKey || "ACS")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, "X");

  return `${prefix}-${String(Date.now()).slice(-5)}-${String(index).padStart(4, "0")}`;
}

function ACS_buildPreviousRegistration(index) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const a = letters[ACS_randomInt(0, letters.length - 1)];
  const b = letters[ACS_randomInt(0, letters.length - 1)];
  const c = letters[ACS_randomInt(0, letters.length - 1)];

  return `N${ACS_randomInt(100, 999)}${a}${b}${c}`.slice(0, 6);
}

function ACS_buildUsedAircraftCondition(ageYears) {
  const age = Number(ageYears || 1);

  const base =
    age <= 3 ? ACS_randomInt(82, 96) :
    age <= 8 ? ACS_randomInt(74, 91) :
    age <= 15 ? ACS_randomInt(65, 85) :
    age <= 25 ? ACS_randomInt(55, 78) :
    ACS_randomInt(45, 70);

  return ACS_clampNumber(base, 35, 98);
}

function ACS_buildUsedAircraftHours(ageYears, tier) {
  const age = Math.max(1, Number(ageYears || 1));

  const yearlyHours =
    tier === "COMMON" ? ACS_randomInt(450, 900) :
    tier === "STANDARD" ? ACS_randomInt(650, 1200) :
    tier === "PREMIUM" ? ACS_randomInt(850, 1500) :
    ACS_randomInt(700, 1300);

  return Math.max(250, Math.round(age * yearlyHours + ACS_randomInt(100, 900)));
}

function ACS_buildUsedAircraftCycles(ageYears, tier) {
  const age = Math.max(1, Number(ageYears || 1));

  const yearlyCycles =
    tier === "COMMON" ? ACS_randomInt(250, 650) :
    tier === "STANDARD" ? ACS_randomInt(220, 520) :
    tier === "PREMIUM" ? ACS_randomInt(160, 420) :
    ACS_randomInt(120, 350);

  return Math.max(100, Math.round(age * yearlyCycles + ACS_randomInt(40, 300)));
}

function ACS_buildUsedMarketPrice(basePrice, ageYears, conditionPct, tier) {
  const price = Number(basePrice || 0);
  const age = Math.max(1, Number(ageYears || 1));
  const condition = Number(conditionPct || 70);

  const ageFactor = ACS_clampNumber(1 - (age * 0.035), 0.22, 0.82);
  const conditionFactor = ACS_clampNumber(condition / 100, 0.35, 0.98);

  const scarcityFactor =
    tier === "COMMON" ? 0.92 :
    tier === "STANDARD" ? 1.0 :
    tier === "PREMIUM" ? 1.08 :
    1.18;

  const marketPrice = price * ageFactor * conditionFactor * scarcityFactor;

  return Math.max(10000, Math.round(marketPrice));
}

async function ACS_getWorldSimYear(client) {
  const worldResult = await client.query(
    `
    SELECT
      sim_start,
      frozen_sim_time,
      real_start
    FROM acs_world
    WHERE id = 1
    LIMIT 1
    `
  );

  if (!worldResult.rows.length) {
    throw new Error("ACS_WORLD_NOT_FOUND");
  }

  const world = worldResult.rows[0];

  const authoritativeTime =
    world.frozen_sim_time ||
    world.sim_start;

  if (!authoritativeTime) {
    throw new Error("ACS_WORLD_TIME_NOT_AVAILABLE");
  }

  return new Date(authoritativeTime).getUTCFullYear();
}

async function ACS_seedUsedAircraftMarketIfNeeded(client) {
  const simYear = await ACS_getWorldSimYear(client);

  const existingSeedResult = await client.query(
    `
    SELECT COUNT(*)::INTEGER AS seed_count
    FROM used_aircraft_market
    WHERE system_generated = true
      AND market_source = 'SYSTEM_GENERATED'
      AND generated_for_sim_year BETWEEN $1 AND $2
    `,
    [
      ACS_USED_MARKET_POLICY.bootstrapStartYear,
      ACS_USED_MARKET_POLICY.bootstrapEndYear
    ]
  );

  const existingSeedCount = Number(existingSeedResult.rows[0]?.seed_count || 0);

  if (existingSeedCount > 0) {
    return {
      sim_year: simYear,
      seed_created: false,
      reason: "SEED_ALREADY_EXISTS",
      existing_seed_count: existingSeedCount
    };
  }

  if (
    simYear < ACS_USED_MARKET_POLICY.bootstrapStartYear ||
    simYear > ACS_USED_MARKET_POLICY.bootstrapEndYear
  ) {
    return {
      sim_year: simYear,
      seed_created: false,
      reason: "OUTSIDE_BOOTSTRAP_WINDOW",
      existing_seed_count: existingSeedCount
    };
  }

  const eligibleAircraftResult = await client.query(
    `
    SELECT
      id,
      model_key,
      manufacturer,
      model,
      aircraft_name,
      year,
      production_year,
      seats,
      range_nm,
      price_acs_usd,
      aircraft_category
    FROM aircraft_catalog
    WHERE COALESCE(is_active, true) = true
      AND COALESCE(year, production_year, 1900) <= $1
      AND COALESCE(price_acs_usd, 0) > 0
    ORDER BY
      COALESCE(year, production_year, 1900) ASC,
      manufacturer ASC,
      model ASC
    `,
    [simYear]
  );

  const eligibleAircraft = eligibleAircraftResult.rows;

  if (!eligibleAircraft.length) {
    return {
      sim_year: simYear,
      seed_created: false,
      reason: "NO_ELIGIBLE_AIRCRAFT_IN_CATALOG",
      existing_seed_count: existingSeedCount
    };
  }

  const generationBatchIdResult = await client.query(
    `SELECT gen_random_uuid() AS batch_id`
  );

  const generationBatchId = generationBatchIdResult.rows[0].batch_id;
  const weightedPool = ACS_weightedAircraftPool(eligibleAircraft);

  const previousOperators = [
    "Bank Inventory",
    "Stored Aircraft Pool",
    "Regional Operator",
    "Charter Operator",
    "Cargo Operator",
    "Broker Remarketing Stock"
  ];

  let insertedCount = 0;

  for (let i = 0; i < ACS_USED_MARKET_POLICY.bootstrapSeedTotal; i++) {
    const selectedAircraft = ACS_pickRandom(weightedPool);
    if (!selectedAircraft) continue;

    const aircraftIntroYear = Number(
      selectedAircraft.year ||
      selectedAircraft.production_year ||
      simYear
    );

    const minimumBuildYear = Math.max(1900, aircraftIntroYear);
    const maximumBuildYear = Math.max(minimumBuildYear, simYear - 1);

    const yearBuilt =
      maximumBuildYear >= minimumBuildYear
        ? ACS_randomInt(minimumBuildYear, maximumBuildYear)
        : aircraftIntroYear;

    const ageYears = Math.max(1, simYear - yearBuilt);
    const tier = ACS_resolveAircraftTier(selectedAircraft);

    const totalHours = ACS_buildUsedAircraftHours(ageYears, tier);
    const totalCycles = ACS_buildUsedAircraftCycles(ageYears, tier);
    const conditionPct = ACS_buildUsedAircraftCondition(ageYears);

    const basePrice = Math.round(Number(selectedAircraft.price_acs_usd || 0));
    const marketPrice = ACS_buildUsedMarketPrice(
      basePrice,
      ageYears,
      conditionPct,
      tier
    );

    const cCheckDueHours = Math.max(100, Math.round(totalHours + ACS_randomInt(300, 1200)));
    const cCheckDueCycles = Math.max(50, Math.round(totalCycles + ACS_randomInt(150, 700)));

    const dCheckDueDate = new Date(Date.UTC(
      simYear + ACS_randomInt(1, 6),
      ACS_randomInt(0, 11),
      ACS_randomInt(1, 28),
      12,
      0,
      0
    ));

    const previousOperator = ACS_pickRandom(previousOperators);

    await client.query(
      `
      INSERT INTO used_aircraft_market (
        listing_uid,
        manufacturer,
        model_key,
        aircraft_name,
        serial_number,
        previous_registration,
        previous_operator,
        year_built,
        age_years,
        total_hours,
        total_cycles,
        condition_pct,
        current_location,
        current_airport,
        base_price,
        market_price,
        currency,
        maintenance_status,
        c_check_due_hours,
        c_check_due_cycles,
        d_check_due_date,
        listing_status,
        listed_at,
        market_source,
        system_generated,
        generation_batch_id,
        generated_for_sim_year,
        expires_sim_year,
        previous_operator_name,
        remarketing_agent,
        lessor_name,
        available_for_purchase,
        available_for_lease,
        ownership_offer_type,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        'BANK / BROKER INVENTORY',
        NULL,
        $12,
        $13,
        'USD',
        'SERVICEABLE',
        $14,
        $15,
        $16,
        'AVAILABLE',
        NOW(),
        'SYSTEM_GENERATED',
        true,
        $17,
        $18,
        NULL,
        $19,
        $20,
        NULL,
        true,
        false,
        'PURCHASE_ONLY',
        NOW(),
        NOW()
      )
      `,
      [
        selectedAircraft.manufacturer,
        selectedAircraft.model_key,
        selectedAircraft.aircraft_name ||
          `${selectedAircraft.manufacturer} ${selectedAircraft.model}`,
        ACS_buildUsedSerialNumber(selectedAircraft.model_key, i + 1),
        ACS_buildPreviousRegistration(i + 1),
        previousOperator,
        yearBuilt,
        ageYears,
        totalHours,
        totalCycles,
        conditionPct,
        basePrice,
        marketPrice,
        cCheckDueHours,
        cCheckDueCycles,
        dCheckDueDate,
        generationBatchId,
        simYear,
        previousOperator,
        ACS_USED_MARKET_POLICY.defaultBroker
      ]
    );

    insertedCount++;
  }

  return {
    sim_year: simYear,
    seed_created: insertedCount > 0,
    reason: insertedCount > 0 ? "BOOTSTRAP_SEED_CREATED" : "SEED_INSERT_FAILED",
    inserted_count: insertedCount,
    generation_batch_id: generationBatchId
  };
}

/* ============================================================
   🕒 ACS USED MARKET SIM DATE RESOLVER — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Purpose:
   - Used Market must age using ACS simulated date.
   - No Date.now() / new Date() as simulation authority.
   - Frontend must send sim_year, sim_month, sim_day.
   ============================================================ */

function ACS_resolveUsedMarketSimDateFromQuery(req) {
  const simYear = Number(req.query?.sim_year);
  const simMonth = Number(req.query?.sim_month);
  const simDay = Number(req.query?.sim_day);

  if (!Number.isInteger(simYear) || simYear < 1900 || simYear > 2100) {
    return {
      ok: false,
      error: "INVALID_ACS_SIM_YEAR"
    };
  }

  if (!Number.isInteger(simMonth) || simMonth < 1 || simMonth > 12) {
    return {
      ok: false,
      error: "INVALID_ACS_SIM_MONTH"
    };
  }

  if (!Number.isInteger(simDay) || simDay < 1 || simDay > 31) {
    return {
      ok: false,
      error: "INVALID_ACS_SIM_DAY"
    };
  }

  const mm = String(simMonth).padStart(2, "0");
  const dd = String(simDay).padStart(2, "0");

  return {
    ok: true,
    sim_year: simYear,
    sim_month: simMonth,
    sim_day: simDay,
    sim_date: `${simYear}-${mm}-${dd}`
  };
}

router.get("/aircraft/used-market", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const simDatePayload = ACS_resolveUsedMarketSimDateFromQuery(req);

    if (!simDatePayload.ok) {
      return res.status(400).json({
        ok: false,
        error: simDatePayload.error,
        details: "Used Market requires ACS simulated date authority."
      });
    }

    await client.query("BEGIN");

    const seedStatus = await ACS_seedUsedAircraftMarketIfNeeded(client);

    const agedSystemCleanupResult = await client.query(
  `
  DELETE FROM public.used_aircraft_market
  WHERE listing_status = 'AVAILABLE'
    AND system_generated IS TRUE
    AND market_source = 'SYSTEM_GENERATED'
    AND year_built IS NOT NULL
    AND ($1::int - year_built) > 21
  RETURNING
    id,
    manufacturer,
    aircraft_name,
    year_built
  `,
  [simDatePayload.sim_year]
);

const systemRefresh = {
  policy: "ACS_USED_MARKET_DELETE_SYSTEM_OVER_21_YEARS_V1",
  sim_year: simDatePayload.sim_year,
  deleted_count: agedSystemCleanupResult.rowCount,
  deleted_listings: agedSystemCleanupResult.rows
};

    const result = await client.query(
  `
  SELECT
    uam.id,
    uam.listing_uid,
    uam.manufacturer,
    uam.model_key,
    uam.aircraft_name,

    ac.model AS model,
    ac.seats AS seats,
    ac.range_nm AS range_nm,
    ac.speed_kts AS speed_kts,
    ac.engines AS engines,
    ac.aircraft_category AS aircraft_category,
    ac.image_filename AS image_filename,
    ac.image_filename AS image_file_name,

    uam.serial_number,
    uam.previous_registration,
    uam.previous_operator,
    uam.previous_operator_name,
    uam.year_built,
    uam.age_years,
    uam.total_hours,
    uam.total_cycles,
    uam.condition_pct,
    uam.current_location,
    uam.current_airport,
    uam.base_price,
    uam.market_price,
    uam.currency,
    uam.maintenance_status,
    uam.c_check_due_hours,
    uam.c_check_due_cycles,
    uam.d_check_due_date,
    uam.listing_status,
    uam.reserved_by_airline_id,
    uam.sold_to_airline_id,
    uam.listed_at,
    uam.reserved_at,
    uam.sold_at,
    uam.market_source,
    uam.system_generated,
    uam.generation_batch_id,
    uam.generated_for_sim_year,
    uam.expires_sim_year,
    uam.previous_airline_id,
    uam.lessor_name,
    uam.remarketing_agent,
    uam.available_for_purchase,
    uam.available_for_lease,
    uam.ownership_offer_type,

    uam.broker_serviced,
    uam.broker_serviced_at,
    uam.system_refresh_count,
    uam.system_refresh_last_sim_date,
    uam.system_refresh_last_type,
    uam.system_refresh_policy_version,

    uam.created_at,
    uam.updated_at
  FROM used_aircraft_market uam
  LEFT JOIN aircraft_catalog ac
    ON ac.model_key = uam.model_key
  WHERE uam.listing_status IN ('AVAILABLE', 'RESERVED')
  ORDER BY uam.listed_at DESC, uam.id DESC
  `
);

        /*
      Airline listings use a prefixed public ID so they
      cannot collide with system Used Market numeric IDs.

      Examples:
      SYSTEM-44
      AIRLINE-12
    */

    const airlineListingsResult =
      await client.query(
        `
        SELECT
          (
            'AIRLINE-' ||
            aml.id::TEXT
          ) AS id,

          aml.id
            AS market_listing_id,

          (
            'AIRLINE-' ||
            aml.id::TEXT
          ) AS listing_uid,

          aml.aircraft_id,
          aml.seller_airline_id,

          aml.listing_type,
          aml.listing_source,

          aml.status
            AS market_listing_status,

          'AVAILABLE'
            AS listing_status,

          TRUE
            AS is_player_listing,

          (
            aml.seller_airline_id = $1
          ) AS is_own_listing,

          af.manufacturer,
          af.model_key,

          COALESCE(
            NULLIF(
              aml.aircraft_name,
              ''
            ),
            af.aircraft_name,
            ac.aircraft_name,
            af.model_key
          ) AS aircraft_name,

          ac.model,
          ac.seats,
          ac.range_nm,
          ac.speed_kts,
          ac.engines,
          ac.aircraft_category,
          ac.image_filename,
          ac.image_filename
            AS image_file_name,

          af.serial_number,

          market_registration.registration_prefix
            AS previous_registration,

          market_registration.registration_prefix
            AS market_registration_prefix,

          COALESCE(
            seller_airline.airline_name,
            'AIRLINE SELLER'
          ) AS previous_operator,

          COALESCE(
            seller_airline.airline_name,
            'AIRLINE SELLER'
          ) AS previous_operator_name,

          aml.year_built,

          GREATEST(
            0,
            $2::INTEGER -
            COALESCE(
              aml.year_built,
              $2::INTEGER
            )
          ) AS age_years,

          aml.total_hours,
          aml.total_cycles,
          aml.condition_pct,

          COALESCE(
            aml.current_airport,
            af.current_airport,
            af.base_icao
          ) AS current_location,

          COALESCE(
            aml.current_airport,
            af.current_airport,
            af.base_icao
          ) AS current_airport,

          aml.base_value
            AS base_price,

          aml.asking_price
            AS market_price,

          aml.currency,

          af.maintenance_status,

          ams.c_check_due_hours,
          ams.c_check_due_cycles,
          ams.c_check_due_date,
          ams.c_check_status,

          ams.d_check_due_date,
          ams.d_check_status,

          ams.maintenance_control_status,
          ams.maintenance_control_reason,

          (
            active_cd.id IS NOT NULL
          ) AS active_cd_maintenance,

          active_cd.check_type
            AS active_cd_check_type,

          CASE
            WHEN active_cd.id IS NOT NULL
              THEN 'TEMPORARILY UNAVAILABLE'
            ELSE 'AVAILABLE'
          END AS commercial_availability_status,

          NULL::INTEGER
            AS reserved_by_airline_id,
           
          NULL::INTEGER
            AS sold_to_airline_id,

          aml.listed_sim_time
            AS listed_at,

          NULL::TIMESTAMP
            AS reserved_at,

          NULL::TIMESTAMP
            AS sold_at,

          'AIRLINE'
            AS market_source,

          FALSE
            AS system_generated,

          NULL::TEXT
            AS generation_batch_id,

          EXTRACT(
            YEAR FROM aml.listed_sim_time
          )::INTEGER
            AS generated_for_sim_year,

          NULL::INTEGER
            AS expires_sim_year,

          aml.seller_airline_id
            AS previous_airline_id,

          NULL::TEXT
            AS lessor_name,

         COALESCE(
            seller_airline.airline_name,
            'AIRLINE SELLER'
          ) AS remarketing_agent,

          CASE
            WHEN aml.listing_type = 'LEASE'
              THEN 'DIRECT AIRLINE LEASE'
            ELSE 'DIRECT AIRLINE SALE'
          END AS market_display_source,

          (
            aml.listing_type = 'SALE'
            AND aml.seller_airline_id <> $1
            AND active_cd.id IS NULL
          ) AS available_for_purchase,
          
          (
            aml.listing_type = 'LEASE'
            AND
            aml.seller_airline_id <> $1
          ) AS available_for_lease,

          aml.listing_type
            AS ownership_offer_type,

          FALSE
            AS broker_serviced,

          NULL::TIMESTAMP
            AS broker_serviced_at,

          0::INTEGER
            AS system_refresh_count,

          NULL::DATE
            AS system_refresh_last_sim_date,

          NULL::TEXT
            AS system_refresh_last_type,

          NULL::TEXT
            AS system_refresh_policy_version,

          aml.created_at,
          aml.updated_at

        FROM
          public.aircraft_market_listings aml

        INNER JOIN
          public.aircraft_fleet af
          ON af.id = aml.aircraft_id

        LEFT JOIN
          public.aircraft_catalog ac
          ON ac.model_key = af.model_key

                 LEFT JOIN
          public.aircraft_maintenance_status ams
          ON ams.aircraft_id = af.id
         AND ams.airline_id = af.airline_id

        LEFT JOIN LATERAL (
          SELECT
            ame.id,
            ame.check_type
          FROM public.aircraft_maintenance_events ame
          WHERE ame.aircraft_id = af.id
            AND ame.airline_id = af.airline_id
            AND ame.event_status = 'IN_PROGRESS'
            AND ame.check_type IN (
              'C_CHECK',
              'D_CHECK'
            )
          ORDER BY
            CASE ame.check_type
              WHEN 'D_CHECK' THEN 1
              WHEN 'C_CHECK' THEN 2
              ELSE 3
            END,
            ame.id DESC
          LIMIT 1
        ) active_cd
          ON TRUE

        LEFT JOIN
          public.airlines seller_airline
          ON seller_airline.airline_id =
             aml.seller_airline_id

        LEFT JOIN LATERAL (
          SELECT
            arp.registration_prefix
          FROM public.aircraft_registration_prefixes arp
          WHERE arp.is_active = TRUE
            AND COALESCE(
              af.base_icao,
              af.current_airport,
              ''
            ) LIKE (arp.icao_prefix || '%')
          ORDER BY
            LENGTH(arp.icao_prefix) DESC
          LIMIT 1
        ) market_registration
          ON TRUE

        WHERE aml.status IN (
          'ACTIVE',
          'OFFER_RECEIVED',
          'SALE_PENDING'
        )

        ORDER BY
          aml.listed_sim_time DESC,
          aml.id DESC
        `,
        [
          Number(req.airline_id),
          simDatePayload.sim_year
        ]
      );

    /*
      Prefix system listing IDs as well. This allows
      frontend actions to identify their real source.
    */

        const systemListings =
      result.rows.map(row => ({
        ...row,

        /*
          Keep the original numeric ID so the current
          Used Market purchase endpoint remains functional.
        */

        id:
          String(row.id),

        listing_source_type:
          "SYSTEM",

        system_listing_id:
          Number(row.id),

        market_listing_id:
          null,

        listing_type:
          row.ownership_offer_type ||
          "SALE",

        is_player_listing:
          false,

        is_own_listing:
          false
      }));
     
    const airlineListings =
      airlineListingsResult.rows;

    const usedMarketListings = [
      ...airlineListings,
      ...systemListings
    ];
     
    await client.query("COMMIT");

    return res.json({
      ok: true,
      endpoint: "ACS_USED_AIRCRAFT_MARKET",
      version: "v1.0",
      policy: {
        bootstrap_start_year: ACS_USED_MARKET_POLICY.bootstrapStartYear,
        bootstrap_end_year: ACS_USED_MARKET_POLICY.bootstrapEndYear,
        bootstrap_seed_total: ACS_USED_MARKET_POLICY.bootstrapSeedTotal,
        replacement_after_purchase: false,
        post_bootstrap_system_generation: false,
        policy_version: ACS_USED_MARKET_POLICY.policyVersion
      },
            seed_status: seedStatus,
      system_refresh: systemRefresh,
      sim_date_authority: {
        source: "ACS_TIME",
        sim_year: simDatePayload.sim_year,
        sim_month: simDatePayload.sim_month,
        sim_day: simDatePayload.sim_day,
        sim_date: simDatePayload.sim_date
      },
      count:
        usedMarketListings.length,

      market_counts: {
        airline_listings:
          airlineListings.length,

      system_listings:
          systemListings.length
      },

      used_market:
        usedMarketListings
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS USED AIRCRAFT MARKET ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "USED_AIRCRAFT_MARKET_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

/* ============================================================
   ACS AIRLINE AIRCRAFT SALE — TRANSACTION AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/market-listings/:id/buy

   Transaction:
   - Locks listing, aircraft and both Finance accounts.
   - Charges buyer.
   - Pays seller net proceeds.
   - Marks listing SOLD.
   - Transfers the same aircraft asset.
   - Transfers technical maintenance authority.
   - Assigns buyer registration.
   - Creates buyer and seller OCC alerts.
   ============================================================ */

router.post(
  "/aircraft/market-listings/:id/buy",
  requireAuth,
  async (req, res) => {
    const client =
      await pool.connect();

    let transactionStarted = false;

    try {
      const buyerAirlineId =
        Number(req.airline_id);

      const buyerUserId =
        req.user_id || null;

      const listingId =
        Number(req.params.id);

      if (
        !Number.isInteger(buyerAirlineId) ||
        buyerAirlineId <= 0
      ) {
        return res.status(401).json({
          ok: false,
          error: "NO_AIRLINE_SESSION"
        });
      }

      if (
        !Number.isInteger(listingId) ||
        listingId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_MARKET_LISTING_ID"
        });
      }

      await client.query("BEGIN");
      transactionStarted = true;

      const listingResult =
        await client.query(
          `
          SELECT
            aml.id,
            aml.aircraft_id,
            aml.seller_airline_id,
            aml.listing_type,
            aml.status,
            aml.currency,
            aml.asking_price,
            aml.broker_commission_amount,
            aml.estimated_net_proceeds,
            aml.registration
              AS previous_registration,

            af.aircraft_name,
            af.model_key,
            af.serial_number,
            af.ownership_type,
            af.status
              AS aircraft_status,

            ams.maintenance_control_status,
            ams.maintenance_control_reason,
            ams.c_check_status,
            ams.d_check_status,

            seller.airline_name
              AS seller_airline_name,

            buyer.airline_name
              AS buyer_airline_name,

            acs_get_current_sim_time()
              AS current_sim_time

          FROM public.aircraft_market_listings aml

          INNER JOIN public.aircraft_fleet af
            ON af.id = aml.aircraft_id
           AND af.airline_id =
               aml.seller_airline_id

          LEFT JOIN
            public.aircraft_maintenance_status ams
            ON ams.aircraft_id = af.id
           AND ams.airline_id = af.airline_id

          LEFT JOIN public.airlines seller
            ON seller.airline_id =
               aml.seller_airline_id

          LEFT JOIN public.airlines buyer
            ON buyer.airline_id = $2

          WHERE aml.id = $1

          FOR UPDATE OF aml, af
          `,
          [
            listingId,
            buyerAirlineId
          ]
        );

      if (!listingResult.rows.length) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(404).json({
          ok: false,
          error:
            "MARKET_LISTING_NOT_FOUND"
        });
      }

      const listing =
        listingResult.rows[0];

      const sellerAirlineId =
        Number(
          listing.seller_airline_id
        );

      if (
        sellerAirlineId ===
        buyerAirlineId
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          ok: false,
          error:
            "AIRLINE_CANNOT_BUY_OWN_AIRCRAFT"
        });
      }

      if (
        String(
          listing.listing_type || ""
        ).toUpperCase() !== "SALE"
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          ok: false,
          error:
            "MARKET_LISTING_NOT_FOR_SALE"
        });
      }

      if (
        ![
          "ACTIVE",
          "OFFER_RECEIVED",
          "SALE_PENDING"
        ].includes(
          String(
            listing.status || ""
          ).toUpperCase()
        )
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          ok: false,
          error:
            "MARKET_LISTING_NOT_ACTIVE",
          listing_status:
            listing.status
        });
      }

      const inProgressResult =
        await client.query(
          `
          SELECT
            id,
            check_type,
            event_status
          FROM public.aircraft_maintenance_events
          WHERE aircraft_id = $1
            AND event_status = 'IN_PROGRESS'
          LIMIT 1
          FOR UPDATE
          `,
          [
            listing.aircraft_id
          ]
        );

      if (inProgressResult.rows.length) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          ok: false,
          error:
            "AIRCRAFT_MAINTENANCE_IN_PROGRESS"
        });
      }

      const buyerBaseResult =
        await client.query(
          `
          SELECT
            base_icao
          FROM public.users
          WHERE user_id = $1
          LIMIT 1
          `,
          [
            buyerUserId
          ]
        );

      const buyerBaseIcao =
        buyerBaseResult.rows[0]
          ?.base_icao || null;

      if (!buyerBaseIcao) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          ok: false,
          error:
            "BUYER_BASE_ICAO_REQUIRED"
        });
      }

      const registrationRule =
        await ACS_RA_resolveRegistrationRule(
          client,
          buyerBaseIcao
        );

      const newRegistration =
        await ACS_RA_generateUniqueRegistration(
          client,
          registrationRule
        );

      const purchasePrice =
        Math.round(
          Number(
            listing.asking_price || 0
          )
        );

      const commissionAmount =
        Math.max(
          0,
          Math.round(
            Number(
              listing
                .broker_commission_amount ||
              0
            )
          )
        );

      const sellerNetProceeds =
        Math.max(
          0,
          Math.round(
            Number(
              listing
                .estimated_net_proceeds ||
              purchasePrice -
                commissionAmount
            )
          )
        );

      if (purchasePrice <= 0) {
        throw new Error(
          "INVALID_MARKET_PURCHASE_PRICE"
        );
      }

      /*
        Create both Finance authorities, then lock
        them in deterministic order.
      */

      await client.query(
        `
        INSERT INTO public.company_finance (
          airline_id,
          capital
        )
        VALUES
          ($1, 700000),
          ($2, 700000)
        ON CONFLICT (airline_id)
        DO NOTHING
        `,
        [
          buyerAirlineId,
          sellerAirlineId
        ]
      );

      const financeLockResult =
        await client.query(
          `
          SELECT
            airline_id,
            capital
          FROM public.company_finance
          WHERE airline_id =
            ANY($1::INTEGER[])
          ORDER BY airline_id
          FOR UPDATE
          `,
          [[
            buyerAirlineId,
            sellerAirlineId
          ]]
        );

      const buyerFinance =
        financeLockResult.rows.find(
          row =>
            Number(row.airline_id) ===
            buyerAirlineId
        );

      const buyerCapital =
        Math.round(
          Number(
            buyerFinance?.capital || 0
          )
        );

      if (
        buyerCapital <
        purchasePrice
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(409).json({
          ok: false,
          error:
            "INSUFFICIENT_CAPITAL",
          capital:
            buyerCapital,
          required:
            purchasePrice
        });
      }

      /*
        The listing stops being active before aircraft
        transfer. This releases the PostgreSQL commercial
        hold trigger inside this same transaction.
      */

      const soldListingResult =
        await client.query(
          `
          UPDATE public.aircraft_market_listings
          SET
            status = 'SOLD',
            updated_at = NOW(),
            version = version + 1
          WHERE id = $1
            AND status IN (
              'ACTIVE',
              'OFFER_RECEIVED',
              'SALE_PENDING'
            )
          RETURNING *
          `,
          [
            listingId
          ]
        );

      if (
        !soldListingResult.rows.length
      ) {
        throw new Error(
          "MARKET_LISTING_SALE_TRANSITION_FAILED"
        );
      }

      const technicalControl =
        String(
          listing
            .maintenance_control_status ||
          "SERVICEABLE"
        ).toUpperCase();

      const buyerFleetStatus =
        technicalControl ===
          "MAINTENANCE_REQUIRED"
          ? "GROUNDED"
          : "ACTIVE";

      const buyerOperationalStatus =
        technicalControl ===
          "MAINTENANCE_REQUIRED"
          ? "UNAVAILABLE"
          : "AVAILABLE";

      const buyerMaintenanceStatus =
        technicalControl ===
          "MAINTENANCE_REQUIRED"
          ? "CHECK_REQUIRED"
          : "SERVICEABLE";

      const transferredAircraftResult =
        await client.query(
          `
          UPDATE public.aircraft_fleet
          SET
            airline_id = $2,
            ownership_type = 'OWNED',

            status = $3,
            operational_status = $4,
            maintenance_status = $5,

            registration = $6,
            base_icao = $7,
            current_airport = $7,

            source = 'USED_MARKET',
            purchase_price = $8,
            current_value = $8,

            delivery_date = $9,
            entry_into_service_date = $9,

            updated_at = NOW()

          WHERE id = $1
            AND airline_id = $10
            AND ownership_type = 'OWNED'

          RETURNING *
          `,
          [
            listing.aircraft_id,
            buyerAirlineId,

            buyerFleetStatus,
            buyerOperationalStatus,
            buyerMaintenanceStatus,

            newRegistration,
            buyerBaseIcao,
            purchasePrice,
            listing.current_sim_time,

            sellerAirlineId
          ]
        );

      if (
        !transferredAircraftResult
          .rows.length
      ) {
        throw new Error(
          "AIRCRAFT_OWNERSHIP_TRANSFER_FAILED"
        );
      }

      /*
        Technical aircraft history follows the aircraft.
      */

      await client.query(
        `
        UPDATE public.aircraft_maintenance_status
        SET
          airline_id = $2,
          registration = $3,
          updated_at = NOW()
        WHERE aircraft_id = $1
          AND airline_id = $4
        `,
        [
          listing.aircraft_id,
          buyerAirlineId,
          newRegistration,
          sellerAirlineId
        ]
      );

      await client.query(
        `
        UPDATE public.aircraft_maintenance_events
        SET
          airline_id = $2,
          updated_at = NOW()
        WHERE aircraft_id = $1
          AND airline_id = $3
        `,
        [
          listing.aircraft_id,
          buyerAirlineId,
          sellerAirlineId
        ]
      );

      /*
        Buyer payment and seller proceeds.
      */

      await client.query(
        `
        UPDATE public.company_finance
        SET
          capital =
            COALESCE(capital, 0) - $2,

          cost_used_aircraft_purchase =
            COALESCE(
              cost_used_aircraft_purchase,
              0
            ) + $2,

          profit =
            COALESCE(profit, 0) - $2,

          updated_at = NOW()

        WHERE airline_id = $1
        `,
        [
          buyerAirlineId,
          purchasePrice
        ]
      );

      await client.query(
        `
        UPDATE public.company_finance
        SET
          capital =
            COALESCE(capital, 0) + $2,

          profit =
            COALESCE(profit, 0) + $2,

          updated_at = NOW()

        WHERE airline_id = $1
        `,
        [
          sellerAirlineId,
          sellerNetProceeds
        ]
      );

      const aircraftName =
        String(
          listing.aircraft_name ||
          listing.model_key ||
          "Aircraft"
        ).trim();

      const buyerAirlineName =
        String(
          listing.buyer_airline_name ||
          "Purchasing airline"
        ).trim();

      const sellerAirlineName =
        String(
          listing.seller_airline_name ||
          "Selling airline"
        ).trim();

      const simTimestamp =
        Math.floor(
          new Date(
            listing.current_sim_time
          ).getTime()
        );

      await client.query(
        `
        INSERT INTO public.finance_log (
          airline_id,
          type,
          source,
          amount,
          timestamp,
          created_at
        )
        VALUES
          (
            $1,
            'INVESTMENT',
            $2,
            $3,
            $7,
            NOW()
          ),
          (
            $4,
            'INCOME',
            $5,
            $6,
            $7,
            NOW()
          )
        `,
        [
          buyerAirlineId,
          `USED MARKET PURCHASE — ${aircraftName}`,
          purchasePrice,

          sellerAirlineId,
          `AIRCRAFT SALE — ${aircraftName} TO ${buyerAirlineName}`,
          sellerNetProceeds,

          simTimestamp
        ]
      );

      /*
        Alerts are part of the transaction.
        No successful transfer means no alert.
      */

      await client.query(
        `
        INSERT INTO public.occ_alerts (
          airline_id,
          alert_key,
          category,
          level,
          title,
          message,
          source,
          source_ref,
          event_sim_time,
          created_at,
          updated_at
        )
        VALUES
          (
            $1,
            $2,
            'aircraft',
            'info',
            'AIRCRAFT ACQUIRED',
            $3,
            'aircraft_market_listings',
            $4,
            $5,
            NOW(),
            NOW()
          ),
          (
            $6,
            $7,
            'aircraft',
            'info',
            'SALE COMPLETED',
            $8,
            'aircraft_market_listings',
            $4,
            $5,
            NOW(),
            NOW()
          )
        ON CONFLICT (
          airline_id,
          alert_key
        )
        WHERE deleted_at IS NULL
        DO NOTHING
        `,
        [
          buyerAirlineId,

          `AIRCRAFT_PURCHASE:${listingId}:${buyerAirlineId}`,

          `Your company acquired ${aircraftName} from ${sellerAirlineName} for ${listing.currency} ${purchasePrice.toLocaleString("en-US")}.`,

          String(listingId),
          listing.current_sim_time,

          sellerAirlineId,

          `AIRCRAFT_SALE:${listingId}:${buyerAirlineId}`,

          `${buyerAirlineName} purchased your ${aircraftName} for ${listing.currency} ${purchasePrice.toLocaleString("en-US")}.`
        ]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(201).json({
        ok: true,

        endpoint:
          "ACS_AIRLINE_AIRCRAFT_SALE",

        version: "v1.0",

        listing:
          soldListingResult.rows[0],

        aircraft:
          transferredAircraftResult
            .rows[0],

        transaction: {
          seller_airline_id:
            sellerAirlineId,

          buyer_airline_id:
            buyerAirlineId,

          purchase_price:
            purchasePrice,

          broker_commission:
            commissionAmount,

          seller_net_proceeds:
            sellerNetProceeds,

          currency:
            listing.currency,

          previous_registration:
            listing.previous_registration,

          new_registration:
            newRegistration
        }
      });

    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch (_) {}
      }

      console.error(
        "ACS AIRLINE AIRCRAFT SALE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRLINE_AIRCRAFT_SALE_FAILED",
        details:
          error?.message ||
          "Aircraft sale transaction failed."
      });

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   🟨 ACS AIRCRAFT MARKET LISTING — CANCEL OFFER v1.0
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/market-listings/:id/cancel

   SALE  → CANCEL SALE
   LEASE → CANCEL LEASE
   ============================================================ */

router.post(
  "/aircraft/market-listings/:id/cancel",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const airlineId =
        Number(req.airline_id);

      const listingId =
        Number(req.params.id);

      if (
        !Number.isInteger(airlineId) ||
        airlineId <= 0
      ) {
        return res.status(401).json({
          ok: false,
          error: "NO_AIRLINE_SESSION"
        });
      }

      if (
        !Number.isInteger(listingId) ||
        listingId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_MARKET_LISTING_ID"
        });
      }

      await client.query("BEGIN");

      /*
        Lock the listing and its aircraft.
        Only the airline that created the offer
        can cancel it.
      */

      const listingResult =
        await client.query(
          `
          SELECT
            aml.id,
            aml.aircraft_id,
            aml.seller_airline_id,
            aml.listing_type,
            aml.status,
            aml.registration
              AS previous_registration,

            af.status
              AS aircraft_status,

            af.operational_status,
            af.ownership_type,
            af.base_icao,
            af.current_airport

          FROM public.aircraft_market_listings aml

          INNER JOIN public.aircraft_fleet af
            ON af.id = aml.aircraft_id

          WHERE aml.id = $1
            AND aml.seller_airline_id = $2

          FOR UPDATE OF aml, af
          `,
          [
            listingId,
            airlineId
          ]
        );

      if (!listingResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "MARKET_LISTING_NOT_FOUND"
        });
      }

      const listing =
        listingResult.rows[0];

      const listingType =
        String(
          listing.listing_type || ""
        )
          .trim()
          .toUpperCase();

      if (
        listingType !== "SALE" &&
        listingType !== "LEASE"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: "INVALID_MARKET_LISTING_TYPE"
        });
      }

      if (
        ![
          "ACTIVE",
          "OFFER_RECEIVED",
          "SALE_PENDING"
        ].includes(
          String(listing.status || "")
            .trim()
            .toUpperCase()
        )
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: "MARKET_LISTING_NOT_ACTIVE",
          listing_status: listing.status
        });
      }

      const expectedAircraftStatus =
        listingType === "SALE"
          ? "FOR_SALE"
          : "FOR_LEASE";

      if (
        String(
          listing.aircraft_status || ""
        )
          .trim()
          .toUpperCase() !==
        expectedAircraftStatus
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "AIRCRAFT_MARKET_STATUS_MISMATCH",
          expected_status:
            expectedAircraftStatus,
          aircraft_status:
            listing.aircraft_status
        });
      }

      if (
        String(
          listing.ownership_type || ""
        )
          .trim()
          .toUpperCase() !== "OWNED"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: "AIRCRAFT_NOT_OWNED"
        });
      }

      /*
        Registration Authority assigns a new
        registration when the aircraft returns
        from the market.
      */

      const baseIcao =
        listing.base_icao ||
        listing.current_airport ||
        null;

      if (!baseIcao) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "REGISTRATION_BASE_ICAO_REQUIRED"
        });
      }

      const registrationRule =
        await ACS_RA_resolveRegistrationRule(
          client,
          baseIcao
        );

      const newRegistration =
        await ACS_RA_generateUniqueRegistration(
          client,
          registrationRule
        );

      /*
        Cancel the commercial offer.
      */

      const cancelledListingResult =
        await client.query(
          `
          UPDATE public.aircraft_market_listings
          SET
            status = 'CANCELLED',
            updated_at = NOW(),
            version = version + 1
          WHERE id = $1
            AND seller_airline_id = $2
          RETURNING
            id,
            aircraft_id,
            seller_airline_id,
            listing_type,
            status,
            updated_at,
            version
          `,
          [
            listingId,
            airlineId
          ]
        );

      /*
        Return aircraft to the airline fleet.

        Operational and maintenance conditions
        remain unchanged. Only the commercial
        market hold is removed.
      */

      const aircraftResult =
  await client.query(
    `
    UPDATE public.aircraft_fleet af
    SET
      status = CASE
        WHEN EXISTS (
          SELECT 1
          FROM public.aircraft_maintenance_events ame
          WHERE ame.aircraft_id = af.id
            AND ame.event_status = 'IN_PROGRESS'
        )
          THEN 'MAINTENANCE'

        WHEN COALESCE(
          (
            SELECT
              ams.maintenance_control_status
            FROM public.aircraft_maintenance_status ams
            WHERE ams.aircraft_id = af.id
              AND ams.airline_id = af.airline_id
            LIMIT 1
          ),
          'SERVICEABLE'
        ) = 'MAINTENANCE_REQUIRED'
          THEN 'GROUNDED'

        ELSE 'ACTIVE'
      END,

      operational_status = CASE
        WHEN EXISTS (
          SELECT 1
          FROM public.aircraft_maintenance_events ame
          WHERE ame.aircraft_id = af.id
            AND ame.event_status = 'IN_PROGRESS'
        )
          THEN 'IN_MAINTENANCE'

        WHEN COALESCE(
          (
            SELECT
              ams.maintenance_control_status
            FROM public.aircraft_maintenance_status ams
            WHERE ams.aircraft_id = af.id
              AND ams.airline_id = af.airline_id
            LIMIT 1
          ),
          'SERVICEABLE'
        ) = 'MAINTENANCE_REQUIRED'
          THEN 'UNAVAILABLE'

        ELSE 'AVAILABLE'
      END,

      maintenance_status = CASE
        WHEN COALESCE(
          (
            SELECT
              ams.maintenance_control_status
            FROM public.aircraft_maintenance_status ams
            WHERE ams.aircraft_id = af.id
              AND ams.airline_id = af.airline_id
            LIMIT 1
          ),
          'SERVICEABLE'
        ) IN (
          'MAINTENANCE_REQUIRED',
          'IN_MAINTENANCE'
        )
          THEN 'CHECK_REQUIRED'

        ELSE 'SERVICEABLE'
      END,

      registration = $3,
      updated_at = NOW()

    WHERE af.id = $1
      AND af.airline_id = $2
      AND af.ownership_type = 'OWNED'

    RETURNING
      af.id,
      af.airline_id,
      af.ownership_type,
      af.status,
      af.operational_status,
      af.maintenance_status,
      af.registration,
      af.base_icao,
      af.current_airport,
      af.updated_at
    `,
    [
      listing.aircraft_id,
      airlineId,
      newRegistration
    ]
  );

if (!aircraftResult.rows.length) {
  throw new Error(
    "AIRCRAFT_MARKET_RETURN_FAILED"
  );
}

      await client.query("COMMIT");

      const actionLabel =
        listingType === "SALE"
          ? "CANCEL SALE"
          : "CANCEL LEASE";

      return res.json({
        ok: true,

        endpoint:
          "ACS_AIRCRAFT_MARKET_CANCEL",

        version: "v1.0",

        action: actionLabel,

        listing:
          cancelledListingResult.rows[0],

        aircraft:
          aircraftResult.rows[0],

        registration: {
          previous:
            listing.previous_registration ||
            null,

          current:
            newRegistration
        },

        route_policy: {
          previous_routes_restored: false,
          previous_slots_restored: false,
          aircraft_available_for_new_assignment:
            true
        }
      });

    } catch (error) {
      await client.query("ROLLBACK");

      console.error(
        "ACS AIRCRAFT MARKET CANCEL ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRCRAFT_MARKET_CANCEL_FAILED",
        details: error.message
      });

    } finally {
      client.release();
    }
  }
);

/* ============================================================
   🟦 ACS USED AIRCRAFT PURCHASE — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/used-market/:id/buy

   ACS Policy:
   - Backend authority only
   - No localStorage
   - No frontend finance mutation
   - No frontend fleet creation
   - Purchased listings are NOT replaced automatically
   - Listing moves AVAILABLE → SOLD
   ============================================================ */

router.post("/aircraft/used-market/:id/buy", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const airlineId = Number(req.airline_id);
    const userId = req.user_id || null;
    const listingId = Number(req.params.id);

    if (!airlineId || !Number.isInteger(airlineId)) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!listingId || !Number.isInteger(listingId)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_USED_LISTING_ID"
      });
    }

    await client.query("BEGIN");

    /* ============================================================
       1) LOCK USED MARKET LISTING
       ============================================================ */

    const listingResult = await client.query(
      `
      SELECT
        uam.id,
        uam.listing_uid,
        uam.manufacturer,
        uam.model_key,
        uam.aircraft_name,
        uam.serial_number,
        uam.previous_registration,
        uam.previous_operator,
        uam.previous_operator_name,
        uam.year_built,
        uam.age_years,
        uam.total_hours,
        uam.total_cycles,
        uam.condition_pct,
        uam.current_location,
        uam.current_airport,
        uam.base_price,
        uam.market_price,
        uam.currency,
        uam.maintenance_status,
        uam.c_check_due_hours,
        uam.c_check_due_cycles,
        uam.d_check_due_date,
        uam.listing_status,
        uam.available_for_purchase,
        uam.available_for_lease,
        uam.ownership_offer_type,
        uam.market_source,
        uam.remarketing_agent,

        ac.model AS catalog_model,
        ac.price_acs_usd AS catalog_price,
        ac.aircraft_category,
        ac.image_filename

      FROM used_aircraft_market uam
      LEFT JOIN aircraft_catalog ac
        ON ac.model_key = uam.model_key
      WHERE uam.id = $1
      FOR UPDATE OF uam
      `,
      [listingId]
    );

    if (!listingResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        ok: false,
        error: "USED_LISTING_NOT_FOUND"
      });
    }

    const listing = listingResult.rows[0];

    if (listing.listing_status !== "AVAILABLE") {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "USED_LISTING_NOT_AVAILABLE",
        listing_status: listing.listing_status
      });
    }

    if (listing.available_for_purchase !== true) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "USED_LISTING_NOT_AVAILABLE_FOR_PURCHASE"
      });
    }

    const purchasePrice = Math.round(Number(listing.market_price || 0));

    if (!purchasePrice || purchasePrice <= 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_USED_MARKET_PRICE"
      });
    }

    /* ============================================================
       2) ENSURE + LOCK FINANCE ROW
       ============================================================ */

    await client.query(
      `
      INSERT INTO company_finance (airline_id, capital)
      VALUES ($1, 700000)
      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airlineId]
    );

    const financeBeforeResult = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airlineId]
    );

    const financeBefore = financeBeforeResult.rows[0];
    const currentCapital = Math.round(Number(financeBefore?.capital || 0));

    if (currentCapital < purchasePrice) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INSUFFICIENT_CAPITAL",
        capital: currentCapital,
        required: purchasePrice
      });
    }

    /* ============================================================
       3) RESOLVE ACS WORLD TIME + BASE AIRPORT
       ============================================================ */

/* ============================================================
   🟦 ACS USED BUY SIM DATE RESOLVER — OCC v1.2
   ------------------------------------------------------------
   Purpose:
   - Never use real server date as simulation authority.
   - Prefer explicit ACS sim date sent by frontend.
   - Fallback only to ACS world time.
   - If ACS time is unavailable, reject operation.
   ============================================================ */

const bodySimYear = Number(req.body?.sim_year);
const bodySimMonth = Number(req.body?.sim_month);
const bodySimDay = Number(req.body?.sim_day);

let simTime = null;

if (
  Number.isInteger(bodySimYear) &&
  bodySimYear >= 1900 &&
  bodySimYear <= 2100 &&
  Number.isInteger(bodySimMonth) &&
  bodySimMonth >= 1 &&
  bodySimMonth <= 12 &&
  Number.isInteger(bodySimDay) &&
  bodySimDay >= 1 &&
  bodySimDay <= 31
) {
  simTime = new Date(Date.UTC(
    bodySimYear,
    bodySimMonth - 1,
    bodySimDay,
    12,
    0,
    0
  ));
} else {
  const worldTimeResult = await client.query(
    `
    SELECT
      frozen_sim_time,
      sim_start
    FROM acs_world
    WHERE id = 1
    LIMIT 1
    `
  );

  const worldTime =
    worldTimeResult.rows[0]?.frozen_sim_time ||
    worldTimeResult.rows[0]?.sim_start ||
    null;

  if (!worldTime) {
    await client.query("ROLLBACK");

    return res.status(409).json({
      ok: false,
      error: "ACS_SIM_TIME_UNAVAILABLE",
      message: "ACS simulation time is required for used aircraft acquisition."
    });
  }

  simTime = new Date(worldTime);
}

if (!(simTime instanceof Date) || Number.isNaN(simTime.getTime())) {
  await client.query("ROLLBACK");

  return res.status(409).json({
    ok: false,
    error: "INVALID_ACS_SIM_TIME",
    message: "Invalid ACS simulation time received by backend."
  });
}

    let baseIcao = null;

    if (userId) {
      const baseResult = await client.query(
        `
        SELECT base_icao
        FROM users
        WHERE user_id = $1
        LIMIT 1
        `,
        [userId]
      );

      baseIcao = baseResult.rows[0]?.base_icao || null;
    }

    const currentAirport =
      listing.current_airport ||
      baseIcao ||
      null;

    const aircraftName =
      listing.aircraft_name ||
      `${listing.manufacturer} ${listing.catalog_model || listing.model_key}`;

    const currentValue = Math.round(
      Number(listing.market_price || listing.base_price || listing.catalog_price || 0)
    );

        /* ============================================================
       🟧 ACS USED MARKET OCC DECISION ENGINE v1.2
       ------------------------------------------------------------
       Rules:
       - Max 3 Used Market acquisitions per 24 real hours.
       - First 3 lifetime Used Market acquisitions may enter ACTIVE.
       - C/D overdue overrides starter privilege.
       - D-check overrides C-check.
       - After starter privilege, aircraft enters PENDING_DELIVERY.
       - A/B preparation is represented by delivery time only after
         the third ACTIVE starter aircraft.
       ============================================================ */

    const usedCycleResult = await client.query(
      `
      SELECT COUNT(*)::INTEGER AS cycle_count
      FROM aircraft_fleet
      WHERE airline_id = $1
        AND source = 'USED_MARKET'
        AND created_at >= (NOW() - INTERVAL '24 hours')
      `,
      [airlineId]
    );

    const usedLifetimeResult = await client.query(
      `
      SELECT COUNT(*)::INTEGER AS lifetime_count
      FROM aircraft_fleet
      WHERE airline_id = $1
        AND source = 'USED_MARKET'
      `,
      [airlineId]
    );

    const usedCycleCount = Number(
      usedCycleResult.rows[0]?.cycle_count || 0
    );

    const usedLifetimeCount = Number(
      usedLifetimeResult.rows[0]?.lifetime_count || 0
    );

    if (usedCycleCount >= 3) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        ok: false,
        error: "MARKET_GATE_NEXT_DAY",
        message: "Used market cycle limit.",
        market_gate: {
          code: "NEXT_DAY",
          label: "MARKET GATE: NEXT DAY",
          used_market_cycle_limit: true
        },
        policy: {
          max_used_market_acquisitions_per_cycle: 3,
          cycle_clock: "SERVER_REAL_TIME_24H",
          frontend_message: "MARKET GATE: NEXT DAY"
        }
      });
    }

    const starterPrivilegeAvailable = usedLifetimeCount < 3;

    const maintenanceText = String(
      listing.maintenance_status || ""
    ).toUpperCase();

    const dCheckDueDate = listing.d_check_due_date
      ? new Date(listing.d_check_due_date)
      : null;

    const dCheckOverdue =
      maintenanceText.includes("D-CHECK OVERDUE") ||
      maintenanceText.includes("D CHECK OVERDUE") ||
      maintenanceText.includes("D_OVERDUE") ||
      (
        dCheckDueDate instanceof Date &&
        !Number.isNaN(dCheckDueDate.getTime()) &&
        dCheckDueDate.getTime() <= new Date(simTime).getTime()
      );

    const cCheckDueHours = Number(listing.c_check_due_hours || 0);
    const cCheckDueCycles = Number(listing.c_check_due_cycles || 0);
    const listingHours = Number(listing.total_hours || 0);
    const listingCycles = Number(listing.total_cycles || 0);

    const cCheckOverdue =
      maintenanceText.includes("C-CHECK OVERDUE") ||
      maintenanceText.includes("C CHECK OVERDUE") ||
      maintenanceText.includes("C_OVERDUE") ||
      (
        cCheckDueHours > 0 &&
        listingHours >= cCheckDueHours
      ) ||
      (
        cCheckDueCycles > 0 &&
        listingCycles >= cCheckDueCycles
      );

    const requiredMaintenance =
      dCheckOverdue
        ? "D_CHECK"
        : cCheckOverdue
          ? "C_CHECK"
          : null;

    const usedBaseDeliveryDays = 10;

    const estimatedUsedDeliveryDate = new Date(
      new Date(simTime).getTime() +
      (usedBaseDeliveryDays * 24 * 60 * 60 * 1000)
    );

    let fleetStatus = "ACTIVE";
    let fleetOperationalStatus = "AVAILABLE";
    let fleetDeliveryDate = simTime;
    let fleetEntryIntoServiceDate = simTime;
    let usedDeliveryMode = "STARTER_ACTIVE";
    let usedMaintenanceDisposition = "CLEAR";

     if (requiredMaintenance) {
      fleetStatus = "MAINTENANCE";

      /*
        aircraft_fleet.operational_status CHECK constraint currently allows:
        AVAILABLE / ASSIGNED / IN_FLIGHT / IN_MAINTENANCE / UNAVAILABLE

        C_CHECK / D_CHECK are operational meanings, but they are not valid
        database values in this column. Store the DB-safe value here and
        keep the exact check type in usedPurchasePolicy.required_maintenance.
      */
      fleetOperationalStatus = "IN_MAINTENANCE";

      fleetDeliveryDate = starterPrivilegeAvailable
        ? simTime
        : estimatedUsedDeliveryDate;

      fleetEntryIntoServiceDate = null;

      usedDeliveryMode = starterPrivilegeAvailable
  ? (
      requiredMaintenance === "D_CHECK"
        ? "STARTER_D_CHECK_MAINTENANCE"
        : "STARTER_C_CHECK_MAINTENANCE"
    )
  : (
      requiredMaintenance === "D_CHECK"
        ? "DELIVERY_THEN_D_CHECK_MAINTENANCE"
        : "DELIVERY_THEN_C_CHECK_MAINTENANCE"
    );

      usedMaintenanceDisposition =
        requiredMaintenance === "D_CHECK"
          ? "D_CHECK_OVERDUE"
          : "C_CHECK_OVERDUE";

    } else if (!starterPrivilegeAvailable) {
      fleetStatus = "PENDING_DELIVERY";

      /*
        aircraft_fleet.operational_status does not currently allow IN_DELIVERY.
        Use UNAVAILABLE as DB-safe operational state while status carries
        PENDING_DELIVERY.
      */
      fleetOperationalStatus = "UNAVAILABLE";

      fleetDeliveryDate = estimatedUsedDeliveryDate;
      fleetEntryIntoServiceDate = null;
      usedDeliveryMode = "STANDARD_USED_DELIVERY";
      usedMaintenanceDisposition = "CLEAR";
    }

        /* ============================================================
       USED AIRCRAFT — DEPRECIATION INITIALIZATION
       ------------------------------------------------------------
       - Straight-line method
       - 20-year standard useful life
       - 24-month minimum remaining life
       - 5% residual value
       - Starts only when available for service
       ============================================================ */

    const depreciationBasis =
      purchasePrice;

    const depreciationResidualValue =
      Math.round(
        depreciationBasis * 0.05
      );

    const aircraftBuildYear =
      Number(listing.year_built);

    const hasValidBuildYear =
      Number.isInteger(aircraftBuildYear) &&
      aircraftBuildYear >= 1900 &&
      aircraftBuildYear <=
        simTime.getUTCFullYear();

    const historicalAgeMonths =
      hasValidBuildYear
        ? Math.max(
            0,
            (
              simTime.getUTCFullYear() -
              aircraftBuildYear
            ) * 12 +
            simTime.getUTCMonth()
          )
        : 216;

    const depreciationUsefulLifeMonths =
      Math.max(
        24,
        240 - historicalAgeMonths
      );

    const depreciationStartSim =
      fleetEntryIntoServiceDate || null;

    const depreciationStatus =
      depreciationStartSim
        ? "ACTIVE"
        : "PENDING_SERVICE";

     
    const usedPurchasePolicy = {
       
      version: "ACS_USED_MARKET_ACQUISITION_OCC_V1_2",
      used_cycle_count_before_purchase: usedCycleCount,
      used_lifetime_count_before_purchase: usedLifetimeCount,
      starter_privilege_available: starterPrivilegeAvailable,
      starter_privilege_limit: 3,
      market_gate: "CLEAR",
      max_used_market_acquisitions_per_24h: 3,
      required_maintenance: requiredMaintenance,
      maintenance_disposition: usedMaintenanceDisposition,
      delivery_mode: usedDeliveryMode,
      base_delivery_days_after_starter: usedBaseDeliveryDays,
      ab_check_policy:
        starterPrivilegeAvailable
          ? "A_B_NOT_APPLIED_TO_STARTER_ACTIVE_AIRCRAFT"
          : "A_B_PREPARATION_REPRESENTED_BY_DELIVERY_TIME",
      c_d_policy:
        "C_D_OVERDUE_OVERRIDES_ACTIVE_STATUS_D_CHECK_HAS_PRIORITY"
    };

    console.log("🟧 ACS USED BUY OCC DECISION:", usedPurchasePolicy);
     
    /* ============================================================
       4) CREATE AIRCRAFT_FLEET RECORD
       ------------------------------------------------------------
       Notes:
       - Registration uses previous_registration for now.
       - Dedicated backend re-registration system can replace this later.
       ============================================================ */

       const registrationRule = await ACS_RA_resolveRegistrationRule(client, baseIcao);
       const newRegistration = await ACS_RA_generateUniqueRegistration(client, registrationRule);
     
       const aircraftResult = await client.query(
      `
      INSERT INTO aircraft_fleet (
        aircraft_uid,
        airline_id,
        user_id,
        source,
        ownership_type,
        manufacturer,
        model_key,
        aircraft_name,
        registration,
        serial_number,
        new_aircraft_order_id,
        used_listing_id,
        status,
        operational_status,
        base_icao,
        current_airport,
        year_built,
        delivery_date,
        entry_into_service_date,
        total_hours,
        total_cycles,
        condition_pct,
        maintenance_status,
        purchase_price,
        current_value,

        depreciation_status,
        depreciation_method,
        depreciation_basis,
        depreciation_residual_value,
        depreciation_useful_life_months,
        depreciation_start_sim,
        accumulated_depreciation,
        book_value,
        depreciation_last_month_key,

        currency,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        'USED_MARKET',
        'OWNED',
        $3,
        $4,
        $5,
        $6,
        $7,
        NULL,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21,

        $22,
        'STRAIGHT_LINE',
        $23,
        $24,
        $25,
        $26,
        0,
        $23,
        NULL,

        'USD',
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        airlineId,
        userId,
        listing.manufacturer,
        listing.model_key,
        aircraftName,
        newRegistration,
        listing.serial_number || null,
        listing.id,

        fleetStatus,
        fleetOperationalStatus,

        baseIcao,
        currentAirport,
        listing.year_built || null,
        fleetDeliveryDate,
        fleetEntryIntoServiceDate,

        Number(listing.total_hours || 0),
        Number(listing.total_cycles || 0),
        Number(listing.condition_pct || 100),

        requiredMaintenance
          ? "CHECK_REQUIRED"
          : (listing.maintenance_status || "SERVICEABLE"),

        purchasePrice,
        currentValue,

        depreciationStatus,
        depreciationBasis,
        depreciationResidualValue,
        depreciationUsefulLifeMonths,
        depreciationStartSim
      ]
    );

    const aircraft = aircraftResult.rows[0];

    await ACS_ensureAircraftMaintenanceStatus(
      client,
      aircraft.id,
      aircraft.airline_id || airlineId,
      {
        baseSimTime:
          fleetEntryIntoServiceDate ||
          fleetDeliveryDate ||
          simTime
      }
    );

/* ============================================================
   5) APPLY FINANCE IMPACT
   ============================================================ */

     await client.query(
      `
      UPDATE company_finance
      SET
        capital =
          COALESCE(capital, 0) - $2,

        cost_used_aircraft_purchase =
          COALESCE(
            cost_used_aircraft_purchase,
            0
          ) + $2,

        updated_at = NOW()

      WHERE airline_id = $1
      `,
      [
        airlineId,
        purchasePrice
      ]
    );

    /* ============================================================
       6) FINANCE LOG
       ============================================================ */

     await client.query(
      `
      INSERT INTO finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp
      )
      VALUES (
        $1,
        'INVESTMENT',
        $2,
        $3,
        $4
      )
      `,
      [
        airlineId,
        `USED MARKET PURCHASE — ${aircraftName}`,
        purchasePrice,
        simTime.getTime()
      ]
    );

    /* ============================================================
       7) MARK USED LISTING AS SOLD
       ------------------------------------------------------------
       ACS Rule:
       - No automatic replacement.
       - Available market count decreases naturally.
       ============================================================ */

    const soldListingResult = await client.query(
      `
      UPDATE used_aircraft_market
      SET
        listing_status = 'SOLD',
        sold_to_airline_id = $2,
        sold_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [listing.id, airlineId]
    );

    const soldListing = soldListingResult.rows[0];

    /* ============================================================
       8) RETURN UPDATED FINANCE SNAPSHOT
       ============================================================ */

    const financeAfterResult = await client.query(
      `
      SELECT *
      FROM company_finance
      WHERE airline_id = $1
      `,
      [airlineId]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      endpoint: "ACS_USED_AIRCRAFT_PURCHASE",
      version: "v1.0",
      policy: {
        backend_authority: true,
        localStorage: false,
        replacement_after_purchase: false,
        listing_transition: "AVAILABLE_TO_SOLD"
      },
      aircraft,
      listing: soldListing,
      finance: financeAfterResult.rows[0],
       
      purchase: {
  listing_id: listing.id,
  aircraft_name: aircraftName,
  purchase_price: purchasePrice,
  currency: "USD",
  used_purchase_policy: usedPurchasePolicy,
  delivery: {
    mode: usedDeliveryMode,
    status: fleetStatus,
    operational_status: fleetOperationalStatus,
    estimated_delivery_date: fleetDeliveryDate,
    entry_into_service_date: fleetEntryIntoServiceDate
  },
  maintenance: {
    required_maintenance: requiredMaintenance,
    disposition: usedMaintenanceDisposition,
    d_check_overdue: dCheckOverdue,
    c_check_overdue: cCheckOverdue
  },
  market_gate: {
    code: "CLEAR",
    cycle_count_before_purchase: usedCycleCount,
    lifetime_count_before_purchase: usedLifetimeCount
  }
}
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS USED AIRCRAFT PURCHASE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "USED_AIRCRAFT_PURCHASE_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

/* ============================================================
   🟦 ACS AIRCRAFT PRODUCTION RULES — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/production-rules

   Purpose:
   - Read aircraft industrial production rules
   - Defines factory availability by manufacturer/model/year
   - PostgreSQL is authority
   - No localStorage authority
   - No Finance mutation
   - No Time Engine interaction
   ============================================================ */

router.get("/aircraft/production-rules", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        rule_uid,
        manufacturer,
        model_key,
        aircraft_name,
        aircraft_category,
        production_start_year,
        production_end_year,
        first_delivery_year,
        last_delivery_year,
        capacity_tier,
        manufacturer_weight,
        model_weight,
        monthly_min_units,
        monthly_max_units,
        is_factory_available,
        is_active_rule,
        notes,
        created_at,
        updated_at
      FROM aircraft_production_rules
      ORDER BY production_start_year ASC, manufacturer ASC, model_key ASC
      `
    );

    return res.json({
      ok: true,
      rules: result.rows
    });

  } catch (err) {
    console.error("ACS AIRCRAFT PRODUCTION RULES ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_PRODUCTION_RULES_FAILED",
      details: err.message
    });
  }
});


/* ============================================================
   🟦 ACS FACTORY CATALOG — BACKEND AUTHORITY v1.1
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/factory/catalog?year=1940

   Purpose:
   - Return aircraft models available from factory for a given year
   - PostgreSQL authority only
   - Join aircraft_catalog + aircraft_production_rules
   - aircraft_catalog provides technical/commercial specs
   - aircraft_production_rules provides historical OEM availability
   - Used Market and Fleet remain separate systems
   - No localStorage authority
   - No Finance mutation
   - No Time Engine interaction
   ============================================================ */

router.get("/aircraft/factory/catalog", requireAuth, async (req, res) => {
  try {
    const yearParam = req.query.year;
    const selectedYear = Number(yearParam);

    if (!yearParam || !Number.isInteger(selectedYear) || selectedYear < 1900 || selectedYear > 2100) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: "Valid year query parameter is required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        ac.id,
        ac.catalog_uid,
        ac.model_key,
        ac.manufacturer,
        ac.model,
        ac.aircraft_name,
        ac.production_year,
        ac.year,
        ac.seats,
        ac.range_nm,
        ac.speed_kts,
        ac.mtow_kg,
        ac.fuel_burn_kgph,
        ac.price_acs_usd,
        ac.engines,

        COALESCE(
          NULLIF(ac.raw_data ->> 'required_runway_m', '')::integer,
          0
        ) AS required_runway_m,

        ac.aircraft_category,
        ac.status,
        ac.image_filename,
        ac.image_filename AS image_file_name,

        pr.id AS production_rule_id,
        pr.rule_uid,
        pr.aircraft_category AS production_category,
        pr.production_start_year,
        pr.production_end_year,
        pr.first_delivery_year,
        pr.last_delivery_year,
        pr.capacity_tier,
        pr.manufacturer_weight,
        pr.model_weight,
        pr.monthly_min_units,
        pr.monthly_max_units,
        pr.monthly_min_units AS monthly_min,
        pr.monthly_max_units AS monthly_max,
        pr.is_factory_available,
        pr.is_active_rule

      FROM aircraft_catalog ac
      INNER JOIN aircraft_production_rules pr
        ON pr.model_key = ac.model_key

      WHERE
        COALESCE(ac.is_active, true) = true
        AND pr.is_active_rule = true
        AND pr.is_factory_available = true
        AND COALESCE(pr.production_start_year, ac.production_year, ac.year) <= $1
        AND (
          pr.production_end_year IS NULL
          OR pr.production_end_year >= $1
        )

      ORDER BY
        COALESCE(pr.production_start_year, ac.production_year, ac.year) ASC,
        ac.manufacturer ASC,
        ac.model ASC
      `,
      [selectedYear]
    );

    return res.json({
      ok: true,
      endpoint: "ACS_FACTORY_CATALOG",
      version: "v1.1",
      year: selectedYear,
      count: result.rows.length,

      aircraft: result.rows,

      /* Temporary migration alias — keep until Buy New fully migrates */
      factory_catalog: result.rows
    });

  } catch (err) {
    console.error("ACS FACTORY CATALOG ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_FACTORY_CATALOG_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 ACS AIRCRAFT CATALOG — BACKEND AUTHORITY v1.0
   ------------------------------------------------------------
   Route:
   GET /v1/aircraft/catalog

   Purpose:
   - Read the complete technical aircraft universe from PostgreSQL
   - Preserve ACS aircraft DB structure for modals, images and aircraft data
   - PostgreSQL becomes backend technical authority
   - No localStorage authority
   - No Finance mutation
   - No Time Engine interaction
   ============================================================ */

router.get("/aircraft/catalog", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        catalog_uid,
        model_key,
        manufacturer,
        model,
        aircraft_name,
        production_year,
        year,
        seats,
        range_nm,
        speed_kts,
        mtow_kg,
        fuel_burn_kgph,
        price_acs_usd,
        engines,
        aircraft_category,
        status,
        image_filename,
        raw_data,
        is_active,
        created_at,
        updated_at
      FROM aircraft_catalog
      WHERE is_active = true
      ORDER BY year ASC, manufacturer ASC, model ASC
      `
    );

    return res.json({
      ok: true,
      catalog: result.rows
    });

  } catch (err) {
    console.error("ACS AIRCRAFT CATALOG ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AIRCRAFT_CATALOG_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 ACS BUY NEW DELIVERY RESOLVER — DRY RUN v1.2
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/orders/delivery-resolver/dry-run

   Purpose:
   - Preview due Buy New aircraft orders
   - No Finance mutation
   - No aircraft_fleet insert
   - No factory slot update
   - No Time Engine mutation
   - Multiplayer-safe design preview

   v1.2 Scope:
   - PAID + PENDING_DELIVERY → deliver preview
   - FINANCED + sufficient capital → charge final payment + deliver preview
   - FINANCED + insufficient capital → move to PAYMENT_HOLD preview
   - PAYMENT_HOLD before grace limit → PAYMENT_HOLD_ACTIVE
   - PAYMENT_HOLD at/after grace limit → DEFAULT_AFTER_PAYMENT_HOLD
   - Default math:
     penalty = 25% initial_payment_amount
     refund  = 75% initial_payment_amount
   ============================================================ */

router.post("/aircraft/orders/delivery-resolver/dry-run", requireAuth, async (req, res) => {
  try {
    const simYear = Number(req.body?.sim_year);
    const simMonth = Number(req.body?.sim_month);
    const simDay = Number(req.body?.sim_day);

    if (!Number.isInteger(simYear) || simYear < 1900 || simYear > 2100) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_YEAR"
      });
    }

    if (!Number.isInteger(simMonth) || simMonth < 1 || simMonth > 12) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_MONTH"
      });
    }

    if (!Number.isInteger(simDay) || simDay < 1 || simDay > 31) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_SIM_DAY"
      });
    }

    const resolverDate = new Date(Date.UTC(
      simYear,
      simMonth - 1,
      simDay,
      12,
      0,
      0
    ));

    /* ============================================================
       1) LOAD DUE ORDERS — DRY RUN ONLY
       ------------------------------------------------------------
       Includes:
       - PENDING_DELIVERY orders due by estimated_delivery_date
       - PAYMENT_HOLD orders due for grace-period review
       ============================================================ */

    const dueOrdersResult = await pool.query(
      `
      SELECT
        o.id,
        o.order_uid,
        o.airline_id,
        o.user_id,
        o.manufacturer,
        o.model_key,
        o.aircraft_name,
        o.factory_slot_id,
        o.quantity,
        o.unit_price,
        o.total_price,
        o.ownership_type,
        o.initial_payment_amount,
        o.final_payment_amount,
        o.payment_status,
        o.final_payment_status,
        o.order_status,
        o.delivery_status,
        o.estimated_delivery_date,
        o.actual_delivery_date,
        o.payment_hold_started_at,
        o.payment_hold_until,
        o.default_penalty_amount,
        o.refund_amount,
        o.delivery_resolved_at,
        f.capital AS current_capital
      FROM new_aircraft_orders o
      LEFT JOIN company_finance f
        ON f.airline_id = o.airline_id
      WHERE o.source = 'FACTORY'
        AND o.order_status = 'ORDERED'
        AND o.delivery_status IN ('PENDING_DELIVERY', 'PAYMENT_HOLD')
        AND o.payment_status IN ('PAID', 'FINANCED')
        AND o.estimated_delivery_date IS NOT NULL
        AND o.estimated_delivery_date <= $1
      ORDER BY o.estimated_delivery_date ASC, o.id ASC
      `,
      [resolverDate]
    );

    /* ============================================================
       2) BUILD PREVIEW ACTIONS
       ============================================================ */

    const preview = dueOrdersResult.rows.map(order => {
      const paymentStatus = String(order.payment_status || "");
      const deliveryStatus = String(order.delivery_status || "");
      const finalPaymentStatus = String(order.final_payment_status || "");

      const capital = Math.round(Number(order.current_capital || 0));
      const initialPayment = Math.round(Number(order.initial_payment_amount || 0));
      const finalPayment = Math.round(Number(order.final_payment_amount || 0));

      const paymentHoldUntil = order.payment_hold_until
        ? new Date(order.payment_hold_until)
        : null;

      const defaultPenaltyAmount = Math.round(initialPayment * 0.25);
      const refundAmount = Math.round(initialPayment * 0.75);

      let resolver_action = "NO_ACTION";
      let resolver_reason = "NO_MATCHING_RULE";
      let payment_hold_status = null;
      let default_preview = null;

      /* ============================================================
         2A) STANDARD PENDING DELIVERY RULES
         ============================================================ */

     /* ============================================================
   🟦 LEASED ORDER DELIVERY PREVIEW — OCC v1.0
   ------------------------------------------------------------
   LEASED aircraft are not financed purchases.
   If lease commitment was paid, delivery proceeds normally.
   No final payment.
   No payment hold.
   ============================================================ */

if (
  deliveryStatus === "PENDING_DELIVERY" &&
  paymentStatus === "PAID" &&
  String(order.ownership_type || "") === "LEASED"
) {
  resolver_action = "LEASED_ORDER_DELIVER_READY";
  resolver_reason = "LEASE_COMMITMENT_PAID_NO_FINAL_PAYMENT_REQUIRED";
}

/* ============================================================
   🟩 PAID OWNED ORDER DELIVERY PREVIEW
   ============================================================ */

if (
  deliveryStatus === "PENDING_DELIVERY" &&
  paymentStatus === "PAID" &&
  String(order.ownership_type || "") !== "LEASED"
) {
  resolver_action = "DELIVER_PAID_ORDER";
  resolver_reason = "ORDER_FULLY_PAID_AND_DUE_FOR_DELIVERY";
}

      if (deliveryStatus === "PENDING_DELIVERY" && paymentStatus === "FINANCED") {
        if (capital >= finalPayment) {
          resolver_action = "CHARGE_FINAL_PAYMENT_AND_DELIVER";
          resolver_reason = "CAPITAL_SUFFICIENT_FOR_FINAL_PAYMENT";
        } else {
          resolver_action = "MOVE_TO_PAYMENT_HOLD";
          resolver_reason = "INSUFFICIENT_CAPITAL_FOR_FINAL_PAYMENT";
        }
      }

      /* ============================================================
         2B) PAYMENT HOLD GRACE PERIOD RULES — v1.2
         ------------------------------------------------------------
         If resolverDate < payment_hold_until:
         - Order remains in PAYMENT_HOLD

         If resolverDate >= payment_hold_until:
         - Order defaults
         - 25% of initial payment retained as penalty
         - 75% refunded to company capital
         - No aircraft created
         - Factory slot must be released in LIVE
         ============================================================ */

      if (deliveryStatus === "PAYMENT_HOLD") {
        if (!paymentHoldUntil || Number.isNaN(paymentHoldUntil.getTime())) {
          resolver_action = "PAYMENT_HOLD_REVIEW_BLOCKED";
          resolver_reason = "PAYMENT_HOLD_UNTIL_MISSING_OR_INVALID";
          payment_hold_status = "INVALID_PAYMENT_HOLD_DATE";
        } else if (resolverDate.getTime() < paymentHoldUntil.getTime()) {
          resolver_action = "PAYMENT_HOLD_ACTIVE";
          resolver_reason = "GRACE_PERIOD_STILL_ACTIVE";
          payment_hold_status = "ACTIVE";
        } else {
          resolver_action = "DEFAULT_AFTER_PAYMENT_HOLD";
          resolver_reason = "PAYMENT_HOLD_GRACE_PERIOD_EXPIRED";
          payment_hold_status = "EXPIRED";

          default_preview = {
            payment_status_after_default: "CANCELLED",
            final_payment_status_after_default: "DEFAULTED",
            delivery_status_after_default: "CANCELLED_PAYMENT_DEFAULT",
            default_penalty_amount: defaultPenaltyAmount,
            refund_amount: refundAmount,
            capital_before_refund: capital,
            capital_after_refund_preview: capital + refundAmount,
            aircraft_fleet_created: false,
            factory_slot_release_required: true,
            factory_slot_id: order.factory_slot_id || null
          };
        }
      }

      return {
        ...order,
        resolver_action,
        resolver_reason,
        resolver_date: resolverDate.toISOString(),

        payment_hold_status,
        payment_hold_until_iso: paymentHoldUntil
          ? paymentHoldUntil.toISOString()
          : null,

        capital_available: capital,
        initial_payment_amount_numeric: initialPayment,
        final_payment_required: finalPayment,
        capital_sufficient_for_final_payment: capital >= finalPayment,

        default_penalty_preview: defaultPenaltyAmount,
        refund_preview: refundAmount,
        default_preview,

        dry_run_only: true,
        mutation_performed: false
      };
    });

    return res.json({
      ok: true,
      endpoint: "ACS_BUY_NEW_DELIVERY_RESOLVER_DRY_RUN",
      version: "v1.2",
      mode: "DRY_RUN_NO_MUTATION",
      resolver_date: resolverDate.toISOString(),
      due_count: preview.length,
      due_orders: preview
    });

  } catch (err) {
    console.error("ACS BUY NEW DELIVERY RESOLVER DRY RUN ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "BUY_NEW_DELIVERY_RESOLVER_DRY_RUN_FAILED",
      details: err.message
    });
  }
});

/* ============================================================
   🟦 ACS BUY NEW DELIVERY RESOLVER — LIVE v1.2
   ------------------------------------------------------------
   Route:
   POST /v1/aircraft/orders/delivery-resolver

   Purpose:
   - Resolve due Buy New aircraft orders
   - Multiplayer-safe backend authority
   - Charges final payment when capital is sufficient
   - Delivers aircraft into aircraft_fleet
   - Moves financed orders to PAYMENT_HOLD when capital is insufficient
   - Defaults PAYMENT_HOLD orders after 30 simulated days
   - Releases factory slot on payment default
   - Registers finance_log entries
   - Does NOT mutate Time Engine
   - Does NOT use localStorage
   - Does NOT touch Lease New

   v1.2 Scope:
   - PAID + PENDING_DELIVERY → deliver
   - FINANCED + sufficient capital → charge final payment + deliver
   - FINANCED + insufficient capital → PAYMENT_HOLD
   - PAYMENT_HOLD + resolverDate < payment_hold_until → keep active
   - PAYMENT_HOLD + resolverDate >= payment_hold_until → DEFAULT
   ============================================================ */

router.post("/aircraft/orders/delivery-resolver", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
        const requestedOrderId =
      req.body?.order_id === undefined ||
      req.body?.order_id === null ||
      req.body?.order_id === ""
        ? null
        : Number(req.body.order_id);

    if (
      requestedOrderId !== null &&
      (
        !Number.isInteger(requestedOrderId) ||
        requestedOrderId <= 0
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_ORDER_ID"
      });
    }

    await client.query("BEGIN");

    const resolverClockResult =
      await client.query(
        `
        SELECT
          acs_get_current_sim_time()::TIMESTAMP
            AS sim_time,

          EXTRACT(
            YEAR FROM acs_get_current_sim_time()
          )::INTEGER AS sim_year,

          EXTRACT(
            MONTH FROM acs_get_current_sim_time()
          )::INTEGER AS sim_month,

          EXTRACT(
            DAY FROM acs_get_current_sim_time()
          )::INTEGER AS sim_day
        `
      );

    const resolverClock =
      resolverClockResult.rows[0];

    if (!resolverClock?.sim_time) {
      throw new Error(
        "ACS_DELIVERY_SIM_TIME_UNAVAILABLE"
      );
    }

    const resolverDate =
      new Date(resolverClock.sim_time);

    const simYear =
      Number(resolverClock.sim_year);

    const simMonth =
      Number(resolverClock.sim_month);

    const simDay =
      Number(resolverClock.sim_day);

    /* ============================================================
       1) LOAD DUE ORDERS — MULTIPLAYER SAFE
       ------------------------------------------------------------
       Includes:
       - PENDING_DELIVERY due orders
       - PAYMENT_HOLD due orders for grace/default review

       Optional:
       - requestedOrderId limits LIVE mutation to one order.
       ============================================================ */

    const dueOrdersResult = await client.query(
      `
      SELECT
        o.*,
        f.capital AS current_capital,
        u.base_icao AS user_base_icao
      FROM new_aircraft_orders o
      LEFT JOIN company_finance f
        ON f.airline_id = o.airline_id
      LEFT JOIN users u
        ON u.user_id = o.user_id
      WHERE o.source = 'FACTORY'
        AND o.order_status = 'ORDERED'
        AND o.delivery_status IN ('PENDING_DELIVERY', 'PAYMENT_HOLD')
        AND o.payment_status IN ('PAID', 'FINANCED')
        AND o.estimated_delivery_date IS NOT NULL
        AND o.estimated_delivery_date <= $1
        AND ($2::BIGINT IS NULL OR o.id = $2::BIGINT)
      ORDER BY o.estimated_delivery_date ASC, o.id ASC
      FOR UPDATE OF o SKIP LOCKED
      `,
      [resolverDate, requestedOrderId]
    );

    const processed = [];
    const skipped = [];

    /* ============================================================
       2) PROCESS EACH DUE ORDER
       ============================================================ */

    for (const order of dueOrdersResult.rows) {
      const orderId = Number(order.id);
      const airlineId = Number(order.airline_id);
      const quantity = Math.max(1, Number(order.quantity || 1));

      const paymentStatus = String(order.payment_status || "");
      const deliveryStatus = String(order.delivery_status || "");

      const initialPaymentAmount = Math.round(Number(order.initial_payment_amount || 0));
      const finalPaymentAmount = Math.round(Number(order.final_payment_amount || 0));
      const currentCapital = Math.round(Number(order.current_capital || 0));

      const aircraftLabel =
        order.aircraft_name ||
        `${order.manufacturer || ""} ${order.model_key || ""}`.trim();

      const baseIcao =
        order.user_base_icao ||
        null;

      /* ============================================================
         2A) PAYMENT HOLD DEFAULT REVIEW — v1.2
         ------------------------------------------------------------
         Rule:
         If resolverDate >= payment_hold_until and order remains
         PAYMENT_HOLD:
         - Cancel order
         - final_payment_status = DEFAULTED
         - delivery_status = CANCELLED_PAYMENT_DEFAULT
         - Retain 25% initial payment as penalty
         - Refund 75% initial payment to capital
         - Release factory slot
         - Do NOT create aircraft_fleet
         ============================================================ */

      if (deliveryStatus === "PAYMENT_HOLD") {
        const paymentHoldUntil = order.payment_hold_until
          ? new Date(order.payment_hold_until)
          : null;

        if (!paymentHoldUntil || Number.isNaN(paymentHoldUntil.getTime())) {
          skipped.push({
            order_id: orderId,
            airline_id: airlineId,
            aircraft_name: aircraftLabel,
            action: "PAYMENT_HOLD_REVIEW_BLOCKED",
            reason: "PAYMENT_HOLD_UNTIL_MISSING_OR_INVALID"
          });

          continue;
        }

        if (resolverDate.getTime() < paymentHoldUntil.getTime()) {
          processed.push({
            order_id: orderId,
            airline_id: airlineId,
            aircraft_name: aircraftLabel,
            action: "PAYMENT_HOLD_ACTIVE",
            reason: "GRACE_PERIOD_STILL_ACTIVE",
            payment_hold_until: paymentHoldUntil.toISOString(),
            mutation: "NO_DEFAULT_APPLIED"
          });

          continue;
        }

        const defaultPenaltyAmount = Math.round(initialPaymentAmount * 0.25);
        const refundAmount = Math.round(initialPaymentAmount * 0.75);

        /* ============================================================
           2A.1) LOCK FINANCE ROW
           ============================================================ */

        await client.query(
          `
          SELECT airline_id
          FROM company_finance
          WHERE airline_id = $1
          FOR UPDATE
          `,
          [airlineId]
        );

        /* ============================================================
           2A.2) APPLY REFUND TO COMPANY CAPITAL
           ------------------------------------------------------------
           Penalty is retained by OEM.
           Since the original initial payment was already recorded as an
           expense when the order was created, LIVE default only returns
           the refundable 75% to capital and logs both audit lines.
           ============================================================ */

        const financeBeforeDefaultResult = await client.query(
          `
          SELECT *
          FROM company_finance
          WHERE airline_id = $1
          `,
          [airlineId]
        );

        const financeBeforeDefault = financeBeforeDefaultResult.rows[0] || null;
        const capitalBeforeRefund = Math.round(Number(financeBeforeDefault?.capital || 0));

                await client.query(
          `
          UPDATE company_finance
          SET
            capital =
              COALESCE(capital, 0) + $2,

            expenses =
              COALESCE(expenses, 0) + $3,

            profit =
              COALESCE(profit, 0) - $3,

            cost_new_aircraft_purchase =
              GREATEST(
                COALESCE(
                  cost_new_aircraft_purchase,
                  0
                ) - $4,
                0
              ),

            cost_other =
              COALESCE(cost_other, 0) + $3,

            updated_at = NOW()

          WHERE airline_id = $1
          `,
          [
            airlineId,
            refundAmount,
            defaultPenaltyAmount,
            initialPaymentAmount
          ]
        );

        const financeAfterDefaultResult = await client.query(
          `
          SELECT *
          FROM company_finance
          WHERE airline_id = $1
          `,
          [airlineId]
        );

        const financeAfterDefault = financeAfterDefaultResult.rows[0] || null;
        const capitalAfterRefund = Math.round(Number(financeAfterDefault?.capital || 0));

        /* ============================================================
           2A.3) FINANCE LOG — REFUND + PENALTY
           ============================================================ */

                await client.query(
          `
          INSERT INTO finance_log (
            airline_id,
            type,
            source,
            amount,
            timestamp,
            created_at
          )
          VALUES
            (
              $1,
              'INCOME',
              $2,
              $3,
              FLOOR(
                EXTRACT(
                  EPOCH FROM acs_get_current_sim_time()
                ) * 1000
              )::BIGINT,
              NOW()
            ),
            (
              $1,
              'EXPENSE',
              $4,
              $5,
              FLOOR(
                EXTRACT(
                  EPOCH FROM acs_get_current_sim_time()
                ) * 1000
              )::BIGINT,
              NOW()
            )
          `,
          [
            airlineId,
            `OEM PURCHASE DEFAULT REFUND — ${aircraftLabel}`,
            refundAmount,
            `OEM PURCHASE DEFAULT PENALTY — ${aircraftLabel}`,
            defaultPenaltyAmount
          ]
        );

        /* ============================================================
           2A.4) RELEASE FACTORY SLOT(S)
           ------------------------------------------------------------
           Uses notes.factory_slots_reserved when available.
           Fallback: factory_slot_id + order quantity.
           ============================================================ */

        let reservedSlots = [];

        try {
          const parsedNotes =
            order.notes && String(order.notes).trim()
              ? JSON.parse(order.notes)
              : {};

          if (Array.isArray(parsedNotes.factory_slots_reserved)) {
            reservedSlots = parsedNotes.factory_slots_reserved;
          }
        } catch (notesError) {
          reservedSlots = [];
        }

        if (!reservedSlots.length && order.factory_slot_id) {
          reservedSlots = [{
            slot_id: order.factory_slot_id,
            reserved_quantity: quantity
          }];
        }

        const releasedSlots = [];

        for (const slot of reservedSlots) {
          const slotId = Number(slot.slot_id);
          const reservedQty = Math.max(1, Number(slot.reserved_quantity || 1));

          if (!slotId) continue;

          const slotUpdateResult = await client.query(
            `
            UPDATE aircraft_factory_slots
            SET
              reserved_quantity = GREATEST(COALESCE(reserved_quantity, 0) - $2, 0),
              available_quantity = COALESCE(available_quantity, 0) + $2,
              slot_status = CASE
                WHEN COALESCE(available_quantity, 0) + $2 > 0
                THEN 'OPEN'
                ELSE slot_status
              END,
              utilization_pct = ROUND(
                (
                  (
                    GREATEST(COALESCE(reserved_quantity, 0) - $2, 0)
                    + COALESCE(delivered_quantity, 0)
                  )::NUMERIC
                  /
                  GREATEST(COALESCE(max_quantity, 0), 1)::NUMERIC
                ) * 100,
                2
              ),
              updated_at = NOW()
            WHERE id = $1
            RETURNING
              id,
              available_quantity,
              reserved_quantity,
              delivered_quantity,
              slot_status,
              utilization_pct
            `,
            [slotId, reservedQty]
          );

          if (slotUpdateResult.rows[0]) {
            releasedSlots.push(slotUpdateResult.rows[0]);
          }
        }

        /* ============================================================
           2A.5) MARK ORDER AS CANCELLED PAYMENT DEFAULT
           ============================================================ */

        const defaultOrderResult = await client.query(
          `
          UPDATE new_aircraft_orders
          SET
            payment_status = 'CANCELLED',
            final_payment_status = 'DEFAULTED',
            order_status = 'CANCELLED',
            delivery_status = 'CANCELLED_PAYMENT_DEFAULT',
            default_penalty_amount = $2,
            refund_amount = $3,
            delivery_resolved_at = NOW(),
            notes = (
              COALESCE(NULLIF(notes, ''), '{}')::jsonb
              || jsonb_build_object(
                'delivery_resolver', 'ACS_BUY_NEW_DELIVERY_RESOLVER_LIVE_V1_2_DEFAULT',
                'payment_default_applied', true,
                'delivery_resolver_date', ($4::timestamp)::text,
                'payment_hold_until', ($5::timestamp)::text,
                'default_penalty_amount', $2::numeric,
                'refund_amount', $3::numeric,
                'capital_before_refund', $6::numeric,
                'capital_after_refund', $7::numeric,
                'aircraft_fleet_created', false,
                'factory_slots_released', $8::jsonb
              )
            )::text,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [
            orderId,
            defaultPenaltyAmount,
            refundAmount,
            resolverDate,
            paymentHoldUntil,
            capitalBeforeRefund,
            capitalAfterRefund,
            JSON.stringify(releasedSlots)
          ]
        );

        processed.push({
          order_id: orderId,
          airline_id: airlineId,
          aircraft_name: aircraftLabel,
          action: "DEFAULT_AFTER_PAYMENT_HOLD_APPLIED",
          reason: "PAYMENT_HOLD_GRACE_PERIOD_EXPIRED",
          payment_status: "CANCELLED",
          final_payment_status: "DEFAULTED",
          delivery_status: "CANCELLED_PAYMENT_DEFAULT",
          default_penalty_amount: defaultPenaltyAmount,
          refund_amount: refundAmount,
          capital_before_refund: capitalBeforeRefund,
          capital_after_refund: capitalAfterRefund,
          aircraft_fleet_created: false,
          released_slots: releasedSlots,
          order: defaultOrderResult.rows[0],
          finance: financeAfterDefault
        });

        continue;
      }

  /* ============================================================
   🟦 LEASED ORDER DELIVERY — OCC v1.0
   ------------------------------------------------------------
   LEASED aircraft are operational lease assets.
   Rules:
   - No final purchase payment
   - No PAYMENT_HOLD
   - Create aircraft_fleet as LEASED
   - Factory slot moves reserved → delivered
   - Leasing contract will be created in a later module
   ============================================================ */

if (
  deliveryStatus === "PENDING_DELIVERY" &&
  paymentStatus === "PAID" &&
  String(order.ownership_type || "") === "LEASED"
) {
  /* ============================================================
     2B.1) INSERT LEASED AIRCRAFT INTO FLEET
     ============================================================ */

  const insertedAircraft = [];

    for (let i = 0; i < quantity; i += 1) {
    const registrationRule = await ACS_RA_resolveRegistrationRule(client, baseIcao);
    const newRegistration = await ACS_RA_generateUniqueRegistration(client, registrationRule);

    const fleetResult = await client.query(
      `
      INSERT INTO aircraft_fleet (
        aircraft_uid,
        airline_id,
        user_id,
        source,
        ownership_type,
        manufacturer,
        model_key,
        aircraft_name,
        registration,
        serial_number,
        line_number,
        new_aircraft_order_id,
        used_listing_id,
        status,
        operational_status,
        base_icao,
        current_airport,
        year_built,
        delivery_date,
        entry_into_service_date,
        total_hours,
        total_cycles,
        condition_pct,
        maintenance_status,
        purchase_price,
        current_value,

        depreciation_status,
        depreciation_method,
        depreciation_basis,
        depreciation_residual_value,
        depreciation_useful_life_months,
        depreciation_start_sim,
        accumulated_depreciation,
        book_value,
        depreciation_last_month_key,

        currency,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        'FACTORY',
        'LEASED',
        $3,
        $4,
        $5,
        $11,
        NULL,
        NULL,
        $6,
        NULL,
        'ACTIVE',
        'AVAILABLE',
        $7,
        $7,
        $8,
        $9,
        $9,
        0,
        0,
        100,
        'SERVICEABLE',
        0,
        $10,

        'NOT_APPLICABLE',
        NULL,
        0,
        0,
        0,
        NULL,
        0,
        0,
        NULL,

        'USD',
        NOW(),
        NOW()
      )
      RETURNING id, aircraft_uid, airline_id, model_key, aircraft_name, ownership_type, status, operational_status
      `,
      [
        airlineId,
        order.user_id || null,
        order.manufacturer,
        order.model_key,
        aircraftLabel,
        orderId,
        baseIcao,
        simYear,
        resolverDate,
        Math.round(Number(order.unit_price || 0)),
        newRegistration
      ]
    );

      const fleetAircraft = fleetResult.rows[0];

    await ACS_ensureAircraftMaintenanceStatus(
      client,
      fleetAircraft.id,
      fleetAircraft.airline_id || airlineId
    );

    insertedAircraft.push(fleetAircraft);
  }

  /* ============================================================
     2B.2) UPDATE FACTORY SLOT(S) FROM RESERVED TO DELIVERED
     ============================================================ */

  let reservedSlots = [];

  try {
    const parsedNotes =
      order.notes && String(order.notes).trim()
        ? JSON.parse(order.notes)
        : {};

    if (Array.isArray(parsedNotes.factory_slots_reserved)) {
      reservedSlots = parsedNotes.factory_slots_reserved;
    }
  } catch (notesError) {
    reservedSlots = [];
  }

  if (!reservedSlots.length && order.factory_slot_id) {
    reservedSlots = [{
      slot_id: order.factory_slot_id,
      reserved_quantity: quantity
    }];
  }

  for (const slot of reservedSlots) {
    const slotId = Number(slot.slot_id);
    const reservedQty = Math.max(1, Number(slot.reserved_quantity || 1));

    if (!slotId) continue;

    await client.query(
      `
      UPDATE aircraft_factory_slots
      SET
        reserved_quantity = GREATEST(COALESCE(reserved_quantity, 0) - $2, 0),
        delivered_quantity = COALESCE(delivered_quantity, 0) + $2,
        slot_status = CASE
          WHEN COALESCE(available_quantity, 0) <= 0
          THEN 'FULL'
          ELSE 'OPEN'
        END,
        utilization_pct = ROUND(
          (
            (
              GREATEST(COALESCE(reserved_quantity, 0) - $2, 0)
              + COALESCE(delivered_quantity, 0)
              + $2
            )::NUMERIC
            /
            GREATEST(COALESCE(max_quantity, 0), 1)::NUMERIC
          ) * 100,
          2
        ),
        updated_at = NOW()
      WHERE id = $1
      `,
      [slotId, reservedQty]
    );
  }

  /* ============================================================
     2B.3) MARK LEASE ORDER AS DELIVERED
     ============================================================ */

  const orderUpdateResult = await client.query(
    `
    UPDATE new_aircraft_orders
    SET
      payment_status = 'PAID',
      final_payment_status = 'PAID',
      order_status = 'COMPLETED',
      delivery_status = 'DELIVERED',
      actual_delivery_date = $2::timestamp,
      delivery_resolved_at = NOW(),
      notes = (
        COALESCE(NULLIF(notes, ''), '{}')::jsonb
        || jsonb_build_object(
          'delivery_resolver', 'ACS_BUY_NEW_DELIVERY_RESOLVER_LIVE_V1_2_LEASED',
          'leased_delivery_resolved', true,
          'delivery_resolver_date', ($2::timestamp)::text,
          'aircraft_created_count', $3::integer,
          'ownership_type', 'LEASED',
          'final_payment_charged', 0,
          'payment_hold_applied', false,
          'lease_contract_pending', true
        )
      )::text,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [orderId, resolverDate, insertedAircraft.length]
  );

  processed.push({
    order_id: orderId,
    airline_id: airlineId,
    aircraft_name: aircraftLabel,
    action: "LEASED_ORDER_DELIVERED",
    reason: "LEASE_COMMITMENT_PAID_NO_FINAL_PAYMENT_REQUIRED",
    ownership_type: "LEASED",
    final_payment_charged: 0,
    payment_hold_applied: false,
    aircraft_created_count: insertedAircraft.length,
    aircraft: insertedAircraft,
    order: orderUpdateResult.rows[0]
  });

  continue;
}
       
      /* ============================================================
         2B) PENDING DELIVERY RULES
         ============================================================ */

      const shouldChargeFinalPayment =
        paymentStatus === "FINANCED" &&
        finalPaymentAmount > 0;

      if (shouldChargeFinalPayment && currentCapital < finalPaymentAmount) {
        const paymentHoldUntil = new Date(
          resolverDate.getTime() + (30 * 24 * 60 * 60 * 1000)
        );

        const holdResult = await client.query(
          `
          UPDATE new_aircraft_orders
          SET
            delivery_status = 'PAYMENT_HOLD',
            final_payment_status = 'PAYMENT_HOLD',
            payment_hold_started_at = $2::timestamp,
            payment_hold_until = $3::timestamp,
            notes = (
              COALESCE(NULLIF(notes, ''), '{}')::jsonb
              || jsonb_build_object(
                'delivery_resolver', 'ACS_BUY_NEW_DELIVERY_RESOLVER_LIVE_V1_2_PAYMENT_HOLD',
                'payment_hold_triggered', true,
                'payment_hold_reason', 'INSUFFICIENT_CAPITAL_FOR_FINAL_PAYMENT',
                'payment_hold_started_at', ($2::timestamp)::text,
                'payment_hold_until', ($3::timestamp)::text,
                'capital_available_at_delivery', $4::numeric,
                'final_payment_required', $5::numeric
              )
            )::text,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [
            orderId,
            resolverDate,
            paymentHoldUntil,
            currentCapital,
            finalPaymentAmount
          ]
        );

        processed.push({
          order_id: orderId,
          airline_id: airlineId,
          aircraft_name: aircraftLabel,
          action: "MOVED_TO_PAYMENT_HOLD",
          capital_available: currentCapital,
          final_payment_required: finalPaymentAmount,
          payment_hold_started_at: resolverDate.toISOString(),
          payment_hold_until: paymentHoldUntil.toISOString(),
          order: holdResult.rows[0]
        });

        continue;
      }

      /* ============================================================
         2C) LOCK FINANCE ROW
         ============================================================ */

      await client.query(
        `
        SELECT airline_id
        FROM company_finance
        WHERE airline_id = $1
        FOR UPDATE
        `,
        [airlineId]
      );

      /* ============================================================
         2D) CHARGE FINAL PAYMENT IF FINANCED
         ============================================================ */

      if (shouldChargeFinalPayment) {
         
                await client.query(
          `
          UPDATE company_finance
          SET
            capital =
              COALESCE(capital, 0) - $2,

            cost_new_aircraft_purchase =
              COALESCE(
                cost_new_aircraft_purchase,
                0
              ) + $2,

            updated_at = NOW()

          WHERE airline_id = $1
          `,
          [
            airlineId,
            finalPaymentAmount
          ]
        );

        await client.query(
          `
          INSERT INTO finance_log (
            airline_id,
            type,
            source,
            amount,
            timestamp,
            created_at
          )
          VALUES (
            $1,
            'INVESTMENT',
            $2,
            $3,
            FLOOR(
              EXTRACT(
                EPOCH FROM acs_get_current_sim_time()
              ) * 1000
            )::BIGINT,
            NOW()
          )
          `,
          [
            airlineId,
            `OEM PURCHASE FINAL — ${aircraftLabel}`,
            finalPaymentAmount
          ]
        );
      }

      /* ============================================================
         2E) INSERT AIRCRAFT INTO FLEET
         ============================================================ */

      const insertedAircraft = [];

      for (let i = 0; i < quantity; i += 1) {
        const registrationRule = await ACS_RA_resolveRegistrationRule(client, baseIcao);
        const newRegistration = await ACS_RA_generateUniqueRegistration(client, registrationRule);

        const fleetResult = await client.query(
          `
          INSERT INTO aircraft_fleet (
            aircraft_uid,
            airline_id,
            user_id,
            source,
            ownership_type,
            manufacturer,
            model_key,
            aircraft_name,
            registration,
            serial_number,
            line_number,
            new_aircraft_order_id,
            used_listing_id,
            status,
            operational_status,
            base_icao,
            current_airport,
            year_built,
            delivery_date,
            entry_into_service_date,
            total_hours,
            total_cycles,
            condition_pct,
            maintenance_status,
            purchase_price,
            current_value,

            depreciation_status,
            depreciation_method,
            depreciation_basis,
            depreciation_residual_value,
            depreciation_useful_life_months,
            depreciation_start_sim,
            accumulated_depreciation,
            book_value,
            depreciation_last_month_key,

            currency,
            created_at,
            updated_at
          )
          VALUES (
            gen_random_uuid(),
            $1,
            $2,
            'FACTORY',
            $3,
            $4,
            $5,
            $6,
            $12,
            NULL,
            NULL,
            $7,
            NULL,
            'ACTIVE',
            'AVAILABLE',
            $8,
            $8,
            $9,
            $10,
            $10,
            0,
            0,
            100,
            'SERVICEABLE',
            $11,
            $11,

            'ACTIVE',
            'STRAIGHT_LINE',
            $11,
            ROUND(
              $11::NUMERIC * 0.05
            )::BIGINT,
            240,
            $10::TIMESTAMP,
            0,
            $11,
            NULL,

            'USD',
            NOW(),
            NOW()
          )
          RETURNING id, aircraft_uid, airline_id, model_key, aircraft_name, status, operational_status
          `,
          [
            airlineId,
            order.user_id || null,
            order.ownership_type || "OWNED",
            order.manufacturer,
            order.model_key,
            aircraftLabel,
            orderId,
            baseIcao,
            simYear,
            resolverDate,
            Math.round(Number(order.unit_price || 0)),
            newRegistration
          ]
        );

        const fleetAircraft = fleetResult.rows[0];

await ACS_ensureAircraftMaintenanceStatus(
  client,
  fleetAircraft.id,
  fleetAircraft.airline_id || airlineId
);

insertedAircraft.push(fleetAircraft);
         
      }

      /* ============================================================
         2F) UPDATE FACTORY SLOT(S) FROM RESERVED TO DELIVERED
         ============================================================ */

      let reservedSlots = [];

      try {
        const parsedNotes =
          order.notes && String(order.notes).trim()
            ? JSON.parse(order.notes)
            : {};

        if (Array.isArray(parsedNotes.factory_slots_reserved)) {
          reservedSlots = parsedNotes.factory_slots_reserved;
        }
      } catch (notesError) {
        reservedSlots = [];
      }

      if (!reservedSlots.length && order.factory_slot_id) {
        reservedSlots = [{
          slot_id: order.factory_slot_id,
          reserved_quantity: quantity
        }];
      }

      for (const slot of reservedSlots) {
        const slotId = Number(slot.slot_id);
        const reservedQty = Math.max(1, Number(slot.reserved_quantity || 1));

        if (!slotId) continue;

        await client.query(
          `
          UPDATE aircraft_factory_slots
          SET
            reserved_quantity = GREATEST(COALESCE(reserved_quantity, 0) - $2, 0),
            delivered_quantity = COALESCE(delivered_quantity, 0) + $2,
            slot_status = CASE
              WHEN COALESCE(available_quantity, 0) <= 0
              THEN 'FULL'
              ELSE 'OPEN'
            END,
            utilization_pct = ROUND(
              (
                (
                  GREATEST(COALESCE(reserved_quantity, 0) - $2, 0)
                  + COALESCE(delivered_quantity, 0)
                  + $2
                )::NUMERIC
                /
                GREATEST(COALESCE(max_quantity, 0), 1)::NUMERIC
              ) * 100,
              2
            ),
            updated_at = NOW()
          WHERE id = $1
          `,
          [slotId, reservedQty]
        );
      }

      /* ============================================================
         2G) MARK ORDER AS DELIVERED
         ============================================================ */

      const orderUpdateResult = await client.query(
        `
        UPDATE new_aircraft_orders
        SET
          payment_status = 'PAID',
          final_payment_status = 'PAID',
          order_status = 'COMPLETED',
          delivery_status = 'DELIVERED',
          actual_delivery_date = $2::timestamp,
          delivery_resolved_at = NOW(),
          notes = (
            COALESCE(NULLIF(notes, ''), '{}')::jsonb
            || jsonb_build_object(
              'delivery_resolver', 'ACS_BUY_NEW_DELIVERY_RESOLVER_LIVE_V1_2',
              'delivery_resolved', true,
              'delivery_resolver_date', ($2::timestamp)::text,
              'aircraft_created_count', $3::integer
            )
          )::text,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [orderId, resolverDate, insertedAircraft.length]
      );

      processed.push({
        order_id: orderId,
        airline_id: airlineId,
        aircraft_name: aircraftLabel,
        action: shouldChargeFinalPayment
          ? "FINAL_PAYMENT_CHARGED_AND_DELIVERED"
          : "PAID_ORDER_DELIVERED",
        final_payment_charged: shouldChargeFinalPayment ? finalPaymentAmount : 0,
        aircraft_created_count: insertedAircraft.length,
        aircraft: insertedAircraft,
        order: orderUpdateResult.rows[0]
      });
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      endpoint: "ACS_BUY_NEW_DELIVERY_RESOLVER",
      version: "v1.2",
      mode: "LIVE_MUTATION",
      resolver_date: resolverDate.toISOString(),
      requested_order_id: requestedOrderId,
      processed_count: processed.length,
      skipped_count: skipped.length,
      processed,
      skipped
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ACS BUY NEW DELIVERY RESOLVER LIVE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "BUY_NEW_DELIVERY_RESOLVER_LIVE_FAILED",
      details: err.message
    });

  } finally {
    client.release();
  }
});

/* ============================================================
   AIRCRAFT INSURANCE — READ
   ============================================================ */

router.get(
  "/aircraft/fleet/:id/insurance",
  requireAuth,
  async (req, res) => {
    try {
      const airlineId = Number(req.airline_id);
      const aircraftId = Number(req.params.id);

      if (
        !Number.isInteger(airlineId) ||
        airlineId <= 0 ||
        !Number.isInteger(aircraftId) ||
        aircraftId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_AIRCRAFT"
        });
      }

      const result = await pool.query(
        `
        SELECT
          af.id AS aircraft_id,
          af.aircraft_uid,
          af.registration,
          af.aircraft_name,
          af.current_value,
          af.year_built,

          aip.policy_uid,
          aip.plan_code,
          aip.policy_status,
          aip.insured_value,
          aip.coverage_percent,
          aip.deductible_percent,
          aip.monthly_rate,
          aip.age_multiplier,
          aip.monthly_premium,
          aip.outstanding_balance,
          aip.policy_start_sim,
          aip.policy_end_sim,
          aip.last_payment_sim,
          aip.next_payment_sim,
          aip.pending_plan_code,
          aip.pending_plan_effective_sim,

          acs_get_current_sim_time()
            AS current_sim_time,

          GREATEST(
            0,
            EXTRACT(
              YEAR FROM acs_get_current_sim_time()
            )::INTEGER
            -
            COALESCE(
              af.year_built,
              EXTRACT(
                YEAR FROM acs_get_current_sim_time()
              )::INTEGER
            )
          ) AS age_years

        FROM public.aircraft_fleet af

        JOIN public.aircraft_insurance_policies aip
          ON aip.aircraft_id = af.id
         AND aip.airline_id = af.airline_id

        WHERE af.id = $1
          AND af.airline_id = $2

        LIMIT 1
        `,
        [
          aircraftId,
          airlineId
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error: "AIRCRAFT_INSURANCE_NOT_FOUND"
        });
      }

      const row = result.rows[0];

      const basicQuote =
        ACS_calculateInsurancePremium({
          planCode: "BASIC",
          currentValue: row.current_value,
          ageYears: row.age_years
        });

      const standardQuote =
        ACS_calculateInsurancePremium({
          planCode: "STANDARD",
          currentValue: row.current_value,
          ageYears: row.age_years
        });

      const goldQuote =
        ACS_calculateInsurancePremium({
          planCode: "GOLD",
          currentValue: row.current_value,
          ageYears: row.age_years
        });

      return res.json({
        ok: true,

        aircraft: {
          id: Number(row.aircraft_id),
          aircraft_uid: row.aircraft_uid,
          registration: row.registration,
          aircraft_name: row.aircraft_name,
          current_value:
            Number(row.current_value || 0),
          year_built:
            Number(row.year_built || 0),
          age_years:
            Number(row.age_years || 0)
        },

        policy: {
          policy_uid: row.policy_uid,
          plan_code: row.plan_code,
          policy_status: row.policy_status,
          insured_value:
            Number(row.insured_value || 0),
          coverage_percent:
            Number(row.coverage_percent || 0),
          deductible_percent:
            Number(row.deductible_percent || 0),
          monthly_rate:
            Number(row.monthly_rate || 0),
          age_multiplier:
            Number(row.age_multiplier || 0),
          monthly_premium:
            Number(row.monthly_premium || 0),
          outstanding_balance:
            Number(row.outstanding_balance || 0),
          policy_start_sim:
            row.policy_start_sim,
          policy_end_sim:
            row.policy_end_sim,
          last_payment_sim:
            row.last_payment_sim,
          next_payment_sim:
            row.next_payment_sim,
          pending_plan_code:
            row.pending_plan_code,
          pending_plan_effective_sim:
            row.pending_plan_effective_sim
        },

        quotes: {
          BASIC: basicQuote,
          STANDARD: standardQuote,
          GOLD: goldQuote
        },

        current_sim_time:
          row.current_sim_time,

        pricing: {
          value_source:
            "aircraft_fleet.current_value",
          age_source:
            "acs_get_current_sim_time",
          currency: "USD"
        }
      });

    } catch (error) {
      console.error(
        "AIRCRAFT INSURANCE READ ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRCRAFT_INSURANCE_READ_FAILED",
        details: error.message
      });
    }
  }
);

async function ACS_createInsurancePlanChangeAlert(
  client,
  {
    airlineId,
    policyUid,
    registration,
    previousPlan,
    requestedPlan,
    changeType,
    confirmedSimTime,
    effectiveSim,
    monthlyPremium
  }
) {
  if (
    !client ||
    changeType === "UNCHANGED"
  ) {
    return null;
  }

  const cleanRegistration = String(
    registration || "AIRCRAFT"
  )
    .trim()
    .toUpperCase();

  const cleanPreviousPlan = String(
    previousPlan || "BASIC"
  )
    .trim()
    .toUpperCase();

  const cleanRequestedPlan = String(
    requestedPlan || "BASIC"
  )
    .trim()
    .toUpperCase();

  const premium = Math.max(
    0,
    Number(monthlyPremium || 0)
  );

  const effectiveDate = effectiveSim
    ? new Date(effectiveSim)
    : null;

  const effectiveDateLabel =
    effectiveDate &&
    !Number.isNaN(effectiveDate.getTime())
      ? effectiveDate
          .toLocaleDateString(
            "en-GB",
            {
              day: "2-digit",
              month: "short",
              year: "numeric",
              timeZone: "UTC"
            }
          )
          .toUpperCase()
      : "NEXT PAYMENT DATE";

  const confirmationKeyTime =
    confirmedSimTime
      ? new Date(
          confirmedSimTime
        ).toISOString()
      : new Date().toISOString();

  const alertKey = [
    "INSURANCE_PLAN_CHANGE",
    String(policyUid),
    cleanPreviousPlan,
    cleanRequestedPlan,
    confirmationKeyTime
  ].join(":");

  const isUpgrade =
    changeType === "UPGRADE";

  const title = isUpgrade
    ? "AIRCRAFT INSURANCE UPGRADED"
    : "AIRCRAFT INSURANCE DOWNGRADE SCHEDULED";

  const message = isUpgrade
    ? [
        `Aircraft ${cleanRegistration} insurance has been upgraded.`,
        "",
        `Previous policy: ${cleanPreviousPlan}`,
        `New policy: ${cleanRequestedPlan}`,
        `Monthly premium: USD ${premium.toLocaleString("en-US")}`,
        "Effective date: IMMEDIATELY"
      ].join("\n")
    : [
        `Aircraft ${cleanRegistration} insurance downgrade has been scheduled.`,
        "",
        `Current policy: ${cleanPreviousPlan}`,
        `Scheduled policy: ${cleanRequestedPlan}`,
        `New monthly premium: USD ${premium.toLocaleString("en-US")}`,
        `Effective date: ${effectiveDateLabel}`
      ].join("\n");

  const result = await client.query(
    `
    INSERT INTO public.occ_alerts (
      airline_id,
      alert_key,
      category,
      level,
      title,
      message,
      source,
      source_ref,
      event_sim_time,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      'insurance',
      'info',
      $3,
      $4,
      'aircraft_insurance_policies',
      $5,
      $6,
      NOW(),
      NOW()
    )
    ON CONFLICT (
      airline_id,
      alert_key
    )
    WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING *
    `,
    [
      airlineId,
      alertKey,
      title,
      message,
      String(policyUid),
      confirmedSimTime
    ]
  );

  return result.rows[0] || null;
}

/* ============================================================
   AIRCRAFT INSURANCE — PLAN CHANGE
   ============================================================ */

router.post(
  "/aircraft/fleet/:id/insurance/plan",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const airlineId = Number(req.airline_id);
      const aircraftId = Number(req.params.id);

      const requestedPlan = String(
        req.body?.plan_code || ""
      )
        .trim()
        .toUpperCase();

      const validPlans = [
        "BASIC",
        "STANDARD",
        "GOLD"
      ];

      if (
        !Number.isInteger(airlineId) ||
        airlineId <= 0 ||
        !Number.isInteger(aircraftId) ||
        aircraftId <= 0 ||
        !validPlans.includes(requestedPlan)
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_INSURANCE_REQUEST",
          message:
            "The selected insurance plan is invalid."
        });
      }

      await client.query("BEGIN");

      const result = await client.query(
        `
        SELECT
          af.id AS aircraft_id,
          af.registration,
          af.current_value,
          af.year_built,

          aip.id AS policy_id,
          aip.policy_uid,
          aip.plan_code,
          aip.policy_status,
          aip.outstanding_balance,
          aip.next_payment_sim,
          aip.pending_plan_code,
          aip.pending_plan_effective_sim,

          acs_get_current_sim_time()
            AS current_sim_time,

          GREATEST(
            0,
            EXTRACT(
              YEAR FROM acs_get_current_sim_time()
            )::INTEGER
            -
            COALESCE(
              af.year_built,
              EXTRACT(
                YEAR FROM acs_get_current_sim_time()
              )::INTEGER
            )
          ) AS age_years

        FROM public.aircraft_fleet af

        JOIN public.aircraft_insurance_policies aip
          ON aip.aircraft_id = af.id
         AND aip.airline_id = af.airline_id

        WHERE af.id = $1
          AND af.airline_id = $2

        LIMIT 1

        FOR UPDATE OF af, aip
        `,
        [
          aircraftId,
          airlineId
        ]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "AIRCRAFT_INSURANCE_NOT_FOUND",
          message:
            "Insurance information was not found."
        });
      }

      const policy = result.rows[0];

      const currentPlan = String(
        policy.plan_code || "BASIC"
      ).toUpperCase();

      if (
        Number(policy.outstanding_balance || 0) > 0
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: "INSURANCE_BALANCE_PENDING",
          message:
            "Outstanding insurance debt must be paid before changing the policy."
        });
      }

      const planOrder = {
        BASIC: 1,
        STANDARD: 2,
        GOLD: 3
      };

      let changeType = "UNCHANGED";
      let effectiveSim =
        policy.current_sim_time;

      if (requestedPlan === currentPlan) {
        await client.query(
          `
          UPDATE public.aircraft_insurance_policies
          SET
            pending_plan_code = NULL,
            pending_plan_effective_sim = NULL,
            updated_at = NOW()
          WHERE id = $1
          `,
          [policy.policy_id]
        );

      } else if (
        planOrder[requestedPlan] >
        planOrder[currentPlan]
      ) {
        const quote =
          ACS_calculateInsurancePremium({
            planCode: requestedPlan,
            currentValue: policy.current_value,
            ageYears: policy.age_years
          });

        await client.query(
          `
          UPDATE public.aircraft_insurance_policies
          SET
            plan_code = $2,
            policy_status = 'ACTIVE',
            insured_value = $3,
            coverage_percent = $4,
            deductible_percent = $5,
            monthly_rate = $6,
            age_multiplier = $7,
            monthly_premium = $8,
            rank_modifier_basis_points = $9,
            pending_plan_code = NULL,
            pending_plan_effective_sim = NULL,
            updated_at = NOW()
          WHERE id = $1
          `,
          [
            policy.policy_id,
            requestedPlan,
            quote.insured_value,
            quote.coverage_percent,
            quote.deductible_percent,
            quote.monthly_rate,
            quote.age_multiplier,
            quote.monthly_premium,
            quote.rank_modifier_basis_points
          ]
        );

        changeType = "UPGRADE";
        effectiveSim =
          policy.current_sim_time;

      } else {
        await client.query(
          `
          UPDATE public.aircraft_insurance_policies
          SET
            pending_plan_code = $2,
            pending_plan_effective_sim =
              next_payment_sim,
            updated_at = NOW()
          WHERE id = $1
          `,
          [
            policy.policy_id,
            requestedPlan
          ]
        );

        changeType =
          "DOWNGRADE_SCHEDULED";

                effectiveSim =
          policy.next_payment_sim;
      }

      if (changeType !== "UNCHANGED") {
        const alertQuote =
          ACS_calculateInsurancePremium({
            planCode: requestedPlan,
            currentValue:
              policy.current_value,
            ageYears:
              policy.age_years
          });

        await ACS_createInsurancePlanChangeAlert(
          client,
          {
            airlineId,
            policyUid:
              policy.policy_uid,
            registration:
              policy.registration,
            previousPlan:
              currentPlan,
            requestedPlan,
            changeType,
            confirmedSimTime:
              policy.current_sim_time,
            effectiveSim,
            monthlyPremium:
              alertQuote.monthly_premium
          }
        );
      }

      await client.query("COMMIT");

      return res.json({
        ok: true,
        aircraft_id: aircraftId,
        previous_plan: currentPlan,
        requested_plan: requestedPlan,
        change_type: changeType,
        effective_sim: effectiveSim
      });

    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}

      console.error(
        "AIRCRAFT INSURANCE PLAN ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRCRAFT_INSURANCE_PLAN_FAILED",
        details: error.message
      });

    } finally {
      client.release();
    }
  }
);

export default router;
