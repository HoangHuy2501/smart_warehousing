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
const { ensureStartup } = require('./repository');

/**
 * Ping DB ngay khi server len de biet ket noi thanh cong hay chua.
 * - memory: chi log la dang chay in-memory (khong can DB).
 * - sqlserver / test-postgres: chay SELECT 1, log kem mode + dialect + thoi gian.
 * Khong chặn listen; that bai chi log loi (server van len de nhin that tu log).
 */
async function logDbConnectionStatus() {
  const mode = db.getMode();
  if (mode === 'memory') {
    console.log('[db] DB_MODE=memory — chạy dữ liệu in-memory, không cần kết nối DB');
    return;
  }
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

// Khoi dong repository layer (chen tai khoan test raw — idempotent, xem
// repository/index.js). Chay nen khong chan listen; loi chi duoc log.
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
