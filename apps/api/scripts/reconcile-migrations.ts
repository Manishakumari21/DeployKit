import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const MIGRATION_LOCK_ID = 4_217_311_902;
const BASELINE_SCHEMA_HASH =
  "c29c363a046bcbbcb1145bf02a3b5aa2d0b1f54457b5ada1e85d45156acbbd01";
const FULL_SCHEMA_HASH =
  "3113e932a2c5a32c75c4669c2d69e50f847c718a0401b5c2a4b6aadb66cff9ba";

const BASELINE_MIGRATIONS = [
  "001_create_projects.sql",
  "002_deployment_engine.sql",
  "003_job_leases.sql",
  "004_release_runtime.sql",
  "005_phase03_hardening.sql",
  "006_rollback_target.sql",
  "007_github_integration.sql",
  "008_webhook_delivery_lease.sql",
  "009_project_gateways.sql",
  "010_deployment_logs.sql",
  "011_users.sql",
  "012_project_members.sql",
  "013_sessions.sql",
  "014_auth_rate_limits.sql",
  "015_custom_domains.sql",
  "016_custom_domain_tls.sql",
  "017_edge_agents.sql",
  "018_edge_build_phase.sql",
  "020_project_build_config.sql",
  "021_incidents.sql",
];

const PENDING_MIGRATIONS = ["019_gateway_sync_queue.sql"];

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

const SCHEMA_QUERY = `
WITH public_tables AS (
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
)
SELECT jsonb_build_object(
  'tables', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', t.table_name,
      'columns', (
        SELECT jsonb_agg(jsonb_build_object(
          'name', c.column_name,
          'data_type', c.data_type,
          'udt_name', c.udt_name,
          'nullable', c.is_nullable,
          'default', c.column_default,
          'max_length', c.character_maximum_length,
          'numeric_precision', c.numeric_precision,
          'numeric_scale', c.numeric_scale
        ) ORDER BY c.ordinal_position)
        FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = t.table_name
      )
    ) ORDER BY t.table_name)
    FROM public_tables t
  ),
  'enums', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', ty.typname,
      'labels', (
        SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
        FROM pg_enum e
        WHERE e.enumtypid = ty.oid
      )
    ) ORDER BY ty.typname)
    FROM pg_type ty
    WHERE ty.typnamespace = 'public'::regnamespace AND ty.typtype = 'e'
  ),
  'constraints', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', co.conname,
      'table', co.conrelid::regclass::text,
      'type', co.contype,
      'definition', pg_get_constraintdef(co.oid)
    ) ORDER BY co.conname)
    FROM pg_constraint co
    WHERE co.connamespace = 'public'::regnamespace
  ),
  'indexes', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', i.indexname,
      'table', i.tablename,
      'definition', i.indexdef
    ) ORDER BY i.indexname)
    FROM pg_indexes i
    WHERE i.schemaname = 'public'
  ),
  'triggers', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', tr.tgname,
      'table', tr.tgrelid::regclass::text,
      'definition', pg_get_triggerdef(tr.oid)
    ) ORDER BY tr.tgname)
    FROM pg_trigger tr
    WHERE tr.tgrelid IN (
      SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
    ) AND NOT tr.tgisinternal
  ),
  'functions', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', p.proname,
      'definition', pg_get_functiondef(p.oid)
    ) ORDER BY p.proname)
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
  ),
  'sequences', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', s.sequence_name,
      'data_type', s.data_type,
      'start_value', s.start_value,
      'minimum_value', s.minimum_value,
      'maximum_value', s.maximum_value,
      'increment', s.increment,
      'cycle_option', s.cycle_option
    ) ORDER BY s.sequence_name)
    FROM information_schema.sequences s
    WHERE s.sequence_schema = 'public'
  )
)::text AS schema_text
`;

type MigrationRow = {
  name: string;
};

type MigrationColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("reconcile: DATABASE_URL is required; refusing to guess a database");
    return 2;
  }
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`reconcile: migrations directory not found at ${MIGRATIONS_DIR}`);
    return 2;
  }

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const checkOnly = args.includes("--check-only");
  const unknownArgs = args.filter((arg) => arg !== "--apply" && arg !== "--check-only");
  if (apply && checkOnly) {
    console.error("reconcile: choose either --apply or --check-only");
    return 2;
  }
  if (unknownArgs.length > 0) {
    console.error(`reconcile: unknown argument(s): ${unknownArgs.join(", ")}`);
    return 2;
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const expected = [...BASELINE_MIGRATIONS, ...PENDING_MIGRATIONS].sort();
  const missingFiles = expected.filter((name) => !files.includes(name));
  const unclassifiedFiles = files.filter((name) => !expected.includes(name));
  if (missingFiles.length > 0) {
    console.error(`reconcile: expected migration file(s) missing: ${missingFiles.join(", ")}`);
    return 1;
  }
  if (unclassifiedFiles.length > 0) {
    console.error(
      `reconcile: unclassified migration file(s): ${unclassifiedFiles.join(", ")}; update the baseline before running`
    );
    return 1;
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    console.error(
      "reconcile: could not connect to the target database:",
      error instanceof Error ? error.message : "unknown error"
    );
    return 1;
  }

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  } catch (error) {
    console.error(
      "reconcile: could not acquire the migration lock:",
      error instanceof Error ? error.message : "unknown error"
    );
    await client.end().catch(() => undefined);
    return 1;
  }

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");

    const migrationTable = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists"
    );
    if (!migrationTable.rows[0]?.exists) {
      throw new Error("schema_migrations is missing; run the migration runner on a fresh database first");
    }

    const columns = await client.query<MigrationColumn>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'
       ORDER BY ordinal_position`
    );
    const expectedColumns: Array<{
      name: string;
      dataType: string;
      nullable: string;
      defaultValue: string | null;
    }> = [
      { name: "name", dataType: "text", nullable: "NO", defaultValue: null },
      {
        name: "applied_at",
        dataType: "timestamp with time zone",
        nullable: "NO",
        defaultValue: "now()",
      },
    ];
    const structureMatches =
      columns.rows.length === expectedColumns.length &&
      expectedColumns.every((expectedColumn, index) => {
        const actual = columns.rows[index];
        return (
          actual.column_name === expectedColumn.name &&
          actual.data_type === expectedColumn.dataType &&
          actual.is_nullable === expectedColumn.nullable &&
          (actual.column_default ?? null) === expectedColumn.defaultValue
        );
      });
    if (!structureMatches) {
      throw new Error("schema_migrations has an unexpected structure; refusing to reconcile");
    }

    const primaryKey = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       WHERE c.connamespace = 'public'::regnamespace
         AND c.conrelid = 'public.schema_migrations'::regclass
         AND c.contype = 'p'`
    );
    if (primaryKey.rows.length !== 1 || primaryKey.rows[0]?.definition !== "PRIMARY KEY (name)") {
      throw new Error("schema_migrations has an unexpected primary key; refusing to reconcile");
    }

    const schemaResult = await client.query<{ schema_text: string }>(SCHEMA_QUERY);
    const schemaText = schemaResult.rows[0]?.schema_text;
    if (!schemaText) {
      throw new Error("schema inspection returned no schema");
    }
    const schemaHash = createHash("sha256").update(schemaText).digest("hex");
    const schemaState =
      schemaHash === BASELINE_SCHEMA_HASH
        ? "baseline"
        : schemaHash === FULL_SCHEMA_HASH
          ? "full"
          : "unknown";
    if (schemaState === "unknown") {
      throw new Error(
        `schema hash ${schemaHash} does not match the confirmed baseline or full schema; refusing to reconcile`
      );
    }

    const currentRows = await client.query<MigrationRow>(
      "SELECT name FROM schema_migrations ORDER BY name"
    );
    const current = new Set(currentRows.rows.map((row) => row.name));
    const unknownRows = [...current].filter((name) => !expected.includes(name));
    if (unknownRows.length > 0) {
      throw new Error(
        `schema_migrations contains unknown migration(s): ${unknownRows.join(", ")}; refusing to reconcile`
      );
    }

    const missingBaseline = BASELINE_MIGRATIONS.filter((name) => !current.has(name));
    const missingPending = PENDING_MIGRATIONS.filter((name) => !current.has(name));
    const pendingRecorded = PENDING_MIGRATIONS.some((name) => current.has(name));

    if (schemaState === "baseline" && pendingRecorded) {
      throw new Error(
        "schema_migrations records 019_gateway_sync_queue.sql but its schema is absent; refusing to reconcile"
      );
    }

    console.log(`reconcile: schema hash=${schemaHash}`);
    console.log(`reconcile: schema state=${schemaState}`);
    console.log(`reconcile: confirmed baseline migrations=${BASELINE_MIGRATIONS.length}`);
    console.log(
      `reconcile: pending migrations=${missingPending.length === 0 ? "none" : missingPending.join(", ")}`
    );
    if (missingBaseline.length > 0) {
      console.log(`reconcile: would add ${missingBaseline.length} baseline migration record(s):`);
      for (const name of missingBaseline) {
        console.log(`  - ${name}`);
      }
    } else {
      console.log("reconcile: baseline migration records already present");
    }
    if (schemaState === "full" && missingPending.length > 0) {
      console.log("reconcile: 019 is applied but untracked; run `npm run db:migrate` to record it");
    }

    if (!apply) {
      console.log("reconcile: check-only; no changes made");
      await client.query("ROLLBACK");
      return 0;
    }

    if (missingBaseline.length === 0) {
      console.log("reconcile: no changes needed");
      await client.query("ROLLBACK");
      return 0;
    }

    const inserted = await client.query<MigrationRow>(
      `INSERT INTO schema_migrations (name)
       SELECT name FROM unnest($1::text[]) AS name
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [missingBaseline]
    );
    const insertedNames = inserted.rows.map((row) => row.name).sort();
    console.log(`reconcile: inserted ${insertedNames.length} migration record(s):`);
    for (const name of insertedNames) {
      console.log(`  - ${name}`);
    }

    const verified = await client.query<{ count: string }>(
      "SELECT count(*) FROM schema_migrations WHERE name = ANY($1::text[])",
      [missingBaseline]
    );
    if (Number(verified.rows[0]?.count ?? 0) !== missingBaseline.length) {
      throw new Error("migration record verification failed after insert");
    }

    await client.query("COMMIT");
    return 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(
      "reconcile:",
      error instanceof Error ? error.message : "unknown error"
    );
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : "Reconciliation failed");
    process.exitCode = 1;
  }
);
