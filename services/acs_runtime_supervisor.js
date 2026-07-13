import { pool } from "../db/pool.js";

const ACS_RUNTIME_LOCK_NAMESPACE = 1095783251;
const ACS_RUNTIME_HANDLERS = new Map();

let ACS_runtimeTimer = null;
let ACS_runtimePollRunning = false;

function ACS_runtimeErrorText(error) {
  return String(
    error?.stack ||
    error?.message ||
    error ||
    "UNKNOWN_ERROR"
  ).slice(0, 2000);
}

export function registerACSRuntimeJobHandler(jobKey, handler) {
  const normalizedJobKey = String(jobKey || "")
    .trim()
    .toUpperCase();

  if (
    !normalizedJobKey ||
    typeof handler !== "function"
  ) {
    throw new Error("INVALID_RUNTIME_JOB_HANDLER");
  }

  ACS_RUNTIME_HANDLERS.set(
    normalizedJobKey,
    handler
  );
}

async function ACS_runActiveRuntimeJob(jobKey) {
  const client = await pool.connect();

  let lockAcquired = false;
  let simTime = null;

  try {
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked",
      [ACS_RUNTIME_LOCK_NAMESPACE, jobKey]
    );

    lockAcquired =
      lockResult.rows[0]?.locked === true;

    if (!lockAcquired) return;

    const claimResult = await client.query(
      `
      UPDATE public.acs_runtime_jobs
      SET
        last_started_sim_time =
          acs_get_current_sim_time(),
        last_started_real_at =
          CURRENT_TIMESTAMP,
        last_status = 'RUNNING',
        last_processed_count = 0,
        last_error_code = NULL,
        last_error_detail = NULL,
        run_count = run_count + 1,
        row_version = row_version + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_key = $1
        AND enabled = TRUE
        AND execution_mode = 'ACTIVE'
        AND (
          last_started_real_at IS NULL
          OR last_started_real_at
             + interval_seconds * INTERVAL '1 second'
             <= CURRENT_TIMESTAMP
        )
      RETURNING
        *,
        acs_get_current_sim_time()
          AS current_sim_time
      `,
      [jobKey]
    );

    if (!claimResult.rows.length) return;

    const job = claimResult.rows[0];
    simTime = job.current_sim_time;

    const handler =
      ACS_RUNTIME_HANDLERS.get(jobKey);

    if (!handler) {
      const error = new Error(
        "RUNTIME_HANDLER_NOT_REGISTERED"
      );

      error.code =
        "RUNTIME_HANDLER_NOT_REGISTERED";

      throw error;
    }

    const result = await handler({
      job,
      simTime,
      pool
    });

    const rawProcessedCount = Number(
      result?.processedCount || 0
    );

    const processedCount =
      Number.isSafeInteger(rawProcessedCount) &&
      rawProcessedCount >= 0
        ? rawProcessedCount
        : 0;

    await client.query(
      `
      UPDATE public.acs_runtime_jobs
      SET
        last_cursor_sim_time = $2,
        last_completed_sim_time = $2,
        last_completed_real_at =
          CURRENT_TIMESTAMP,
        last_success_real_at =
          CURRENT_TIMESTAMP,
        last_status = 'SUCCESS',
        last_processed_count = $3,
        success_count = success_count + 1,
        row_version = row_version + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_key = $1
      `,
      [
        jobKey,
        simTime,
        processedCount
      ]
    );
  } catch (error) {
    const errorCode = String(
      error?.code ||
      error?.message ||
      "RUNTIME_JOB_FAILED"
    ).slice(0, 120);

    try {
      await client.query(
        `
        UPDATE public.acs_runtime_jobs
        SET
          last_completed_sim_time =
            COALESCE(
              $2::timestamp,
              acs_get_current_sim_time()
            ),
          last_completed_real_at =
            CURRENT_TIMESTAMP,
          last_status = 'FAILED',
          last_processed_count = 0,
          last_error_code = $3,
          last_error_detail = $4,
          failure_count = failure_count + 1,
          row_version = row_version + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE job_key = $1
        `,
        [
          jobKey,
          simTime,
          errorCode,
          ACS_runtimeErrorText(error)
        ]
      );
    } catch (statusError) {
      console.error(
        "[ACS RUNTIME] Failed to publish job error:",
        statusError
      );
    }

    console.error(
      `[ACS RUNTIME] ${jobKey} failed:`,
      error
    );
  } finally {
    if (lockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock($1, hashtext($2))",
          [
            ACS_RUNTIME_LOCK_NAMESPACE,
            jobKey
          ]
        );
      } catch (_) {}
    }

    client.release();
  }
}

async function ACS_executeActiveRuntimeJobs() {
  const dueResult = await pool.query(
    `
    SELECT job_key
    FROM public.acs_runtime_jobs
    WHERE enabled = TRUE
      AND execution_mode = 'ACTIVE'
      AND (
        last_started_real_at IS NULL
        OR last_started_real_at
           + interval_seconds * INTERVAL '1 second'
           <= CURRENT_TIMESTAMP
      )
    ORDER BY job_key
    `
  );

  await Promise.allSettled(
    dueResult.rows.map((row) =>
      ACS_runActiveRuntimeJob(
        String(row.job_key || "")
          .toUpperCase()
      )
    )
  );
}

async function ACS_executeRuntimePoll() {
  if (ACS_runtimePollRunning) return;

  ACS_runtimePollRunning = true;

  try {
    const result = await pool.query(
      `
      WITH sim_clock AS MATERIALIZED (
        SELECT acs_get_current_sim_time() AS sim_time
      ),
      due_jobs AS MATERIALIZED (
        SELECT jobs.job_key
        FROM public.acs_runtime_jobs jobs
        WHERE jobs.enabled = TRUE
          AND jobs.execution_mode = 'OBSERVE'
          AND (
            jobs.last_started_real_at IS NULL
            OR jobs.last_started_real_at
               + jobs.interval_seconds * INTERVAL '1 second'
               <= CURRENT_TIMESTAMP
          )
        ORDER BY jobs.job_key
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.acs_runtime_jobs jobs
      SET
        last_cursor_sim_time = clock.sim_time,
        last_started_sim_time = clock.sim_time,
        last_completed_sim_time = clock.sim_time,
        last_started_real_at = CURRENT_TIMESTAMP,
        last_completed_real_at = CURRENT_TIMESTAMP,
        last_success_real_at = CURRENT_TIMESTAMP,
        last_status = 'SUCCESS',
        last_processed_count = 0,
        last_error_code = NULL,
        last_error_detail = NULL,
        run_count = jobs.run_count + 1,
        success_count = jobs.success_count + 1,
        row_version = jobs.row_version + 1,
        updated_at = CURRENT_TIMESTAMP
      FROM due_jobs due
      CROSS JOIN sim_clock clock
      WHERE jobs.job_key = due.job_key
      RETURNING jobs.job_key
      `
    );

      if (result.rowCount > 0) {
      console.log(
        `[ACS RUNTIME] OBSERVE heartbeat: ${result.rowCount} jobs`
      );
    }

    await ACS_executeActiveRuntimeJobs();

    
  } catch (error) {
    console.error(
      "[ACS RUNTIME] Supervisor poll failed:",
      error
    );
  } finally {
    ACS_runtimePollRunning = false;
  }
}

export function startACSRuntimeSupervisor({
  intervalMs = Number(
    process.env.ACS_RUNTIME_POLL_INTERVAL_MS || 1000
  )
} = {}) {
  if (
    process.env.ACS_RUNTIME_SUPERVISOR_ENABLED === "false"
  ) {
    console.log(
      "[ACS RUNTIME] Supervisor disabled by environment"
    );

    return false;
  }

  if (ACS_runtimeTimer) return false;

  const normalizedIntervalMs =
    Number.isFinite(intervalMs) && intervalMs >= 1000
      ? Math.floor(intervalMs)
      : 1000;

  void ACS_executeRuntimePoll();

  ACS_runtimeTimer = setInterval(() => {
    void ACS_executeRuntimePoll();
  }, normalizedIntervalMs);

  ACS_runtimeTimer.unref?.();

  console.log(
    `[ACS RUNTIME] Supervisor started (${normalizedIntervalMs} ms)`
  );

  return true;
}

export function stopACSRuntimeSupervisor() {
  if (!ACS_runtimeTimer) return false;

  clearInterval(ACS_runtimeTimer);
  ACS_runtimeTimer = null;

  console.log("[ACS RUNTIME] Supervisor stopped");

  return true;
}
