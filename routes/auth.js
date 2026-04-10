import express from "express";
import { pool } from "../db/pool.js";
import crypto from "crypto";
import bcrypt from "bcrypt";

const router = express.Router();

/* ============================================================
   REGISTER USER
   ============================================================ */

router.post("/auth/register", async (req, res) => {

  const {
    fullName,
    email,
    country,
    dob,
    age,
    password,
    termsAccepted
  } = req.body;

  try {

    if (
      typeof fullName !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof country !== "string" ||
      typeof termsAccepted !== "boolean"
    ) {
      return res.status(400).json({ error: "INVALID_INPUT" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const passwordInput = password.trim();

    if (!normalizedEmail || !passwordInput) {
      return res.status(400).json({ error: "INVALID_INPUT" });
    }

    if (passwordInput.length < 8 || passwordInput.length > 200) {
      return res.status(400).json({ error: "INVALID_PASSWORD" });
    }

    const userId = crypto.randomUUID();

    const passwordHash = await bcrypt.hash(passwordInput, 12);

    const client = await pool.connect();

    try {

      await client.query("BEGIN");

      await client.query(`
        INSERT INTO users
        (user_id, full_name, email, country, dob, age, created_at, terms_accepted)
        VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
      `, [
        userId,
        fullName.trim(),
        normalizedEmail,
        country.trim(),
        dob,
        age,
        termsAccepted
      ]);

      await client.query(`
        INSERT INTO users_auth
        (user_id, email, password_hash)
        VALUES ($1,$2,$3)
      `, [
        userId,
        normalizedEmail,
        passwordHash
      ]);

      await client.query(`
        INSERT INTO terms_cond
        (timestamp, email, version, user_agent, source, user_id, accepted_at)
        VALUES (NOW(), $1, '1.0', $2, 'register', $3, NOW())
      `, [
        normalizedEmail,
        req.headers["user-agent"] || "",
        userId
      ]);

      await client.query("COMMIT");

    } catch (err) {

      await client.query("ROLLBACK");

      if (err.code === "23505") {
        return res.json({ status: "EMAIL_EXISTS" });
      }

      throw err;

    } finally {
      client.release();
    }

    res.json({
      status: "success",
      userId
    });

  } catch (err) {

    console.error("REGISTER ERROR:", err);

    res.status(500).json({
      status: "ERROR"
    });
  }
});

/* ============================================================
   LOGIN
   ============================================================ */

router.post("/auth/login", async (req, res) => {

  const { email, password } = req.body;

  try {

    const normalizedEmail = email?.trim().toLowerCase();
    const passwordInput = password?.trim();

    const result = await pool.query(`
      SELECT u.user_id, u.email, u.airline_id, a.password_hash
      FROM users u
      JOIN users_auth a ON a.user_id = u.user_id
      WHERE u.email = $1
    `, [normalizedEmail]);

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "";

    const fail = async (userId = null) => {
      await pool.query(`
        INSERT INTO security_log (user_id, action, ip_address)
        VALUES ($1, $2, $3)
      `, [
        userId,
        "LOGIN_FAILED",
        ip
      ]);

      return res.json({
        ok: false,
        error: "INVALID_CREDENTIALS"
      });
    };

    if (!result.rows.length) {
      return await fail(null);
    }

    const user = result.rows[0];

if (!passwordInput || !user.password_hash) {
  console.error("LOGIN ERROR: missing password input or password_hash", {
    email: normalizedEmail,
    hasPasswordInput: !!passwordInput,
    hasPasswordHash: !!user.password_hash
  });
  return await fail(user.user_id);
}

const passwordOk = await bcrypt.compare(passwordInput, user.password_hash);

if (!passwordOk) {
  return await fail(user.user_id);
}

    const rawToken = crypto.randomBytes(48).toString("hex");

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

    const userAgent = req.headers["user-agent"] || "";

    await pool.query(`
      UPDATE sessions
      SET active = false
      WHERE user_id = $1
    `, [user.user_id]);

    await pool.query(`
      INSERT INTO sessions
      (token_hash, user_id, airline_id, created_at, expires_at, ip_address, user_agent, active, last_seen_at)
      VALUES ($1,$2,$3,NOW(),$4,$5,$6,true,NOW())
    `, [
      tokenHash,
      user.user_id,
      user.airline_id,
      expiresAt,
      ip,
      userAgent
    ]);

    await pool.query(`
      INSERT INTO security_log (user_id, action, ip_address)
      VALUES ($1, $2, $3)
    `, [
      user.user_id,
      "LOGIN_SUCCESS",
      ip
    ]);

 res.cookie("acs_session", rawToken, {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000
});
     
    return res.json({
      ok: true,
      user: {
        user_id: user.user_id,
        email: user.email,
        airline_id: user.airline_id
      }
    });

  } catch (err) {

    console.error("LOGIN ERROR:", err);

    res.status(500).json({
      status: "ERROR",
      message: err.message
    });
  }
});

/* ============================================================
   SET USER BASE
   ============================================================ */

router.post("/users/set-base", async (req, res) => {

  const { user_id, base_icao } = req.body;

  try {

    await pool.query(
      `
      UPDATE users
      SET base_icao = $1
      WHERE user_id = $2
      `,
      [base_icao, user_id]
    );

    res.json({
      ok: true
    });

  } catch (err) {

    console.error("SET BASE ERROR:", err);

    res.status(500).json({
      ok: false
    });
  }
});

/* ============================================================
   GET USER PROFILE (DASHBOARD SOURCE)
   ============================================================ */

router.get("/users/profile/:user_id", async (req, res) => {

  const { user_id } = req.params;

  try {

    const userResult = await pool.query(`
      SELECT
        user_id,
        full_name,
        email,
        country,
        airline_id,
        base_icao
      FROM users
      WHERE user_id = $1
    `, [user_id]);

    if (!userResult.rows.length) {
      return res.json({
        status: "USER_NOT_FOUND"
      });
    }

    const user = userResult.rows[0];

    let airline = null;

    if (user.airline_id) {

      const airlineResult = await pool.query(`
        SELECT
          airline_id,
          airline_name,
          country
        FROM airlines
        WHERE airline_id = $1
      `, [user.airline_id]);

      airline = airlineResult.rows[0] || null;
    }

    res.json({
      status: "success",
      user,
      airline
    });

  } catch (err) {

    console.error("PROFILE ERROR:", err);

    res.status(500).json({
      status: "ERROR"
    });
  }
});

/* ============================================================
   GET CURRENT SESSION
   ============================================================ */

import { requireAuth } from "../middleware/auth.js";

router.get("/session", requireAuth, async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT user_id, email, airline_id
      FROM users
      WHERE user_id = $1
    `, [req.user_id]);

    if (!result.rows.length) {
      return res.status(404).json({ ok: false });
    }

    res.json({
      ok: true,
      user: result.rows[0]
    });

  } catch (err) {

    console.error("SESSION ERROR:", err);

    res.status(500).json({ ok: false });
  }
});

/* ============================================================
   TOKEN AUTH — GET CURRENT USER
   ============================================================ */

router.get("/auth/me", async (req, res) => {
  try {

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, error: "NO_TOKEN" });
    }

    const rawToken = authHeader.slice(7).trim();

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    const result = await pool.query(`
      SELECT user_id, airline_id, expires_at, active
      FROM sessions
      WHERE token_hash = $1
      LIMIT 1
    `, [tokenHash]);

    if (!result.rows.length) {
      return res.status(401).json({ ok: false, error: "INVALID_TOKEN" });
    }

    const session = result.rows[0];

    if (!session.active) {
      return res.status(401).json({ ok: false, error: "SESSION_INACTIVE" });
    }

    if (new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ ok: false, error: "SESSION_EXPIRED" });
    }

    return res.json({
      ok: true,
      user: {
        user_id: session.user_id,
        airline_id: session.airline_id
      }
    });

  } catch (err) {

    console.error("AUTH ME ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "AUTH_ME_ERROR"
    });
  }
});

export default router;
