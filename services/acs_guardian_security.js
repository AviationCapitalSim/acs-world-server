/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   PRIVATE ACCESS SECURITY
   ------------------------------------------------------------
   Guardian requires:
   1. A valid ACS session.
   2. An explicitly authorized email address.
   3. A fresh password verification.
   4. A short-lived Guardian access token.
   ============================================================ */

import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool } from "../db/pool.js";

const ACS_GUARDIAN_ACCESS_MINUTES = 30;

function ACS_hashToken(rawToken) {
  return crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");
}

function ACS_createRawToken() {
  return crypto
    .randomBytes(48)
    .toString("base64url");
}

function ACS_getAllowedAdministratorEmails() {
  return new Set(
    String(
      process.env.ACS_GUARDIAN_ADMIN_EMAILS || ""
    )
      .split(",")
      .map((email) =>
        email.trim().toLowerCase()
      )
      .filter(Boolean)
  );
}

function ACS_getRequestIP(req) {
  return (
    req.headers["x-forwarded-for"]
      ?.split(",")[0]
      ?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

function ACS_readBearerToken(req) {
  const authorization = String(
    req.headers.authorization || ""
  ).trim();

  const match = authorization.match(
    /^Bearer\s+(.+)$/i
  );

  return match?.[1]?.trim() || null;
}

async function ACS_writeGuardianAudit({
  userId = null,
  eventType,
  actionId = null,
  sourceIP = null,
  details = {}
}) {
  await pool.query(`
    INSERT INTO public.acs_guardian_audit_log (
      user_id,
      event_type,
      action_id,
      source_ip,
      details
    )
    VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [
    userId,
    eventType,
    actionId,
    sourceIP,
    JSON.stringify(details)
  ]);
}

async function ACS_getGuardianAdministrator(userId) {
  const allowedEmails =
    ACS_getAllowedAdministratorEmails();

  if (!allowedEmails.size) {
    const error = new Error(
      "GUARDIAN_ADMIN_EMAILS_NOT_CONFIGURED"
    );

    error.statusCode = 503;
    throw error;
  }

  const result = await pool.query(`
    SELECT
      users.user_id,
      LOWER(users.email) AS email,
      users_auth.password_hash

    FROM public.users

    JOIN public.users_auth
      ON users_auth.user_id =
         users.user_id

    WHERE users.user_id = $1

    LIMIT 1
  `, [userId]);

  if (!result.rows.length) {
    const error = new Error(
      "GUARDIAN_USER_NOT_FOUND"
    );

    error.statusCode = 403;
    throw error;
  }

  const administrator =
    result.rows[0];

  if (
    !allowedEmails.has(
      administrator.email
    )
  ) {
    const error = new Error(
      "GUARDIAN_ACCESS_FORBIDDEN"
    );

    error.statusCode = 403;
    throw error;
  }

  return administrator;
}

export async function ACS_issueGuardianAccess({
  userId,
  password,
  sourceIP = null
}) {
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 200
  ) {
    const error = new Error(
      "GUARDIAN_PASSWORD_REQUIRED"
    );

    error.statusCode = 400;
    throw error;
  }

  const administrator =
    await ACS_getGuardianAdministrator(
      userId
    );

  const passwordMatches =
    await bcrypt.compare(
      password,
      administrator.password_hash
    );

  if (!passwordMatches) {
    await ACS_writeGuardianAudit({
      userId,
      eventType:
        "GUARDIAN_ACCESS_DENIED",
      sourceIP,
      details: {
        reason: "WRONG_PASSWORD"
      }
    });

    const error = new Error(
      "GUARDIAN_REAUTHENTICATION_FAILED"
    );

    error.statusCode = 401;
    throw error;
  }

  const rawToken =
    ACS_createRawToken();

  const tokenHash =
    ACS_hashToken(rawToken);

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    /*
      Only one active Guardian access
      token per administrator.
    */

    await client.query(`
      UPDATE public.acs_guardian_access_tokens

      SET revoked_at =
        CURRENT_TIMESTAMP

      WHERE user_id = $1
        AND revoked_at IS NULL
        AND expires_at >
            CURRENT_TIMESTAMP
    `, [userId]);

    const inserted =
      await client.query(`
        INSERT INTO
          public.acs_guardian_access_tokens (
            user_id,
            token_hash,
            expires_at
          )

        VALUES (
          $1,
          $2,
          CURRENT_TIMESTAMP +
            ($3 * INTERVAL '1 minute')
        )

        RETURNING expires_at
      `, [
        userId,
        tokenHash,
        ACS_GUARDIAN_ACCESS_MINUTES
      ]);

    await client.query(`
      INSERT INTO
        public.acs_guardian_audit_log (
          user_id,
          event_type,
          source_ip,
          details
        )

      VALUES (
        $1,
        'GUARDIAN_ACCESS_GRANTED',
        $2,
        $3::jsonb
      )
    `, [
      userId,
      sourceIP,
      JSON.stringify({
        expiresAt:
          inserted.rows[0].expires_at
      })
    ]);

    await client.query("COMMIT");

    return {
      ok: true,
      accessToken: rawToken,

      expiresAt:
        inserted.rows[0].expires_at,

      expiresInMinutes:
        ACS_GUARDIAN_ACCESS_MINUTES
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ACS_requireGuardianAccess(
  req,
  res,
  next
) {
  try {
    /*
      Confirm that the current ACS user
      is still an authorized Guardian
      administrator.
    */

    await ACS_getGuardianAdministrator(
      req.user_id
    );

    const rawToken =
      ACS_readBearerToken(req);

    if (!rawToken) {
      return res.status(401).json({
        ok: false,
        error:
          "GUARDIAN_ACCESS_TOKEN_REQUIRED"
      });
    }

    const tokenHash =
      ACS_hashToken(rawToken);

    const result = await pool.query(`
      SELECT
        id,
        expires_at

      FROM
        public.acs_guardian_access_tokens

      WHERE user_id = $1
        AND token_hash = $2
        AND revoked_at IS NULL
        AND expires_at >
            CURRENT_TIMESTAMP

      LIMIT 1
    `, [
      req.user_id,
      tokenHash
    ]);

    if (!result.rows.length) {
      return res.status(401).json({
        ok: false,
        error:
          "GUARDIAN_ACCESS_TOKEN_INVALID"
      });
    }

    req.guardian_access_id =
      result.rows[0].id;

    req.guardian_access_expires_at =
      result.rows[0].expires_at;

    return next();
  } catch (error) {
    console.error(
      "[ACS Guardian] Access validation error:",
      error.message
    );

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,

        error:
          error.message ||
          "GUARDIAN_ACCESS_ERROR"
      });
  }
}

export async function ACS_revokeGuardianAccess({
  userId,
  rawToken,
  sourceIP = null
}) {
  if (!rawToken) {
    return;
  }

  const tokenHash =
    ACS_hashToken(rawToken);

  await pool.query(`
    UPDATE public.acs_guardian_access_tokens

    SET revoked_at =
      CURRENT_TIMESTAMP

    WHERE user_id = $1
      AND token_hash = $2
      AND revoked_at IS NULL
  `, [
    userId,
    tokenHash
  ]);

  await ACS_writeGuardianAudit({
    userId,
    eventType:
      "GUARDIAN_ACCESS_REVOKED",
    sourceIP,
    details: {}
  });
}

export {
  ACS_getRequestIP,
  ACS_readBearerToken,
  ACS_writeGuardianAudit
};
