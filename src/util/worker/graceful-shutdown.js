/**
 * GRACEFUL SHUTDOWN CHUNG CHO WORKER PROCESS (Receipt + IQC dùng chung).
 *
 * Bắt SIGTERM/SIGINT đúng MỘT lần cho cả process; các module đăng ký
 * handler qua registerShutdownHandler(fn) theo thứ tự ngược (close
 * Worker trước, Queue sau, Redis cuối). Active transaction của SQL pool
 * không bị cắt đột ngột: handler worker.close() chờ job đang chạy xong
 * (mặc định BullMQ close chờ active jobs, timeout tổng 10s bên dưới).
 *
 * Luồng: SIGTERM/SIGINT → chạy handler tuần tự (mỗi handler tối đa 10s)
 * → process.exit(0). Lỗi trong 1 handler vẫn chạy handler kế tiếp.
 */

'use strict';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const { createWorkerLogger } = require('./logger');
const logger = createWorkerLogger('shutdown');

/** @type {Array<{ name: string, fn: Function }>} */
const handlers = [];
let registered = false;
let shuttingDown = false;

/**
 * Đăng ký 1 bước dọn dẹp khi shutdown (gọi lúc khởi tạo module worker).
 * @param {string} name tên bước (vd 'close_worker', 'close_queue')
 * @param {() => Promise<void>} fn async dọn dẹp
 */
function registerShutdownHandler(name, fn) {
    handlers.push({ name, fn });
    if (!registered) {
        registered = true;
        process.once('SIGTERM', runShutdown);
        process.once('SIGINT', runShutdown);
    }
}

/**
 * Chạy handler với timeout — không để 1 bước treo cả process.
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function runWithTimeout(name, fn) {
    return Promise.race([
        Promise.resolve()
            .then(fn)
            .catch((error) =>
                logger.error('shutdown_step_failed', {
                    name,
                    message: error && error.message,
                })
            ),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
}

/** Thực thi toàn bộ shutdown (chạy đúng 1 lần). */
async function runShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_start', { steps: handlers.length });
    // Ngược thứ tự đăng ký: closeWorker (đăng ký đầu) chạy TRƯỚC, Redis cuối.
    const ordered = [...handlers].reverse();
    for (const { name, fn } of ordered) {
        logger.info('shutdown_step', { name });
        await runWithTimeout(name, fn);
    }
    logger.info('shutdown_done');
    process.exit(0);
}

module.exports = { registerShutdownHandler };
