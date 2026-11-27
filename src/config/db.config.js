'use strict';

// Đọc cấu hình kết nối SQL Server từ biến môi trường.
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

// Kiểm tra chế độ cơ sở dữ liệu và trả cấu hình SQL Server.
function resolveDbConfig() {
  const mode = String(process.env.DB_MODE || 'sqlserver').trim().toLowerCase();
  if (mode && mode !== 'sqlserver') throw new Error('DB_MODE phải là sqlserver');
  return { mode: 'sqlserver', mssql: resolveMssqlConfig() };
}

module.exports = { resolveDbConfig };
