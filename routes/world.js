import express from "express";
import { pool } from "../db/pool.js";
import { ACS_getRequestIP, ACS_requireGuardianAccess } from "../services/acs_guardian_security.js";

const router = express.Router();

/* ============================================================
   GET WORLD STATE — POSTGRESQL TIME AUTHORITY
   ============================================================ */

router.get("/world", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        sim_start,
        sim_end,
        real_start,
        frozen_sim_time,
        status,
        updated_at,
        acs_get_current_sim_time() AS current_sim_time,
        'POSTGRESQL_TIME_AUTHORITY' AS time_source
      FROM acs_world
      WHERE id = 1
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "ACS_WORLD_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      world: result.rows[0]
    });

  } catch (err) {
    console.error("WORLD FETCH ERROR:", err);

    res.status(500).json({
      ok: false,
      error: "WORLD_FETCH_FAILED"
    });
  }
});

/* ============================================================
   GLOBAL WORLD PAUSE / RESUME — GUARDIAN ADMIN ONLY
   PostgreSQL remains the single time authority. Pausing stores
   the current simulated time; resuming restarts from that exact
   instant without advancing time while ACS was paused.
   ============================================================ */

async function ACS_applyWorldControl(req, res, action) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const currentResult = await client.query(`
      SELECT
        status,
        frozen_sim_time
      FROM public.acs_world
      WHERE id = 1
      FOR UPDATE
    `);

    if (!currentResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        error: "ACS_WORLD_NOT_FOUND"
      });
    }

    const current = currentResult.rows[0];
    const currentStatus = String(current.status || "")
      .trim()
      .toUpperCase();
    const targetStatus = action === "pause" ? "OFF" : "ON";

    if (!["ON", "OFF"].includes(currentStatus)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "ACS_WORLD_STATUS_INVALID"
      });
    }

    const clockResult = await client.query(`
      SELECT public.acs_get_current_sim_time() AS current_sim_time
    `);
    const currentSimTime = clockResult.rows[0]?.current_sim_time;
    const changed = currentStatus !== targetStatus;

    if (changed && action === "pause") {
      await client.query(`
        UPDATE public.acs_world
        SET
          status = 'OFF',
          frozen_sim_time = $1,
          real_start = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = 1
      `, [currentSimTime]);
    } else if (changed) {
      await client.query(`
        UPDATE public.acs_world
        SET
          status = 'ON',
          real_start = clock_timestamp(),
          frozen_sim_time = COALESCE(frozen_sim_time, $1),
          updated_at = clock_timestamp()
        WHERE id = 1
      `, [currentSimTime]);
    }

    if (changed) {
      await client.query(`
        INSERT INTO public.acs_guardian_audit_log (
          administrator_id,
          event_type,
          source_ip,
          details
        )
        VALUES ($1, $2, $3, $4::jsonb)
      `, [
        req.guardian_administrator.id,
        action === "pause" ? "ACS_WORLD_PAUSED" : "ACS_WORLD_RESUMED",
        ACS_getRequestIP(req),
        JSON.stringify({
          from: currentStatus,
          to: targetStatus,
          simTime: currentSimTime
        })
      ]);
    }

    const worldResult = await client.query(`
      SELECT
        id,
        sim_start,
        sim_end,
        real_start,
        frozen_sim_time,
        status,
        updated_at,
        public.acs_get_current_sim_time() AS current_sim_time,
        'POSTGRESQL_TIME_AUTHORITY' AS time_source
      FROM public.acs_world
      WHERE id = 1
    `);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      changed,
      world: worldResult.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("WORLD CONTROL ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: "WORLD_CONTROL_FAILED"
    });
  } finally {
    client.release();
  }
}

router.post(
  "/world/control",
  ACS_requireGuardianAccess,
  async (req, res) => {
    const action = String(req.body?.action || "")
      .trim()
      .toLowerCase();

    if (!["pause", "resume"].includes(action)) {
      return res.status(400).json({
        ok: false,
        error: "WORLD_CONTROL_ACTION_INVALID"
      });
    }

    return ACS_applyWorldControl(req, res, action);
  }
);

/*
  Retain the historical route shape for administrative clients,
  but never accept caller-supplied clock values. It is protected
  by Guardian and delegates to the same frozen-time transitions.
*/
router.post(
  "/world",
  ACS_requireGuardianAccess,
  async (req, res) => {
    const status = String(req.body?.status || "")
      .trim()
      .toUpperCase();
    const action = status === "OFF"
      ? "pause"
      : status === "ON"
        ? "resume"
        : null;

    if (!action) {
      return res.status(400).json({
        ok: false,
        error: "WORLD_STATUS_INVALID"
      });
    }

    return ACS_applyWorldControl(req, res, action);
  }
);

export default router;
