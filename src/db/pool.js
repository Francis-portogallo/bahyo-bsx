// src/db/pool.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Erreur pool PostgreSQL:', err.message);
});

// Wrapper query avec logs en développement
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.NODE_ENV === 'development') {
      const duration = Date.now() - start;
      if (duration > 500) {
        console.warn(`[DB] Requête lente (${duration}ms):`, text.substring(0, 80));
      }
    }
    return result;
  } catch (err) {
    console.error('[DB] Erreur requête:', err.message, '\nSQL:', text.substring(0, 120));
    throw err;
  }
};

// Transaction helper
export const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export default pool;
