/**
 * Loi nghiep vu: message chua ma loi on dinh (VD: 'no_permission') de FE map sang i18n.
 * httpStatus: 400 (mac dinh), 403 (no_permission), 404 (not_found)...
 */

'use strict';

class ApiError extends Error {
  constructor(message, httpStatus = 400, code = 'BUSINESS_ERROR') {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

module.exports = { ApiError };
