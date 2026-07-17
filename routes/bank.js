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

export default router;
