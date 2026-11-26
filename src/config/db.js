/** Kết nối SQL Server và giữ transaction cho repository. */

'use strict';

const { resolveDbConfig } = require('./db.config');
const { executeBatch } = require('../util/api-sql-deadline');

let pool;

function getMode() {
  return resolveDbConfig().mode;
}

function getDialect() {
  return 'mssql';
}

async function getPool() {
  if (!pool) {
    const { ConnectionPool } = require('mssql');
    pool = new ConnectionPool(resolveDbConfig().mssql);
  }
  return pool.connected ? pool : pool.connect();
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
  const connection = await getPool();
  return executeSqlServerRequest(connection.request(), text, params);
}

/**
 * Chay nhieu lenh trong 1 transaction.
 * fn nhan vao ham query rieng (buoc trong transaction) — commit neu thanh cong,
 * rollback neu co loi bat ky.
 */
async function withTransaction(fn) {
  const connection = await getPool();
  const { Transaction } = require('mssql');
  const tx = new Transaction(connection);
  await tx.begin();
  try {
    const result = await fn((text, params = []) =>
      executeSqlServerRequest(tx.request(), text, params));
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

module.exports = { getMode, getDialect, query, withTransaction };
