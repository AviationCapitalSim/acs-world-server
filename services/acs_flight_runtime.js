/* ============================================================
   ACS FLIGHT RUNTIME — SERVER OPERATIONAL AUTHORITY
   ------------------------------------------------------------
   Owns:
   - Flight occurrence generation
   - Dispatch and maintenance holds
   - En-route and arrival transitions
   - Flight settlement orchestration

   Does not own:
   - Route planning
   - Weekly schedule editing
   - Maintenance lifecycle
   - Frontend rendering
   - ACS simulated time

   Authorities:
   - PostgreSQL
   - acs_get_current_sim_time()
   ============================================================ */

import { pool } from "../db/pool.js";

function ACS_normalizeHorizonDays(value) {
  const days = Number(value);

  if (!Number.isInteger(days)) {
    return 8;
  }

  return Math.min(
    21,
    Math.max(1, days)
  );
}
