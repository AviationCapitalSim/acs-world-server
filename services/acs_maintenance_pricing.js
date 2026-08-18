/* ============================================================
   ACS OCC MAINTENANCE PRICING AUTHORITY v2.0
   ------------------------------------------------------------
   Purpose:
   - Single pricing authority for A/B/C/D maintenance.
   - Use PostgreSQL policy parameters.
   - Calculate aircraft age from ACS simulated time.
   - Apply the approved continuous age curve.
   - Use catalog value as the primary technical reference.
   - Return a complete auditable pricing breakdown.

   This module:
   - Does not query PostgreSQL.
   - Does not mutate aircraft.
   - Does not charge finance.
   - Does not create maintenance events.
   ============================================================ */

const ACS_MAINTENANCE_CHECK_TYPES = Object.freeze([
  "A_CHECK",
  "B_CHECK",
  "C_CHECK",
  "D_CHECK"
]);

function ACS_pricingNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const numericValue = Number(value);

  return Number.isFinite(numericValue)
    ? numericValue
    : null;
}

function ACS_positivePricingNumber(value) {
  const numericValue =
    ACS_pricingNumber(value);

  return (
    numericValue !== null &&
    numericValue > 0
  )
    ? numericValue
    : null;
}

function ACS_normalizeMaintenanceCheckType(value) {
  const normalized =
    String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");

  if (
    ACS_MAINTENANCE_CHECK_TYPES
      .includes(normalized)
  ) {
    return normalized;
  }

  throw new Error(
    "INVALID_MAINTENANCE_CHECK_TYPE"
  );
}

function ACS_resolveSimYear(simTime) {
  const date =
    simTime instanceof Date
      ? simTime
      : new Date(simTime);

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      "ACS_CURRENT_SIM_TIME_INVALID"
    );
  }

  return date.getUTCFullYear();
}

function ACS_resolveAircraftAge(
  aircraft,
  simYear
) {
  const yearBuilt =
    ACS_pricingNumber(
      aircraft?.year_built
    );

  if (
    yearBuilt === null ||
    !Number.isInteger(yearBuilt) ||
    yearBuilt < 1900 ||
    yearBuilt > simYear
  ) {
    throw new Error(
      "AIRCRAFT_YEAR_BUILT_INVALID"
    );
  }

  return {
    year_built: yearBuilt,
    sim_year: simYear,
    aircraft_age: simYear - yearBuilt
  };
}

function ACS_resolveTechnicalValue(aircraft) {
  const candidates = [
    {
      source:
        "aircraft_catalog.price_acs_usd",
      value:
        aircraft?.price_acs_usd ??
        aircraft?.catalog_price
    },
    {
      source:
        "aircraft_fleet.purchase_price",
      value:
        aircraft?.purchase_price
    },
    {
      source:
        "aircraft_fleet.current_value",
      value:
        aircraft?.current_value
    }
  ];

  for (const candidate of candidates) {
    const resolvedValue =
      ACS_positivePricingNumber(
        candidate.value
      );

    if (resolvedValue !== null) {
      return {
        technical_value:
          resolvedValue,

        technical_value_source:
          candidate.source
      };
    }
  }

  throw new Error(
    "MAINTENANCE_TECHNICAL_VALUE_UNAVAILABLE"
  );
}

function ACS_resolveConditionFactor(
  aircraft,
  policy
) {
  const conditionPct =
    ACS_pricingNumber(
      aircraft?.condition_pct
    );

  if (
    conditionPct === null ||
    conditionPct < 0 ||
    conditionPct > 100
  ) {
    throw new Error(
      "AIRCRAFT_CONDITION_INVALID"
    );
  }

  let conditionFactor =
    ACS_positivePricingNumber(
      policy?.condition_factor_good
    );

  let conditionLevel =
    "GOOD";

  if (conditionPct < 70) {
    conditionFactor =
      ACS_positivePricingNumber(
        policy?.condition_factor_low
      );

    conditionLevel =
      "LOW";

  } else if (conditionPct < 85) {
    conditionFactor =
      ACS_positivePricingNumber(
        policy?.condition_factor_medium
      );

    conditionLevel =
      "MEDIUM";
  }

  if (conditionFactor === null) {
    throw new Error(
      "MAINTENANCE_CONDITION_FACTOR_INVALID"
    );
  }

  return {
    condition_pct:
      conditionPct,

    condition_level:
      conditionLevel,

    condition_factor:
      conditionFactor
  };
}

function ACS_resolveUsageFactor(
  aircraft,
  policy
) {
  const totalHours =
    Math.max(
      0,
      ACS_pricingNumber(
        aircraft?.total_hours
      ) ?? 0
    );

  const totalCycles =
    Math.max(
      0,
      ACS_pricingNumber(
        aircraft?.total_cycles
      ) ?? 0
    );

  let usageFactor =
    ACS_positivePricingNumber(
      policy?.usage_factor_normal
    );

  let usageLevel =
    "NORMAL";

  if (
    totalHours > 20000 ||
    totalCycles > 12000
  ) {
    usageFactor =
      ACS_positivePricingNumber(
        policy?.usage_factor_high
      );

    usageLevel =
      "HIGH";

  } else if (
    totalHours > 10000 ||
    totalCycles > 6000
  ) {
    usageFactor =
      ACS_positivePricingNumber(
        policy?.usage_factor_medium
      );

    usageLevel =
      "MEDIUM";
  }

  if (usageFactor === null) {
    throw new Error(
      "MAINTENANCE_USAGE_FACTOR_INVALID"
    );
  }

  return {
    total_hours:
      totalHours,

    total_cycles:
      totalCycles,

    usage_level:
      usageLevel,

    usage_factor:
      usageFactor
  };
}

function ACS_resolveAgePressure(
  aircraftAge,
  checkType
) {
  if (aircraftAge <= 4) {
    return "LOW";
  }

  if (aircraftAge <= 9) {
    return ["C_CHECK", "D_CHECK"]
      .includes(checkType)
        ? "MODERATE"
        : "LIGHT";
  }

  if (aircraftAge <= 14) {
    return ["C_CHECK", "D_CHECK"]
      .includes(checkType)
        ? "IMPORTANT"
        : "MODERATE";
  }

  if (aircraftAge <= 19) {
    return ["C_CHECK", "D_CHECK"]
      .includes(checkType)
        ? "HIGH"
        : "IMPORTANT";
  }

  if (aircraftAge <= 24) {
    return ["C_CHECK", "D_CHECK"]
      .includes(checkType)
        ? "VERY_HIGH"
        : "HIGH";
  }

  return ["C_CHECK", "D_CHECK"]
    .includes(checkType)
      ? "CRITICAL"
      : "VERY_HIGH";
}

function ACS_resolveAgeFactor(
  aircraftAge,
  checkType,
  policy
) {
  const ceiling =
    ACS_positivePricingNumber(
      policy?.age_curve_ceiling
    );

  const amplitude =
    ACS_pricingNumber(
      policy?.age_curve_amplitude
    );

  const rate =
    ACS_positivePricingNumber(
      policy?.age_curve_rate
    );

  const exponent =
    ACS_positivePricingNumber(
      policy?.age_curve_exponent
    );

  const abSensitivity =
    ACS_pricingNumber(
      policy?.ab_age_sensitivity
    );

  const cdSensitivity =
    ACS_pricingNumber(
      policy?.cd_age_sensitivity
    );

  if (
    ceiling === null ||
    amplitude === null ||
    amplitude < 0 ||
    rate === null ||
    exponent === null ||
    abSensitivity === null ||
    abSensitivity < 0 ||
    cdSensitivity === null ||
    cdSensitivity < 0
  ) {
    throw new Error(
      "MAINTENANCE_AGE_POLICY_INVALID"
    );
  }

  const curveFactor =
    ceiling -
    amplitude *
    Math.exp(
      -Math.pow(
        rate * aircraftAge,
        exponent
      )
    );

  const sensitivity =
    ["A_CHECK", "B_CHECK"]
      .includes(checkType)
        ? abSensitivity
        : cdSensitivity;

  const ageFactor =
    1 +
    sensitivity *
    (curveFactor - 1);

  if (
    !Number.isFinite(ageFactor) ||
    ageFactor < 1
  ) {
    throw new Error(
      "MAINTENANCE_AGE_FACTOR_INVALID"
    );
  }

  return {
    age_curve_factor:
      Number(
        curveFactor.toFixed(6)
      ),

    age_sensitivity:
      sensitivity,

    age_factor:
      Number(
        ageFactor.toFixed(6)
      ),

    age_pressure:
      ACS_resolveAgePressure(
        aircraftAge,
        checkType
      )
  };
}

function ACS_resolveMaintenanceCostRate(
  policy,
  checkType
) {
  const rateFieldByCheck =
    Object.freeze({
      A_CHECK:
        "a_check_cost_rate",

      B_CHECK:
        "b_check_cost_rate",

      C_CHECK:
        "c_check_cost_rate",

      D_CHECK:
        "d_check_cost_rate"
    });

  const rateField =
    rateFieldByCheck[checkType];

  const costRate =
    ACS_positivePricingNumber(
      policy?.[rateField]
    );

  if (costRate === null) {
    throw new Error(
      "MAINTENANCE_COST_RATE_INVALID"
    );
  }

  return {
    cost_rate_field:
      rateField,

    cost_rate:
      costRate
  };
}

export function ACS_calculateMaintenancePrice({
  aircraft,
  policy,
  checkType,
  simTime
}) {
  if (!aircraft || typeof aircraft !== "object") {
    throw new Error(
      "MAINTENANCE_AIRCRAFT_REQUIRED"
    );
  }

  if (!policy || typeof policy !== "object") {
    throw new Error(
      "MAINTENANCE_POLICY_REQUIRED"
    );
  }

  const normalizedCheckType =
    ACS_normalizeMaintenanceCheckType(
      checkType
    );

  const simYear =
    ACS_resolveSimYear(
      simTime
    );

  const age =
    ACS_resolveAircraftAge(
      aircraft,
      simYear
    );

  const technicalValue =
    ACS_resolveTechnicalValue(
      aircraft
    );

  const costRate =
    ACS_resolveMaintenanceCostRate(
      policy,
      normalizedCheckType
    );

  const agePricing =
    ACS_resolveAgeFactor(
      age.aircraft_age,
      normalizedCheckType,
      policy
    );

  const condition =
    ACS_resolveConditionFactor(
      aircraft,
      policy
    );

  const usage =
    ACS_resolveUsageFactor(
      aircraft,
      policy
    );

  const rawCost =
    technicalValue.technical_value *
    costRate.cost_rate *
    agePricing.age_factor *
    condition.condition_factor *
    usage.usage_factor;

  const finalCost =
    Math.round(rawCost);

  if (
    !Number.isFinite(finalCost) ||
    finalCost <= 0
  ) {
    throw new Error(
      "INVALID_MAINTENANCE_COST"
    );
  }

  return {
    ok: true,

    authority:
      "ACS_OCC_MAINTENANCE_PRICING",

    pricing_formula_version:
      String(
        policy.pricing_formula_version ||
        "ACS_OCC_MAINTENANCE_AGE_V2"
      ),

    check_type:
      normalizedCheckType,

    currency:
      aircraft.currency || "USD",

    final_cost:
      finalCost,

    calculation: {
      technical_value:
        technicalValue.technical_value,

      technical_value_source:
        technicalValue.technical_value_source,

      cost_rate:
        costRate.cost_rate,

      cost_rate_field:
        costRate.cost_rate_field,

      aircraft_age:
        age.aircraft_age,

      year_built:
        age.year_built,

      sim_year:
        age.sim_year,

      age_pressure:
        agePricing.age_pressure,

      age_curve_factor:
        agePricing.age_curve_factor,

      age_sensitivity:
        agePricing.age_sensitivity,

      age_factor:
        agePricing.age_factor,

      condition_pct:
        condition.condition_pct,

      condition_level:
        condition.condition_level,

      condition_factor:
        condition.condition_factor,

      total_hours:
        usage.total_hours,

      total_cycles:
        usage.total_cycles,

      usage_level:
        usage.usage_level,

      usage_factor:
        usage.usage_factor,

      raw_cost:
        Number(
          rawCost.toFixed(6)
        )
    },

    policy: {
      id:
        policy.id ?? null,

      policy_code:
        policy.policy_code ?? null,

      aircraft_size_class:
        policy.aircraft_size_class ?? null,

      aircraft_category:
        policy.aircraft_category ?? null,

      era_start_year:
        Number(
          policy.era_start_year
        ),

      era_end_year:
        Number(
          policy.era_end_year
        )
    }
  };
}

export {
  ACS_MAINTENANCE_CHECK_TYPES,
  ACS_normalizeMaintenanceCheckType
};
