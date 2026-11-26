/**
 * Bootstrap server — Smart Warehouse v3.
 * Nap env, tao HTTP server va listen tren PORT (mac dinh 3000).
 * Theo AGENTS.md: server.js chiu trach nhiem khoi dong, app.js chi cau hinh Express.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');
const app = require('./app');
const db = require('./config/db');
const { ensureStartup } = require('./modules/accounts/account-startup.service');

/**
 * Ping DB ngay khi server len de biet ket noi thanh cong hay chua.
 * - chay SELECT 1, log kem mode + dialect + thoi gian.
 * Khong chặn listen; that bai chi log loi (server van len de nhin that tu log).
 */
async function logDbConnectionStatus() {
  const mode = db.getMode();
  const startedAt = Date.now();
  try {
    await db.query('SELECT 1 AS ping');
    console.log(
      '[db] Kết nối DB THÀNH CÔNG — mode=' +
      mode +
      ', dialect=' +
      db.getDialect() +
      ' (' +
      (Date.now() - startedAt) +
      'ms)'
    );
  } catch (error) {
    console.error('[db] Kết nối DB THẤT BẠI — mode=' + mode + ' :: ' + error.message);
  }
}

// Khởi tạo tài khoản đã cấu hình trong nền, không chặn HTTP server.
ensureStartup().catch((error) => {
  console.error('[startup] repository init failed:', error.message);
});

/** Chuan hoa PORT: so, named pipe, hoac false neu khong hop le. */
function normalizePort(val) {
  const port = parseInt(val, 10);
  if (Number.isNaN(port)) return val; // named pipe
  if (port >= 0) return port; // port number
  return false;
}

/** Loi khi listen — hien thi thong bao than thien roi thoat. */
function onError(error) {
  if (error.syscall !== 'listen') throw error;
  const bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

const port = normalizePort(process.env.PORT || '3000');
app.set('port', port);

const server = http.createServer(app);
server.listen(port);
server.on('error', onError);
server.on('listening', () => {
  const addr = server.address();
  const bind = typeof addr === 'string' ? 'pipe ' + addr : 'port ' + addr.port;
  console.log('Smart Warehouse v3 listening on ' + bind);
  void logDbConnectionStatus();
});
