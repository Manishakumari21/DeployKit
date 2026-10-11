import pg from 'pg';
import { redactForLog } from '../agents/edgeJobSchema.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (error) => {
  console.error(
    'Database pool error:',
    error instanceof Error ? redactForLog(error.message) : 'Unknown database error'
  );
});

export default pool;