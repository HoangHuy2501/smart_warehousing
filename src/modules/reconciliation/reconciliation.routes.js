'use strict';

const reconcileController = require('./reconcile.controller');
const { requireAuth } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');

module.exports = function registerReconciliationRoutes(router) {
  router.get(
    '/reconcile-issues',
    requireAuth,
    asyncHandler(reconcileController.listReconcileIssues)
  );
};
