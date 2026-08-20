/* ============================================================
   🧭 ACS OCC — ROUTE PLANNING AUTHORITY v1.0
   ------------------------------------------------------------
   File: routes/route_planning.js

   PURPOSE
   - Independent backend authority for Route Planning.
   - Read ACS master data directly from PostgreSQL.
   - Provide historical aircraft study data.
   - Keep Route Planning isolated from operational systems.

   RULES
   - PostgreSQL authority only.
   - READ ONLY.
   - No INSERT.
   - No UPDATE.
   - No DELETE.
   - No aircraft purchase.
   - No fleet modification.
   - No route creation.
   - No slot reservation.
   - No schedule modification.
   - No maintenance modification.
   - No finance movement.
   - No future aircraft.

   HISTORICAL AIRCRAFT RULE
   - Aircraft already introduced by the requested ACS year
     may be studied.
   - Production end does NOT remove an aircraft from study.
   - Ownership does NOT matter.
   - Factory availability does NOT matter.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";

const router = express.Router();


/* ============================================================
   GET /v1/route-planning/aircraft?year=1965
   ------------------------------------------------------------
   Returns every aircraft model already historically available
   by the requested ACS simulation year.

   IMPORTANT:
   aircraft_catalog is the primary authority.

   aircraft_production_rules is supplementary historical
   metadata only. A missing production-rule record must NOT
   remove an aircraft from Route Planning.
   ============================================================ */

router.get("/aircraft", async (req, res) => {
  try {

    const year =
      Number(req.query.year);


    /* ----------------------------------------------------------
       Validate requested ACS year
       ---------------------------------------------------------- */

    if (
      !Number.isInteger(year) ||
      year < 1900 ||
      year > 2100
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_YEAR",
        message:
          "A valid ACS simulation year is required."
      });
    }


    /* ----------------------------------------------------------
       Historical Route Planning catalog

       IMPORTANT:

       LEFT JOIN is intentional.

       Route Planning studies aircraft_catalog.

       aircraft_production_rules may enrich the historical
       introduction date, but absence from that table must
       never make an aircraft disappear from this department.
       ---------------------------------------------------------- */

    const result =
      await pool.query(
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

          ac.engines,
          ac.aircraft_category,

          ac.status,

          ac.image_filename
            AS image_file_name,


          /* ----------------------------------------------
             Supplementary historical production metadata
             ---------------------------------------------- */

          pr.aircraft_category
            AS production_category,

          pr.production_start_year,
          pr.production_end_year,

          pr.first_delivery_year,
          pr.last_delivery_year,

          pr.capacity_tier,


          /* ----------------------------------------------
             Canonical Route Planning introduction year
             ---------------------------------------------- */

          COALESCE(
            pr.first_delivery_year,
            pr.production_start_year,
            ac.production_year,
            ac.year
          ) AS introduction_year


        FROM aircraft_catalog ac


        LEFT JOIN aircraft_production_rules pr
          ON pr.model_key = ac.model_key


        WHERE

          COALESCE(
            pr.first_delivery_year,
            pr.production_start_year,
            ac.production_year,
            ac.year
          ) <= $1


        ORDER BY

          COALESCE(
            pr.first_delivery_year,
            pr.production_start_year,
            ac.production_year,
            ac.year
          ) DESC,

          ac.manufacturer ASC,
          ac.model ASC;
        `,
        [year]
      );


    /* ----------------------------------------------------------
       Response
       ---------------------------------------------------------- */

    return res.json({

      ok: true,

      endpoint:
        "ACS_ROUTE_PLANNING_AIRCRAFT",

      version:
        "v1.0",

      authority:
        "POSTGRESQL",

      mode:
        "READ_ONLY",

      year,

      count:
        result.rows.length,

      aircraft:
        result.rows
    });


  } catch (err) {

    console.error(
      "ACS ROUTE PLANNING AIRCRAFT ERROR:",
      err
    );


    return res.status(500).json({

      ok: false,

      error:
        "ROUTE_PLANNING_AIRCRAFT_FAILED",

      message:
        err.message
    });
  }
});


export default router;
