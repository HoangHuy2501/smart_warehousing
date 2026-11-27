'use strict';

const authController = require('./auth.controller');
const { requireBodyFields } = require('../../middleware/validate.middleware');
const { requireAuth } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');

// Đăng ký API xác thực và middleware kiểm tra quyền.
module.exports = function registerAuthRoutes(router) {
  router.post(
    '/auth/login',
    requireBodyFields(['empNo', 'password']),
    asyncHandler(authController.login)
  );

  router.post('/auth/logout', requireAuth, asyncHandler(authController.logout));

  router.get('/auth/me', requireAuth, asyncHandler(authController.me));
};
