import express from "express";
import { pool } from "../db/pool.js";
import crypto from "crypto";

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
  passwordHash,
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
`,
[userId, fullName, email, country, dob, age, termsAccepted]
);

// registrar aceptación de términos
     
await pool.query(`
  INSERT INTO terms_cond
  (timestamp, email, version, user_agent, source, user_id, accepted_at)
  VALUES (NOW(), $1, '1.0', $2, 'register', $3, NOW())
`,
[
  email,
  req.headers["user-agent"] || "",
  userId
]);
     
    // guardar auth
     
    await pool.query(`
      INSERT INTO users_auth
      (user_id, email, password_hash)
      VALUES ($1,$2,$3)
    `,
    [userId, email, passwordHash]
    );

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

  const { email, passwordHash } = req.body;

  try {

    const result = await pool.query(`
      SELECT u.user_id, u.email, u.airline_id, a.password_hash
      FROM users u
      JOIN users_auth a ON a.user_id = u.user_id
      WHERE u.email = $1
    `, [email]);

    if (!result.rows.length) {
      return res.json({ status: "NO_USER" });
    }

    const user = result.rows[0];

    if (user.password_hash !== passwordHash) {
      return res.json({ status: "WRONG_PASSWORD" });
    }

    // ============================================================
    // 🔐 CREATE SESSION (NEW CORE)
    // ============================================================

    const rawToken = crypto.randomBytes(48).toString("hex");

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7); // 7 días

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      "";

    const userAgent = req.headers["user-agent"] || "";

  await pool.query(`
  INSERT INTO sessions
  (session_token, token_hash, user_id, airline_id, created_at, expires_at, ip_address, user_agent, active, last_seen_at)
  VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,true,NOW())
`, [
  rawToken,
  tokenHash,
  user.user_id,
  user.airline_id,
  expiresAt,
  ip,
  userAgent
]);
     
   /* ============================================================
   SET SECURE SESSION COOKIE
   ============================================================ */

res.cookie("acs_session", rawToken, {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  expires: expiresAt,
  path: "/"
});

/* ============================================================
   RESPONSE
   ============================================================ */

if (!user.airline_id) {
  return res.json({
    status: "NO_AIRLINE",
    user: {
      userId: user.user_id,
      email: user.email
    }
  });
}

return res.json({
  status: "HAS_AIRLINE",
  user: {
    userId: user.user_id,
    email: user.email,
    airline: user.airline_id
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

    /* --------------------------------------------------------
       USER
    -------------------------------------------------------- */

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

    /* --------------------------------------------------------
       AIRLINE
    -------------------------------------------------------- */

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

    /* --------------------------------------------------------
       RESPONSE
    -------------------------------------------------------- */

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

export default router;
