/**
 * ERROR MODEL DÙNG CHUNG CHO WORKER (Receipt + IQC).
 *
 * Chỉ 3 class nhỏ + 1 hàm phân loại lỗi DB — đủ dùng, KHÔNG 20 class:
 *   - RetryableInfrastructureError : lỗi hạ tầng tạm thời (network/Redis
 *     phụ trợ) → BullMQ technical retry.
 *   - DataIntegrityError           : dữ liệu sai/không thể xử lý thêm
 *     → KHÔNG retry (job processor bọc sang UnrecoverableError).
 *   - AmbiguousMatchError          : mapping T8 không xác định duy nhất
 *     → KHÔNG retry, KHÔNG ghi DB sai.
 *
 * classifyDbError(error) phân loại lỗi SQL Server / PostgreSQL ở MỘT chỗ
 * (không parse error.message.includes rải rác): trả về true nếu là lỗi
 * hạ tầng tạm thời đáng technical retry. Lỗi nghiệp vụ dữ liệu (vi phạm
 * FK/CHECK, chuyển đổi kiểu) → false.
 *
 * isUniqueViolation(error) nhận diện VI PHẠM UNIQUE ở một chỗ cho cả 2
 * dialect (mssql 2627/2601; pg 23505 — pg có thể giấu trong cause chain):
 * dùng cho idempotent upsert (race lành tính, không phải technical error).
 */

'use strict';

/** Lỗi hạ tầng tạm thời — đáng technical retry. */
class RetryableInfrastructureError extends Error {
    /**
     * @param {string} message
     * @param {{ cause?: unknown }} [options]
     */
    constructor(message, options = {}) {
        super(message);
        this.name = 'RetryableInfrastructureError';
        this.retryable = true;
        if (options.cause) this.cause = options.cause;
    }
}

/** Dữ liệu không hợp lệ / không tồn tại như hợp đồng — không retry. */
class DataIntegrityError extends Error {
    /**
     * @param {string} message
     * @param {{ cause?: unknown }} [options]
     */
    constructor(message, options = {}) {
        super(message);
        this.name = 'DataIntegrityError';
        this.unrecoverable = true;
        if (options.cause) this.cause = options.cause;
    }
}

/** Mapping T8 không xác định duy nhất — không retry, không ghi DB. */
class AmbiguousMatchError extends Error {
    /**
     * @param {string} message
     * @param {{ cause?: unknown }} [options]
     */
    constructor(message, options = {}) {
        super(message);
        this.name = 'AmbiguousMatchError';
        this.unrecoverable = true;
        if (options.cause) this.cause = options.cause;
    }
}

/**
 * Mã lỗi SQL Server (mssql RequestError/ConnectionError) đáng retry.
 * 1205/1204 = deadlock/victim, ETIMEOUT = timeout, ECONN* = mất kết nối.
 */
const MSSQL_RETRYABLE_CODES = new Set([
    'ETIMEOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNCLOSED',
    'ESOCKET',
    'ENOTOPEN',
]);

const MSSQL_RETRYABLE_NUMBERS = new Set([1205, 1204, 1222, -1, -2]);

/** Mã lỗi PostgreSQL (pg DatabaseError.code) đáng retry. */
const PG_RETRYABLE_CODES = new Set([
    '40001', // serialization_failure / deadlock
    '40P01', // deadlock_detected
    '53300', // too_many_connections
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '57014', // query_canceled (statement_timeout)
]);

/**
 * Nhận diện lỗi VI PHẠM UNIQUE — idempotent race lành tính.
 * mssql 2627 (constraint) / 2601 (unique index); pg 23505 (có thể nằm
 * trong cause chain của lỗi Drizzle/proxy bọc ngoài).
 * @param {unknown} error
 * @returns {boolean}
 */
function isUniqueViolation(error) {
    const anyError = /** @type {any} */ (error);
    if ([2627, 2601].includes(Number(anyError.number))) return true;
    let current = error;
    for (
        let depth = 0;
        current && typeof current === 'object' && depth < 4;
        depth += 1
    ) {
        if (String((/** @type {any} */ (current)).code) === '23505') return true;
        current = (/** @type {any} */ (current)).cause;
    }
    return false;
}

/**
 * Phân loại 1 exception từ DB/Redis/network: có đáng technical retry?
 * Unknown error → mặc định retry true (an toàn cho hạ tầng; lỗi nghiệp
 * vụ nên được service bắt và throw đúng loại từ trước).
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableError(error) {
    if (!(error instanceof Error)) return true;
    if (error instanceof RetryableInfrastructureError) return true;
    if (error instanceof DataIntegrityError) return false;
    if (error instanceof AmbiguousMatchError) return false;

    const anyError = /** @type {any} */ (error);
    const code = String(anyError.code || '');
    const number = Number(anyError.number);

    if (code.startsWith('E') && MSSQL_RETRYABLE_CODES.has(code)) return true;
    if (MSSQL_RETRYABLE_NUMBERS.has(number)) return true;
    if (PG_RETRYABLE_CODES.has(code)) return true;
    if (anyError.name === 'ConnectionError') return true;
    return true;
}

module.exports = {
    RetryableInfrastructureError,
    DataIntegrityError,
    AmbiguousMatchError,
    isRetryableError,
    isUniqueViolation,
};
