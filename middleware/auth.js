/* ============================================================
   === ACS AUTH MIDDLEWARE — COOKIE SESSION ===================
   ============================================================ */

import crypto from "crypto";
import { pool } from "../db/pool.js";

function getCanonicalSessionToken(req) {
  const rawHeader = req.headers?.cookie || "";

  if (!rawHeader) return null;

  const parts = rawHeader
    .split(";")
    .map(p => p.trim())
    .filter(Boolean);

  const sessionCookies = [];

  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;

    const name = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();

    if (name === "acs_session" && value) {
      sessionCookies.push(value);
    }
  }

  if (!sessionCookies.length) {
    return null;
  }

  return sessionCookies[sessionCookies.length - 1];
}

export async function requireAuth(req, res, next) {

  try {

    const token = getCanonicalSessionToken(req);

    if (!token) {
      return res.status(401).json({ ok: false, error: "NO_SESSION" });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await pool.query(`
      SELECT user_id, airline_id, expires_at, active, ip_address, user_agent
      FROM sessions
      WHERE token_hash = $1
      LIMIT 1
    `, [tokenHash]);

    if (!result.rows.length) {
      return res.status(401).json({ ok: false, error: "INVALID_SESSION" });
    }

    const session = result.rows[0];

    /* ============================================================
   DEVICE / IP VALIDATION (SAFE MODE — NO BLOCK)
   ============================================================ */

const currentIP =
  req.headers["x-forwarded-for"]?.split(",")[0] ||
  req.socket.remoteAddress ||
  "";

const currentUA = req.headers["user-agent"] || "";

// ⚠️ Comparación simple (no estricta)
if (session.ip_address && session.user_agent) {

  const ipChanged = session.ip_address !== currentIP;
  const uaChanged = session.user_agent !== currentUA;

  if (ipChanged || uaChanged) {

/* ============================================================
   SECURITY LOG — SUSPICIOUS SESSION
   ============================================================ */

await pool.query(`
  INSERT INTO security_log
  (user_id, action, ip_address, date)
  VALUES ($1, $2, $3, NOW())
`, [
  session.user_id,
  "SUSPICIOUS_SESSION",
  currentIP
]);

    // (FUTURO) aquí puedes registrar en DB o security_log
  }
}
     
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
