/* ============================================================
   ACS OCC — SYSTEM GUARDIAN
   STORAGE MONITOR
   ------------------------------------------------------------
   Read-only PostgreSQL storage observer.
   It never deletes, truncates, reindexes or vacuums anything.
   ============================================================ */

import { pool } from "../db/pool.js";

const BYTES_PER_MB = 1024 * 1024;

function ACS_toNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function ACS_bytesToMB(bytes) {
  return Number(
    (ACS_toNumber(bytes) / BYTES_PER_MB).toFixed(2)
  );
}

function ACS_round(value, decimals = 2) {
  const factor = 10 ** decimals;

  return (
    Math.round(
      ACS_toNumber(value) * factor
    ) / factor
  );
}

function ACS_getVolumeCapacityMB() {
  const configured = ACS_toNumber(
    process.env.ACS_GUARDIAN_VOLUME_CAPACITY_MB,
    500
  );

  return configured > 0
    ? configured
    : 500;
}

function ACS_getStorageSeverity(percent) {
  if (percent >= 90) {
    return "CRITICAL";
  }

  if (percent >= 75) {
    return "WARNING";
  }

  return "STABLE";
}

async function ACS_readWalBytes() {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(
          SUM(size),
          0
        )::bigint AS wal_bytes
      FROM pg_ls_waldir()
    `);

    return {
      available: true,
      bytes: ACS_toNumber(
        result.rows[0]?.wal_bytes
      )
    };
  } catch (error) {
    console.warn(
      "[ACS Guardian] WAL metric unavailable:",
      error.message
    );

    return {
      available: false,
      bytes: 0
    };
  }
}

async function ACS_readDatabaseSizes() {
  const result = await pool.query(`
    SELECT
      pg_database_size(
        current_database()
      )::bigint AS current_database_bytes,

      (
        SELECT
          COALESCE(
            SUM(
              pg_database_size(datname)
            ),
            0
          )::bigint
        FROM pg_database
      ) AS all_databases_bytes
  `);

  return {
    currentDatabaseBytes: ACS_toNumber(
      result.rows[0]?.current_database_bytes
    ),

    allDatabasesBytes: ACS_toNumber(
      result.rows[0]?.all_databases_bytes
    )
  };
}

async function ACS_readLargestTables() {
  const result = await pool.query(`
    SELECT
      namespace.nspname AS table_schema,
      relation.relname AS table_name,

      pg_total_relation_size(
        relation.oid
      )::bigint AS total_bytes,

      pg_relation_size(
        relation.oid
      )::bigint AS table_bytes,

      pg_indexes_size(
        relation.oid
      )::bigint AS index_bytes,

      GREATEST(
        relation.reltuples,
        0
      )::bigint AS estimated_rows

    FROM pg_class relation

    JOIN pg_namespace namespace
      ON namespace.oid =
         relation.relnamespace

    WHERE relation.relkind = 'r'
      AND namespace.nspname = 'public'

    ORDER BY
      pg_total_relation_size(
        relation.oid
      ) DESC

    LIMIT 20
  `);

  return result.rows.map((row) => ({
    schema: row.table_schema,
    table: row.table_name,

    totalBytes: ACS_toNumber(
      row.total_bytes
    ),

    totalMB: ACS_bytesToMB(
      row.total_bytes
    ),

    tableBytes: ACS_toNumber(
      row.table_bytes
    ),

    tableMB: ACS_bytesToMB(
      row.table_bytes
    ),

    indexBytes: ACS_toNumber(
      row.index_bytes
    ),

    indexMB: ACS_bytesToMB(
      row.index_bytes
    ),

    estimatedRows: ACS_toNumber(
      row.estimated_rows
    )
  }));
}

export async function ACS_getGuardianStorageSnapshot() {
  const capturedAt =
    new Date().toISOString();

  const [
    databaseSizes,
    wal,
    largestTables
  ] = await Promise.all([
    ACS_readDatabaseSizes(),
    ACS_readWalBytes(),
    ACS_readLargestTables()
  ]);

  const capacityMB =
    ACS_getVolumeCapacityMB();

  const databasesMB =
    ACS_bytesToMB(
      databaseSizes.allDatabasesBytes
    );

  const currentDatabaseMB =
    ACS_bytesToMB(
      databaseSizes.currentDatabaseBytes
    );

  const walMB = wal.available
    ? ACS_bytesToMB(wal.bytes)
    : null;

  const estimatedUsedMB =
    wal.available
      ? ACS_round(
          databasesMB + walMB
        )
      : null;

  const estimatedFreeMB =
    estimatedUsedMB === null
      ? null
      : ACS_round(
          Math.max(
            capacityMB - estimatedUsedMB,
            0
          )
        );

  const estimatedPercent =
    estimatedUsedMB === null
      ? null
      : ACS_round(
          (
            estimatedUsedMB /
            capacityMB
          ) * 100,
          1
        );

  return {
    ok: true,
    authority: "POSTGRESQL",
    capturedAt,

    volume: {
      source: wal.available
        ? "POSTGRES_DATABASES_PLUS_WAL_ESTIMATE"
        : "POSTGRES_DATABASES_ONLY",

      isExactRailwayVolumeMetric: false,

      capacityMB,
      estimatedUsedMB,
      estimatedFreeMB,
      estimatedPercent,

      severity:
        estimatedPercent === null
          ? "UNKNOWN"
          : ACS_getStorageSeverity(
              estimatedPercent
            ),

      note: wal.available
        ? "Estimate based on all PostgreSQL databases plus WAL."
        : "WAL could not be read. Volume estimate is incomplete."
    },

    postgresql: {
      currentDatabaseMB,
      allDatabasesMB: databasesMB,
      walAvailable: wal.available,
      walMB
    },

    largestTables
  };
}
