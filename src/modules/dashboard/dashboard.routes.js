'use strict';

const overviewController = require('./overview.controller');
const itDashboard = require('./it-dashboard.controller');
const { requireAuth, requireManager, requireIt } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');
const { limitSqlReads } = require('../../middleware/sql-load.middleware');

// Đăng ký API giám sát vận hành và middleware kiểm tra quyền.
module.exports = function registerDashboardRoutes(router) {
  router.get('/it/workers', requireAuth, requireIt, asyncHandler(itDashboard.workers));

  router.get('/it/audit', requireAuth, requireIt, limitSqlReads(itDashboard.audit));

  router.post(
    '/reset',
    requireAuth,
    requireManager,
    asyncHandler(overviewController.reset)
  );
};
