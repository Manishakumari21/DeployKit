// Apply database/migrations/*.sql in lexical (numeric) order.
//
// Why this exists: the DB-backed test suites require a migrated schema, and the
// repository had no supported way to build one from empty. Compose only wires a
// volume; it never applies the SQL. Tests must not be "fixed" by weakening them,
// so a deterministic, re-runnable initializer is required before CI.
//
// Deliberately minimal, and deliberately NOT implicit:
//   * DATABASE_URL must be set explicitly. This script never guesses a
//     developer database, so it cannot migrate one by accident.
//   * Applied files are recorded in `schema_migrations`, so re-running is safe.
//     This matters because 001/002/004 are NOT idempotent (plain CREATE TABLE /
//     CREATE INDEX with no IF NOT EXISTS) and would otherwise error confusingly.
//   * Each file runs in its own transaction, so a failure leaves no half-applied
//     schema and is reported with the file that failed.
//
// Usage (from apps/api, with DATABASE_URL set to the target database):
//   npx tsx scripts/migrate.ts
//
// Re-running is expected and safe: already-applied files are skipped.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

// scripts/ -> apps/api/ -> apps/ -> <repo root>
// DEPLOYKIT_MIGRATIONS_DIR overrides the location; it exists so migration
// failure paths can be exercised against fixtures without editing the real
// migrations. Unset (the normal case) always uses the repository directory.
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

  // Serialize concurrent migration processes. Without this, two runners can
  // both read `schema_migrations`, both decide the same file is pending, and
  // both try to apply it. The lock is session-scoped and released on exit.
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