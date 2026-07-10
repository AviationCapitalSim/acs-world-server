import express from "express";
import { pool } from "../db/pool.js";
import crypto from "crypto";
import bcrypt from "bcrypt";
import nodemailer from "nodemailer";

const router = express.Router();

const PASSWORD_RESET_RESPONSE =
  "If the account exists, a recovery email has been sent.";

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

function getRequestIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    ""
  );
}

function isValidNewPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password)
  );
}

function createMailTransporter() {
  const requiredEnvironmentVariables = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_APP_PASSWORD",
    "PASSWORD_RESET_URL"
  ];

  const missingVariables = requiredEnvironmentVariables.filter(
    name => !process.env[name]
  );

  if (missingVariables.length) {
    throw new Error(
      `Missing password recovery environment variables: ${missingVariables.join(", ")}`
    );
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_APP_PASSWORD
    }
  });
}

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

    // verificar si el usuario ya existe
    const existing = await pool.query(
      "SELECT user_id FROM users WHERE email = $1",
      [email]
    );

    if (existing.rows.length > 0) {
      return res.json({
        status: "EMAIL_EXISTS"
      });
    }

    const userId = crypto.randomUUID();

    // crear usuario
    await pool.query(`
      INSERT INTO users
      (user_id, full_name, email, country, dob, age, created_at, terms_accepted)
      VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
    `, [
      userId,
      fullName,
      email,
      country,
      dob,
      age,
      termsAccepted
    ]);

    // registrar aceptación de términos
    await pool.query(`
      INSERT INTO terms_cond
      (timestamp, email, version, user_agent, source, user_id, accepted_at)
      VALUES (NOW(), $1, '1.0', $2, 'register', $3, NOW())
    `, [
      email,
      req.headers["user-agent"] || "",
      userId
    ]);

    // 🔐 HASH PASSWORD (BCRYPT)
    const hashedPassword = await bcrypt.hash(password, 10);

    // guardar auth
    await pool.query(`
      INSERT INTO users_auth
      (user_id, email, password_hash)
      VALUES ($1,$2,$3)
    `, [
      userId,
      email,
      hashedPassword
    ]);

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

    const result = await pool.query(`
      SELECT
        u.user_id,
        u.email,
        u.airline_id AS user_airline_id,
        al.airline_id AS linked_airline_id,
        COALESCE(u.airline_id, al.airline_id) AS airline_id,
        ua.password_hash
      FROM users u
      JOIN users_auth ua
        ON ua.user_id = u.user_id
      LEFT JOIN airlines al
        ON al.user_id = u.user_id
      WHERE LOWER(u.email) = LOWER($1)
      LIMIT 1
    `, [email]);

    if (!result.rows.length) {
      return res.json({ status: "NO_USER" });
    }

    const user = result.rows[0];

    // 🔐 BCRYPT COMPARE
    if (!user.password_hash) {
      return res.status(500).json({
        status: "AUTH_DATA_INVALID"
      });
    }

    const isMatch = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!isMatch) {
      return res.json({ status: "WRONG_PASSWORD" });
    }

    /* ============================================================
       AUTO-REPAIR USER AIRLINE LINK
       ------------------------------------------------------------
       If the airline exists in airlines but users.airline_id is NULL,
       repair the canonical user link before creating the session.
       ============================================================ */

    if (!user.user_airline_id && user.linked_airline_id) {
      await pool.query(`
        UPDATE users
        SET airline_id = $1
        WHERE user_id = $2
          AND airline_id IS NULL
      `, [
        user.linked_airline_id,
        user.user_id
      ]);

      user.airline_id = user.linked_airline_id;
    }

    // ============================================================
    // 🔐 CREATE SESSION (NEW CORE)
    // ============================================================

    const rawToken = crypto.randomBytes(48).toString("hex");

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    const expiresAt = new Date(
      Date.now() + 1000 * 60 * 60 * 24 * 7
    ); // 7 días

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "";

    const userAgent = req.headers["user-agent"] || "";

    /* ============================================================
       INVALIDATE PREVIOUS ACTIVE SESSIONS
       ============================================================ */

    await pool.query(`
      UPDATE sessions
      SET active = false
      WHERE user_id = $1
        AND active = true
    `, [user.user_id]);

    await pool.query(`
      INSERT INTO sessions
      (
        token_hash,
        user_id,
        airline_id,
        created_at,
        expires_at,
        ip_address,
        user_agent,
        active,
        last_seen_at
      )
      VALUES ($1,$2,$3,NOW(),$4,$5,$6,true,NOW())
    `, [
      tokenHash,
      user.user_id,
      user.airline_id,
      expiresAt,
      ip,
      userAgent
    ]);

    /* ============================================================
       CANONICAL SESSION COOKIE — SINGLE SOURCE OF TRUTH
       • Limpia variantes viejas
       • Emite una sola cookie canónica para todo ACS
       ============================================================ */

    // 1) limpiar variantes heredadas / legacy
    res.clearCookie("acs_session", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/"
    });

    res.clearCookie("acs_session", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      domain: "api.aviationcapitalsim.com"
    });

    res.clearCookie("acs_session", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      domain: ".aviationcapitalsim.com"
    });

    // 2) emitir cookie canónica única
    res.cookie("acs_session", rawToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      domain: ".aviationcapitalsim.com",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    /* ============================================================
       RESPONSE
       ============================================================ */

    if (!user.airline_id) {
      return res.json({
        ok: true,
        status: "NO_AIRLINE",
        user: {
          user_id: user.user_id,
          email: user.email,
          airline_id: null
        }
      });
    }

    return res.json({
      ok: true,
      status: "HAS_AIRLINE",
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
      message: err.message,
      detail: err.detail || null
    });

  }

});

/* ============================================================
   FORGOT PASSWORD
   ============================================================ */

router.post("/auth/forgot-password", async (req, res) => {
  const genericResponse = {
    ok: true,
    message: PASSWORD_RESET_RESPONSE
  };

  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";

  // Always return the same public response.
  if (!email || email.length > 320) {
    return res.status(200).json(genericResponse);
  }

  let resetId = null;

  try {
    const userResult = await pool.query(`
      SELECT user_id, email
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `, [email]);

    if (!userResult.rows.length) {
      return res.status(200).json(genericResponse);
    }

    const user = userResult.rows[0];

    const rawToken = crypto
      .randomBytes(32)
      .toString("base64url");

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    resetId = crypto.randomUUID();

    const requestedIP = getRequestIP(req);
    const userAgent = req.headers["user-agent"] || "";

    // Invalidate earlier unused tokens before issuing a new one.
    await pool.query(`
      UPDATE password_reset_tokens
      SET used_at = NOW()
      WHERE user_id = $1
        AND used_at IS NULL
    `, [user.user_id]);

    await pool.query(`
      INSERT INTO password_reset_tokens
      (
        reset_id,
        user_id,
        token_hash,
        expires_at,
        used_at,
        requested_ip,
        user_agent,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        NOW() + INTERVAL '30 minutes',
        NULL,
        $4,
        $5,
        NOW()
      )
    `, [
      resetId,
      user.user_id,
      tokenHash,
      requestedIP,
      userAgent
    ]);

    const resetURL = new URL(
      process.env.PASSWORD_RESET_URL
    );

    resetURL.hash =
      `reset_token=${encodeURIComponent(rawToken)}`;

    const transporter = createMailTransporter();

    await transporter.sendMail({
      from: {
        name: "Aviation Capital Simulator",
        address: process.env.SMTP_USER
      },
      to: user.email,
      subject: "ACS PASSWORD RECOVERY",
      text: [
        "ACS PASSWORD RECOVERY",
        "",
        "We received a request to reset your Aviation Capital Simulator password.",
        "",
        "Reset Password:",
        resetURL.toString(),
        "",
        "This link expires in 30 minutes.",
        "",
        "If you did not request this change, you can safely ignore this email.",
        "",
        "Please do not reply to this email."
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;color:#071427;line-height:1.6">
          <h2 style="color:#c98300">
            ACS PASSWORD RECOVERY
          </h2>

          <p>
            We received a request to reset your Aviation
            Capital Simulator password.
          </p>

          <p>
            <a
              href="${resetURL.toString()}"
              style="display:inline-block;padding:12px 20px;background:#ffb300;color:#071427;text-decoration:none;font-weight:700;border-radius:6px"
            >
              Reset Password
            </a>
          </p>

          <p>This link expires in 30 minutes.</p>

          <p>
            If you did not request this change, you can safely
            ignore this email.
          </p>

          <p>Please do not reply to this email.</p>
        </div>
      `
    });

    return res.status(200).json(genericResponse);

  } catch (err) {

    console.error("FORGOT PASSWORD ERROR:", err);

    // Do not leave a usable token when email delivery failed.
    if (resetId) {
      try {
        await pool.query(`
          UPDATE password_reset_tokens
          SET used_at = NOW()
          WHERE reset_id = $1
            AND used_at IS NULL
        `, [resetId]);
      } catch (cleanupError) {
        console.error(
          "PASSWORD RESET TOKEN CLEANUP ERROR:",
          cleanupError
        );
      }
    }

    // Never expose account existence or SMTP details.
    return res.status(200).json(genericResponse);
  }
});

/* ============================================================
   RESET PASSWORD
   ============================================================ */

router.post("/auth/reset-password", async (req, res) => {
  const token =
    typeof req.body?.token === "string"
      ? req.body.token.trim()
      : "";

  const newPassword = req.body?.newPassword;

  if (!token || token.length > 200) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_OR_EXPIRED_TOKEN"
    });
  }

  if (!isValidNewPassword(newPassword)) {
    return res.status(400).json({
      ok: false,
      error: "PASSWORD_POLICY",
      message:
        "Password must contain 12–128 characters, including uppercase, lowercase and a number."
    });
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tokenResult = await client.query(`
      SELECT reset_id, user_id
      FROM password_reset_tokens
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      LIMIT 1
      FOR UPDATE
    `, [tokenHash]);

    if (!tokenResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        ok: false,
        error: "INVALID_OR_EXPIRED_TOKEN"
      });
    }

    const resetToken = tokenResult.rows[0];

    const passwordHash = await bcrypt.hash(
      newPassword,
      12
    );

    const updateResult = await client.query(`
      UPDATE users_auth
      SET password_hash = $1
      WHERE user_id = $2
    `, [
      passwordHash,
      resetToken.user_id
    ]);

    if (updateResult.rowCount !== 1) {
      throw new Error("AUTH_RECORD_NOT_FOUND");
    }

    // Consume this token and every outstanding token for the user.
    await client.query(`
      UPDATE password_reset_tokens
      SET used_at = NOW()
      WHERE user_id = $1
        AND used_at IS NULL
    `, [resetToken.user_id]);

    await client.query(`
      INSERT INTO security_log
      (user_id, action, ip_address, date)
      VALUES ($1, $2, $3, NOW())
    `, [
      resetToken.user_id,
      "PASSWORD_RESET_COMPLETED",
      getRequestIP(req)
    ]);

    await client.query("COMMIT");

    return res.status(200).json({
      ok: true,
      status: "PASSWORD_RESET_COMPLETE"
    });

  } catch (err) {

    await client.query("ROLLBACK");

    console.error("RESET PASSWORD ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "PASSWORD_RESET_ERROR"
    });

  } finally {

    client.release();

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

export default router;
