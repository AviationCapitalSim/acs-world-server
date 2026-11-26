import { pool } from "../db/pool.js";

export async function ACS_isWorldActive(database = pool) {
  const result = await database.query(`
    SELECT status
    FROM public.acs_world
    WHERE id = 1
  `);

  return String(result.rows[0]?.status || "")
    .trim()
    .toUpperCase() === "ON";
}
