/**
 * Wrapper cho async controller: bat Promise rejection va chuyen sang error handler
 * (Express 4 khong tu dong bat loi async).
 */

'use strict';

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
