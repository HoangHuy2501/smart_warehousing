/**
 * Error handler tap trung: khong lo stack trace / loi SQL ra client.
 * Dinh dang response loi dong bo voi FE:
 *   { error: { code: 'BUSINESS_ERROR', message: <ma loi>, timestamp: <ms> } }
 */

'use strict';

const debug = require('debug')('smart-whs-v3:error');
const { ApiError } = require('../util/api-error');

function notFoundHandler(req, res, next) {
  next(new ApiError('not_found', 404));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof ApiError) {
    return res.status(err.httpStatus).json({
      error: { code: err.code, message: err.message, timestamp: Date.now() },
    });
  }
  debug('Unhandled error:', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'internal_error', timestamp: Date.now() },
  });
}

module.exports = { notFoundHandler, errorHandler };
