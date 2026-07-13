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
