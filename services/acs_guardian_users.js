/* ============================================================
   ACS OCC — GUARDIAN USERS AND SESSIONS
   PRIVATE READ-ONLY MONITOR
   ============================================================ */

import { pool } from "../db/pool.js";

const ACS_DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "maildrop.cc",
  "mailinator.com",
  "sharklasers.com",
  "temp-mail.org",
  "tempmail.com",
  "trashmail.com",
  "yopmail.com"
]);

function ACS_isValidEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(
    String(email || "").trim()
  );
}

function ACS_getEmailDomain(email) {
  const value =
    String(email || "")
      .trim()
      .toLowerCase();

  const separator =
    value.lastIndexOf("@");

  return separator === -1
    ? ""
    : value.slice(separator + 1);
}

function ACS_buildReviewIndicators(row) {
  const indicators = [];

  const email =
    String(row.email || "").trim();

  const domain =
    ACS_getEmailDomain(email);

  if (!ACS_isValidEmailFormat(email)) {
    indicators.push(
      "INVALID_EMAIL_FORMAT"
    );
  }

  if (
    domain &&
    ACS_DISPOSABLE_EMAIL_DOMAINS.has(
      domain
    )
  ) {
    indicators.push(
      "KNOWN_DISPOSABLE_EMAIL_DOMAIN"
    );
  }

  if (
    Number(
      row.related_account_count || 0
    ) > 1
  ) {
    indicators.push(
      "SHARED_NETWORK_REVIEW"
    );
  }

  if (
    Number(
      row.valid_session_count || 0
    ) > 1
  ) {
    indicators.push(
      "MULTIPLE_ACTIVE_SESSIONS"
    );
  }

  return indicators;
}

export async function
ACS_getGuardianUsersSnapshot() {

  const result =
    await pool.query(`
      WITH clock AS (
        SELECT
          CURRENT_TIMESTAMP
            AT TIME ZONE 'UTC'
            AS utc_now
      ),

      latest_session AS (
        SELECT DISTINCT ON (
          session.user_id
        )
          session.user_id,
          session.airline_id,
          session.created_at,
          session.expires_at,
          session.active,
          session.last_seen_at,
          session.ip_address
        FROM
          public.sessions session
        ORDER BY
          session.user_id,
          session.created_at
            DESC NULLS LAST,
          session.last_seen_at
            DESC NULLS LAST
      ),

      session_counts AS (
        SELECT
          session.user_id,

          COUNT(*) FILTER (
            WHERE
              session.active = true
              AND session.expires_at >
                clock.utc_now
          )::integer
            AS valid_session_count

        FROM
          public.sessions session

        CROSS JOIN
          clock

        GROUP BY
          session.user_id,
          clock.utc_now
      ),

      network_links AS (
        SELECT
          session.ip_address,

          COUNT(
            DISTINCT session.user_id
          )::integer
            AS related_account_count

        FROM
          public.sessions session

        WHERE
          NULLIF(
            BTRIM(
              session.ip_address
            ),
            ''
          ) IS NOT NULL

        GROUP BY
          session.ip_address
      ),

      user_rows AS (
        SELECT
          users.user_id,
          users.full_name,
          users.email,
          users.country,
          users.airline_id,

          airline.airline_name,

          users.created_at
            AS registered_at,

          latest.created_at
            AS last_login_at,

          latest.last_seen_at,
          latest.expires_at,

          COALESCE(
            counts.valid_session_count,
            0
          ) AS valid_session_count,

          COALESCE(
            links.related_account_count,
            0
          ) AS related_account_count,

          CASE
            WHEN latest.user_id IS NULL
              THEN 'INACTIVE'

            WHEN latest.active = false
              THEN 'REVOKED'

            WHEN latest.expires_at <=
              clock.utc_now
              THEN 'EXPIRED'

            WHEN
              latest.active = true
              AND latest.expires_at >
                clock.utc_now
              AND latest.last_seen_at >=
                clock.utc_now -
                INTERVAL '10 minutes'
              THEN 'ONLINE'

            ELSE 'INACTIVE'
          END AS session_status

        FROM
          public.users users

        CROSS JOIN
          clock

        LEFT JOIN
          public.airlines airline
            ON airline.airline_id =
               users.airline_id

        LEFT JOIN
          latest_session latest
            ON latest.user_id =
               users.user_id

        LEFT JOIN
          session_counts counts
            ON counts.user_id =
               users.user_id

        LEFT JOIN
          network_links links
            ON links.ip_address =
               latest.ip_address
      ),

      summary AS (
        SELECT
          (
            SELECT
              COUNT(*)::integer
            FROM
              public.users
          ) AS registered_users,

          (
            SELECT
              COUNT(
                DISTINCT session.user_id
              )::integer
            FROM
              public.sessions session
            CROSS JOIN
              clock
            WHERE
              session.active = true
              AND session.expires_at >
                clock.utc_now
          ) AS valid_session_users,

          (
            SELECT
              COUNT(
                DISTINCT session.user_id
              )::integer
            FROM
              public.sessions session
            CROSS JOIN
              clock
            WHERE
              session.active = true
              AND session.expires_at >
                clock.utc_now
              AND session.last_seen_at >=
                clock.utc_now -
                INTERVAL '10 minutes'
          ) AS online_users
      )

      SELECT
        clock.utc_now
          AS captured_at,

        summary.registered_users,
        summary.valid_session_users,
        summary.online_users,

        user_rows.*

      FROM
        clock

      CROSS JOIN
        summary

      LEFT JOIN
        user_rows
          ON true

      ORDER BY
        CASE user_rows.session_status
          WHEN 'ONLINE' THEN 1
          WHEN 'INACTIVE' THEN 2
          WHEN 'EXPIRED' THEN 3
          WHEN 'REVOKED' THEN 4
          ELSE 5
        END,

        user_rows.last_seen_at
          DESC NULLS LAST,

        user_rows.registered_at
          DESC NULLS LAST
    `);

  const firstRow =
    result.rows[0] || {};

  const users =
    result.rows
      .filter(row => row.user_id)
      .map(row => {

        const reviewIndicators =
          ACS_buildReviewIndicators(
            row
          );

        return {
          userId:
            row.user_id,

          fullName:
            row.full_name,

          email:
            row.email,

          country:
            row.country,

          airlineId:
            row.airline_id,

          airlineName:
            row.airline_name,

          registeredAt:
            row.registered_at,

          lastLoginAt:
            row.last_login_at,

          lastSeenAt:
            row.last_seen_at,

          expiresAt:
            row.expires_at,

          sessionStatus:
            row.session_status,

          validSessionCount:
            Number(
              row.valid_session_count ||
              0
            ),

          reviewStatus:
            reviewIndicators.length
              ? "REVIEW"
              : "CLEAR",

          reviewIndicators
        };
      });

  return {
    ok: true,

    capturedAt:
      firstRow.captured_at ||
      null,

    summary: {
      registeredUsers:
        Number(
          firstRow.registered_users ||
          0
        ),

      validSessionUsers:
        Number(
          firstRow.valid_session_users ||
          0
        ),

      onlineUsers:
        Number(
          firstRow.online_users ||
          0
        ),

      reviewUsers:
        users.filter(
          user =>
            user.reviewStatus ===
            "REVIEW"
        ).length
    },

    emailVerificationAvailable:
      false,

    users
  };
}
