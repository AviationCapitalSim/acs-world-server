/* ============================================================
   === ACS AUTH MIDDLEWARE — COOKIE SESSION ===================
   ============================================================ */

import crypto from "crypto";
import { pool } from "../db/pool.js";

export async function requireAuth(req, res, next) {

  try {

    const token = req.cookies?.acs_session;

    if (!token) {
      return res.status(401).json({ ok: false, error: "NO_SESSION" });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await pool.query(`
      SELECT user_id, airline_id, expires_at, active
      FROM sessions
      WHERE token_hash = $1
      LIMIT 1
    `, [tokenHash]);

    if (!result.rows.length) {
      return res.status(401).json({ ok: false, error: "INVALID_SESSION" });
    }

    const session = result.rows[0];

    if (!session.active) {
      return res.status(401).json({ ok: false, error: "SESSION_INACTIVE" });
    }

    if (new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ ok: false, error: "SESSION_EXPIRED" });
    }

    // 🔐 attach to request
    req.user_id = session.user_id;
    req.airline_id = session.airline_id;

    next();

  } catch (err) {

    console.error("AUTH MIDDLEWARE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AUTH_ERROR"
    });
  }
}
