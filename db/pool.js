import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL in environment");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  },

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

pool.on("error", (err) => {
  console.error(
    "ACS POSTGRESQL IDLE CONNECTION ERROR — connection discarded:",
    err.message
  );
});

pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error(
      "ACS POSTGRESQL CLIENT CONNECTION ERROR — connection discarded:",
      err.message
    );
  });
});

