/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   INDEPENDENT ADMINISTRATOR SECURITY
   ============================================================ */

import crypto from "crypto";
import bcrypt from "bcrypt";

import { pool }
  from "../db/pool.js";

const ACCESS_MINUTES = 30;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function validEmail(value) {
  return (
    value.length >= 3 &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      value
    )
  );
}

function validPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= 12 &&
    value.length <= 200
  );
}

function guardianError(
  code,
  statusCode
) {
  const error = new Error(code);

  error.statusCode = statusCode;

  return error;
}

function safeSecretEqual(
  received,
  configured
) {
  const left = Buffer.from(
    String(received || "")
  );

  const right = Buffer.from(
    String(configured || "")
  );

  return Boolean(
    left.length &&
    left.length === right.length &&
    crypto.timingSafeEqual(
      left,
      right
    )
  );
}

export function ACS_getRequestIP(req) {
  return (
    req.headers["x-forwarded-for"]
      ?.split(",")[0]
      ?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

export function ACS_readBearerToken(req) {
  const authorization = String(
    req.headers.authorization || ""
  ).trim();

  const match = authorization.match(
    /^Bearer\s+(.+)$/i
  );

  return match?.[1]?.trim() || null;
}

export async function ACS_writeGuardianAudit({
  administratorId = null,
  eventType,
  actionId = null,
  sourceIP = null,
  details = {}
}) {
  await pool.query(`
    INSERT INTO
      public.acs_guardian_audit_log (
        administrator_id,
        event_type,
        action_id,
        source_ip,
        details
      )

    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5::jsonb
    )
  `, [
    administratorId,
    eventType,
    actionId,
    sourceIP,
    JSON.stringify(details)
  ]);
}

export async function ACS_getGuardianSetupStatus() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::integer
        AS administrator_count

    FROM
      public.acs_guardian_administrators

    WHERE active = true
  `);

  const administratorCount = Number(
    result.rows[0]
      ?.administrator_count || 0
  );

  return {
    ok: true,

    setupRequired:
      administratorCount === 0,

    administratorCount
  };
}

export async function ACS_createInitialGuardianAdministrator({
  email,
  displayName,
  password,
  setupKey,
  sourceIP = null
}) {
  const configuredKey = String(
    process.env
      .ACS_GUARDIAN_SETUP_KEY || ""
  );

  if (configuredKey.length < 24) {
    throw guardianError(
      "GUARDIAN_SETUP_KEY_NOT_CONFIGURED",
      503
    );
  }

  if (
    !safeSecretEqual(
      setupKey,
      configuredKey
    )
  ) {
    throw guardianError(
      "GUARDIAN_SETUP_KEY_INVALID",
      403
    );
  }

  const cleanEmail =
    normalizeEmail(email);

  const cleanName = String(
    displayName || ""
  ).trim();

  if (!validEmail(cleanEmail)) {
    throw guardianError(
      "GUARDIAN_EMAIL_INVALID",
      400
    );
  }

  if (
    cleanName.length < 2 ||
    cleanName.length > 120
  ) {
    throw guardianError(
      "GUARDIAN_DISPLAY_NAME_INVALID",
      400
    );
  }

  if (!validPassword(password)) {
    throw guardianError(
      "GUARDIAN_PASSWORD_REQUIRES_12_CHARACTERS",
      400
    );
  }

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      SELECT pg_advisory_xact_lock(
        hashtext(
          'ACS_GUARDIAN_INITIAL_SETUP'
        )
      )
    `);

    const existing =
      await client.query(`
        SELECT
          COUNT(*)::integer AS total
        FROM
          public.acs_guardian_administrators
      `);

    if (
      Number(existing.rows[0].total) > 0
    ) {
      throw guardianError(
        "GUARDIAN_SETUP_ALREADY_COMPLETED",
        409
      );
    }

    const passwordHash =
      await bcrypt.hash(
        password,
        12
      );

    const inserted =
      await client.query(`
        INSERT INTO
          public.acs_guardian_administrators (
            email,
            display_name,
            password_hash
          )

        VALUES (
          $1,
          $2,
          $3
        )

        RETURNING
          id,
          email,
          display_name,
          created_at
      `, [
        cleanEmail,
        cleanName,
        passwordHash
      ]);

    const administrator =
      inserted.rows[0];

    await client.query(`
      INSERT INTO
        public.acs_guardian_audit_log (
          administrator_id,
          event_type,
          source_ip,
          details
        )

      VALUES (
        $1,
        'GUARDIAN_INITIAL_ADMIN_CREATED',
        $2,
        $3::jsonb
      )
    `, [
      administrator.id,
      sourceIP,

      JSON.stringify({
        email:
          administrator.email,

        displayName:
          administrator.display_name
      })
    ]);

    await client.query("COMMIT");

    return {
      ok: true,

      administrator: {
        id:
          administrator.id,

        email:
          administrator.email,

        displayName:
          administrator.display_name,

        createdAt:
          administrator.created_at
      }
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}

async function registerFailedLogin(
  administrator,
  sourceIP
) {
  const attempts =
    Number(
      administrator
        .failed_login_attempts || 0
    ) + 1;

  const lock =
    attempts >= MAX_FAILED_LOGINS;

  await pool.query(`
    UPDATE
      public.acs_guardian_administrators

    SET
      failed_login_attempts = $2,

      locked_until =
        CASE
          WHEN $3
          THEN
            CURRENT_TIMESTAMP +
            ($4 * INTERVAL '1 minute')
          ELSE locked_until
        END,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = $1
  `, [
    administrator.id,
    lock ? 0 : attempts,
    lock,
    LOCK_MINUTES
  ]);

  await ACS_writeGuardianAudit({
    administratorId:
      administrator.id,

    eventType:
      "GUARDIAN_LOGIN_REJECTED",

    sourceIP,

    details: {
      reason:
        "INVALID_CREDENTIALS",

      accountLocked:
        lock
    }
  });
}

export async function ACS_issueGuardianAccess({
  email,
  password,
  sourceIP = null
}) {
  const cleanEmail =
    normalizeEmail(email);

  if (
    !validEmail(cleanEmail) ||
    typeof password !== "string" ||
    !password.length ||
    password.length > 200
  ) {
    throw guardianError(
      "GUARDIAN_CREDENTIALS_INVALID",
      401
    );
  }

  const result = await pool.query(`
    SELECT
      id,
      email,
      display_name,
      password_hash,
      active,
      failed_login_attempts,
      locked_until

    FROM
      public.acs_guardian_administrators

    WHERE LOWER(email) = $1

    LIMIT 1
  `, [
    cleanEmail
  ]);

  const administrator =
    result.rows[0];

  if (
    !administrator ||
    !administrator.active
  ) {
    throw guardianError(
      "GUARDIAN_CREDENTIALS_INVALID",
      401
    );
  }

  if (
    administrator.locked_until &&
    new Date(
      administrator.locked_until
    ) > new Date()
  ) {
    throw guardianError(
      "GUARDIAN_ACCOUNT_TEMPORARILY_LOCKED",
      423
    );
  }

  const passwordMatches =
    await bcrypt.compare(
      password,
      administrator.password_hash
    );

  if (!passwordMatches) {
    await registerFailedLogin(
      administrator,
      sourceIP
    );

    throw guardianError(
      "GUARDIAN_CREDENTIALS_INVALID",
      401
    );
  }

  const rawToken = crypto
    .randomBytes(48)
    .toString("base64url");

  const tokenHash =
    sha256(rawToken);

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      UPDATE
        public.acs_guardian_administrators

      SET
        failed_login_attempts = 0,
        locked_until = NULL,
        last_login_at =
          CURRENT_TIMESTAMP,
        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = $1
    `, [
      administrator.id
    ]);

    await client.query(`
      UPDATE
        public.acs_guardian_access_tokens

      SET
        revoked_at =
          CURRENT_TIMESTAMP

      WHERE administrator_id = $1
        AND revoked_at IS NULL
    `, [
      administrator.id
    ]);

    const tokenResult =
      await client.query(`
        INSERT INTO
          public.acs_guardian_access_tokens (
            administrator_id,
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
        administrator.id,
        tokenHash,
        ACCESS_MINUTES
      ]);

    await client.query(`
      INSERT INTO
        public.acs_guardian_audit_log (
          administrator_id,
          event_type,
          source_ip,
          details
        )

      VALUES (
        $1,
        'GUARDIAN_ACCESS_GRANTED',
        $2,
        '{}'::jsonb
      )
    `, [
      administrator.id,
      sourceIP
    ]);

    await client.query("COMMIT");

    return {
      ok: true,
      accessToken: rawToken,

      expiresAt:
        tokenResult.rows[0]
          .expires_at,

      administrator: {
        id:
          administrator.id,

        email:
          administrator.email,

        displayName:
          administrator.display_name
      }
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
    const rawToken =
      ACS_readBearerToken(req);

    if (!rawToken) {
      return res.status(401).json({
        ok: false,
        error:
          "GUARDIAN_ACCESS_TOKEN_REQUIRED"
      });
    }

    const result = await pool.query(`
      SELECT
        token.id AS access_id,
        token.expires_at,

        administrator.id
          AS administrator_id,

        administrator.email,
        administrator.display_name

      FROM
        public.acs_guardian_access_tokens
          token

      JOIN
        public.acs_guardian_administrators
          administrator

        ON administrator.id =
           token.administrator_id

      WHERE token.token_hash = $1
        AND token.revoked_at IS NULL
        AND token.expires_at >
            CURRENT_TIMESTAMP
        AND administrator.active = true

      LIMIT 1
    `, [
      sha256(rawToken)
    ]);

    if (!result.rows.length) {
      return res.status(401).json({
        ok: false,
        error:
          "GUARDIAN_ACCESS_TOKEN_INVALID"
      });
    }

    const access =
      result.rows[0];

    req.guardian_access_id =
      access.access_id;

    req.guardian_access_expires_at =
      access.expires_at;

    req.guardian_administrator = {
      id:
        access.administrator_id,

      email:
        access.email,

      displayName:
        access.display_name
    };

    return next();

  } catch (error) {
    console.error(
      "[ACS Guardian] Access validation failed:",
      error.message
    );

    return res.status(500).json({
      ok: false,
      error:
        "GUARDIAN_ACCESS_VALIDATION_FAILED"
    });
  }
}

export async function ACS_revokeGuardianAccess({
  administratorId,
  rawToken,
  sourceIP = null
}) {
  if (!rawToken) {
    return;
  }

  await pool.query(`
    UPDATE
      public.acs_guardian_access_tokens

    SET
      revoked_at =
        CURRENT_TIMESTAMP

    WHERE administrator_id = $1
      AND token_hash = $2
      AND revoked_at IS NULL
  `, [
    administratorId,
    sha256(rawToken)
  ]);

  await ACS_writeGuardianAudit({
    administratorId,

    eventType:
      "GUARDIAN_ACCESS_REVOKED",

    sourceIP,
    details: {}
  });
}

export const ACS_hashGuardianValue =
  sha256;
