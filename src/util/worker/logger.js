/**
 * LOGGER CỦA WORKER (nhỏ, có cấu trúc — Receipt + IQC dùng chung).
 *
 * BE Express hiện không có logger framework; worker cần log trace được
 * 1 job theo: worker / queue / jobId / allocationId / state / durationMs.
 * Wrapper này in 1 dòng JSON mỗi entry (grep + parse được) thay vì
 * console.log rải rác. KHÔNG log password/token/secret.
 *
 * Cách dùng:
 *   const logger = createWorkerLogger('receipt-sync');
 *   logger.info('job_completed', { jobId, allocationId, state, durationMs });
 */

'use strict';

/**
 * Tạo logger có scope cố định (tên worker).
 * @param {string} scope tên worker/queue để gắn vào mỗi dòng log
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
function createWorkerLogger(scope) {
    /**
     * In 1 entry JSON: { ts, scope, level, event, ...fields }.
     * @param {'info'|'warn'|'error'} level
     * @param {string} event tên sự kiện ngắn (vd 'job_completed')
     * @param {Record<string, unknown>} fields
     */
    function emit(level, event, fields = {}) {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            scope,
            level,
            event,
            ...fields,
        });
        if (level === 'error') {
            console.error(line);
        } else {
            console.log(line);
        }
    }

    return {
        info: (event, fields) => emit('info', event, fields),
        warn: (event, fields) => emit('warn', event, fields),
        error: (event, fields) => emit('error', event, fields),
    };
}

module.exports = { createWorkerLogger };
