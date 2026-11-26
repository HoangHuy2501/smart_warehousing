'use strict';

const overviewController = require('./overview.controller');
const itDashboard = require('./it-dashboard.controller');
const { requireAuth, requireManager, requireIt } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');
const { limitSqlReads } = require('../../middleware/sql-load.middleware');

module.exports = function registerDashboardRoutes(router) {
  router.get('/', requireAuth, limitSqlReads(overviewController.bootstrap));

  router.get('/it/workers', requireAuth, requireIt, asyncHandler(itDashboard.workers));

  router.get('/it/audit', requireAuth, requireIt, limitSqlReads(itDashboard.audit));

  router.post(
    '/reset',
    requireAuth,
    requireManager,
    asyncHandler(overviewController.reset)
  );
};
