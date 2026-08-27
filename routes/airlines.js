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

const callsignResult = await client.query(
  `
  SELECT
    public.acs_generate_unique_airline_callsign(
      $1::TEXT,
      NULL::INTEGER
    ) AS callsign
  `,
  [airlineName]
);

const callsign =
  String(
    callsignResult.rows[0]?.callsign || ""
  )
    .trim()
    .toUpperCase();

if (!iata || !icao || !callsign) {
  throw new Error(
    "AIRLINE_IDENTIFIERS_EXHAUSTED"
  );
}

return {
  iata,
  icao,
  callsign
};
}

/* ============================================================
   ACS CREATE AIRLINE VALIDATION AUTHORITY
   ============================================================ */

const ACS_DEFAULT_BUSINESS_MODEL =
  "PASSENGER";

const ACS_DEFAULT_OPERATION_MODE =
  "SCHEDULED";

const ALLOWED_AIRLINE_TYPES = new Set([
  "STARTER",
  "MEDIUM",
  "ADVANCED",
  "GLOBAL"
]);

function normalizeRequiredText(value) {
  if (typeof value !== "string") {
    return null;
  }

  return value
    .replace(/\s+/g, " ")
    .trim();
}

function calculateInfrastructureFacility(
  principal,
  annualInterestRate,
  termMonths
) {
  const amount = Number(principal);
  const annualRate =
    Number(annualInterestRate);
  const months = Number(termMonths);

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isFinite(annualRate) ||
    annualRate < 0 ||
    !Number.isInteger(months) ||
    months <= 0
  ) {
    throw new Error(
      "INVALID_INFRASTRUCTURE_FACILITY_VALUES"
    );
  }

  const monthlyRate =
    annualRate / 1200;

  const rawMonthlyPayment =
    monthlyRate === 0
      ? amount / months
      : (
          amount *
          monthlyRate *
          Math.pow(
            1 + monthlyRate,
            months
          )
        ) / (
          Math.pow(
            1 + monthlyRate,
            months
          ) - 1
        );

  const monthlyPayment =
    Math.max(
      1,
      Math.ceil(rawMonthlyPayment)
    );

  const totalRepayment =
    monthlyPayment * months;

  return {
    monthlyPayment,
    totalRepayment,
    totalInterest:
      Math.max(
        0,
        totalRepayment - amount
      )
  };
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

  const airlineTypeValue =
    normalizeRequiredText(
      payload.airline_type
    );

  const airlineType =
    airlineTypeValue
      ? airlineTypeValue.toUpperCase()
      : null;

    const requiredValues = {
    airline_name: airlineName,
    country,
    region,
    airline_type: airlineType
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
      error:
        "INVALID_AIRLINE_NAME_LENGTH",
      field: "airline_name"
    };
  }

  if (
    /[\u0000-\u001F\u007F]/.test(
      airlineName
    )
  ) {
    return {
      ok: false,
      error:
        "INVALID_AIRLINE_NAME_CHARACTERS",
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
    !ALLOWED_AIRLINE_TYPES.has(
      airlineType
    )
  ) {
    return {
      ok: false,
      error: "INVALID_AIRLINE_TYPE",
      field: "airline_type",
      allowed_values: [
        ...ALLOWED_AIRLINE_TYPES
      ]
    };
  }

    return {
    ok: true,
    data: {
      airlineName,
      country,
      region,
      businessModel:
        ACS_DEFAULT_BUSINESS_MODEL,
      operationMode:
        ACS_DEFAULT_OPERATION_MODE,
      airlineType
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
   Railway and PostgreSQL authority:
   - Reads users.base_icao
   - Resolves airport airline type limit
   - Resolves historical infrastructure costs
   - Returns the four ACS airline types
   - No frontend storage authority
   ============================================================ */

router.get(
  "/users/base-context",
  requireAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        WITH infrastructure_clock AS (
          SELECT
            EXTRACT(
              YEAR FROM
              public.acs_get_current_sim_time()
            )::INTEGER AS sim_year
        ),

        base_context AS (
          SELECT
            UPPER(BTRIM(player.base_icao))
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

            airport.region AS country,

            airport.category
              AS airport_category,

            airport.runway_m,

            airport.aircraft_limit,

            UPPER(
              BTRIM(
                airport.airline_type_limit
              )
            ) AS airline_type_limit

          FROM public.users player

          INNER JOIN
            public.v_acs_airport_authority_current
              airport
            ON UPPER(BTRIM(airport.icao)) =
               UPPER(BTRIM(player.base_icao))

          WHERE player.user_id = $1
            AND player.base_icao IS NOT NULL
            AND BTRIM(player.base_icao) <> ''

          LIMIT 1
        )

        SELECT
          base.base_icao,
          base.region,
          base.country,
          base.airport_category,
          base.runway_m,
          base.aircraft_limit,
          base.airline_type_limit,

          clock.sim_year,

          COALESCE(
            (
              SELECT
                JSONB_AGG(
                  JSONB_BUILD_OBJECT(
                    'airline_type',
                      resolved.airline_type,

                    'type_rank',
                      resolved.type_rank,

                    'initial_investment',
                      resolved.initial_investment,

                    'monthly_operating_cost',
                      resolved.monthly_operating_cost,

                    'facility_term_months',
                      resolved.facility_term_months,

                    'historical_factor',
                      resolved.historical_factor,

                    'data_kind',
                      resolved.data_kind,

                    'available',
                      type_policy.type_rank <=
                      limit_policy.type_rank
                  )
                  ORDER BY type_policy.type_rank
                )

              FROM
                public.acs_infrastructure_type_policy
                  type_policy

              INNER JOIN
                public.acs_infrastructure_type_policy
                  limit_policy
                ON limit_policy.airline_type =
                   base.airline_type_limit

              CROSS JOIN LATERAL
                public.acs_resolve_infrastructure_policy(
                  type_policy.airline_type,
                  clock.sim_year
                ) resolved

              WHERE type_policy.is_active = TRUE
            ),
            '[]'::JSONB
          ) AS infrastructure_options

        FROM base_context base
        CROSS JOIN infrastructure_clock clock
        `,
        [req.user_id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error: "ONBOARDING_BASE_NOT_FOUND"
        });
      }

      const base = result.rows[0];

      if (
        !base.airline_type_limit ||
        !Array.isArray(
          base.infrastructure_options
        ) ||
        base.infrastructure_options.length !== 4
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "ONBOARDING_INFRASTRUCTURE_AUTHORITY_INCOMPLETE"
        });
      }

      return res.json({
        ok: true,
        base
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
   GET COMPANY INFRASTRUCTURE CHANGE CONTEXT
   ------------------------------------------------------------
   Railway and PostgreSQL authority:
   - Reads the authenticated airline.
   - Resolves historical infrastructure values.
   - Applies airport limits.
   - Applies the six-month ACS cooldown.
   - Determines CURRENT, UPGRADE, DOWNGRADE or LOCKED.
   - Does not modify infrastructure or finance.
   ============================================================ */

router.get(
  "/airlines/infrastructure/context",
  requireAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        WITH infrastructure_clock AS (
          SELECT
            public.acs_get_current_sim_time()
              AS current_sim_time,

            EXTRACT(
              YEAR FROM
              public.acs_get_current_sim_time()
            )::INTEGER AS sim_year,

            EXTRACT(
              MONTH FROM
              public.acs_get_current_sim_time()
            )::INTEGER AS sim_month
        ),

        company_context AS (
          SELECT
            player.airline_id,

            UPPER(BTRIM(player.base_icao))
              AS base_icao,

            UPPER(BTRIM(
              infrastructure.airline_type
            )) AS current_airline_type,

            current_policy.type_rank
              AS current_type_rank,

            UPPER(BTRIM(
              airport.airline_type_limit
            )) AS airline_type_limit,

            limit_policy.type_rank
              AS airline_type_limit_rank,

            COALESCE(finance.capital, 0)
              AS available_capital

          FROM public.users player

          INNER JOIN
            public.airline_infrastructure
              infrastructure
            ON infrastructure.airline_id =
               player.airline_id

          INNER JOIN
            public.acs_infrastructure_type_policy
              current_policy
            ON current_policy.airline_type =
               UPPER(BTRIM(
                 infrastructure.airline_type
               ))
           AND current_policy.is_active = TRUE

          INNER JOIN
            public.v_acs_airport_authority_current
              airport
            ON UPPER(BTRIM(airport.icao)) =
               UPPER(BTRIM(player.base_icao))

          INNER JOIN
            public.acs_infrastructure_type_policy
              limit_policy
            ON limit_policy.airline_type =
               UPPER(BTRIM(
                 airport.airline_type_limit
               ))
           AND limit_policy.is_active = TRUE

          LEFT JOIN public.company_finance finance
            ON finance.airline_id =
               player.airline_id

          WHERE player.user_id = $1
            AND player.airline_id IS NOT NULL

          LIMIT 1
        )

        SELECT
          company.airline_id,
          company.base_icao,
          company.current_airline_type,
          company.current_type_rank,
          company.airline_type_limit,
          company.airline_type_limit_rank,
          company.available_capital,

          clock.current_sim_time,
          clock.sim_year,
          clock.sim_month,

          (
            clock.sim_year * 12
            + clock.sim_month
            - 1
          )::INTEGER AS current_period_number,

          latest.change_kind
            AS latest_change_kind,

          latest.change_period_number
            AS latest_change_period_number,

          latest.next_allowed_period_number,

          COALESCE(
            (
              SELECT JSONB_AGG(
                JSONB_BUILD_OBJECT(
                  'airline_type',
                    resolved.airline_type,

                  'type_rank',
                    resolved.type_rank,

                  'initial_investment',
                    resolved.initial_investment,

                  'monthly_operating_cost',
                    resolved.monthly_operating_cost,

                  'facility_term_months',
                    resolved.facility_term_months,

                  'historical_factor',
                    resolved.historical_factor,

                  'policy_revision_code',
                    resolved.revision_code
                )
                ORDER BY resolved.type_rank
              )

              FROM
                public.acs_infrastructure_type_policy
                  type_policy

              CROSS JOIN LATERAL
                public.acs_resolve_infrastructure_policy(
                  type_policy.airline_type,
                  clock.sim_year
                ) resolved

              WHERE type_policy.is_active = TRUE
            ),
            '[]'::JSONB
          ) AS infrastructure_options

        FROM company_context company

        CROSS JOIN infrastructure_clock clock

        LEFT JOIN LATERAL (
          SELECT
            change.change_kind,
            change.change_period_number,
            change.next_allowed_period_number

          FROM
            public.airline_infrastructure_changes
              change

          WHERE change.airline_id =
                company.airline_id

          ORDER BY
            change.change_period_number DESC,
            change.id DESC

          LIMIT 1
        ) latest
          ON TRUE
        `,
        [req.user_id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "AIRLINE_INFRASTRUCTURE_CONTEXT_NOT_FOUND"
        });
      }

      const context = result.rows[0];

      const currentType =
        String(
          context.current_airline_type || ""
        ).trim().toUpperCase();

      const currentRank =
        Number(context.current_type_rank);

      const limitRank =
        Number(
          context.airline_type_limit_rank
        );

      const availableCapital =
        Number(context.available_capital || 0);

      const currentPeriod =
        Number(
          context.current_period_number
        );

      const nextAllowedPeriod =
        context.next_allowed_period_number === null
          ? null
          : Number(
              context.next_allowed_period_number
            );

      const cooldownActive =
        Number.isInteger(nextAllowedPeriod) &&
        currentPeriod < nextAllowedPeriod;

      const monthsRemaining =
        cooldownActive
          ? nextAllowedPeriod - currentPeriod
          : 0;

      const options =
        Array.isArray(
          context.infrastructure_options
        )
          ? context.infrastructure_options
          : [];

      if (
        !currentType ||
        !Number.isInteger(currentRank) ||
        !Number.isInteger(limitRank) ||
        options.length !== 4
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "AIRLINE_INFRASTRUCTURE_AUTHORITY_INCOMPLETE"
        });
      }

      const infrastructureOptions =
        options.map(option => {
          const airlineType =
            String(
              option.airline_type || ""
            ).trim().toUpperCase();

          const typeRank =
            Number(option.type_rank);

          const initialInvestment =
            Number(
              option.initial_investment || 0
            );

          const monthlyCost =
            Number(
              option.monthly_operating_cost || 0
            );

          const isCurrent =
            airlineType === currentType;

          const isUpgrade =
            typeRank > currentRank;

          const isDowngrade =
            typeRank < currentRank;

          let action = "LOCKED";
          let available = false;
          let denialCode = null;
          let upgradeCharge = 0;

          if (isCurrent) {
            action = "CURRENT";
            denialCode = "CURRENT_LEVEL";

          } else if (cooldownActive) {
            action =
              isUpgrade
                ? "UPGRADE"
                : "DOWNGRADE";

            denialCode =
              "INFRASTRUCTURE_CHANGE_COOLDOWN";

          } else if (isUpgrade) {
            action = "UPGRADE";

            if (typeRank !== currentRank + 1) {
              denialCode =
                "UPGRADE_LEVEL_SKIP";

            } else if (typeRank > limitRank) {
              denialCode =
                "AIRPORT_INFRASTRUCTURE_LIMIT";

            } else if (
              availableCapital <
              initialInvestment
            ) {
              denialCode =
                "INSUFFICIENT_CAPITAL";

            } else {
              available = true;
              upgradeCharge =
                initialInvestment;
            }

          } else if (isDowngrade) {
            action = "DOWNGRADE";
            available = true;
          }

          return {
            airline_type:
              airlineType,

            type_rank:
              typeRank,

            current:
              isCurrent,

            action,

            available,

            disabled:
              !available,

            denial_code:
              denialCode,

            initial_investment:
              initialInvestment,

            upgrade_charge:
              upgradeCharge,

            amount_due_now:
              upgradeCharge,

            monthly_operating_cost:
              monthlyCost,

            facility_term_months:
              Number(
                option.facility_term_months || 0
              ),

            historical_factor:
              Number(
                option.historical_factor || 0
              ),

            policy_revision_code:
              option.policy_revision_code || null
          };
        });

      const nextAllowedYear =
        cooldownActive
          ? Math.floor(
              nextAllowedPeriod / 12
            )
          : null;

      const nextAllowedMonth =
        cooldownActive
          ? (
              nextAllowedPeriod % 12
            ) + 1
          : null;

      return res.json({
        ok: true,

        authority:
          "POSTGRESQL_ACS_INFRASTRUCTURE_AUTHORITY",

        current: {
          airline_type:
            currentType,

          type_rank:
            currentRank,

          monthly_operating_cost:
            infrastructureOptions.find(
              option => option.current
            )?.monthly_operating_cost || 0
        },

        base: {
          base_icao:
            context.base_icao,

          airline_type_limit:
            context.airline_type_limit,

          airline_type_limit_rank:
            limitRank
        },

        finance: {
          available_capital:
            availableCapital
        },

        simulation: {
          sim_year:
            Number(context.sim_year),

          sim_month:
            Number(context.sim_month),

          current_period_number:
            currentPeriod
        },

        cooldown: {
          active:
            cooldownActive,

          months_remaining:
            monthsRemaining,

          next_allowed_period_number:
            nextAllowedPeriod,

          next_allowed_sim_year:
            nextAllowedYear,

          next_allowed_sim_month:
            nextAllowedMonth
        },

        options:
          infrastructureOptions
      });

    } catch (error) {
      console.error(
        "GET AIRLINE INFRASTRUCTURE CONTEXT ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "AIRLINE_INFRASTRUCTURE_CONTEXT_FAILED"
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
  airline_callsign: designators.callsign,
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
   Transactional ACS onboarding:
   - Session user is authority
   - Validates selected airline type
   - Validates airport type limit
   - Creates airline
   - Creates company infrastructure
   - Creates one-time infrastructure facility
   - Does not deposit facility principal into capital
   - Links user and active sessions
   - Initializes HR
   ============================================================ */

router.post(
  "/airlines/create",
  requireAuth,
  async (req, res) => {

    const body = req.body || {};
    const userUUID = req.user_id;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      /* ========================================================
         1. EXISTING AIRLINE
         ======================================================== */

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
          [
            existingAirlineId,
            userUUID
          ]
        );

        await client.query(
          `
          UPDATE public.sessions
          SET airline_id = $1
          WHERE user_id = $2
            AND active = TRUE
            AND (
              airline_id IS NULL
              OR airline_id <> $1
            )
          `,
          [
            existingAirlineId,
            userUUID
          ]
        );

        await client.query("COMMIT");

        return res.status(200).json({
          ok: true,
          status:
            "AIRLINE_ALREADY_EXISTS_LINK_REPAIRED",
          airline_id:
            existingAirlineId
        });
      }

      /* ========================================================
         2. PAYLOAD VALIDATION
         ======================================================== */

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
        operationMode,
        airlineType
      } = validation.data;

      /* ========================================================
         3. LOCK USER AND READ BASE
         ======================================================== */

      const userResult = await client.query(
        `
        SELECT
          user_id,
          UPPER(BTRIM(base_icao))
            AS base_icao

        FROM public.users

        WHERE user_id = $1

        FOR UPDATE
        `,
        [userUUID]
      );

      if (!userResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "USER_NOT_FOUND"
        });
      }

      const baseIcao =
        String(
          userResult.rows[0].base_icao || ""
        ).trim().toUpperCase();

      if (!/^[A-Z0-9]{4}$/.test(baseIcao)) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "ONBOARDING_BASE_NOT_FOUND"
        });
      }

      /* ========================================================
         4. AIRPORT, INFRASTRUCTURE AND BANK AUTHORITY
         ======================================================== */

      const authorityResult =
        await client.query(
          `
          WITH infrastructure_clock AS (
            SELECT
              public.acs_get_current_sim_time()
                AS current_sim_time,

              EXTRACT(
                YEAR FROM
                public.acs_get_current_sim_time()
              )::INTEGER AS sim_year,

              FLOOR(
                EXTRACT(
                  EPOCH FROM
                  public.acs_get_current_sim_time()
                ) * 1000
              )::BIGINT AS sim_timestamp_ms
          )

          SELECT
            UPPER(BTRIM(airport.icao))
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
            END AS authority_region,

            airport.region
              AS authority_country,

            UPPER(
              BTRIM(
                airport.airline_type_limit
              )
            ) AS airline_type_limit,

            selected_policy.type_rank
              AS selected_type_rank,

            airport_limit_policy.type_rank
              AS airport_limit_rank,

            clock.current_sim_time,
            clock.sim_year,
            clock.sim_timestamp_ms,

            infrastructure.historical_factor,
            infrastructure.initial_investment,
            infrastructure.monthly_operating_cost,
            infrastructure.facility_term_months,
            infrastructure.revision_code,

            bank_policy.id
              AS bank_policy_id,

            bank_policy.policy_code
              AS bank_policy_code,

            bank_policy.base_interest_rate

          FROM
            public.v_acs_airport_authority_current
              airport

          INNER JOIN
            public.acs_infrastructure_type_policy
              selected_policy
            ON selected_policy.airline_type = $2
           AND selected_policy.is_active = TRUE

          INNER JOIN
            public.acs_infrastructure_type_policy
              airport_limit_policy
            ON airport_limit_policy.airline_type =
               UPPER(
                 BTRIM(
                   airport.airline_type_limit
                 )
               )
           AND airport_limit_policy.is_active = TRUE

          CROSS JOIN infrastructure_clock clock

          CROSS JOIN LATERAL
            public.acs_resolve_infrastructure_policy(
              $2,
              clock.sim_year
            ) infrastructure

          LEFT JOIN LATERAL (
            SELECT
              policy.id,
              policy.policy_code,
              policy.base_interest_rate

            FROM public.bank_credit_policy policy

            WHERE clock.sim_year
                  BETWEEN
                    policy.era_start_year
                    AND policy.era_end_year

              AND policy.is_active = TRUE

            ORDER BY
              policy.era_start_year DESC

            LIMIT 1
          ) bank_policy
            ON TRUE

          WHERE UPPER(BTRIM(airport.icao)) = $1

          LIMIT 1
          `,
          [
            baseIcao,
            airlineType
          ]
        );

      if (!authorityResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "AIRLINE_INFRASTRUCTURE_AUTHORITY_NOT_FOUND"
        });
      }

      const authority =
        authorityResult.rows[0];

      if (!authority.bank_policy_id) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: "BANK_POLICY_NOT_FOUND",
          sim_year:
            authority.sim_year || null
        });
      }

      if (
        Number(authority.selected_type_rank) >
        Number(authority.airport_limit_rank)
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "AIRLINE_TYPE_NOT_AVAILABLE_AT_BASE",
          selected_airline_type:
            airlineType,
          airport_airline_type_limit:
            authority.airline_type_limit
        });
      }

      const authorityCountry =
        String(
          authority.authority_country || ""
        ).trim();

      const authorityRegion =
        String(
          authority.authority_region || ""
        ).trim();

      if (
        country.toUpperCase() !==
          authorityCountry.toUpperCase() ||
        region.toUpperCase() !==
          authorityRegion.toUpperCase()
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error: "BASE_CONTEXT_MISMATCH"
        });
      }

      /* ========================================================
         5. UNIQUE AIRLINE NAME
         ======================================================== */

      const nameCheck = await client.query(
        `
        SELECT 1
        FROM public.airlines

        WHERE LOWER(BTRIM(airline_name)) =
              LOWER(BTRIM($1))

        LIMIT 1
        `,
        [airlineName]
      );

      if (nameCheck.rows.length > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          ok: false,
          error:
            "AIRLINE_NAME_ALREADY_EXISTS"
        });
      }

      /* ========================================================
         6. SERIALIZE DESIGNATOR ASSIGNMENT
         ======================================================== */

      await client.query(
        `
        SELECT pg_advisory_xact_lock(
          hashtext($1)
        )
        `,
        [
          "ACS_AIRLINE_DESIGNATOR_ALLOCATION"
        ]
      );

      const assignedDesignators =
        await generateAvailableDesignators(
          client,
          airlineName
        );

      /* ========================================================
         7. CREATE AIRLINE
         ======================================================== */

      const insertAirline =
  await client.query(
    `
    INSERT INTO public.airlines (
      user_id,
      airline_name,
      iata,
      icao,
      callsign,
      country,
      region,
      business_model,
      operation_mode
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9
    )
    RETURNING
      airline_id,
      callsign
    `,
    [
      userUUID,
      airlineName,
      assignedDesignators.iata,
      assignedDesignators.icao,
      assignedDesignators.callsign,
      authorityCountry,
      authorityRegion,
      businessModel,
      operationMode
    ]
  );
      const airlineId =
        insertAirline.rows[0].airline_id;

      /* ========================================================
         8. LINK USER AND ACTIVE SESSIONS
         ======================================================== */

      const userUpdate =
        await client.query(
          `
          UPDATE public.users
          SET airline_id = $1

          WHERE user_id = $2

          RETURNING
            user_id,
            airline_id
          `,
          [
            airlineId,
            userUUID
          ]
        );

      if (!userUpdate.rows.length) {
        throw new Error(
          "USER_LINK_FAILED"
        );
      }

      await client.query(
        `
        UPDATE public.sessions
        SET airline_id = $1

        WHERE user_id = $2
          AND active = TRUE
        `,
        [
          airlineId,
          userUUID
        ]
      );

      /* ========================================================
         9. INITIALIZE COMPANY FINANCE
         Starting operational capital remains $1,500,000.
         Facility principal is not deposited into capital.
         ======================================================== */

      await client.query(
        `
        INSERT INTO public.company_finance (
          airline_id,
          capital,
          opening_capital
        )
        VALUES (
          $1,
          1500000,
          1500000
        )

        ON CONFLICT (airline_id)
        DO NOTHING
        `,
        [airlineId]
      );

      /* ========================================================
         10. CALCULATE INFRASTRUCTURE FACILITY
         ======================================================== */

      const initialInvestment =
        Number(
          authority.initial_investment
        );

      const facilityTermMonths =
        Number(
          authority.facility_term_months
        );

      const annualInterestRate =
        Number(
          authority.base_interest_rate
        );

      const facilityPlan =
        calculateInfrastructureFacility(
          initialInvestment,
          annualInterestRate,
          facilityTermMonths
        );

      /* ========================================================
         11. RESERVE BANK LOAN ID
         ======================================================== */

      const loanIdResult =
        await client.query(
          `
          SELECT nextval(
            pg_get_serial_sequence(
              'public.bank_loans',
              'id'
            )
          )::BIGINT AS id
          `
        );

      const facilityLoanId =
        String(
          loanIdResult.rows[0].id
        );

      const facilityReference =
        `ACS-INFRA-${airlineId}-${facilityLoanId}`;

      /* ========================================================
         12. RECORD RESTRICTED FINANCING
         This records the financing event but does not increase
         company_finance.capital.
         ======================================================== */

      const financeLogResult =
        await client.query(
          `
          INSERT INTO public.finance_log (
            airline_id,
            type,
            source,
            amount,
            timestamp,
            reference_uid,
            description
          )
          VALUES (
            $1,
            'FINANCING',
            'ACS_INITIAL_INFRASTRUCTURE_FACILITY',
            $2,
            $3,
            $4,
            $5
          )
          RETURNING id
          `,
          [
            airlineId,
            initialInvestment,
            authority.sim_timestamp_ms,
            `INFRASTRUCTURE_FACILITY:${facilityReference}`,
            `ACS Initial Infrastructure Facility for ${airlineType}`
          ]
        );

      const financeLogId =
        financeLogResult.rows[0].id;

      /* ========================================================
         13. CREATE RESTRICTED FACILITY
         ======================================================== */

      const facilityResult =
        await client.query(
          `
          INSERT INTO public.bank_loans (
            id,
            airline_id,
            policy_id,
            loan_reference,
            status,
            loan_product_code,
            collateral_mode,
            original_principal,
            remaining_principal,
            annual_interest_rate,
            term_months,
            monthly_payment,
            total_repayment,
            total_interest,
            currency,
            opened_sim_time,
            maturity_sim_time,
            next_payment_sim_time,
            payment_number,
            finance_log_id,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'ACTIVE',
            'ACS_INITIAL_INFRASTRUCTURE_FACILITY',
            'UNSECURED',
            $5,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            'USD',
            $11,
            $11::TIMESTAMP +
              make_interval(
                months => $7::INTEGER
              ),
            $11::TIMESTAMP +
              INTERVAL '1 month',
            0,
            $12,
            NOW()
          )
          RETURNING *
          `,
          [
            facilityLoanId,
            airlineId,
            authority.bank_policy_id,
            facilityReference,
            initialInvestment,
            annualInterestRate,
            facilityTermMonths,
            facilityPlan.monthlyPayment,
            facilityPlan.totalRepayment,
            facilityPlan.totalInterest,
            authority.current_sim_time,
            financeLogId
          ]
        );

      /* ========================================================
         14. CREATE COMPANY INFRASTRUCTURE
         ======================================================== */

      await client.query(
        `
        INSERT INTO
          public.airline_infrastructure (
            airline_id,
            airline_type,
            established_base_icao,
            established_sim_year,
            initial_historical_factor,
            initial_investment,
            initial_monthly_operating_cost,
            facility_term_months,
            financing_mode,
            policy_revision_code
          )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          'ACS_INITIAL_FACILITY',
          $9
        )
        `,
        [
          airlineId,
          airlineType,
          baseIcao,
          authority.sim_year,
          authority.historical_factor,
          initialInvestment,
          authority.monthly_operating_cost,
          facilityTermMonths,
          authority.revision_code
        ]
      );

      /* ========================================================
         15. INITIALIZE HR
         Infrastructure remains financially separate from HR.
         ======================================================== */

      await client.query(
        `
        SELECT public.init_airline_hr($1)
        `,
        [airlineId]
      );

      await client.query("COMMIT");

      console.log(
        "ACS AIRLINE AND INFRASTRUCTURE CREATED",
        {
          airlineId,
          userUUID,
          airlineType,
          baseIcao,
          initialInvestment,
          facilityLoanId
        }
      );

      return res.status(201).json({
        ok: true,

        airline_id:
          airlineId,

        airline_iata:
          assignedDesignators.iata,

        airline_icao:
          assignedDesignators.icao,

        airline_callsign:
          assignedDesignators.callsign,
         
        infrastructure: {
          airline_type:
            airlineType,

          base_icao:
            baseIcao,

          sim_year:
            Number(authority.sim_year),

          initial_investment:
            initialInvestment,

          monthly_operating_cost:
            Number(
              authority.monthly_operating_cost
            )
        },

        facility: {
          id:
            String(
              facilityResult.rows[0].id
            ),

          reference:
            facilityReference,

          product_code:
            "ACS_INITIAL_INFRASTRUCTURE_FACILITY",

          status:
            facilityResult.rows[0].status,

          original_principal:
            initialInvestment,

          annual_interest_rate:
            annualInterestRate,

          term_months:
            facilityTermMonths,

          monthly_payment:
            facilityPlan.monthlyPayment,

          first_payment_sim_time:
            facilityResult.rows[0]
              .next_payment_sim_time
        }
      });

    } catch (err) {
      await client.query("ROLLBACK");

      console.error(
        "CREATE AIRLINE ERROR:",
        err
      );

      if (err.code === "23505") {
        const constraint =
          String(
            err.constraint || ""
          );

        if (
          constraint.includes(
            "uq_bank_loans_one_infrastructure_facility"
          )
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "INFRASTRUCTURE_FACILITY_ALREADY_EXISTS"
          });
        }

        if (
           constraint.includes("iata") ||
           constraint.includes("icao") ||
           constraint.includes("callsign")
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
        error:
          err.message ||
          "CREATE_AIRLINE_FAILED"
      });

    } finally {
      client.release();
    }
  }
);

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
