/* ============================================================
   ACS OCC — FINANCE CORE
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
          SUM(COALESCE(payroll, 0)),
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
      cost_leasing,
      cost_loans,
      cost_other,

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
      0,

      $27,
      $27,
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
      ACS_toInteger(finance.cost_leasing),
      ACS_toInteger(finance.cost_loans),
      ACS_toInteger(finance.cost_other),

      ACS_toInteger(
        finance.cost_new_aircraft_purchase
      ),

      ACS_toInteger(
        finance.cost_used_aircraft_purchase
      ),

      flightCount,
      closingTimestampMs
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
  leasingAmount
) {
  const totalAmount =
    ACS_toInteger(payrollAmount) +
    ACS_toInteger(leasingAmount);

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

      updated_at = NOW()

    WHERE airline_id = $1

    RETURNING *
    `,
    [
      airlineId,
      totalAmount,
      ACS_toInteger(payrollAmount),
      ACS_toInteger(leasingAmount)
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
      cost_leasing = 0,
      cost_airport = 0,
      cost_other = 0,

      cost_handling = 0,
      cost_landing = 0,
      cost_slots = 0,
      cost_navigation = 0,
      cost_overflight = 0,
      cost_loans = 0,

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
        currentBoundaries.period_start_timestamp_ms
      )
    );

  let payrollAppliedCount = 0;

  if (currentPayrollAmount > 0) {
    finance =
      await ACS_applyMonthlyObligations(
        client,
        normalizedAirlineId,
        currentPayrollAmount,
        0
      );

    payrollAppliedCount += 1;
  }

  if (openPeriodNumber === officialPeriodNumber) {
    return {
      ok: true,
      rolled_over: false,
      closed_months: [],
      payroll_applied_count:
        payrollAppliedCount,
      current_payroll:
        currentPayrollAmount,
      current_period: officialPeriod,
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
          leasingAmount
        );
    }

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
          nextBoundaries.period_start_timestamp_ms
        )
      );

    if (nextPayrollAmount > 0) {
      finance =
        await ACS_applyMonthlyObligations(
          client,
          normalizedAirlineId,
          nextPayrollAmount,
          0
        );

      payrollAppliedCount += 1;
    }

    closedMonths.push({
      history_id: historyId,
      year: closingYear,
      month: closingMonth,
      month_key: closingMonthKey,
      payroll: closedPayrollAmount,
      leasing: leasingAmount,
      flight_count: flightCount,
      closing_capital:
        ACS_toInteger(finance.opening_capital),
      next_month_payroll:
        nextPayrollAmount
    });
  }

  return {
    ok: true,
    rolled_over:
      closedMonths.length > 0,
    closed_months: closedMonths,
    payroll_applied_count:
      payrollAppliedCount,
    current_period: officialPeriod,
    finance
  };
}
