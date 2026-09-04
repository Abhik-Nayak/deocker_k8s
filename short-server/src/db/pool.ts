import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

import { config } from "../config";

const url = new URL(config.databaseUrl);
const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Managed Postgres (Supabase et al.) requires TLS; local Postgres usually has none.
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

/** host:port/dbname of the configured URL, without the credentials. */
const target = `${url.hostname}:${url.port || 5432}${url.pathname}`;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens a connection and creates this service's tables if they are missing.
 * Retries a few times so a slow or briefly failing DNS lookup does not kill
 * the process on startup.
 */
export async function initSchema(attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let client;

    try {
      client = await pool.connect();
    } catch (err: any) {
      if (attempt >= attempts) throw err;
      console.log(
        `WARN:     Database connect failed (${err.code ?? err.message}), ` +
          `retry ${attempt}/${attempts - 1} in 2s`
      );
      await delay(2000);
      continue;
    }

    console.log(`INFO:     Database connected successfully: ${target}`);

    try {
      // __dirname works for both ts-node-dev (src) and the compiled build (dist).
      await client.query(readFileSync(join(__dirname, "schema.sql"), "utf8"));
      console.log("INFO:     Database schema ready (table: links)");
      return;
    } finally {
      client.release();
    }
  }
}
