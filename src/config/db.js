/**
 * Loi ket noi DB thong nhat cho ca hai phuong phap:
 * - SQL Server  (package `mssql`)  — che do chinh theo quy trinh team.
 * - PostgreSQL  (package `pg`)     — chi dung de TEST trong sandbox MiaoDa.
 *
 * TAT CA query trong repository viet bang placeholder `?`.
 * Ham `query()` o day se tu dong chuyen sang kieu phu thuoc phuong phap:
 *   SQL Server:  ? -> @p1, @p2, ...  (request.input co gan ro kieu du lieu)
 *   PostgreSQL:  ? -> $1, $2, ...
 *
 * Ngoai ra cung cap `withTransaction(fn)` de chay nhieu lenh trong 1 transaction:
 *   await withTransaction(async (query) => { await query('INSERT ...', [...]); });

 */

'use strict';

const { resolveDbConfig } = require('./db.config');
const { executeBatch } = require('../util/api-sql-deadline');

let state = null; // { dialect: 'mssql' | 'pg', pool }

/** Dialect hien tai ('mssql' | 'pg') — dung de build SQL phu hop (OUTPUT vs RETURNING). */
function getDialect() {
  const { mode } = resolveDbConfig();
  return mode === 'sqlserver' ? 'mssql' : 'pg';
}

/** Mode DB hien tai ('sqlserver' | 'test-postgres') — chi doc env, khong ket noi. */
function getMode() {
  return resolveDbConfig().mode;
}

/** Khoi tao pool (lazy — ket noi lan dau tien chay query moi thuc su mo ket noi). */
async function getExecutor() {
  if (!state) {
    const cfg = resolveDbConfig();
    if (cfg.mode === 'sqlserver') {
      const mssql = require('mssql');
      state = { dialect: 'mssql', pool: new mssql.ConnectionPool(cfg.mssql) };
    } else {
      const { Pool } = require('pg');
      state = { dialect: 'pg', pool: new Pool(cfg.pg.pool) };
    }
  }
  if (state.dialect === 'mssql' && !state.pool.connected) {
    await state.pool.connect();
  }
  return state;
}

/**
 * Gan kieu ro rang cho tham so SQL Server.
 * mssql khong tu suy ra kieu khi gia tri la null nen phai gan cu the.
 */
function mssqlInputType(sql, value) {
  if (value === null || value === undefined) return sql.NVarChar;
  if (typeof value === 'string') return sql.NVarChar;
  if (typeof value === 'boolean') return sql.Bit;
  if (value instanceof Date) return sql.DateTimeOffset;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? sql.Int : sql.Float;
  }
  return sql.NVarChar;
}

/** Doi chuoi `?` thanh ten tham so phu hop tung phuong phap. */
function convertPlaceholders(text, token) {
  let index = 0;
  return text.replace(/\?/g, () => token.replace('{n}', (index += 1)));
}

async function executeSqlServerRequest(request, text, params) {
  const mssql = require('mssql');
  const named = convertPlaceholders(text, '@p{n}');
  params.forEach((value, i) => {
    request.input(`p${i + 1}`, mssqlInputType(mssql, value), value);
  });
  // Duy trì bảng tạm theo session và thời hạn SQL của request HTTP.
  const result = await executeBatch(request, named);
  return { rows: result.recordset || [] };
}

/** Chay 1 cau lenh SQL voi tham so, tra ve { rows }. */
async function query(text, params = []) {
  const executor = await getExecutor();

  if (executor.dialect === 'mssql') {
    return executeSqlServerRequest(executor.pool.request(), text, params);
  }

  const numbered = convertPlaceholders(text, '${n}');
  const result = await executor.pool.query(numbered, params);
  return { rows: result.rows };
}

/**
 * Chay nhieu lenh trong 1 transaction.
 * fn nhan vao ham query rieng (buoc trong transaction) — commit neu thanh cong,
 * rollback neu co loi bat ky.
 */
async function withTransaction(fn) {
  const executor = await getExecutor();

  if (executor.dialect === 'mssql') {
    const mssql = require('mssql');
    const tx = new mssql.Transaction(executor.pool);
    await tx.begin();
    try {
      const out = await fn((text, params = []) =>
        executeSqlServerRequest(tx.request(), text, params));
      await tx.commit();
      return out;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  const client = await executor.pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(async (text, params = []) => {
      const numbered = convertPlaceholders(text, '${n}');
      const result = await client.query(numbered, params);
      return { rows: result.rows };
    });
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getMode, getDialect, query, withTransaction };
