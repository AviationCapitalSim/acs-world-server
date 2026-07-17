import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function bankNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function resolveFinancialAuthority(fleetValue) {
  if (fleetValue >= 100000000) {
    return {
      level: "GLOBAL AUTHORITY",
      stability: "SECURE",
      percentage: 100
    };
  }

  if (fleetValue >= 25000000) {
    return {
      level: "EXTENDED AUTHORITY",
      stability: "STRONG",
      percentage: 75
    };
  }

  if (fleetValue >= 5000000) {
    return {
      level: "STANDARD AUTHORITY",
      stability: "STABLE",
      percentage: 55
    };
  }

  if (fleetValue >= 1000000) {
    return {
      level: "LIMITED AUTHORITY",
      stability: "ELEVATED RISK",
      percentage: 35
    };
  }

  return {
    level: "RESTRICTED AUTHORITY",
    stability: "UNSTABLE",
    percentage: 15
  };
}

router.get("/bank/summary", requireAuth, async (req, res) => {
  try {
    const airlineId = Number(req.airline_id);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const contextResult = await pool.query(
      `
      WITH bank_clock AS (
        SELECT
          acs_get_current_sim_time() AS current_sim_time,
          EXTRACT(
            YEAR FROM acs_get_current_sim_time()
          )::INTEGER AS sim_year
      )
      SELECT
        bank_clock.current_sim_time,
        bank_clock.sim_year,

        policy.id AS policy_id,
        policy.policy_code,
        policy.max_ltv,
        policy.base_interest_rate,
        policy.collateral_advance_rate,

        policy.debt_ratio_level_1,
        policy.debt_ratio_level_2,
        policy.debt_ratio_level_3,

        policy.penalty_level_1,
        policy.penalty_level_2,
        policy.penalty_level_3,

        policy.max_term_months,
        policy.loan_cooldown_days

      FROM bank_clock

      LEFT JOIN LATERAL (
        SELECT *
        FROM public.bank_credit_policy
        WHERE bank_clock.sim_year
              BETWEEN era_start_year AND era_end_year
          AND is_active = TRUE
        ORDER BY era_start_year DESC
        LIMIT 1
      ) policy ON TRUE
      `
    );

    const context = contextResult.rows[0];

    if (!context?.policy_id) {
      return res.status(409).json({
        ok: false,
        error: "BANK_POLICY_NOT_FOUND",
        sim_year: context?.sim_year || null
      });
    }

    const [
      fleetResult,
      loansResult,
      collateralResult
    ] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::INTEGER AS aircraft_count,

          COALESCE(
            ROUND(
              SUM(
                GREATEST(
                  COALESCE(
                    current_value,
                    purchase_price,
                    0
                  ),
                  0
                )
              )
            ),
            0
          )::BIGINT AS fleet_value

        FROM public.aircraft_fleet

        WHERE airline_id = $1
          AND UPPER(
            COALESCE(
              ownership_type,
              'OWNED'
            )
          ) NOT IN (
            'LEASE',
            'LEASED'
          )
        `,
        [airlineId]
      ),

      pool.query(
        `
        SELECT
          id,
          loan_reference,
          status,
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
          last_payment_sim_time,
          closed_sim_time,

          payment_number

        FROM public.bank_loans

        WHERE airline_id = $1

        ORDER BY
          opened_sim_time DESC,
          id DESC
        `,
        [airlineId]
      ),

      pool.query(
        `
        SELECT
          COUNT(*)::INTEGER
            AS locked_aircraft_count,

          COALESCE(
            SUM(appraised_value),
            0
          )::BIGINT
            AS locked_collateral_value

        FROM public.bank_loan_collateral

        WHERE airline_id = $1
          AND released_sim_time IS NULL
        `,
        [airlineId]
      )
    ]);

    const fleetValue = bankNumber(
      fleetResult.rows[0]?.fleet_value
    );

    const aircraftCount = bankNumber(
      fleetResult.rows[0]?.aircraft_count
    );

    const loans = loansResult.rows;

    const activeLoans = loans.filter(
      loan =>
        String(
          loan.status || ""
        ).toUpperCase() === "ACTIVE" &&
        bankNumber(
          loan.remaining_principal
        ) > 0
    );

    const totalOutstanding =
      activeLoans.reduce(
        (total, loan) =>
          total +
          bankNumber(
            loan.remaining_principal
          ),
        0
      );

    const totalMonthly =
      activeLoans.reduce(
        (total, loan) =>
          total +
          bankNumber(
            loan.monthly_payment
          ),
        0
      );

    const totalOriginal =
      loans.reduce(
        (total, loan) =>
          total +
          bankNumber(
            loan.original_principal
          ),
        0
      );

    const debtRatio =
      fleetValue > 0
        ? totalOutstanding / fleetValue
        : totalOutstanding > 0
          ? 1
          : 0;

    let ratePenalty = 0;

    if (
      debtRatio >
      bankNumber(
        context.debt_ratio_level_3
      )
    ) {
      ratePenalty =
        bankNumber(
          context.penalty_level_3
        );
    } else if (
      debtRatio >
      bankNumber(
        context.debt_ratio_level_2
      )
    ) {
      ratePenalty =
        bankNumber(
          context.penalty_level_2
        );
    } else if (
      debtRatio >
      bankNumber(
        context.debt_ratio_level_1
      )
    ) {
      ratePenalty =
        bankNumber(
          context.penalty_level_1
        );
    }

    const baseInterestRate =
      bankNumber(
        context.base_interest_rate
      );

    const interestRate =
      baseInterestRate + ratePenalty;

    const maximumCredit =
      Math.floor(
        fleetValue *
        bankNumber(context.max_ltv)
      );

    const loanCapacity =
      Math.max(
        0,
        maximumCredit - totalOutstanding
      );

    const mappedLoans =
      loans.map(loan => ({
        id: String(loan.id),
        ref: loan.loan_reference,
        status: loan.status,

        collateralMode:
          loan.collateral_mode,

        originalAmount:
          bankNumber(
            loan.original_principal
          ),

        remaining:
          bankNumber(
            loan.remaining_principal
          ),

        rate:
          bankNumber(
            loan.annual_interest_rate
          ),

        termMonths:
          bankNumber(
            loan.term_months
          ),

        monthlyPayment:
          bankNumber(
            loan.monthly_payment
          ),

        totalRepayment:
          bankNumber(
            loan.total_repayment
          ),

        totalInterest:
          bankNumber(
            loan.total_interest
          ),

        currency:
          loan.currency || "USD",

        startDate:
          loan.opened_sim_time,

        maturityDate:
          loan.maturity_sim_time,

        nextPaymentDate:
          loan.next_payment_sim_time,

        lastPaymentDate:
          loan.last_payment_sim_time,

        closedDate:
          loan.closed_sim_time,

        paymentNumber:
          bankNumber(
            loan.payment_number
          )
      }));

    return res.json({
      ok: true,

      endpoint:
        "ACS_BANK_SUMMARY",

      authority:
        "RAILWAY_POSTGRESQL",

      airline_id:
        airlineId,

      current_sim_time:
        context.current_sim_time,

      year:
        bankNumber(
          context.sim_year
        ),

      policy: {
        id:
          String(context.policy_id),

        code:
          context.policy_code,

        maxLtv:
          bankNumber(
            context.max_ltv
          ),

        baseInterestRate,
        ratePenalty,

        collateralAdvanceRate:
          bankNumber(
            context.collateral_advance_rate
          ),

        maxTermMonths:
          bankNumber(
            context.max_term_months
          ),

        cooldownDays:
          bankNumber(
            context.loan_cooldown_days
          )
      },

      fleetValue,
      fleetAircraftCount:
        aircraftCount,

      maximumCredit,
      loanCapacity,
      creditAvailability:
        loanCapacity,

      interestRate,
      debtRatio,

      totalOriginal,
      totalMonthly,
      totalOutstanding,

      lockedAircraftCount:
        bankNumber(
          collateralResult.rows[0]
            ?.locked_aircraft_count
        ),

      lockedCollateralValue:
        bankNumber(
          collateralResult.rows[0]
            ?.locked_collateral_value
        ),

      financialAuthority:
        resolveFinancialAuthority(
          fleetValue
        ),

      activeLoanCount:
        activeLoans.length,

      loanCount:
        mappedLoans.length,

      loans:
        mappedLoans
    });

  } catch (error) {
    console.error(
      "ACS BANK SUMMARY ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "BANK_SUMMARY_FAILED",
      details:
        error.message
    });
  }
});

function bankHttpError(statusCode, code, details = null) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function bankInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function bankAircraftIds(value) {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map(item => Number(item))
        .filter(item => Number.isSafeInteger(item) && item > 0)
    )
  ];
}

function bankRatePenalty(policy, debtRatio) {
  if (debtRatio > bankNumber(policy.debt_ratio_level_3)) {
    return bankNumber(policy.penalty_level_3);
  }

  if (debtRatio > bankNumber(policy.debt_ratio_level_2)) {
    return bankNumber(policy.penalty_level_2);
  }

  if (debtRatio > bankNumber(policy.debt_ratio_level_1)) {
    return bankNumber(policy.penalty_level_1);
  }

  return 0;
}

function bankAmortization(principal, annualRate, months) {
  const monthlyRate = annualRate / 1200;

  const rawPayment = monthlyRate === 0
    ? principal / months
    : principal * monthlyRate * Math.pow(1 + monthlyRate, months)
      / (Math.pow(1 + monthlyRate, months) - 1);

  const monthlyPayment = Math.max(1, Math.ceil(rawPayment));
  const totalRepayment = monthlyPayment * months;

  return {
    monthlyPayment,
    totalRepayment,
    totalInterest: Math.max(0, totalRepayment - principal)
  };
}

/* ============================================================
   AVAILABLE AIRCRAFT COLLATERAL
   ============================================================ */

router.get("/bank/collateral", requireAuth, async (req, res) => {
  try {
    const airlineId = Number(req.airline_id);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    const result = await pool.query(
      `
      SELECT
        af.id,
        af.registration,
        af.manufacturer,
        af.model_key,
        af.aircraft_name,
        af.ownership_type,
        af.status,
        af.operational_status,
        af.currency,

        ROUND(
          GREATEST(
            COALESCE(af.current_value, af.purchase_price, 0),
            0
          )
        )::BIGINT AS appraised_value,

        (blc.id IS NULL) AS available,
        bl.loan_reference AS locked_loan_reference

      FROM public.aircraft_fleet af

      LEFT JOIN public.bank_loan_collateral blc
        ON blc.airline_id = af.airline_id
       AND blc.aircraft_id = af.id
       AND blc.released_sim_time IS NULL

      LEFT JOIN public.bank_loans bl
        ON bl.id = blc.loan_id
       AND bl.airline_id = af.airline_id

      WHERE af.airline_id = $1
        AND UPPER(COALESCE(af.ownership_type, 'OWNED'))
            NOT IN ('LEASE', 'LEASED')

      ORDER BY af.created_at DESC, af.id DESC
      `,
      [airlineId]
    );

    return res.json({
      ok: true,
      endpoint: "ACS_BANK_COLLATERAL",
      authority: "RAILWAY_POSTGRESQL",

      aircraft: result.rows.map(row => ({
        id: String(row.id),
        registration: row.registration,
        manufacturer: row.manufacturer,
        modelKey: row.model_key,
        aircraftName: row.aircraft_name,
        ownershipType: row.ownership_type,
        status: row.status,
        operationalStatus: row.operational_status,
        currency: row.currency || "USD",
        appraisedValue: bankNumber(row.appraised_value),
        available: row.available === true,
        lockedLoanReference: row.locked_loan_reference || null
      }))
    });

  } catch (error) {
    console.error("ACS BANK COLLATERAL ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "BANK_COLLATERAL_FAILED",
      details: error.message
    });
  }
});

/* ============================================================
   CREATE LOAN
   ============================================================ */

router.post("/bank/loans", requireAuth, async (req, res) => {
  const airlineId = Number(req.airline_id);
  const amount = bankInteger(req.body?.amount);
  const termMonths = bankInteger(req.body?.term_months);
  const aircraftIds = bankAircraftIds(req.body?.aircraft_ids);

  if (!Number.isInteger(airlineId) || airlineId <= 0) {
    return res.status(401).json({
      ok: false,
      error: "NO_AIRLINE_SESSION"
    });
  }

  if (amount <= 0) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_LOAN_AMOUNT"
    });
  }

  if (![36, 72, 120, 180, 240].includes(termMonths)) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_LOAN_TERM"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const contextResult = await client.query(
      `
      WITH bank_clock AS (
        SELECT
          acs_get_current_sim_time() AS current_sim_time,

          EXTRACT(
            YEAR FROM acs_get_current_sim_time()
          )::INTEGER AS sim_year,

          FLOOR(
            EXTRACT(EPOCH FROM acs_get_current_sim_time()) * 1000
          )::BIGINT AS sim_timestamp_ms
      )

      SELECT
        bank_clock.current_sim_time,
        bank_clock.sim_year,
        bank_clock.sim_timestamp_ms,
        policy.*

      FROM bank_clock

      LEFT JOIN LATERAL (
        SELECT *
        FROM public.bank_credit_policy

        WHERE bank_clock.sim_year
              BETWEEN era_start_year AND era_end_year
          AND is_active = TRUE

        ORDER BY era_start_year DESC
        LIMIT 1
      ) policy ON TRUE
      `
    );

    const context = contextResult.rows[0];

    if (!context?.id) {
      throw bankHttpError(409, "BANK_POLICY_NOT_FOUND");
    }

    if (termMonths > bankInteger(context.max_term_months)) {
      throw bankHttpError(409, "LOAN_TERM_EXCEEDS_POLICY");
    }

    const lastLoanResult = await client.query(
      `
      SELECT
        opened_sim_time,

        opened_sim_time +
        make_interval(days => $2::INTEGER)
          AS next_allowed_sim_time

      FROM public.bank_loans

      WHERE airline_id = $1

      ORDER BY opened_sim_time DESC, id DESC
      LIMIT 1
      `,
      [
        airlineId,
        bankInteger(context.loan_cooldown_days)
      ]
    );

    const nextAllowed =
      lastLoanResult.rows[0]?.next_allowed_sim_time;

    if (
      nextAllowed &&
      new Date(context.current_sim_time).getTime() <
      new Date(nextAllowed).getTime()
    ) {
      throw bankHttpError(
        409,
        "LOAN_COOLDOWN_ACTIVE",
        {
          next_allowed_sim_time: nextAllowed
        }
      );
    }

    const lockedLoansResult = await client.query(
      `
      SELECT
        id,
        remaining_principal

      FROM public.bank_loans

      WHERE airline_id = $1
        AND status = 'ACTIVE'
        AND remaining_principal > 0

      FOR UPDATE
      `,
      [airlineId]
    );

    const totalOutstanding =
      lockedLoansResult.rows.reduce(
        (total, loan) =>
          total + bankNumber(loan.remaining_principal),
        0
      );

    const fleetResult = await client.query(
      `
      SELECT
        COALESCE(
          ROUND(
            SUM(
              GREATEST(
                COALESCE(current_value, purchase_price, 0),
                0
              )
            )
          ),
          0
        )::BIGINT AS fleet_value

      FROM public.aircraft_fleet

      WHERE airline_id = $1
        AND UPPER(COALESCE(ownership_type, 'OWNED'))
            NOT IN ('LEASE', 'LEASED')
      `,
      [airlineId]
    );

    const fleetValue =
      bankNumber(fleetResult.rows[0]?.fleet_value);

    const maximumCredit = Math.floor(
      fleetValue * bankNumber(context.max_ltv)
    );

    const availableCapacity = Math.max(
      0,
      maximumCredit - totalOutstanding
    );

    if (amount > availableCapacity) {
      throw bankHttpError(
        409,
        "LOAN_CAPACITY_EXCEEDED",
        {
          available_capacity: availableCapacity
        }
      );
    }

    let selectedAircraft = [];

    if (aircraftIds.length > 0) {
      const aircraftResult = await client.query(
        `
        SELECT
          af.id,
          af.registration,
          af.aircraft_name,

          ROUND(
            GREATEST(
              COALESCE(af.current_value, af.purchase_price, 0),
              0
            )
          )::BIGINT AS appraised_value,

          blc.id AS active_collateral_id

        FROM public.aircraft_fleet af

        LEFT JOIN public.bank_loan_collateral blc
          ON blc.airline_id = af.airline_id
         AND blc.aircraft_id = af.id
         AND blc.released_sim_time IS NULL

        WHERE af.airline_id = $1
          AND af.id = ANY($2::BIGINT[])
          AND UPPER(COALESCE(af.ownership_type, 'OWNED'))
              NOT IN ('LEASE', 'LEASED')

        FOR UPDATE OF af
        `,
        [
          airlineId,
          aircraftIds
        ]
      );

      selectedAircraft = aircraftResult.rows;

      if (selectedAircraft.length !== aircraftIds.length) {
        throw bankHttpError(
          409,
          "INVALID_COLLATERAL_SELECTION"
        );
      }

      if (
        selectedAircraft.some(
          item => item.active_collateral_id
        )
      ) {
        throw bankHttpError(
          409,
          "AIRCRAFT_ALREADY_PLEDGED"
        );
      }

      const collateralCapacity = Math.floor(
        selectedAircraft.reduce(
          (total, item) =>
            total + bankNumber(item.appraised_value),
          0
        ) *
        bankNumber(context.collateral_advance_rate)
      );

      if (amount > collateralCapacity) {
        throw bankHttpError(
          409,
          "COLLATERAL_CAPACITY_EXCEEDED",
          {
            collateral_capacity: collateralCapacity
          }
        );
      }
    }

    const debtRatio = fleetValue > 0
      ? totalOutstanding / fleetValue
      : totalOutstanding > 0
        ? 1
        : 0;

    const annualInterestRate =
      bankNumber(context.base_interest_rate) +
      bankRatePenalty(context, debtRatio);

    const paymentPlan = bankAmortization(
      amount,
      annualInterestRate,
      termMonths
    );

    await client.query(
      `
      INSERT INTO public.company_finance (
        airline_id,
        capital
      )
      VALUES ($1, 1500000)

      ON CONFLICT (airline_id)
      DO NOTHING
      `,
      [airlineId]
    );

    await client.query(
      `
      SELECT airline_id
      FROM public.company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airlineId]
    );

    const idResult = await client.query(
      `
      SELECT nextval(
        pg_get_serial_sequence(
          'public.bank_loans',
          'id'
        )
      )::BIGINT AS id
      `
    );

    const loanId = String(idResult.rows[0].id);

    const loanReference =
      \`ACS-BANK-\${airlineId}-\${loanId}\`;

    const collateralMode =
      selectedAircraft.length > 0
        ? "SECURED"
        : "UNSECURED";

    const logResult = await client.query(
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
        'BANK_LOAN_DISBURSEMENT',
        $2,
        $3,
        $4,
        $5
      )
      RETURNING id
      `,
      [
        airlineId,
        amount,
        context.sim_timestamp_ms,
        \`BANK_LOAN:\${loanReference}:DISBURSEMENT\`,
        \`Bank loan \${loanReference} disbursed by ACS OCC\`
      ]
    );

    const financeLogId = logResult.rows[0].id;

    const loanResult = await client.query(
      `
      INSERT INTO public.bank_loans (
        id,
        airline_id,
        policy_id,
        loan_reference,
        status,
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
        $5,
        $6,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        'USD',
        $12,
        $12::TIMESTAMP +
          make_interval(months => $8::INTEGER),
        $12::TIMESTAMP + INTERVAL '1 month',
        0,
        $13,
        NOW()
      )
      RETURNING *
      `,
      [
        loanId,
        airlineId,
        context.id,
        loanReference,
        collateralMode,
        amount,
        annualInterestRate,
        termMonths,
        paymentPlan.monthlyPayment,
        paymentPlan.totalRepayment,
        paymentPlan.totalInterest,
        context.current_sim_time,
        financeLogId
      ]
    );

    for (const aircraft of selectedAircraft) {
      const appraisedValue =
        bankNumber(aircraft.appraised_value);

      const securedAmount = Math.floor(
        appraisedValue *
        bankNumber(context.collateral_advance_rate)
      );

      await client.query(
        `
        INSERT INTO public.bank_loan_collateral (
          loan_id,
          airline_id,
          aircraft_id,
          appraised_value,
          advance_rate,
          secured_amount,
          locked_sim_time,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          NOW()
        )
        `,
        [
          loanId,
          airlineId,
          aircraft.id,
          appraisedValue,
          context.collateral_advance_rate,
          securedAmount,
          context.current_sim_time
        ]
      );
    }

    const financeResult = await client.query(
      `
      UPDATE public.company_finance

      SET
        capital = COALESCE(capital, 0) + $2,
        updated_at = NOW()

      WHERE airline_id = $1

      RETURNING capital
      `,
      [
        airlineId,
        amount
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      endpoint: "ACS_BANK_CREATE_LOAN",
      authority: "RAILWAY_POSTGRESQL",

      loan: loanResult.rows[0],

      collateralAircraftIds:
        aircraftIds.map(String),

      finance: {
        capital:
          bankNumber(financeResult.rows[0]?.capital),

        financeLogId:
          String(financeLogId)
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "ACS BANK CREATE LOAN ERROR:",
      error
    );

    const uniqueCollateralConflict =
      error.code === "23505" &&
      String(error.constraint || "").includes(
        "bank_collateral_active_aircraft_unique"
      );

    return res.status(
      uniqueCollateralConflict
        ? 409
        : error.statusCode || 500
    ).json({
      ok: false,

      error: uniqueCollateralConflict
        ? "AIRCRAFT_ALREADY_PLEDGED"
        : error.code || "BANK_CREATE_LOAN_FAILED",

      details:
        error.details || error.message
    });

  } finally {
    client.release();
  }
});

/* ============================================================
   MANUAL AMORTIZATION
   ============================================================ */

router.post(
  "/bank/loans/:loanId/amortize",
  requireAuth,
  async (req, res) => {
    const airlineId = Number(req.airline_id);
    const loanId = Number(req.params.loanId);
    const requestedAmount =
      bankInteger(req.body?.amount);

    if (!Number.isInteger(airlineId) || airlineId <= 0) {
      return res.status(401).json({
        ok: false,
        error: "NO_AIRLINE_SESSION"
      });
    }

    if (!Number.isSafeInteger(loanId) || loanId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_LOAN_ID"
      });
    }

    if (requestedAmount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PAYMENT_AMOUNT"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const clockResult = await client.query(
        `
        SELECT
          acs_get_current_sim_time()
            AS current_sim_time,

          FLOOR(
            EXTRACT(
              EPOCH FROM acs_get_current_sim_time()
            ) * 1000
          )::BIGINT AS sim_timestamp_ms
        `
      );

      const clock = clockResult.rows[0];

      const loanResult = await client.query(
        `
        SELECT *
        FROM public.bank_loans

        WHERE id = $1
          AND airline_id = $2

        FOR UPDATE
        `,
        [
          loanId,
          airlineId
        ]
      );

      const loan = loanResult.rows[0];

      if (!loan) {
        throw bankHttpError(
          404,
          "LOAN_NOT_FOUND"
        );
      }

      if (
        String(loan.status).toUpperCase() !== "ACTIVE" ||
        bankNumber(loan.remaining_principal) <= 0
      ) {
        throw bankHttpError(
          409,
          "LOAN_ALREADY_CLOSED"
        );
      }

      await client.query(
        `
        INSERT INTO public.company_finance (
          airline_id,
          capital
        )
        VALUES ($1, 1500000)

        ON CONFLICT (airline_id)
        DO NOTHING
        `,
        [airlineId]
      );

      const financeLock = await client.query(
        `
        SELECT capital
        FROM public.company_finance

        WHERE airline_id = $1

        FOR UPDATE
        `,
        [airlineId]
      );

      const balanceBefore =
        bankNumber(loan.remaining_principal);

      const paymentAmount = Math.min(
        requestedAmount,
        balanceBefore
      );

      if (
        bankNumber(financeLock.rows[0]?.capital) <
        paymentAmount
      ) {
        throw bankHttpError(
          409,
          "INSUFFICIENT_CAPITAL_FOR_PAYMENT"
        );
      }

      const balanceAfter =
        balanceBefore - paymentAmount;

      const paymentIdResult = await client.query(
        `
        SELECT nextval(
          pg_get_serial_sequence(
            'public.bank_loan_payments',
            'id'
          )
        )::BIGINT AS id
        `
      );

      const paymentId =
        String(paymentIdResult.rows[0].id);

      const paymentReference =
        \`BANK_PAYMENT:\${loan.loan_reference}:\${paymentId}\`;

      const logResult = await client.query(
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
          'EXPENSE',
          'BANK_LOAN_AMORTIZATION',
          $2,
          $3,
          $4,
          $5
        )
        RETURNING id
        `,
        [
          airlineId,
          paymentAmount,
          clock.sim_timestamp_ms,
          paymentReference,
          \`Manual amortization for \${loan.loan_reference}\`
        ]
      );

      const financeLogId =
        logResult.rows[0].id;

      await client.query(
        `
        INSERT INTO public.bank_loan_payments (
          id,
          loan_id,
          airline_id,
          payment_type,
          amount,
          principal_component,
          interest_component,
          balance_before,
          balance_after,
          payment_sim_time,
          scheduled_for_sim_time,
          finance_log_id
        )
        VALUES (
          $1,
          $2,
          $3,
          'EXTRA_PRINCIPAL',
          $4,
          $4,
          0,
          $5,
          $6,
          $7,
          NULL,
          $8
        )
        `,
        [
          paymentId,
          loanId,
          airlineId,
          paymentAmount,
          balanceBefore,
          balanceAfter,
          clock.current_sim_time,
          financeLogId
        ]
      );

      await client.query(
        `
        UPDATE public.company_finance

        SET
          capital =
            COALESCE(capital, 0) - $2,

          expenses =
            COALESCE(expenses, 0) + $2,

          profit =
            COALESCE(profit, 0) - $2,

          cost_loans =
            COALESCE(cost_loans, 0) + $2,

          updated_at = NOW()

        WHERE airline_id = $1
        `,
        [
          airlineId,
          paymentAmount
        ]
      );

      const updatedLoanResult =
        await client.query(
          `
          UPDATE public.bank_loans

          SET
            remaining_principal = $3,

            status =
              CASE
                WHEN $3 = 0 THEN 'PAID'
                ELSE status
              END,

            last_payment_sim_time = $4,

            closed_sim_time =
              CASE
                WHEN $3 = 0 THEN $4
                ELSE closed_sim_time
              END,

            updated_at = NOW()

          WHERE id = $1
            AND airline_id = $2

          RETURNING *
          `,
          [
            loanId,
            airlineId,
            balanceAfter,
            clock.current_sim_time
          ]
        );

      if (balanceAfter === 0) {
        await client.query(
          `
          UPDATE public.bank_loan_collateral

          SET
            released_sim_time = $3,
            updated_at = NOW()

          WHERE loan_id = $1
            AND airline_id = $2
            AND released_sim_time IS NULL
          `,
          [
            loanId,
            airlineId,
            clock.current_sim_time
          ]
        );
      }

      await client.query("COMMIT");

      return res.json({
        ok: true,
        endpoint: "ACS_BANK_AMORTIZE_LOAN",
        authority: "RAILWAY_POSTGRESQL",

        payment: {
          id: paymentId,
          amount: paymentAmount,
          balanceBefore,
          balanceAfter,
          financeLogId: String(financeLogId)
        },

        loan:
          updatedLoanResult.rows[0],

        collateralReleased:
          balanceAfter === 0
      });

    } catch (error) {
      await client.query("ROLLBACK");

      console.error(
        "ACS BANK AMORTIZATION ERROR:",
        error
      );

      return res
        .status(error.statusCode || 500)
        .json({
          ok: false,
          error:
            error.code ||
            "BANK_AMORTIZATION_FAILED",
          details:
            error.details || error.message
        });

    } finally {
      client.release();
    }
  }
);

export default router;
