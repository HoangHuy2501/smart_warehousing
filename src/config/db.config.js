/**
 * Cau hinh nguon du lieu cua server (SQL Server / PostgreSQL test / in-memory).
 *
 * Thu tu uu tien:
 *   1. DB_MODE=sqlserver (+ cac bien MSSQL_*)  -> SQL Server (moi truong that cua team).
 *   2. DB_MODE=test-postgres, hoac tu dong phat hien SUDA_DATABASE_URL
 *      -> PostgreSQL test rieng cua MiaoDa trong sandbox (xem test/db.test.config.js).
 *   3. Con lai -> in-memory (mock trong RAM, mat du lieu khi restart server).
 *
 * Cac bien SQL Server (quy trinh chuan cua team):
 *   MSSQL_HOST            ten may / IP cua SQL Server
 *   MSSQL_PORT            port (mac dinh 1433)
 *   MSSQL_DATABASE        ten database
 *   MSSQL_USER            tai khoan dang nhap
 *   MSSQL_PASSWORD        mat khau
 *   MSSQL_ENCRYPT         co ma hoa ket noi khong (true/false, mac dinh true)
 *   MSSQL_TRUST_SERVER_CERT  bo qua xac minh certificate khi dev local (mac dinh true)
 *   DB_TABLE_PREFIX       tien to ten bang neu can tach biet trong cung DB (mac dinh rong)
 */

'use strict';

const { buildTestPostgresConfig } = require('../../test/db.test.config');

function resolveMssqlConfig() {
  return {
    server: process.env.MSSQL_HOST,
    port: Number(process.env.MSSQL_PORT || 1433),
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    requestTimeout: Number(process.env.MSSQL_REQUEST_TIMEOUT || 45000),
    options: {
      encrypt: String(process.env.MSSQL_ENCRYPT || 'true') === 'true',
      trustServerCertificate:
        String(process.env.MSSQL_TRUST_SERVER_CERT || 'true') === 'true',
    },
  };
}

/**
 * Giai cau hinh DB theo thu tu uu tien.
 * Luu y: ham chi doc env, KHONG tao ket noi — viec ket noi lam o db.js.
 */
function resolveDbConfig() {
  const mode = String(process.env.DB_MODE || '').trim().toLowerCase();
  if (mode === 'memory') return { mode: 'memory' };

  if (mode === 'sqlserver' || (!mode && process.env.MSSQL_HOST)) {
    return { mode: 'sqlserver', mssql: resolveMssqlConfig() };
  }

  if (mode === 'test-postgres' || (!mode && process.env.SUDA_DATABASE_URL)) {
    return { mode: 'test-postgres', pg: buildTestPostgresConfig() };
  }

  return { mode: 'memory' };
}

module.exports = { resolveDbConfig };
