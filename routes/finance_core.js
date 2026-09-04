/* ============================================================
   ACS OCC —  FINANCE CORE
   ------------------------------------------------------------
   Purpose:
   - Official simulation-month authority
   - Monthly payroll settlement
   - Monthly leasing settlement
   - Monthly finance history
   - Transaction-safe rollover
   - Multi-player concurrency control

   Authority:
   - PostgreSQL
   - acs_get_current_sim_time()
   - Authenticated airline from caller
   - Backend only

   Forbidden:
   - Date.now()
   - new Date()
   - localStorage
   - frontend financial authority
   - frontend month/year authority
   - frontend payroll/leasing amounts
   ============================================================ */

const ACS_toInteger = value => {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.round(number);
};

const ACS_periodNumber = (year, month) => {
  return (Number(year) * 12) + Number(month) - 1;
};

const ACS_nextPeriod = (year, month) => {
  if (Number(month) === 12) {
    return {
      year: Number(year) + 1,
      month: 1
    };
  }

  return {
    year: Number(year),
    month: Number(month) + 1
  };
};

const ACS_monthKey = (year, month) => {
  return (
    String(year).padStart(4, "0") +
    "-" +
    String(month).padStart(2, "0")
  );
};

/* ============================================================
   ACS CORPORATE INCOME TAX — HISTORICAL GLOBAL RATE
   ------------------------------------------------------------
   Internal values use basis points:
   100 basis points = 1%.
   PostgreSQL simulation year is the only year authority.
   ============================================================ */

const ACS_getCorporateTaxRateBasisPoints = (year) => {
  const normalizedYear = Number(year);

  if (
    !Number.isInteger(normalizedYear) ||
    normalizedYear < 1800 ||
    normalizedYear > 2200
  ) {
    throw new Error(
      "INVALID_CORPORATE_TAX_SIMULATION_YEAR"
    );
  }

  if (normalizedYear < 1913) return 0;
  if (normalizedYear <= 1919) return 200;
  if (normalizedYear <= 1929) return 1000;
  if (normalizedYear <= 1939) return 1500;
  if (normalizedYear <= 1945) return 2500;
  if (normalizedYear <= 1951) return 3000;
  if (normalizedYear <= 1963) return 4000;
  if (normalizedYear <= 1967) return 3800;
  if (normalizedYear <= 1979) return 4000;
  if (normalizedYear <= 1989) return 3800;
  if (normalizedYear <= 1999) return 3300;
  if (normalizedYear <= 2009) return 2800;
  if (normalizedYear <= 2017) return 2400;

  return 2200;
};

/* ============================================================
   ACS AIRCRAFT INSURANCE — POLICY AUTHORITY v1.0
   ------------------------------------------------------------
   Rules:
   - One policy per aircraft.
   - BASIC is mandatory.
   - Annual contract with monthly payments.
   - PostgreSQL simulation time is the only date authority.
   - RANK integration is prepared but not executed.
   ============================================================ */

const ACS_INSURANCE_PLANS = Object.freeze({
  BASIC: Object.freeze({
    planCode: "BASIC",
    coveragePercent: 50,
    deductiblePercent: 20,
    monthlyRate: 0.0015,
    rankModifierBasisPoints: 0
  }),

  STANDARD: Object.freeze({
    planCode: "STANDARD",
    coveragePercent: 80,
    deductiblePercent: 10,
    monthlyRate: 0.0030,
    rankModifierBasisPoints: 200
  }),

  GOLD: Object.freeze({
    planCode: "GOLD",
    coveragePercent: 100,
    deductiblePercent: 5,
    monthlyRate: 0.0050,
    rankModifierBasisPoints: 500
  })
});

function ACS_normalizeInsurancePlan(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  return ACS_INSURANCE_PLANS[normalized]
    ? normalized
    : null;
}

function ACS_getInsurancePlan(planCode) {
  const normalized =
    ACS_normalizeInsurancePlan(planCode);

  if (!normalized) {
    throw new Error(
      "AIRCRAFT_INSURANCE_PLAN_INVALID"
    );
  }

  return ACS_INSURANCE_PLANS[normalized];
}

/* ============================================================
   AGE RISK MULTIPLIER
   ============================================================ */

function ACS_getInsuranceAgeMultiplier(ageYears) {
  const age = Number(ageYears);

  if (!Number.isFinite(age) || age < 0) {
    throw new Error(
      "AIRCRAFT_INSURANCE_AGE_INVALID"
    );
  }

  if (age <= 5) {
    return 1.00;
  }

  if (age <= 10) {
    return 1.10;
  }

  if (age <= 15) {
    return 1.25;
  }

  if (age <= 20) {
    return 1.45;
  }

  return 1.75;
}

/* ============================================================
   MONTHLY PREMIUM CALCULATION
   ------------------------------------------------------------
   The aircraft value and age must come from PostgreSQL.
   This function never obtains time from JavaScript.
   ============================================================ */

function ACS_calculateInsurancePremium({
  planCode,
  currentValue,
  ageYears
}) {
  const plan = ACS_getInsurancePlan(planCode);

  const insuredValue =
    ACS_toInteger(currentValue);

  if (insuredValue < 0) {
    throw new Error(
      "AIRCRAFT_INSURANCE_VALUE_INVALID"
    );
  }

  const ageMultiplier =
    ACS_getInsuranceAgeMultiplier(ageYears);

  const monthlyPremium = Math.max(
    0,
    Math.round(
      insuredValue *
      plan.monthlyRate *
      ageMultiplier
    )
  );

  return {
    plan_code: plan.planCode,
    insured_value: insuredValue,
    coverage_percent:
      plan.coveragePercent,
    deductible_percent:
      plan.deductiblePercent,
    monthly_rate:
      plan.monthlyRate,
    age_multiplier:
      ageMultiplier,
    monthly_premium:
      monthlyPremium,

    /*
     * Future RANK authority reads this value only when:
     * - policy_status = ACTIVE
     * - outstanding_balance = 0
     */
    rank_modifier_basis_points:
      plan.rankModifierBasisPoints
  };
}

/* ============================================================
   ACS AIRCRAFT INSURANCE — OCC ALERTS
   ============================================================ */

async function ACS_createInsuranceOccAlert(
  client,
  {
    airlineId,
    policyUid,
    registration,
    planCode,
    action,
    amount,
    outstandingBalance = 0,
    nextPaymentSim = null,
    eventSimTime,
    monthKey
  }
) {
  const normalizedAction = String(action || "")
    .trim()
    .toUpperCase();

  const cleanRegistration =
    String(registration || "UNREGISTERED").trim();

  const cleanPlan =
    ACS_normalizeInsurancePlan(planCode) || "BASIC";

  const cleanAmount =
    Math.max(0, ACS_toInteger(amount));

  const cleanOutstanding =
    Math.max(0, ACS_toInteger(outstandingBalance));

  const messages = {
    PAID: {
      level: "info",
      title: "AIRCRAFT INSURANCE PAID",
      message:
        `Monthly insurance premium for aircraft ` +
        `${cleanRegistration} has been paid successfully.\n\n` +
        `Policy: ${cleanPlan}\n` +
        `Amount paid: USD ${cleanAmount.toLocaleString("en-US")}\n` +
        `Coverage: ACTIVE` +
        (
          nextPaymentSim
            ? `\nNext payment: ${nextPaymentSim}`
            : ""
        )
    },

    PAYMENT_DUE: {
      level:
        cleanOutstanding > cleanAmount
          ? "critical"
          : "warning",
      title:
        cleanOutstanding > cleanAmount
          ? "AIRCRAFT INSURANCE COVERAGE SUSPENDED"
          : "AIRCRAFT INSURANCE PAYMENT DUE",
      message:
        `Insurance payment for aircraft ` +
        `${cleanRegistration} could not be completed ` +
        `due to insufficient company funds.\n\n` +
        `Policy: ${cleanPlan}\n` +
        `Amount due: USD ${cleanAmount.toLocaleString("en-US")}\n` +
        `Outstanding balance: USD ` +
        `${cleanOutstanding.toLocaleString("en-US")}\n` +
        `Coverage status: PAYMENT DUE`
    },

    RESTORED: {
      level: "info",
      title: "AIRCRAFT INSURANCE RESTORED",
      message:
        `Outstanding insurance premiums for aircraft ` +
        `${cleanRegistration} have been paid.\n\n` +
        `Amount settled: USD ` +
        `${cleanAmount.toLocaleString("en-US")}\n` +
        `Policy: ${cleanPlan}\n` +
        `Full coverage has been restored.`
    }
  };

  const alert = messages[normalizedAction];

  if (!alert) {
    throw new Error(
      "AIRCRAFT_INSURANCE_ALERT_ACTION_INVALID"
    );
  }

  const alertKey =
    `INSURANCE_${normalizedAction}:` +
    `${policyUid}:${monthKey}`;

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
      $3,
      $4,
      $5,
      'aircraft_insurance_policies',
      $6,
      $7,
      NOW(),
      NOW()
    )
    ON CONFLICT (airline_id, alert_key)
    WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING id
    `,
    [
      airlineId,
      alertKey,
      alert.level,
      alert.title,
      alert.message,
      String(policyUid),
      eventSimTime
    ]
  );

  return result.rows[0] || null;
}

/* ============================================================
   ENSURE MANDATORY BASIC POLICY
   ============================================================ */

async function ACS_ensureBasicAircraftInsurance(
  client,
  airlineId,
  officialPeriod
) {
  const aircraftResult = await client.query(
    `
    SELECT
      af.id,
      af.registration,
      af.current_value,

      GREATEST(
        0,
        EXTRACT(
          YEAR FROM acs_get_current_sim_time()
        )::INTEGER
        - COALESCE(
            af.year_built,
            EXTRACT(
              YEAR FROM acs_get_current_sim_time()
            )::INTEGER
          )
      ) AS age_years

    FROM public.aircraft_fleet af

    LEFT JOIN public.aircraft_insurance_policies aip
      ON aip.aircraft_id = af.id

    WHERE af.airline_id = $1
      AND aip.id IS NULL
      AND UPPER(COALESCE(af.status, 'ACTIVE'))
          <> 'SCRAPPED'

    ORDER BY af.id

    FOR UPDATE OF af
    `,
    [airlineId]
  );

  let createdCount = 0;

  for (const aircraft of aircraftResult.rows) {
    const quote = ACS_calculateInsurancePremium({
      planCode: "BASIC",
      currentValue: aircraft.current_value,
      ageYears: aircraft.age_years
    });

    const inserted = await client.query(
      `
      INSERT INTO public.aircraft_insurance_policies (
        airline_id,
        aircraft_id,
        plan_code,
        policy_status,
        insured_value,
        coverage_percent,
        deductible_percent,
        monthly_rate,
        age_multiplier,
        monthly_premium,
        rank_modifier_basis_points,
        outstanding_balance,
        policy_start_sim,
        policy_end_sim,
        next_payment_sim,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'BASIC',
        'ACTIVE',
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        0,
        0,
        $9::TIMESTAMP,
        $9::TIMESTAMP + INTERVAL '1 year',
        $9::TIMESTAMP,
        NOW(),
        NOW()
      )
      ON CONFLICT (aircraft_id)
      DO NOTHING
      RETURNING id
      `,
      [
        airlineId,
        aircraft.id,
        quote.insured_value,
        quote.coverage_percent,
        quote.deductible_percent,
        quote.monthly_rate,
        quote.age_multiplier,
        quote.monthly_premium,
        officialPeriod.sim_time
      ]
    );

    if (inserted.rows.length) {
      createdCount += 1;
    }
  }

  return createdCount;
}

/* ============================================================
   SETTLE INSURANCE THROUGH ACS SIMULATION TIME
   ============================================================ */

async function ACS_settleAircraftInsurance(
  client,
  airlineId,
  cutoffSimTime
) {
  let appliedCount = 0;

  /*
   * Activate scheduled downgrades whose historical
   * effective date has arrived.
   */
  await client.query(
    `
    UPDATE public.aircraft_insurance_policies
    SET
      plan_code = pending_plan_code,
      pending_plan_code = NULL,
      pending_plan_effective_sim = NULL,
      updated_at = NOW()
    WHERE airline_id = $1
      AND pending_plan_code IS NOT NULL
      AND pending_plan_effective_sim IS NOT NULL
      AND pending_plan_effective_sim
          <= $2::TIMESTAMP
    `,
    [
      airlineId,
      cutoffSimTime
    ]
  );

  /*
   * First restore policies whose complete outstanding balance
   * can now be paid.
   */
  const arrearsResult = await client.query(
    `
    SELECT
      aip.*,
      af.registration,
      cf.capital,

      TO_CHAR(
        $2::TIMESTAMP,
        'YYYY-MM'
      ) AS month_key

    FROM public.aircraft_insurance_policies aip

    JOIN public.aircraft_fleet af
      ON af.id = aip.aircraft_id
     AND af.airline_id = aip.airline_id

    JOIN public.company_finance cf
      ON cf.airline_id = aip.airline_id

    WHERE aip.airline_id = $1
      AND aip.policy_status = 'PAYMENT_DUE'
      AND aip.outstanding_balance > 0
      AND COALESCE(cf.capital, 0)
          >= aip.outstanding_balance

    ORDER BY
  aip.outstanding_balance ASC,
  aip.id

LIMIT 1

FOR UPDATE OF aip, cf
    `,
    [airlineId, cutoffSimTime]
  );

  for (const policy of arrearsResult.rows) {
    const amount =
      ACS_toInteger(policy.outstanding_balance);

    const paymentReference =
      `INSURANCE_ARREARS:` +
      `${policy.policy_uid}:` +
      `${policy.month_key}`;

    const logResult = await client.query(
      `
      INSERT INTO public.finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        reference_uid,
        description,
        created_at
      )
      VALUES (
        $1,
        'PAYMENT',
        'AIRCRAFT_INSURANCE_ARREARS',
        $2,
        FLOOR(
          EXTRACT(EPOCH FROM $3::TIMESTAMP) * 1000
        )::BIGINT,
        $4,
        $5,
        NOW()
      )
      ON CONFLICT (reference_uid)
      DO NOTHING
      RETURNING id
      `,
      [
        airlineId,
        amount,
        cutoffSimTime,
        paymentReference,
        `Insurance arrears paid for aircraft ` +
          `${policy.registration || "UNREGISTERED"}`
      ]
    );

    if (!logResult.rows.length) {
      continue;
    }

    await client.query(
      `
      UPDATE public.company_finance
      SET
        capital = COALESCE(capital, 0) - $2,
        debt = GREATEST(
          0,
          COALESCE(debt, 0) - $2
        ),
        updated_at = NOW()
      WHERE airline_id = $1
      `,
      [airlineId, amount]
    );

    await client.query(
      `
      UPDATE public.aircraft_insurance_policies
      SET
        policy_status = 'ACTIVE',
        outstanding_balance = 0,
        updated_at = NOW()
      WHERE id = $1
      `,
      [policy.id]
    );

    await ACS_createInsuranceOccAlert(
      client,
      {
        airlineId,
        policyUid: policy.policy_uid,
        registration: policy.registration,
        planCode: policy.plan_code,
        action: "RESTORED",
        amount,
        eventSimTime: cutoffSimTime,
        monthKey: policy.month_key
      }
    );

    appliedCount += 1;
  }

  /*
   * Process every premium whose anniversary has arrived.
   */
  while (true) {
    const dueResult = await client.query(
      `
      SELECT
        aip.*,
        af.registration,
        af.current_value,
        cf.capital,

        GREATEST(
          0,
          EXTRACT(
            YEAR FROM aip.next_payment_sim
          )::INTEGER
          - COALESCE(
              af.year_built,
              EXTRACT(
                YEAR FROM aip.next_payment_sim
              )::INTEGER
            )
        ) AS age_years,

        TO_CHAR(
          aip.next_payment_sim,
          'YYYY-MM'
        ) AS month_key

      FROM public.aircraft_insurance_policies aip

      JOIN public.aircraft_fleet af
        ON af.id = aip.aircraft_id
       AND af.airline_id = aip.airline_id

      JOIN public.company_finance cf
        ON cf.airline_id = aip.airline_id

      WHERE aip.airline_id = $1
        AND aip.policy_status IN (
          'ACTIVE',
          'PAYMENT_DUE'
        )
        AND aip.next_payment_sim <= $2::TIMESTAMP

      ORDER BY
        aip.next_payment_sim,
        aip.id

      LIMIT 1

      FOR UPDATE OF aip, cf
      `,
      [airlineId, cutoffSimTime]
    );

    if (!dueResult.rows.length) {
      break;
    }

    const policy = dueResult.rows[0];

    const quote = ACS_calculateInsurancePremium({
      planCode: policy.plan_code,
      currentValue: policy.current_value,
      ageYears: policy.age_years
    });

    const premium =
      ACS_toInteger(quote.monthly_premium);

    const paymentReference =
      `INSURANCE_MONTHLY:` +
      `${policy.policy_uid}:` +
      `${policy.month_key}`;

    const existingLog = await client.query(
      `
      SELECT id
      FROM public.finance_log
      WHERE reference_uid = $1
      LIMIT 1
      `,
      [paymentReference]
    );

    if (existingLog.rows.length) {
      await client.query(
        `
        UPDATE public.aircraft_insurance_policies
        SET
          next_payment_sim =
            next_payment_sim + INTERVAL '1 month',
          updated_at = NOW()
        WHERE id = $1
        `,
        [policy.id]
      );

      continue;
    }

    const cannotPay =
      ACS_toInteger(policy.outstanding_balance) > 0 ||
      ACS_toInteger(policy.capital) < premium;

    await client.query(
      `
      INSERT INTO public.finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        reference_uid,
        description,
        created_at
      )
      VALUES (
        $1,
        'EXPENSE',
        'AIRCRAFT_INSURANCE_MONTHLY',
        $2,
        FLOOR(
          EXTRACT(
            EPOCH FROM $3::TIMESTAMP
          ) * 1000
        )::BIGINT,
        $4,
        $5,
        NOW()
      )
      `,
      [
        airlineId,
        premium,
        policy.next_payment_sim,
        paymentReference,
        `Monthly ${policy.plan_code} insurance for ` +
          `${policy.registration || "UNREGISTERED"}`
      ]
    );

    if (cannotPay) {
      await client.query(
        `
        UPDATE public.company_finance
        SET
          expenses =
            COALESCE(expenses, 0) + $2,
          profit =
            COALESCE(profit, 0) - $2,
          cost_insurance =
            COALESCE(cost_insurance, 0) + $2,
          debt =
            COALESCE(debt, 0) + $2,
          updated_at = NOW()
        WHERE airline_id = $1
        `,
        [airlineId, premium]
      );

      const updatedPolicy = await client.query(
        `
        UPDATE public.aircraft_insurance_policies
        SET
          policy_status = 'PAYMENT_DUE',
          insured_value = $2,
          coverage_percent = $3,
          deductible_percent = $4,
          monthly_rate = $5,
          age_multiplier = $6,
          monthly_premium = $7,
          rank_modifier_basis_points = $8,
          outstanding_balance =
            outstanding_balance + $7,
          next_payment_sim =
            next_payment_sim + INTERVAL '1 month',
          policy_end_sim = CASE
            WHEN next_payment_sim >= policy_end_sim
              THEN policy_end_sim + INTERVAL '1 year'
            ELSE policy_end_sim
          END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING outstanding_balance
        `,
        [
          policy.id,
          quote.insured_value,
          quote.coverage_percent,
          quote.deductible_percent,
          quote.monthly_rate,
          quote.age_multiplier,
          premium,
          quote.rank_modifier_basis_points
        ]
      );

      await ACS_createInsuranceOccAlert(
        client,
        {
          airlineId,
          policyUid: policy.policy_uid,
          registration: policy.registration,
          planCode: policy.plan_code,
          action: "PAYMENT_DUE",
          amount: premium,
          outstandingBalance:
            updatedPolicy.rows[0].outstanding_balance,
          eventSimTime: policy.next_payment_sim,
          monthKey: policy.month_key
        }
      );
    } else {
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
          cost_insurance =
            COALESCE(cost_insurance, 0) + $2,
          updated_at = NOW()
        WHERE airline_id = $1
        `,
        [airlineId, premium]
      );

      const updatedPolicy = await client.query(
        `
        UPDATE public.aircraft_insurance_policies
        SET
          policy_status = 'ACTIVE',
          insured_value = $2,
          coverage_percent = $3,
          deductible_percent = $4,
          monthly_rate = $5,
          age_multiplier = $6,
          monthly_premium = $7,
          rank_modifier_basis_points = $8,
          last_payment_sim = next_payment_sim,
          next_payment_sim =
            next_payment_sim + INTERVAL '1 month',
          policy_end_sim = CASE
            WHEN next_payment_sim >= policy_end_sim
              THEN policy_end_sim + INTERVAL '1 year'
            ELSE policy_end_sim
          END,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          TO_CHAR(
            next_payment_sim,
            'DD MON YYYY'
          ) AS next_payment_display
        `,
        [
          policy.id,
          quote.insured_value,
          quote.coverage_percent,
          quote.deductible_percent,
          quote.monthly_rate,
          quote.age_multiplier,
          premium,
          quote.rank_modifier_basis_points
        ]
      );

      await ACS_createInsuranceOccAlert(
        client,
        {
          airlineId,
          policyUid: policy.policy_uid,
          registration: policy.registration,
          planCode: policy.plan_code,
          action: "PAID",
          amount: premium,
          nextPaymentSim:
            updatedPolicy.rows[0].next_payment_display,
          eventSimTime: policy.next_payment_sim,
          monthKey: policy.month_key
        }
      );
    }

    appliedCount += 1;
  }

  return appliedCount;
}

/* ============================================================
   OFFICIAL SIMULATION PERIOD
   ============================================================ */

export async function ACS_getOfficialFinancePeriod(client) {
  const result = await client.query(
    `
    SELECT
      acs_get_current_sim_time() AS sim_time,

      EXTRACT(
        YEAR FROM acs_get_current_sim_time()
      )::INTEGER AS sim_year,

      EXTRACT(
        MONTH FROM acs_get_current_sim_time()
      )::INTEGER AS sim_month,

      FLOOR(
        EXTRACT(
          EPOCH FROM acs_get_current_sim_time()
        ) * 1000
      )::BIGINT AS sim_timestamp_ms
    `
  );

  if (!result.rows.length) {
    throw new Error("OFFICIAL_SIMULATION_TIME_NOT_FOUND");
  }

  const row = result.rows[0];

  const year = Number(row.sim_year);
  const month = Number(row.sim_month);
  const timestampMs = Number(row.sim_timestamp_ms);

  if (!Number.isInteger(year)) {
    throw new Error("INVALID_OFFICIAL_SIMULATION_YEAR");
  }

  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    throw new Error("INVALID_OFFICIAL_SIMULATION_MONTH");
  }

  return {
    sim_time: row.sim_time,
    year,
    month,
    month_key: ACS_monthKey(year, month),
    timestamp_ms: timestampMs
  };
}

/* ============================================================
   ENSURE COMPANY FINANCE ROW
   ------------------------------------------------------------
   Must be called inside an open transaction.
   ============================================================ */

async function ACS_ensureCompanyFinanceRow(
  client,
  airlineId,
  officialPeriod
) {
  await client.query(
    `
    INSERT INTO public.company_finance (
      airline_id,
      capital,
      opening_capital,
      current_sim_year,
      current_sim_month
    )
    VALUES (
      $1,
      1500000,
      1500000,
      $2,
      $3
    )
    ON CONFLICT (airline_id)
    DO NOTHING
    `,
    [
      airlineId,
      officialPeriod.year,
      officialPeriod.month
    ]
  );

  const result = await client.query(
    `
    SELECT *
    FROM public.company_finance
    WHERE airline_id = $1
    FOR UPDATE
    `,
    [airlineId]
  );

  if (!result.rows.length) {
    throw new Error("COMPANY_FINANCE_NOT_FOUND");
  }

  let finance = result.rows[0];

  /*
   * Compatibility initialization for rows created by old routes
   * before those routes are migrated to Finance Core.
   */
  if (
    finance.current_sim_year === null ||
    finance.current_sim_month === null
  ) {
    const initialized = await client.query(
      `
      UPDATE public.company_finance
      SET
        current_sim_year = $2,
        current_sim_month = $3,
        opening_capital =
          COALESCE(capital, 0)
          - COALESCE(profit, 0),
        updated_at = NOW()
      WHERE airline_id = $1
      RETURNING *
      `,
      [
        airlineId,
        officialPeriod.year,
        officialPeriod.month
      ]
    );

    finance = initialized.rows[0];
  }

  return finance;
}

/* ============================================================
   PERIOD BOUNDARIES
   ------------------------------------------------------------
   PostgreSQL constructs all simulation dates.
   No JavaScript date authority.
   ============================================================ */

async function ACS_getPeriodBoundaries(
  client,
  year,
  month
) {
  const result = await client.query(
    `
    SELECT
      MAKE_DATE($1, $2, 1)::TIMESTAMP
        AS period_start,

            (
        MAKE_DATE($1, $2, 1)
        + INTERVAL '1 month'
      )::TIMESTAMP
        AS next_period_start,

      (
        MAKE_DATE($1, $2, 1)
        + INTERVAL '1 month'
        - INTERVAL '1 millisecond'
      )::TIMESTAMP
        AS period_end,

      FLOOR(
        EXTRACT(
          EPOCH FROM MAKE_DATE($1, $2, 1)
        ) * 1000
      )::BIGINT
        AS period_start_timestamp_ms,

      FLOOR(
        EXTRACT(
          EPOCH FROM (
            MAKE_DATE($1, $2, 1)
            + INTERVAL '1 month'
          )
        ) * 1000
      )::BIGINT
        AS next_period_timestamp_ms
    `,
    [
      year,
      month
    ]
  );

  return result.rows[0];
}

/* ============================================================
   SETTLE MONTHLY PAYROLL
   ------------------------------------------------------------
   Payroll amount comes exclusively from hr_departments.
   One canonical log per airline and simulation month.
   ============================================================ */

async function ACS_settleMonthlyPayroll(
  client,
  airlineId,
  year,
  month,
  settlementTimestampMs
) {
  const monthKey = ACS_monthKey(year, month);
  const referenceUid =
    `PAYROLL:${airlineId}:${monthKey}`;

  const result = await client.query(
    `
    WITH payroll_total AS (
      SELECT
        COALESCE(
      SUM(
      ROUND(
      COALESCE(staff, 0)::NUMERIC *
      COALESCE(salary, 0)::NUMERIC
        )
       ),
        0
      )::BIGINT AS amount
      FROM public.hr_departments
      WHERE airline_id = $1
    ),

    inserted_log AS (
      INSERT INTO public.finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        route_plan_id,
        schedule_item_id,
        reference_uid,
        description,
        created_at
      )
      SELECT
        $1,
        'EXPENSE',
        'HR_PAYROLL',
        payroll_total.amount,
        $2,
        NULL,
        NULL,
        $3,
        $4,
        NOW()
      FROM payroll_total
      WHERE payroll_total.amount > 0

      ON CONFLICT (reference_uid)
      DO NOTHING

      RETURNING amount
    )

    SELECT
      COALESCE(
        SUM(amount),
        0
      )::BIGINT AS applied_amount
    FROM inserted_log
    `,
    [
      airlineId,
      settlementTimestampMs,
      referenceUid,
      `Monthly payroll settled by ACS OCC for ${monthKey}`
    ]
  );

  return ACS_toInteger(
    result.rows[0]?.applied_amount
  );
}

/* ============================================================
   SETTLE MONTHLY LEASING
   ------------------------------------------------------------
   Contract selection and amounts come exclusively from PostgreSQL.
   One canonical log per contract and simulation month.
   ============================================================ */

async function ACS_settleMonthlyLeasing(
  client,
  airlineId,
  year,
  month,
  closingTimestampMs,
  boundaries
) {
  const monthKey = ACS_monthKey(year, month);

  const result = await client.query(
    `
    WITH eligible_contracts AS (
      SELECT
        alc.id,
        alc.contract_uid,
        alc.monthly_payment,
        alc.aircraft_name
      FROM public.aircraft_leasing_contracts alc
      WHERE alc.airline_id = $1
        AND alc.status = 'ACTIVE'
        AND alc.monthly_payment > 0

        /*
         * Contract existed during at least part of
         * the simulation month being closed.
         */
        AND alc.lease_start_date < $2::TIMESTAMP
        AND alc.lease_end_date >= $3::TIMESTAMP

      FOR UPDATE
    ),

    inserted_logs AS (
      INSERT INTO public.finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        route_plan_id,
        schedule_item_id,
        reference_uid,
        description,
        created_at
      )
      SELECT
        $1,
        'EXPENSE',
        'AIRCRAFT_LEASING_MONTHLY',
        ROUND(ec.monthly_payment)::BIGINT,
        $4,
        NULL,
        NULL,
        (
          'LEASE_MONTHLY:'
          || ec.contract_uid::TEXT
          || ':'
          || $5
        ),
        (
          'Monthly leasing payment for '
          || COALESCE(
            NULLIF(TRIM(ec.aircraft_name), ''),
            ec.contract_uid::TEXT
          )
          || ' — '
          || $5
        ),
        NOW()
      FROM eligible_contracts ec

      ON CONFLICT (reference_uid)
      DO NOTHING

      RETURNING
        reference_uid,
        amount
    ),

    updated_contracts AS (
      UPDATE public.aircraft_leasing_contracts alc
      SET
        last_payment_date = $3::TIMESTAMP,
        next_payment_due_date = $2::TIMESTAMP,
        updated_at = NOW()
      FROM eligible_contracts ec
      WHERE alc.id = ec.id
      RETURNING alc.id
    )

    SELECT
      COALESCE(
        SUM(amount),
        0
      )::BIGINT AS applied_amount
    FROM inserted_logs
    `,
    [
      airlineId,
      boundaries.next_period_start,
      boundaries.period_start,
      closingTimestampMs,
      monthKey
    ]
  );

  return ACS_toInteger(
    result.rows[0]?.applied_amount
  );
}

/* ============================================================
   COUNT SETTLED FLIGHTS IN PERIOD
   ------------------------------------------------------------
   Counts canonical FLIGHT_REVENUE settlements.
   No route history is created.
   ============================================================ */

async function ACS_countMonthlyFlights(
  client,
  airlineId,
  boundaries
) {
  const result = await client.query(
    `
    SELECT
      COUNT(
        DISTINCT schedule_item_id
      )::INTEGER AS flight_count
    FROM public.finance_log
    WHERE airline_id = $1
      AND source = 'FLIGHT_REVENUE'
      AND schedule_item_id IS NOT NULL
      AND timestamp >= FLOOR(
        EXTRACT(
          EPOCH FROM $2::TIMESTAMP
        ) * 1000
      )::BIGINT
      AND timestamp < FLOOR(
        EXTRACT(
          EPOCH FROM $3::TIMESTAMP
        ) * 1000
      )::BIGINT
    `,
    [
      airlineId,
      boundaries.period_start,
      boundaries.next_period_start
    ]
  );

  return ACS_toInteger(
    result.rows[0]?.flight_count
  );
}

/* ============================================================
   SETTLE MONTHLY AIRCRAFT DEPRECIATION
   ------------------------------------------------------------
   Rules:
   - OWNED aircraft only.
   - Straight-line monthly depreciation.
   - Full monthly charge when available during any part
     of the closing month.
   - Monthly amount is always rounded upward.
   - Capital is not reduced because this is a non-cash expense.
   - Book value never falls below residual value.
   - One canonical movement per aircraft and month.
   ============================================================ */

async function ACS_settleMonthlyAircraftDepreciation(
  client,
  airlineId,
  year,
  month,
  closingTimestampMs,
  boundaries
) {
  const monthKey = ACS_monthKey(year, month);

  const result = await client.query(
    `
    WITH eligible_aircraft AS MATERIALIZED (
      SELECT
        af.id,
        af.registration,
        af.aircraft_name,
        af.depreciation_basis,
        af.depreciation_residual_value,
        af.depreciation_useful_life_months,
        af.accumulated_depreciation,
        af.book_value,

        LEAST(
          GREATEST(
            COALESCE(af.book_value, 0)
              - COALESCE(
                  af.depreciation_residual_value,
                  0
                ),
            0
          ),

          CEIL(
            GREATEST(
              COALESCE(af.depreciation_basis, 0)
                - COALESCE(
                    af.depreciation_residual_value,
                    0
                  ),
              0
            )::NUMERIC
            /
            GREATEST(
              COALESCE(
                af.depreciation_useful_life_months,
                0
              ),
              1
            )::NUMERIC
          )::BIGINT
        )::BIGINT AS depreciation_amount

      FROM public.aircraft_fleet af

      WHERE af.airline_id = $1
        AND af.ownership_type = 'OWNED'
        AND af.depreciation_status = 'ACTIVE'
        AND af.depreciation_method = 'STRAIGHT_LINE'
        AND af.depreciation_start_sim IS NOT NULL

        /*
         * The aircraft was available during at least part
         * of the simulation month being closed.
         */
        AND af.depreciation_start_sim < $2::TIMESTAMP

        AND COALESCE(af.book_value, 0)
          > COALESCE(
              af.depreciation_residual_value,
              0
            )

        AND af.depreciation_last_month_key
          IS DISTINCT FROM $4::VARCHAR

      FOR UPDATE
    ),

    inserted_logs AS (
      INSERT INTO public.finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        route_plan_id,
        schedule_item_id,
        reference_uid,
        description,
        created_at
      )

      SELECT
        $1,
        'EXPENSE',
        'AIRCRAFT_DEPRECIATION_MONTHLY',
        ea.depreciation_amount,
        $3,
        NULL,
        NULL,

        (
          'AIRCRAFT_DEPRECIATION:'
          || ea.id::TEXT
          || ':'
          || $4::VARCHAR
        ),

        (
          'Monthly depreciation — '
          || COALESCE(
               NULLIF(ea.registration, ''),
               ea.aircraft_name,
               'Aircraft'
             )
          || ' — '
          || $4::VARCHAR
        ),

        NOW()

      FROM eligible_aircraft ea

      WHERE ea.depreciation_amount > 0

      ON CONFLICT (reference_uid)
      DO NOTHING

      RETURNING
        reference_uid,
        amount
    ),

    updated_aircraft AS (
      UPDATE public.aircraft_fleet af

      SET
        accumulated_depreciation =
          LEAST(
            COALESCE(af.depreciation_basis, 0)
              - COALESCE(
                  af.depreciation_residual_value,
                  0
                ),

            COALESCE(
              af.accumulated_depreciation,
              0
            ) + ea.depreciation_amount
          ),

        book_value =
          GREATEST(
            COALESCE(
              af.depreciation_residual_value,
              0
            ),

            COALESCE(af.book_value, 0)
              - ea.depreciation_amount
          ),

        depreciation_last_month_key =
          $4::VARCHAR,

        depreciation_status =
          CASE
            WHEN
              COALESCE(af.book_value, 0)
                - ea.depreciation_amount
              <= COALESCE(
                   af.depreciation_residual_value,
                   0
                 )
            THEN 'FULLY_DEPRECIATED'
            ELSE 'ACTIVE'
          END,

        updated_at = NOW()

      FROM eligible_aircraft ea

      JOIN inserted_logs il
        ON il.reference_uid = (
          'AIRCRAFT_DEPRECIATION:'
          || ea.id::TEXT
          || ':'
          || $4::VARCHAR
        )

      WHERE af.id = ea.id

      RETURNING
        af.id,
        ea.depreciation_amount
    )

    SELECT
      COUNT(*)::INTEGER AS aircraft_count,

      COALESCE(
        SUM(depreciation_amount),
        0
      )::BIGINT AS applied_amount

    FROM updated_aircraft
    `,
    [
      airlineId,
      boundaries.next_period_start,
      closingTimestampMs,
      monthKey
    ]
  );

  const aircraftCount =
    ACS_toInteger(
      result.rows[0]?.aircraft_count
    );

  const appliedAmount =
    ACS_toInteger(
      result.rows[0]?.applied_amount
    );

  if (appliedAmount > 0) {
    const financeResult = await client.query(
      `
      UPDATE public.company_finance
      SET
        expenses =
          COALESCE(expenses, 0) + $2,

        profit =
          COALESCE(profit, 0) - $2,

        cost_depreciation =
          COALESCE(cost_depreciation, 0) + $2,

        updated_at = NOW()

      WHERE airline_id = $1

      RETURNING airline_id
      `,
      [
        airlineId,
        appliedAmount
      ]
    );

    if (!financeResult.rows.length) {
      throw new Error(
        "COMPANY_FINANCE_DEPRECIATION_UPDATE_FAILED"
      );
    }
  }

    return {
    aircraftCount,
    appliedAmount
  };
}

/* ============================================================
   SETTLE MONTHLY CORPORATE INCOME TAX
   ------------------------------------------------------------
   Rules:
   - Historical global rate.
   - Monthly settlement at finance close.
   - Loan interest is deductible.
   - Loan principal is added back.
   - Losses expire after 12 historical months.
   - Oldest available losses are consumed first.
   - Tax expense affects profit.
   - Only the paid amount reduces capital.
   - Unpaid tax becomes outstanding debt.
   - One canonical settlement per airline and month.
   ============================================================ */

async function ACS_settleMonthlyCorporateTax(
  client,
  airlineId,
  year,
  month,
  closingTimestampMs,
  boundaries
) {
  const monthKey = ACS_monthKey(year, month);

  const taxRateBasisPoints =
    ACS_getCorporateTaxRateBasisPoints(year);

  const existingResult = await client.query(
    `
    SELECT *
    FROM public.corporate_tax
    WHERE airline_id = $1
      AND year = $2
      AND month = $3
    FOR UPDATE
    `,
    [airlineId, year, month]
  );

  if (existingResult.rows.length) {
    const existing = existingResult.rows[0];

    const financeResult = await client.query(
      `
      SELECT *
      FROM public.company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [airlineId]
    );

    return {
      applied: false,
      taxDue: ACS_toInteger(existing.tax_due),
      taxPaid: ACS_toInteger(existing.tax_paid),
      taxOutstanding:
        ACS_toInteger(existing.tax_outstanding),
      priorTaxPaid: 0,
      lossGenerated:
        ACS_toInteger(existing.loss_generated),
      lossApplied:
        ACS_toInteger(existing.loss_applied),
      taxableProfit:
        ACS_toInteger(
          existing.taxable_profit_after_losses
        ),
      taxRateBasisPoints:
        ACS_toInteger(
          existing.tax_rate_basis_points
        ),
      finance: financeResult.rows[0]
    };
  }

  const financeResult = await client.query(
    `
    SELECT *
    FROM public.company_finance
    WHERE airline_id = $1
    FOR UPDATE
    `,
    [airlineId]
  );

  let finance = financeResult.rows[0];

  if (!finance) {
    throw new Error(
      "COMPANY_FINANCE_CORPORATE_TAX_ROW_NOT_FOUND"
    );
  }

  /*
   * Settle older outstanding taxes first.
   * This payment does not affect expenses or profit again.
   */

  let priorTaxPaid = 0;

  let availableForPriorTax = Math.max(
    ACS_toInteger(finance.capital),
    0
  );

  if (availableForPriorTax > 0) {
    const outstandingResult = await client.query(
      `
      SELECT
        id,
        tax_outstanding

      FROM public.corporate_tax

      WHERE airline_id = $1
        AND month_key < $2::VARCHAR
        AND tax_outstanding > 0

      ORDER BY year, month, id

      FOR UPDATE
      `,
      [airlineId, monthKey]
    );

    for (const taxRow of outstandingResult.rows) {
      if (availableForPriorTax <= 0) break;

      const outstandingAmount =
        ACS_toInteger(taxRow.tax_outstanding);

      const paidAmount = Math.min(
        outstandingAmount,
        availableForPriorTax
      );

      if (paidAmount <= 0) continue;

      await client.query(
        `
        UPDATE public.corporate_tax
        SET
          tax_paid = tax_paid + $2,
          tax_outstanding =
            tax_outstanding - $2,

          payment_status =
            CASE
              WHEN tax_outstanding - $2 = 0
                THEN 'PAID'
              ELSE 'PARTIALLY_PAID'
            END,

          settled_sim_time =
            CASE
              WHEN tax_outstanding - $2 = 0
                THEN $3::TIMESTAMP
              ELSE settled_sim_time
            END,

          updated_at = NOW()

        WHERE id = $1
        `,
        [
          taxRow.id,
          paidAmount,
          boundaries.period_end
        ]
      );

      priorTaxPaid += paidAmount;
      availableForPriorTax -= paidAmount;
    }
  }

  if (priorTaxPaid > 0) {
    const priorPaymentResult = await client.query(
      `
      UPDATE public.company_finance
      SET
        capital =
          COALESCE(capital, 0) - $2,

        debt =
          GREATEST(
            COALESCE(debt, 0) - $2,
            0
          ),

        updated_at = NOW()

      WHERE airline_id = $1

      RETURNING *
      `,
      [airlineId, priorTaxPaid]
    );

    if (!priorPaymentResult.rows.length) {
      throw new Error(
        "COMPANY_FINANCE_PRIOR_TAX_PAYMENT_FAILED"
      );
    }

    finance = priorPaymentResult.rows[0];
  }

  const accountingProfitBeforeTax =
    ACS_toInteger(finance.profit);

  /*
   * Principal was recorded as an accounting expense by the
   * loan payment system, but it is not tax deductible.
   * Interest remains included as a deductible expense.
   */

  const principalResult = await client.query(
    `
    SELECT
      COALESCE(
        SUM(principal_component),
        0
      )::BIGINT AS principal_addback

    FROM public.bank_loan_payments

    WHERE airline_id = $1
      AND payment_sim_time >= $2::TIMESTAMP
      AND payment_sim_time < $3::TIMESTAMP
    `,
    [
      airlineId,
      boundaries.period_start,
      boundaries.next_period_start
    ]
  );

  const loanPrincipalAddback =
    ACS_toInteger(
      principalResult.rows[0]?.principal_addback
    );

  const taxableProfitBeforeLosses =
    accountingProfitBeforeTax +
    loanPrincipalAddback;

  /*
   * Losses only exist once Corporate Income Tax applies.
   */

  const lossGenerated =
    taxRateBasisPoints > 0
      ? Math.max(
          -taxableProfitBeforeLosses,
          0
        )
      : 0;

  let remainingTaxableProfit = Math.max(
    taxableProfitBeforeLosses,
    0
  );

  let lossApplied = 0;

  /*
   * Apply valid losses in FIFO order.
   */

  if (
    taxRateBasisPoints > 0 &&
    remainingTaxableProfit > 0
  ) {
    const availableLossesResult =
      await client.query(
        `
        SELECT
          id,
          loss_remaining

        FROM public.corporate_tax

        WHERE airline_id = $1
          AND month_key < $2::VARCHAR
          AND loss_expires_month_key >= $2::VARCHAR
          AND loss_remaining > 0

        ORDER BY year, month, id

        FOR UPDATE
        `,
        [airlineId, monthKey]
      );

    for (
      const lossRow
      of availableLossesResult.rows
    ) {
      if (remainingTaxableProfit <= 0) break;

      const availableLoss =
        ACS_toInteger(lossRow.loss_remaining);

      const usedAmount = Math.min(
        availableLoss,
        remainingTaxableProfit
      );

      if (usedAmount <= 0) continue;

      await client.query(
        `
        UPDATE public.corporate_tax
        SET
          loss_used =
            loss_used + $2,

          loss_remaining =
            loss_remaining - $2,

          updated_at = NOW()

        WHERE id = $1
        `,
        [lossRow.id, usedAmount]
      );

      lossApplied += usedAmount;
      remainingTaxableProfit -= usedAmount;
    }
  }

  const taxableProfitAfterLosses =
    remainingTaxableProfit;

  /*
   * PostgreSQL performs the exact upward rounding.
   */

  const calculationResult = await client.query(
    `
    SELECT
      CEIL(
        $1::NUMERIC *
        $2::NUMERIC /
        10000
      )::BIGINT AS tax_due
    `,
    [
      taxableProfitAfterLosses,
      taxRateBasisPoints
    ]
  );

  const taxDue =
    ACS_toInteger(
      calculationResult.rows[0]?.tax_due
    );

  const availableCapital = Math.max(
    ACS_toInteger(finance.capital),
    0
  );

  const taxPaid = Math.min(
    taxDue,
    availableCapital
  );

  const taxOutstanding =
    taxDue - taxPaid;

  let paymentStatus = "NO_TAX_DUE";

  if (taxRateBasisPoints === 0) {
    paymentStatus = "NOT_APPLICABLE";
  } else if (
    taxDue > 0 &&
    taxOutstanding === 0
  ) {
    paymentStatus = "PAID";
  } else if (
    taxPaid > 0 &&
    taxOutstanding > 0
  ) {
    paymentStatus = "PARTIALLY_PAID";
  } else if (taxOutstanding > 0) {
    paymentStatus = "PAYMENT_DUE";
  }

  /*
   * Twelve historical months after the loss month.
   * No JavaScript date authority is used.
   */

  const expiryPeriodNumber =
    ACS_periodNumber(year, month) + 12;

  const lossExpiresMonthKey =
    lossGenerated > 0
      ? ACS_monthKey(
          Math.floor(
            expiryPeriodNumber / 12
          ),
          (
            expiryPeriodNumber % 12
          ) + 1
        )
      : null;

  let financeLogId = null;

  if (taxDue > 0) {
    const referenceUid =
      `CORPORATE_INCOME_TAX:` +
      `${airlineId}:${monthKey}`;

    const logResult = await client.query(
      `
      INSERT INTO public.finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        route_plan_id,
        schedule_item_id,
        reference_uid,
        description,
        created_at
      )
      VALUES (
        $1,
        'EXPENSE',
        'CORPORATE_INCOME_TAX',
        $2,
        $3,
        NULL,
        NULL,
        $4,
        $5,
        NOW()
      )

      ON CONFLICT (reference_uid)
      DO UPDATE SET
        reference_uid =
          EXCLUDED.reference_uid

      RETURNING id
      `,
      [
        airlineId,
        taxDue,
        closingTimestampMs,
        referenceUid,
        `Corporate Income Tax — ${monthKey}`
      ]
    );

    financeLogId =
      logResult.rows[0].id;
  }

  const settledSimTime =
    taxOutstanding === 0
      ? boundaries.period_end
      : null;

  await client.query(
    `
    INSERT INTO public.corporate_tax (
      airline_id,
      year,
      month,
      month_key,

      accounting_profit_before_tax,
      loan_principal_addback,
      taxable_profit_before_losses,

      loss_generated,
      loss_applied,
      loss_used,
      loss_remaining,
      loss_expires_month_key,

      taxable_profit_after_losses,
      tax_rate_basis_points,

      tax_due,
      tax_paid,
      tax_outstanding,
      payment_status,
      settled_sim_time,

      finance_log_id,
      metadata,
      created_at,
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

      $8,
      $9,
      0,
      $8,
      $10,

      $11,
      $12,

      $13,
      $14,
      $15,
      $16,
      $17::TIMESTAMP,

      $18,

      JSONB_BUILD_OBJECT(
        'loss_carryforward_months',
        12,
        'loan_interest_deductible',
        TRUE,
        'loan_principal_deductible',
        FALSE
      ),

      NOW(),
      NOW()
    )
    `,
    [
      airlineId,
      year,
      month,
      monthKey,

      accountingProfitBeforeTax,
      loanPrincipalAddback,
      taxableProfitBeforeLosses,

      lossGenerated,
      lossApplied,
      lossExpiresMonthKey,

      taxableProfitAfterLosses,
      taxRateBasisPoints,

      taxDue,
      taxPaid,
      taxOutstanding,
      paymentStatus,
      settledSimTime,

      financeLogId
    ]
  );

  const updatedFinanceResult =
    await client.query(
      `
      UPDATE public.company_finance
      SET
        capital =
          COALESCE(capital, 0) - $2,

        expenses =
          COALESCE(expenses, 0) + $3,

        profit =
          COALESCE(profit, 0) - $3,

        cost_taxes =
          COALESCE(cost_taxes, 0) + $3,

        debt =
          COALESCE(debt, 0) + $4,

        updated_at = NOW()

      WHERE airline_id = $1

      RETURNING *
      `,
      [
        airlineId,
        taxPaid,
        taxDue,
        taxOutstanding
      ]
    );

  if (!updatedFinanceResult.rows.length) {
    throw new Error(
      "COMPANY_FINANCE_CORPORATE_TAX_UPDATE_FAILED"
    );
  }

  return {
    applied: true,
    taxDue,
    taxPaid,
    taxOutstanding,
    priorTaxPaid,
    lossGenerated,
    lossApplied,
    taxableProfit:
      taxableProfitAfterLosses,
    taxRateBasisPoints,
    finance:
      updatedFinanceResult.rows[0]
  };
}

/* ============================================================
   SETTLE MONTHLY COMPANY INFRASTRUCTURE
   ------------------------------------------------------------
   Rules:
   - Airline type comes from airline_infrastructure.
   - Cost comes from the global historical resolver.
   - The current simulation year determines the amount.
   - One canonical movement per airline and month.
   - PostgreSQL remains the monetary authority.
   ============================================================ */

async function ACS_settleMonthlyCompanyInfrastructure(
  client,
  airlineId,
  year,
  month,
  settlementTimestampMs
) {
  const monthKey =
    ACS_monthKey(year, month);

  const referenceUid =
    `COMPANY_INFRASTRUCTURE:${airlineId}:${monthKey}`;

  const result = await client.query(
    `
    WITH infrastructure_authority AS (
      SELECT
        infrastructure.airline_type,

        resolved.monthly_operating_cost
          AS amount

      FROM public.airline_infrastructure
        infrastructure

      CROSS JOIN LATERAL
        public.acs_resolve_infrastructure_policy(
          infrastructure.airline_type,
          $2::INTEGER
        ) resolved

      WHERE infrastructure.airline_id = $1
    ),

    inserted_log AS (
      INSERT INTO public.finance_log (
        airline_id,
        type,
        source,
        amount,
        timestamp,
        route_plan_id,
        schedule_item_id,
        reference_uid,
        description,
        created_at
      )

      SELECT
        $1,
        'EXPENSE',
        'COMPANY_INFRASTRUCTURE_MONTHLY',
        authority.amount,
        $3,
        NULL,
        NULL,
        $4,
        (
          'Monthly Company Infrastructure — '
          || authority.airline_type
          || ' — '
          || $5
        ),
        NOW()

      FROM infrastructure_authority
        authority

      WHERE authority.amount > 0

      ON CONFLICT (reference_uid)
      DO NOTHING

      RETURNING amount
    )

    SELECT
      COALESCE(
        SUM(amount),
        0
      )::BIGINT AS applied_amount

    FROM inserted_log
    `,
    [
      airlineId,
      year,
      settlementTimestampMs,
      referenceUid,
      monthKey
    ]
  );

  return ACS_toInteger(
    result.rows[0]?.applied_amount
  );
}

/* ============================================================
   ARCHIVE ONE MONTH
   ------------------------------------------------------------
   Payroll and leasing must already be included in company_finance.
   ============================================================ */

async function ACS_archiveFinanceMonth(
  client,
  airlineId,
  finance,
  year,
  month,
  flightCount,
  closingTimestampMs
) {
  const monthKey = ACS_monthKey(year, month);

  const result = await client.query(
    `
    INSERT INTO public.finance_history (
      airline_id,
      year,
      month,
      month_key,

      revenue,
      expenses,
      profit,

      capital,
      opening_capital,
      closing_capital,

      debt,
      fleet_size,

      cost_fuel,
      cost_handling,
      cost_landing,
      cost_slots,
      cost_navigation,
      cost_overflight,
      cost_airport,
      cost_maintenance,
      cost_hr,
      cost_training_qualification,
      cost_leasing,
      cost_insurance,
      cost_depreciation,
      cost_taxes,
      cost_loans,
      cost_other,
      cost_company_infrastructure,

      cost_new_aircraft_purchase,
      cost_used_aircraft_purchase,

      flight_count,
      passenger_count,

      timestamp,
      closed_sim_timestamp,
      record_kind,
      data_quality,
      period_start_sim,
      period_end_sim,
      closed_by,
      metadata,
      cost_flight_pax_taxes,
      created_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4::varchar,

      $5,
      $6,
      $7,

      $8,
      $9,
      $8,

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
      $30,

      $31,
      0,

      $32,
      $32,
      'MONTHLY_CLOSE',
      'VERIFIED',
      MAKE_DATE($2, $3, 1)::TIMESTAMP,
      (
        MAKE_DATE($2, $3, 1)
        + INTERVAL '1 month'
      )::TIMESTAMP,
      'ACS_FINANCE_RUNTIME_V1',
             JSONB_BUILD_OBJECT(
        'month_key',
        $4::VARCHAR,
        'monthly_breakdown_available',
        TRUE
      ),
      $33,
      NOW()
    )

    ON CONFLICT (
      airline_id,
      year,
      month
    )
    DO NOTHING

    RETURNING id
    `,
    [
      airlineId,
      year,
      month,
      monthKey,

      ACS_toInteger(finance.revenue),
      ACS_toInteger(finance.expenses),
      ACS_toInteger(finance.profit),

      ACS_toInteger(finance.capital),
      ACS_toInteger(finance.opening_capital),

      ACS_toInteger(finance.debt),
      ACS_toInteger(finance.fleet_size),

      ACS_toInteger(finance.cost_fuel),
      ACS_toInteger(finance.cost_handling),
      ACS_toInteger(finance.cost_landing),
      ACS_toInteger(finance.cost_slots),
      ACS_toInteger(finance.cost_navigation),
      ACS_toInteger(finance.cost_overflight),
      ACS_toInteger(finance.cost_airport),
      ACS_toInteger(finance.cost_maintenance),
      ACS_toInteger(finance.cost_hr),
      ACS_toInteger(
        finance.cost_training_qualification
      ),
      ACS_toInteger(finance.cost_leasing),
      ACS_toInteger(finance.cost_insurance),
      ACS_toInteger(finance.cost_depreciation),
      ACS_toInteger(finance.cost_taxes),
      ACS_toInteger(finance.cost_loans),
      ACS_toInteger(finance.cost_other),
      ACS_toInteger(
        finance.cost_company_infrastructure
      ),

      ACS_toInteger(
        finance.cost_new_aircraft_purchase
      ),
   
      ACS_toInteger(
        finance.cost_used_aircraft_purchase
      ),

      flightCount,
      closingTimestampMs,
      ACS_toInteger(
        finance.cost_flight_pax_taxes
      )
    ]
  );

  if (!result.rows.length) {
    throw new Error(
      `FINANCE_MONTH_ALREADY_ARCHIVED:${airlineId}:${monthKey}`
    );
  }

  return result.rows[0].id;
}

/* ============================================================
   APPLY MONTHLY OBLIGATIONS TO CURRENT FINANCE
   ============================================================ */

async function ACS_applyMonthlyObligations(
  client,
  airlineId,
  payrollAmount,
  leasingAmount,
  infrastructureAmount
) {
  const normalizedPayroll =
    ACS_toInteger(payrollAmount);

  const normalizedLeasing =
    ACS_toInteger(leasingAmount);

  const normalizedInfrastructure =
    ACS_toInteger(
      infrastructureAmount
    );

  const totalAmount =
    normalizedPayroll +
    normalizedLeasing +
    normalizedInfrastructure;

  const result = await client.query(
    `
    UPDATE public.company_finance
    SET
      capital =
        COALESCE(capital, 0) - $2,

      expenses =
        COALESCE(expenses, 0) + $2,

      profit =
        COALESCE(profit, 0) - $2,

      cost_hr =
        COALESCE(cost_hr, 0) + $3,

      cost_leasing =
        COALESCE(cost_leasing, 0) + $4,

      cost_company_infrastructure =
        COALESCE(
          cost_company_infrastructure,
          0
        ) + $5,

      updated_at = NOW()

    WHERE airline_id = $1

    RETURNING *
    `,
    [
      airlineId,
      totalAmount,
      normalizedPayroll,
      normalizedLeasing,
      normalizedInfrastructure
    ]
  );

  if (!result.rows.length) {
    throw new Error(
      "COMPANY_FINANCE_MONTHLY_OBLIGATION_UPDATE_FAILED"
    );
  }

  return result.rows[0];
}

/* ============================================================
   OPEN NEXT MONTH
   ------------------------------------------------------------
   Capital and debt are balances and are carried forward.
   Monthly accumulators are reset.
   ============================================================ */

async function ACS_openNextFinanceMonth(
  client,
  airlineId,
  nextYear,
  nextMonth
) {
  const result = await client.query(
    `
    UPDATE public.company_finance
    SET
      opening_capital = COALESCE(capital, 0),

      revenue = 0,
      expenses = 0,
      profit = 0,

      live_revenue = 0,
      weekly_revenue = 0,

      cost_fuel = 0,
      cost_maintenance = 0,
      cost_hr = 0,
      cost_training_qualification = 0,
      cost_leasing = 0,
      cost_insurance = 0,
      cost_depreciation = 0,
      cost_taxes = 0,
      cost_airport = 0,
      cost_other = 0,
      cost_company_infrastructure = 0,

      cost_handling = 0,
      cost_landing = 0,
      cost_slots = 0,
      cost_navigation = 0,
      cost_overflight = 0,
      cost_loans = 0,
      cost_flight_pax_taxes = 0,

      cost_new_aircraft_purchase = 0,
      cost_used_aircraft_purchase = 0,

      current_sim_year = $2,
      current_sim_month = $3,

      updated_at = NOW()

    WHERE airline_id = $1

    RETURNING *
    `,
    [
      airlineId,
      nextYear,
      nextMonth
    ]
  );

  if (!result.rows.length) {
    throw new Error(
      "COMPANY_FINANCE_NEXT_MONTH_OPEN_FAILED"
    );
  }

  return result.rows[0];
}

/* ============================================================
   PUBLIC AUTHORITY — ENSURE FINANCE PERIOD
   ------------------------------------------------------------
   Requirements:
   - Caller must already have BEGIN active.
   - airlineId must come from authenticated backend context.
   - Never pass airlineId from request body.

   Concurrency:
   - company_finance FOR UPDATE serializes one airline only.
   - Other airlines continue independently.
   ============================================================ */

export async function ACS_ensureFinancePeriod(
  client,
  airlineId
) {
  const normalizedAirlineId = Number(airlineId);

  if (
    !Number.isInteger(normalizedAirlineId) ||
    normalizedAirlineId <= 0
  ) {
    throw new Error(
      "INVALID_AUTHENTICATED_AIRLINE_ID"
    );
  }

  const officialPeriod =
    await ACS_getOfficialFinancePeriod(client);

  let finance =
    await ACS_ensureCompanyFinanceRow(
      client,
      normalizedAirlineId,
      officialPeriod
    );

  let insuranceAppliedCount = 0;
  let insuranceCreatedCount = 0;  
   
  const financeYear =
    Number(finance.current_sim_year);

  const financeMonth =
    Number(finance.current_sim_month);

  const openPeriodNumber =
    ACS_periodNumber(
      financeYear,
      financeMonth
    );

  const officialPeriodNumber =
    ACS_periodNumber(
      officialPeriod.year,
      officialPeriod.month
    );

    /*
   * Current period: ensure mandatory policies and settle
   * every insurance anniversary already reached.
   */
   
  if (openPeriodNumber === officialPeriodNumber) {
    insuranceCreatedCount +=
      await ACS_ensureBasicAircraftInsurance(
        client,
        normalizedAirlineId,
        officialPeriod
      );

    insuranceAppliedCount +=
      await ACS_settleAircraftInsurance(
        client,
        normalizedAirlineId,
        officialPeriod.sim_time
      );

    const refreshedFinance = await client.query(
      `
      SELECT *
      FROM public.company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [normalizedAirlineId]
    );

    finance = refreshedFinance.rows[0];
  }
   
  if (openPeriodNumber > officialPeriodNumber) {
    throw new Error(
      `FINANCE_PERIOD_AHEAD_OF_SIMULATION_TIME:` +
      `${financeYear}-${financeMonth}`
    );
  }

  /*
   * Ensure payroll for the currently open month.
   * The canonical reference prevents duplicate charges.
   *
   * This also repairs a month already opened by the previous
   * rollover sequence without its opening payroll.
   */
   
  const currentBoundaries =
    await ACS_getPeriodBoundaries(
      client,
      financeYear,
      financeMonth
    );

  const currentPayrollAmount =
    await ACS_settleMonthlyPayroll(
      client,
      normalizedAirlineId,
      financeYear,
      financeMonth,
      Number(
        currentBoundaries
          .period_start_timestamp_ms
      )
    );

  const currentInfrastructureAmount =
    await ACS_settleMonthlyCompanyInfrastructure(
      client,
      normalizedAirlineId,
      financeYear,
      financeMonth,
      Number(
        currentBoundaries
          .period_start_timestamp_ms
      )
    );

  let payrollAppliedCount = 0;
  let infrastructureAppliedCount = 0;

  if (
    currentPayrollAmount > 0 ||
    currentInfrastructureAmount > 0
  ) {
    finance =
      await ACS_applyMonthlyObligations(
        client,
        normalizedAirlineId,
        currentPayrollAmount,
        0,
        currentInfrastructureAmount
      );
  }

  if (currentPayrollAmount > 0) {
    payrollAppliedCount += 1;
  }

  if (currentInfrastructureAmount > 0) {
    infrastructureAppliedCount += 1;
  }

  if (
    openPeriodNumber ===
    officialPeriodNumber
  ) {
    return {
      ok: true,
      rolled_over: false,
      closed_months: [],

      payroll_applied_count:
        payrollAppliedCount,

      infrastructure_applied_count:
        infrastructureAppliedCount,

      current_payroll:
        currentPayrollAmount,

      current_company_infrastructure:
        ACS_toInteger(
          finance
            .cost_company_infrastructure
        ),

      insurance_created_count:
        insuranceCreatedCount,

      insurance_applied_count:
        insuranceAppliedCount,

      current_period:
        officialPeriod,

      finance
    };
  }

  const closedMonths = [];

  /*
   * Close every missing month in sequence.
   * Every newly opened month receives its payroll immediately.
   */
   
  while (
    ACS_periodNumber(
      finance.current_sim_year,
      finance.current_sim_month
    ) < officialPeriodNumber
  ) {
    const closingYear =
      Number(finance.current_sim_year);

    const closingMonth =
      Number(finance.current_sim_month);

    const closingMonthKey =
      ACS_monthKey(
        closingYear,
        closingMonth
      );

    const boundaries =
      await ACS_getPeriodBoundaries(
        client,
        closingYear,
        closingMonth
      );

    const closingTimestampMs =
      Number(
        boundaries.next_period_timestamp_ms
      ) - 1;

      insuranceAppliedCount +=
      await ACS_settleAircraftInsurance(
        client,
        normalizedAirlineId,
        boundaries.period_end
      );

    const insuranceFinanceRefresh =
      await client.query(
        `
        SELECT *
        FROM public.company_finance
        WHERE airline_id = $1
        FOR UPDATE
        `,
        [normalizedAirlineId]
      );

        finance =
      insuranceFinanceRefresh.rows[0];

    /*
     * Ensure infrastructure before closing the month.
     * The canonical reference prevents duplicate charges.
     */

    const repairedInfrastructureAmount =
      await ACS_settleMonthlyCompanyInfrastructure(
        client,
        normalizedAirlineId,
        closingYear,
        closingMonth,
        Number(
          boundaries
            .period_start_timestamp_ms
        )
      );

    if (
      repairedInfrastructureAmount > 0
    ) {
      finance =
        await ACS_applyMonthlyObligations(
          client,
          normalizedAirlineId,
          0,
          0,
          repairedInfrastructureAmount
        );

      infrastructureAppliedCount += 1;
    }

    const closedInfrastructureAmount =
      ACS_toInteger(
        finance
          .cost_company_infrastructure
      );
     
    /*
     * Payroll was applied when this month opened.
     * Capture the HR total without charging it again.
     */
     
    const closedPayrollAmount =
      ACS_toInteger(finance.cost_hr);

    const leasingAmount =
      await ACS_settleMonthlyLeasing(
        client,
        normalizedAirlineId,
        closingYear,
        closingMonth,
        closingTimestampMs,
        boundaries
      );

       if (leasingAmount > 0) {
      finance =
       await ACS_applyMonthlyObligations(
          client,
          normalizedAirlineId,
          0,
          leasingAmount,
          0
        );
    }

    const depreciationSettlement =
      await ACS_settleMonthlyAircraftDepreciation(
        client,
        normalizedAirlineId,
        closingYear,
        closingMonth,
        closingTimestampMs,
        boundaries
      );

    if (depreciationSettlement.appliedAmount > 0) {
      const depreciationFinanceRefresh =
        await client.query(
          `
          SELECT *
          FROM public.company_finance
          WHERE airline_id = $1
          FOR UPDATE
          `,
          [normalizedAirlineId]
        );

      finance =
        depreciationFinanceRefresh.rows[0];
    }

    const corporateTaxSettlement =
      await ACS_settleMonthlyCorporateTax(
        client,
        normalizedAirlineId,
        closingYear,
        closingMonth,
        closingTimestampMs,
        boundaries
      );

    finance =
      corporateTaxSettlement.finance;

    const flightCount =
      await ACS_countMonthlyFlights(
        client,
        normalizedAirlineId,
        boundaries
      );

    const historyId =
      await ACS_archiveFinanceMonth(
        client,
        normalizedAirlineId,
        finance,
        closingYear,
        closingMonth,
        flightCount,
        closingTimestampMs
      );

    const nextPeriod =
      ACS_nextPeriod(
        closingYear,
        closingMonth
      );

    finance =
      await ACS_openNextFinanceMonth(
        client,
        normalizedAirlineId,
        nextPeriod.year,
        nextPeriod.month
      );

    /*
     * Apply payroll immediately after opening the new month.
     * PostgreSQL provides the exact first timestamp of the month.
     */
     
    const nextBoundaries =
      await ACS_getPeriodBoundaries(
        client,
        nextPeriod.year,
        nextPeriod.month
      );

        const nextPayrollAmount =
      await ACS_settleMonthlyPayroll(
        client,
        normalizedAirlineId,
        nextPeriod.year,
        nextPeriod.month,
        Number(
          nextBoundaries
            .period_start_timestamp_ms
        )
      );

    const nextInfrastructureAmount =
      await ACS_settleMonthlyCompanyInfrastructure(
        client,
        normalizedAirlineId,
        nextPeriod.year,
        nextPeriod.month,
        Number(
          nextBoundaries
            .period_start_timestamp_ms
        )
      );

    if (
      nextPayrollAmount > 0 ||
      nextInfrastructureAmount > 0
    ) {
      finance =
        await ACS_applyMonthlyObligations(
          client,
          normalizedAirlineId,
          nextPayrollAmount,
          0,
          nextInfrastructureAmount
        );
    }

    if (nextPayrollAmount > 0) {
      payrollAppliedCount += 1;
    }

    if (nextInfrastructureAmount > 0) {
      infrastructureAppliedCount += 1;
    }

    closedMonths.push({
      history_id: historyId,
      year: closingYear,
      month: closingMonth,
      month_key: closingMonthKey,
      payroll:
        closedPayrollAmount,

      company_infrastructure:
        closedInfrastructureAmount,

      leasing:
        leasingAmount,
      depreciation:
        depreciationSettlement.appliedAmount,
      depreciated_aircraft:
        depreciationSettlement.aircraftCount,
      corporate_tax:
        corporateTaxSettlement.taxDue,
      corporate_tax_paid:
        corporateTaxSettlement.taxPaid,
      corporate_tax_outstanding:
        corporateTaxSettlement.taxOutstanding,
      prior_corporate_tax_paid:
        corporateTaxSettlement.priorTaxPaid,
      corporate_tax_rate_basis_points:
        corporateTaxSettlement.taxRateBasisPoints,
      tax_loss_generated:
        corporateTaxSettlement.lossGenerated,
      tax_loss_applied:
        corporateTaxSettlement.lossApplied,
      flight_count: flightCount,
      closing_capital:
        ACS_toInteger(finance.opening_capital),
      next_month_payroll:
        nextPayrollAmount,

      next_month_company_infrastructure:
        nextInfrastructureAmount
    });
  }

     insuranceCreatedCount +=
    await ACS_ensureBasicAircraftInsurance(
      client,
      normalizedAirlineId,
      officialPeriod
    );

  insuranceAppliedCount +=
    await ACS_settleAircraftInsurance(
      client,
      normalizedAirlineId,
      officialPeriod.sim_time
    );

  const finalFinanceRefresh =
    await client.query(
      `
      SELECT *
      FROM public.company_finance
      WHERE airline_id = $1
      FOR UPDATE
      `,
      [normalizedAirlineId]
    );

  finance = finalFinanceRefresh.rows[0];
   
  return {
    ok: true,
    rolled_over:
      closedMonths.length > 0,
    closed_months: closedMonths,
    payroll_applied_count:
      payrollAppliedCount,

    infrastructure_applied_count:
      infrastructureAppliedCount,

    current_company_infrastructure:
      ACS_toInteger(
        finance
          .cost_company_infrastructure
      ),

    insurance_created_count:
      insuranceCreatedCount,
    insurance_applied_count:
      insuranceAppliedCount,     
    current_period: officialPeriod,
    finance
  };
}
 
export {
  ACS_INSURANCE_PLANS,
  ACS_calculateInsurancePremium
};
