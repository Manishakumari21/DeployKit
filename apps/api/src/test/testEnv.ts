import "dotenv/config";

// Enforce test database URL before any pool or database module initializes
if (process.env.DATABASE_URL && process.env.DATABASE_URL.endsWith("/deploykit")) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/deploykit$/, "/deploykit_test");
} else if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://deploykit:deploykit@localhost:5433/deploykit_test";
}

if (!process.env.DATABASE_POOL_MIN) {
  process.env.DATABASE_POOL_MIN = "0";
}
if (!process.env.DATABASE_POOL_IDLE_TIMEOUT_MS) {
  process.env.DATABASE_POOL_IDLE_TIMEOUT_MS = "1000";
}
