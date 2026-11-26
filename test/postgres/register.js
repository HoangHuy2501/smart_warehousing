'use strict';

// Nạp trước app để chỉ tiến trình kiểm thử dùng PostgreSQL.
const toPostgresSql = require('./translate-sql');
const { Pool } = require('pg');
const db = require('../../src/config/db');
const { buildTestPostgresConfig } = require('./db.test.config');

const pool = new Pool(buildTestPostgresConfig().pool);

async function queryWith(client, text, params = []) {
  let index = 0;
  const statement = toPostgresSql(text).replace(/\?/g, () => '$' + (++index));
  const { rows } = await client.query(statement, params);
  return { rows };
}

db.getMode = () => 'test-postgres';
db.getDialect = () => 'pg';
db.query = (text, params) => queryWith(pool, text, params);
db.withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn((text, params) => queryWith(client, text, params));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
