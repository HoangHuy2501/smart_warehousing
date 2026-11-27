'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const apiContext = new AsyncLocalStorage();
const SQL_TIMEOUT_MS = 45000;

// Thiết lập giới hạn thời gian chạy SQL cho request API.
function withApiSqlDeadline(req, res, next) {
  apiContext.run(true, next);
}

// Thực thi batch SQL theo giới hạn thời gian hiện tại.
async function executeBatch(request, text, timeoutMs = SQL_TIMEOUT_MS) {
  if (!apiContext.getStore()) return request.batch(text);

  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    request.cancel();
  }, timeoutMs);

  try {
    return await request.batch(text);
  } catch (error) {
    const driverCode = error.originalError?.code ?? error.code;
    if (driverCode === 'ETIMEOUT' || (expired && driverCode === 'ECANCEL')) {
      const timeout = new Error('SQL query reached the API deadline', { cause: error });
      timeout.code = 'ETIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withApiSqlDeadline, executeBatch };
