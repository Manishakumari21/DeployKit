import pg from 'pg';
import { redactForLog } from '../agents/edgeJobSchema.js';
import { parsePoolConfig } from './poolConfig.js';

const { Pool } = pg;

const config = parsePoolConfig();

const pool = new Pool({
  connectionString: config.connectionString,
  max: config.max,
  min: config.min,
  connectionTimeoutMillis: config.connectionTimeoutMillis,
  idleTimeoutMillis: config.idleTimeoutMillis,
  maxLifetimeSeconds: config.maxLifetimeSeconds,
});

pool.on('error', (error) => {
  console.error(
    'Database pool error:',
    error instanceof Error ? redactForLog(error.message) : 'Unknown database error'
  );
});

export default pool;