/**
 * REDIS CONNECTION CHUNG CHO BULLMQ (Receipt + IQC dùng chung).
 *
 * Quy tắc #12: KHÔNG new IORedis(...) rải nhiều file — tất cả connection
 * Redis của worker đều đi qua đây. Mỗi process (API producer / worker)
 * tạo ĐÚNG 1 connection theo loại, cached lazy:
 *   - getWorkerRedisConnection()   : cho Worker + Queue trong worker
 *     process — BẮT BUỘC maxRetriesPerRequest: null (BullMQ blocking
 *     client; nếu để mặc định, khi Redis ngắt quãng lệnh BLPOP sẽ throw
 *     thay vì chờ kết nối lại).
 *   - getProducerRedisConnection() : cho Queue trong API process — FAIL
 *     FAST (#12): enableOfflineQueue:false + maxRetriesPerRequest:1 — khi
 *     Redis down, lệnh enqueue bị reject NGAY thay vì xếp hàng trong RAM vô
 *     hạn (caller nhận false → log → sweep khôi phục). Worker process thì
 *     khác semantics: được phép reconnect lâu dài (blocking client).
 *
 * Xử lý sự kiện error/reconnecting/close MỘT lần, KHÔNG spam log: chỉ
 * log lần reconnect đầu và khi error thật (dedupe theo trạng thái).
 */

'use strict';

const IORedis = require('ioredis');
const workerConfig = require('../../config/worker.config');
const { createWorkerLogger } = require('./logger');

const logger = createWorkerLogger('redis');

/** Cache connection theo loại — 1 connection mỗi loại mỗi process. */
let workerConnection = null;
let producerConnection = null;
let lastReconnectLoggedAt = 0;

/**
 * Gắn handler sự kiện cho 1 connection (mỗi connection chỉ gắn 1 lần).
 * @param {import('ioredis').Redis} connection
 * @param {string} role tên vai trò để log ('worker' | 'producer')
 */
function attachConnectionHandlers(connection, role) {
    connection.on('error', (error) => {
        logger.error('redis_error', { role, message: error.message });
    });
    connection.on('reconnecting', () => {
        // Dedupe: chỉ log 1 lần mỗi 30s để không spam khi Redis down lâu.
        const now = Date.now();
        if (now - lastReconnectLoggedAt > 30_000) {
            lastReconnectLoggedAt = now;
            logger.warn('redis_reconnecting', { role });
        }
    });
    connection.on('end', () => {
        logger.warn('redis_connection_closed', { role });
    });
}

/**
 * Tạo options ioredis từ worker.config.
 * @param {{ maxRetriesPerRequest: number | null, enableOfflineQueue?: boolean,
 *           connectTimeout?: number }} retryOption
 * @returns {import('ioredis').RedisOptions}
 */
function buildOptions(retryOption) {
    const options = {
        host: workerConfig.redis.host,
        port: workerConfig.redis.port,
        password: workerConfig.redis.password,
        db: workerConfig.redis.db,
        maxRetriesPerRequest: retryOption.maxRetriesPerRequest,
        // enableOfflineQueue mặc định true (xếp lệnh vào RAM khi mất kết nối) —
        // producer PHẢI tắt để fail fast; worker giữ true (blocking client).
        enableOfflineQueue: retryOption.enableOfflineQueue !== false,
        connectTimeout: retryOption.connectTimeout || 10_000,
        enableReadyCheck: true,
        lazyConnect: false,
    };
    // Redis managed/HA bắt buộc TLS — bật qua REDIS_TLS=true (ioredis tls:{}
    // dùng mặc định TLS của client; tùy CA riêng thì mở rộng sau).
    if (workerConfig.redis.tls) {
        options.tls = {};
    }
    return options;
}

/**
 * Connection dùng cho BullMQ Worker (blocking client).
 * @returns {import('ioredis').Redis}
 */
function getWorkerRedisConnection() {
    if (!workerConnection) {
        workerConnection = new IORedis(buildOptions({ maxRetriesPerRequest: null }));
        attachConnectionHandlers(workerConnection, 'worker');
    }
    return workerConnection;
}

/**
 * Connection dùng cho Queue producer trong API process (enqueue).
 * @returns {import('ioredis').Redis}
 */
function getProducerRedisConnection() {
    if (!producerConnection) {
        // Producer fail-fast (#12): Redis down → lệnh enqueue reject ngay
        // (enableOfflineQueue:false, chỉ 1 retry/request) → API không treo,
        // không tích lũy lệnh trong RAM. Enqueue fail = log + sweep khôi phục.
        producerConnection = new IORedis(
            buildOptions({
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
                connectTimeout: 5_000,
            })
        );
        attachConnectionHandlers(producerConnection, 'producer');
    }
    return producerConnection;
}

/**
 * Đóng connection do process này sở hữu (chỉ gọi từ graceful shutdown).
 * @returns {Promise<void>}
 */
async function closeRedisConnections() {
    const closing = [];
    if (workerConnection) closing.push(workerConnection.quit().catch(() => { }));
    if (producerConnection) {
        closing.push(producerConnection.quit().catch(() => { }));
    }
    await Promise.all(closing);
    workerConnection = null;
    producerConnection = null;
}

module.exports = {
    getWorkerRedisConnection,
    getProducerRedisConnection,
    closeRedisConnections,
};
