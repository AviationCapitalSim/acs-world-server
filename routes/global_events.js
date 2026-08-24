/* ============================================================
   ACS OCC - GLOBAL EVENTS ROUTE v1.0
   ------------------------------------------------------------
   Date: 2026-08-24
   Read-only PostgreSQL global events authority.

   Lifecycle:
   - ACTIVE
   - NORMAL
   - EXPIRED

   PostgreSQL remains the permanent historical authority.
   No embedded data, local fallback or database writes.
   ============================================================ */

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/* ============================================================
   GET GLOBAL EVENTS
   ------------------------------------------------------------
   POINT EVENTS
   - ACTIVE: first 90 simulated days.
   - NORMAL: following 60 simulated days.
   - EXPIRED: removed from the visible table.

   EXTENDED EVENTS
   - ACTIVE: through event_end_date.
   - NORMAL: 60 days after event_end_date.
   - EXPIRED: removed from the visible table.

   Expired records remain permanently stored in PostgreSQL.
   ============================================================ */

router.get(
  "/global-events",
  requireAuth,
  async (req, res) => {
    try {
      const result = await pool.query(`
        WITH world_authority AS (
          SELECT
            acs_get_current_sim_time()
              AS current_sim_time
        ),

        classified_events AS (
          SELECT
            ge.id,
            ge.event_key,
            ge.origin,
            ge.category,
            ge.headline,
            ge.summary,
            ge.article,
            ge.aviation_effect,
            ge.location,
            ge.publication_date,
            ge.image_filename,

            CASE
              /* Extended event currently ACTIVE */
              WHEN ge.event_end_date IS NOT NULL
                AND COALESCE(
                      ge.event_start_date::date,
                      ge.publication_date
                    )
                    <= world_authority.current_sim_time::date
                AND ge.event_end_date::date
                    >= world_authority.current_sim_time::date
              THEN 'ACTIVE'

              /* Extended event inside 60-day NORMAL period */
              WHEN ge.event_end_date IS NOT NULL
                AND world_authority.current_sim_time::date
                    > ge.event_end_date::date
                AND world_authority.current_sim_time::date
                    < ge.event_end_date::date
                      + INTERVAL '60 days'
              THEN 'NORMAL'

              /* Point event inside 90-day ACTIVE period */
              WHEN ge.event_end_date IS NULL
                AND world_authority.current_sim_time::date
                    < ge.publication_date
                      + INTERVAL '90 days'
              THEN 'ACTIVE'

              /* Point event inside following 60-day NORMAL period */
              WHEN ge.event_end_date IS NULL
                AND world_authority.current_sim_time::date
                    >= ge.publication_date
                      + INTERVAL '90 days'
                AND world_authority.current_sim_time::date
                    < ge.publication_date
                      + INTERVAL '150 days'
              THEN 'NORMAL'

              ELSE 'EXPIRED'
            END AS lifecycle_status

          FROM public.global_events AS ge
          CROSS JOIN world_authority

          WHERE ge.is_published = TRUE
            AND ge.publication_date
                <= world_authority.current_sim_time::date
        ),

        visible_events AS (
          SELECT *
          FROM classified_events
          WHERE lifecycle_status IN (
            'ACTIVE',
            'NORMAL'
          )
        )

        SELECT
          world_authority.current_sim_time,

          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id',
                  visible_events.id,
                'event_key',
                  visible_events.event_key,
                'origin',
                  visible_events.origin,
                'category',
                  visible_events.category,
                'headline',
                  visible_events.headline,
                'summary',
                  visible_events.summary,
                'article',
                  visible_events.article,
                'aviation_effect',
                  visible_events.aviation_effect,
                'location',
                  visible_events.location,
                'publication_date',
                  visible_events.publication_date,
                'image_filename',
                  visible_events.image_filename,
                'lifecycle_status',
                  visible_events.lifecycle_status,
                'is_active',
                  visible_events.lifecycle_status = 'ACTIVE'
              )

              ORDER BY
                CASE
                  WHEN visible_events.lifecycle_status = 'ACTIVE'
                    THEN 0
                  ELSE 1
                END,
                visible_events.publication_date DESC,
                visible_events.id DESC
            ) FILTER (
              WHERE visible_events.id IS NOT NULL
            ),

            '[]'::JSONB
          ) AS events

        FROM world_authority

        LEFT JOIN visible_events
          ON TRUE

        GROUP BY
          world_authority.current_sim_time
      `);

      const currentSimTime =
        result.rows[0]?.current_sim_time || null;

      const events =
        Array.isArray(result.rows[0]?.events)
          ? result.rows[0].events
          : [];

      if (!currentSimTime) {
        return res.status(503).json({
          ok: false,
          error: "ACS_TIME_UNAVAILABLE"
        });
      }

      const activeTotal = events.filter(
        (event) =>
          event.lifecycle_status === "ACTIVE"
      ).length;

      const normalTotal = events.filter(
        (event) =>
          event.lifecycle_status === "NORMAL"
      ).length;

      const worldStatus =
        activeTotal > 0
          ? "ACTIVE"
          : "NORMAL";

      res.set("Cache-Control", "no-store");

      return res.status(200).json({
        ok: true,
        time_source:
          "POSTGRESQL_TIME_AUTHORITY",
        current_sim_time: currentSimTime,
        world_status: worldStatus,
        total: events.length,
        active_total: activeTotal,
        normal_total: normalTotal,
        events
      });

    } catch (error) {
      console.error(
        "ACS GLOBAL EVENTS FETCH ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "ACS_GLOBAL_EVENTS_FETCH_FAILED"
      });
    }
  }
);

export default router;
