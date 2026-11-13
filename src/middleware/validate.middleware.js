/**
 * Middleware validate input: kiem tra cac field bat buoc co trong req.body
 * truoc khi vao controller/service.
 */

'use strict';

const { ApiError } = require('../util/api-error');

function requireBodyFields(fields) {
  return (req, res, next) => {
    const missing = fields.filter(
      (field) =>
        req.body[field] === undefined ||
        req.body[field] === null ||
        req.body[field] === ''
    );
    if (missing.length > 0) {
      return next(
        new ApiError(`missing_fields: ${missing.join(', ')}`, 400, 'VALIDATION_ERROR')
      );
    }
    return next();
  };
}

module.exports = { requireBodyFields };
