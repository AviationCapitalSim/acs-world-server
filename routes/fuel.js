/* ============================================================
   ACS OCC - FUEL MARKET ROUTE v1.0
   ------------------------------------------------------------
   Date: 2026-08-08
   Read-only PostgreSQL market authority.
   No embedded prices, interpolation or local fallback.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const fuelCatalogue = [
  {
    id: "avgas-100ll",
    code: "AVGAS",
    seriesCode: "AVGAS",
    name: "AVGAS 100LL",
    family: "Aviation Gasoline",
    engine_type: "Piston",
    grade: "100LL",
    identification: "Blue",
    introduced_on: null,
    retired_on: null,
    specification: "ASTM D910"
  },
  {
    id: "jet-a",
    code: "JET_A",
    seriesCode: "JET_FUEL_REFERENCE",
    name: "JET A",
    family: "Kerosene Jet Fuel",
    engine_type: "Turbine",
    grade: "JET A",
    identification: "Clear / Straw",
    introduced_on: null,
    retired_on: null,
    specification: "ASTM D1655"
  },
  {
    id: "jet-a1",
    code: "JET_A1",
    seriesCode: "JET_FUEL_REFERENCE",
    name: "JET A-1",
    family: "Kerosene Jet Fuel",
    engine_type: "Turbine",
    grade: "JET A-1",
    identification: "Clear / Straw",
    introduced_on: null,
    retired_on: null,
    specification: "DEF STAN 91-091"
  },
  {
    id: "saf",
    code: "SAF",
    seriesCode: "SAF",
    name: "SAF",
    family: "Sustainable Aviation Fuel",
    engine_type: "Turbine",
    grade: "Approved Blend",
    identification: "Specification dependent",
    introduced_on: null,
    retired_on: null,
    specification: "ASTM D7566 / D1655"
  }
];

function mapRecord(row) {
  return {
    period: String(row.price_year),
    price: Number(row.price_usd_per_us_gallon),
    annual_change_percent:
      row.annual_change_percent === null
        ? null
        : Number(row.annual_change_percent),
    quality_grade: row.quality_grade,
    source_method: row.data_kind,
    is_projection: row.data_kind === "PROJECTION",
    source_name: row.source_name,
    source_url: row.source_url,
    market_scope: row.market_scope,
    market_name: row.market_name,
    price_basis: row.price_basis,
    confidence: row.confidence,
    revision_code: row.revision_code,
    is_simulation_seed: row.is_simulation_seed
  };
}

function ACS_clamp(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  );
}

function ACS_roundFuel(
  value,
  decimals = 6
) {
  const factor = 10 ** decimals;

  return (
    Math.round(
      (Number(value) + Number.EPSILON) *
      factor
    ) / factor
  );
}

function ACS_seedPhase(value) {
  const source =
    String(value || "ACS_FUEL");

  let hash = 2166136261;

  for (
    let index = 0;
    index < source.length;
    index += 1
  ) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(
      hash,
      16777619
    );
  }

  return (
    ((hash >>> 0) / 4294967295) *
    Math.PI *
    2
  );
}

function ACS_percentChange(
  currentValue,
  previousValue
) {
  if (
    !Number.isFinite(currentValue) ||
    !Number.isFinite(previousValue) ||
    previousValue === 0
  ) {
    return null;
  }

  return ACS_roundFuel(
    (
      (currentValue - previousValue) /
      previousValue
    ) * 100,
    4
  );
}

function ACS_buildMonthlySeries(
  annualRows,
  logicalSeriesCode,
  currentSimTime
) {
  const currentYear =
    currentSimTime.getUTCFullYear();

  const currentMonth =
    currentSimTime.getUTCMonth() + 1;

  const currentDay =
    currentSimTime.getUTCDate();

  const currentWeekOfMonth =
    Math.min(
      4,
      Math.max(
        1,
        Math.ceil(currentDay / 7)
      )
    );

  const monthlySeries = [];

  let priorMonthPrice = null;
  let priorWeekPrice = null;

  annualRows.forEach(
    (row, annualIndex) => {
      const year =
        Number(row.price_year);

      const annualPrice =
        Number(
          row.price_usd_per_us_gallon
        );

      const priorAnnualPrice =
        annualIndex > 0
          ? Number(
              annualRows[
                annualIndex - 1
              ].price_usd_per_us_gallon
            )
          : annualPrice;

      if (
        !Number.isFinite(year) ||
        !Number.isFinite(annualPrice) ||
        annualPrice <= 0
      ) {
        return;
      }

      const annualChangeRatio =
        priorAnnualPrice > 0
          ? Math.abs(
              (
                annualPrice -
                priorAnnualPrice
              ) /
              priorAnnualPrice
            )
          : 0;

      const requestedAmplitude =
        ACS_clamp(
          0.012 +
            annualChangeRatio *
            0.22,
          0.012,
          0.08
        );

      const phase =
        ACS_seedPhase(
          `${logicalSeriesCode}:${year}`
        );

      const rawMonthlyShape =
        Array.from(
          { length: 12 },
          (_, monthIndex) =>
            Math.sin(
              (
                monthIndex *
                Math.PI *
                2
              ) /
                12 +
                phase
            ) +
            0.35 *
              Math.sin(
                (
                  monthIndex *
                  Math.PI *
                  4
                ) /
                  12 +
                  phase / 2
              )
        );

      const shapeAverage =
        rawMonthlyShape.reduce(
          (total, value) =>
            total + value,
          0
        ) /
        rawMonthlyShape.length;

      const monthlyShape =
        rawMonthlyShape.map(
          value =>
            value -
            shapeAverage
        );

      const maximumPositive =
        Math.max(
          ...monthlyShape,
          0.000001
        );

      const maximumNegative =
        Math.abs(
          Math.min(
            ...monthlyShape,
            -0.000001
          )
        );

      const lowPrice =
        Number(
          row.price_low_usd_per_us_gallon
        );

      const highPrice =
        Number(
          row.price_high_usd_per_us_gallon
        );

      let amplitude =
        requestedAmplitude;

      if (
        Number.isFinite(lowPrice) &&
        lowPrice > 0 &&
        lowPrice < annualPrice
      ) {
        amplitude =
          Math.min(
            amplitude,
            (
              (
                annualPrice -
                lowPrice
              ) /
              annualPrice
            ) /
              maximumNegative
          );
      }

      if (
        Number.isFinite(highPrice) &&
        highPrice > annualPrice
      ) {
        amplitude =
          Math.min(
            amplitude,
            (
              (
                highPrice -
                annualPrice
              ) /
              annualPrice
            ) /
              maximumPositive
          );
      }

      const monthLimit =
        year < currentYear
          ? 12
          : currentMonth;

      for (
        let month = 1;
        month <= monthLimit;
        month += 1
      ) {
        const monthPrice =
          ACS_roundFuel(
            annualPrice *
              (
                1 +
                amplitude *
                  monthlyShape[
                    month - 1
                  ]
              )
          );

        const weeklyAmplitude =
          Math.min(
            0.012,
            Math.max(
              0.003,
              amplitude * 0.28
            )
          );

        const weekPhase =
          ACS_seedPhase(
            `${logicalSeriesCode}:${year}:${month}`
          );

        const rawWeeklyShape =
          Array.from(
            { length: 4 },
            (_, weekIndex) =>
              Math.sin(
                (
                  weekIndex *
                  Math.PI *
                  2
                ) /
                  4 +
                  weekPhase
              )
          );

        const weeklyAverage =
          rawWeeklyShape.reduce(
            (total, value) =>
              total + value,
            0
          ) /
          rawWeeklyShape.length;

        const weeklyShape =
          rawWeeklyShape.map(
            value =>
              value -
              weeklyAverage
          );

        const weeklyPrices =
          weeklyShape.map(
            value =>
              ACS_roundFuel(
                monthPrice *
                  (
                    1 +
                    weeklyAmplitude *
                      value
                  )
              )
          );

        const visibleWeek =
          year === currentYear &&
          month === currentMonth
            ? currentWeekOfMonth
            : 4;

        let weeklyChangePercent =
          null;

        for (
          let week = 1;
          week <= visibleWeek;
          week += 1
        ) {
          const weekPrice =
            weeklyPrices[
              week - 1
            ];

          weeklyChangePercent =
            ACS_percentChange(
              weekPrice,
              priorWeekPrice
            );

          priorWeekPrice =
            weekPrice;
        }

        monthlySeries.push({
          period:
            `${year}-${String(month).padStart(2, "0")}`,

          price:
            monthPrice,

          monthly_change_percent:
            ACS_percentChange(
              monthPrice,
              priorMonthPrice
            ),

          weekly_change_percent:
            weeklyChangePercent,

          quality_grade:
            row.quality_grade,

          source_method:
            row.data_kind,

          is_projection:
            row.data_kind ===
            "PROJECTION",

          source_name:
            row.source_name,

          market_scope:
            row.market_scope,

          market_name:
            row.market_name,

          price_basis:
            row.price_basis,

          confidence:
            row.confidence,

          revision_code:
            row.revision_code,

          is_simulation_seed:
            row.is_simulation_seed,

          annual_anchor_price:
            annualPrice,

          is_modeled_period:
            true,

          methodology:
            "ACS_DETERMINISTIC_MONTHLY_V1"
        });

        priorMonthPrice =
          monthPrice;
      }
    }
  );

  return monthlySeries;
}

router.get("/fuel/market", requireAuth, async (req, res) => {
  try {
     
 const result = await pool.query(`
 
     WITH world_authority AS (
  SELECT
    acs_get_current_sim_time()
      AS current_sim_time,

    EXTRACT(
      YEAR FROM acs_get_current_sim_time()
    )::smallint
      AS current_sim_year
),

active_market AS (
        SELECT
          CASE
            WHEN fuel_code = 'AVGAS' THEN 'AVGAS'
            WHEN fuel_code IN ('TURBINE_KEROSENE_EQ', 'JET_FUEL')
              THEN 'JET_FUEL_REFERENCE'
            ELSE fuel_code
          END AS logical_series_code,
          price_year,
          price_usd_per_us_gallon,
          price_low_usd_per_us_gallon,
          price_high_usd_per_us_gallon,
          market_scope,
          market_name,
          data_kind,
          quality_grade,
          source_name,
          source_url,
          price_basis,
          confidence,
          revision_code,
          is_simulation_seed,
          source_retrieved_on,
          updated_at,
          world_authority.current_sim_time,
          world_authority.current_sim_year
FROM public.fuel_market_series
CROSS JOIN world_authority
WHERE is_active = true
          AND fuel_code IN ('AVGAS', 'TURBINE_KEROSENE_EQ', 'JET_FUEL', 'SAF')
          AND price_year <= world_authority.current_sim_year
          ),
      movement AS (
        SELECT
          active_market.*,
          LAG(price_usd_per_us_gallon) OVER (
            PARTITION BY logical_series_code
            ORDER BY price_year
          ) AS prior_price
        FROM active_market
      )
      SELECT
        logical_series_code,
        price_year,
        price_usd_per_us_gallon,
        price_low_usd_per_us_gallon,
        price_high_usd_per_us_gallon,
        CASE
          WHEN prior_price IS NULL OR prior_price = 0 THEN NULL
          ELSE ROUND(
            ((price_usd_per_us_gallon - prior_price) / prior_price) * 100,
            4
          )
        END AS annual_change_percent,
        market_scope,
        market_name,
        data_kind,
        quality_grade,
        source_name,
        source_url,
        price_basis,
        confidence,
        revision_code,
        is_simulation_seed,
        source_retrieved_on,
        updated_at,
        current_sim_time,
        current_sim_year
      FROM movement
      ORDER BY logical_series_code, price_year
    `);

    const seriesByCode = new Map();

    for (const row of result.rows) {
      const records = seriesByCode.get(row.logical_series_code) || [];
      records.push(mapRecord(row));
      seriesByCode.set(row.logical_series_code, records);
    }

    const fuels = fuelCatalogue.map((fuel) => {
       
      const annualRows =
        result.rows.filter(
          row =>
            row.logical_series_code ===
            fuel.seriesCode
        );

      const annualSeries =
        seriesByCode.get(
          fuel.seriesCode
        ) || [];

      const currentSimTime =
        new Date(
          result.rows[0]
            ?.current_sim_time ||
          Date.now()
        );

      const series =
        ACS_buildMonthlySeries(
          annualRows,
          fuel.seriesCode,
          currentSimTime
        );

      const first =
        annualSeries[0] ||
        null;

      const latest =
        annualSeries[
          annualSeries.length - 1
        ] ||
        null;

      return {
        id: fuel.id,
        code: fuel.code,
        name: fuel.name,
        family: fuel.family,
        engine_type: fuel.engine_type,
        grade: fuel.grade,
        identification: fuel.identification,
        introduced_on: fuel.introduced_on,
        retired_on: fuel.retired_on,
        market_status: series.length ? "AVAILABLE" : "UNAVAILABLE",
        unit: "USD / US GAL",
        specification: fuel.specification,
        source: {
          name: latest?.source_name || null,
          market: latest?.market_name || null,
          method: latest?.source_method || null,
          coverage:
            first && latest
              ? `${first.period}-${latest.period}`
              : null,
          quality_grade: latest?.quality_grade || null
        },
        series
      };
    });

    const retrievedDates = result.rows
      .map((row) => row.source_retrieved_on)
      .filter(Boolean)
      .map((value) => new Date(value).toISOString().slice(0, 10));

    const updateTimes = result.rows
      .map((row) => row.updated_at)
      .filter(Boolean)
      .map((value) => new Date(value).toISOString());

    res.set("Cache-Control", "no-store");
    return res.json({
            ok: true,

      as_of:
        retrievedDates
          .sort()
          .at(-1) ||
        null,

      world_date:
        result.rows[0]
          ?.current_sim_time
          ? new Date(
              result.rows[0]
                .current_sim_time
            ).toISOString()
          : null,

      world_year:
        Number(
          result.rows[0]
            ?.current_sim_year
        ) ||
        null,
       
      dataset_revision: updateTimes.sort().at(-1) || null,
      fuels
    });
  } catch (error) {
    console.error("ACS FUEL MARKET FETCH ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "ACS_FUEL_MARKET_FETCH_FAILED"
    });
  }
});

export default router;
