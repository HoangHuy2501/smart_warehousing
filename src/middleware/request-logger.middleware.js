/**
 * Middleware log moi request vao terminal (method + url + status + ms) —
 * de debug 500 INTERNAL_ERROR ma terminal khong co gi:
 * - Truoc khi vao controller: log "→ GET /api/warehouse/pos?keyword=…"
 * - Sau khi response gui xong: log "← GET /api/warehouse/pos 200 (12ms)"
 * - Khi co loi 500: log day du stacktrace ngay duoi dòng 500 —
 *   loi SQL / loi JS nao gay internal_error thay het.
 *
 * Chi dung console.log/error (thu vien co san Express), khong can them
 * package. Nen tat o production thi cho vao if (process.env.LOG_REQUESTS).
 */

'use strict';

function requestLogger(req, res, next) {
    const startedAt = Date.now();
    const method = req.method;
    const url = req.originalUrl || req.url;

    console.log(`→ ${method} ${url}`);

    const originalSend = res.send;
    res.send = function patchedSend(body) {
        const ms = Date.now() - startedAt;
        const status = res.statusCode;
        const color =
            status >= 500 ? '\x1b[31m'
                : status >= 400 ? '\x1b[33m'
                    : status >= 300 ? '\x1b[36m'
                        : '\x1b[32m';
        const reset = '\x1b[0m';
        console.log(`← ${method} ${url} ${color}${status}${reset} (${ms}ms)`);

        if (status >= 500 && res._errorStack) {
            console.error(`\n[500 ERROR] ${method} ${url}`);
            console.error(res._errorStack);
            console.error('---\n');
        }

        return originalSend.call(this, body);
    };

    next();
}

function attachErrorStack(err, req, res, next) {
    if (err && err.stack && (err.httpStatus >= 500 || !err.httpStatus)) {
        res._errorStack = err.stack;
    }
    next(err);
}

module.exports = { requestLogger, attachErrorStack };
