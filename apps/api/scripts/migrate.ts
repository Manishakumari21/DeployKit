

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const MIGRATIONS_DIR = process.env.DEPLOYKIT_MIGRATIONS_DIR
  ? path.resolve(process.env.DEPLOYKIT_MIGRATIONS_DIR)
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "database",
      "migrations"
    );

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("migrate: DATABASE_URL is required; refusing to guess a database");
    return 2;
  }
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`migrate: migrations directory not found at ${MIGRATIONS_DIR}`);
    return 2;
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    console.error(
      "migrate: could not connect to the target database:",
      error instanceof Error ? error.message : "unknown error"
    );
    return 1;
  }




  const MIGRATION_LOCK_ID = 4_217_311_902;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  } catch (error) {
    console.error(
      "migrate: could not acquire the migration lock:",
      error instanceof Error ? error.message : "unknown error"
    );
    await client.end().catch(() => undefined);
    return 1;
  }

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );

    const migrationCount = await client.query<{ count: string }>(
      "SELECT count(*) FROM schema_migrations"
    );
    const applicationTableCount = await client.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name <> 'schema_migrations'`
    );
    if (
      Number(migrationCount.rows[0]?.count ?? 0) === 0 &&
      Number(applicationTableCount.rows[0]?.count ?? 0) > 0
    ) {
      console.error(
        "migrate: schema_migrations is empty but application tables exist; refusing to run. " +
          "Run `npm run db:reconcile -- --check-only`, then `npm run db:reconcile -- --apply`."
      );
      return 3;
    }

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name
      )
    );

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error(
          `migrate: FAILED applying ${file}:`,
          error instanceof Error ? error.message : "unknown error"
        );
        return 1;
      }
      count += 1;
      console.log(`migrate: applied ${file}`);
    }

    console.log(
      count === 0
        ? `migrate: already up to date (${files.length} migrations)`
        : `migrate: applied ${count} migration(s); schema now at ${files.length}`
    );
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exitCode = 1;
  }
);