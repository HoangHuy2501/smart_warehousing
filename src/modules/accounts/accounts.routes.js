'use strict';

const overviewController = require('../dashboard/overview.controller');
const accountController = require('./account.controller');
const { requireBodyFields } = require('../../middleware/validate.middleware');
const { requireAuth, requireManager, requireAccountAdmin } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');

module.exports = function registerAccountsRoutes(router) {
  router.get('/accounts', requireAuth, asyncHandler(overviewController.listAccounts));

  router.get('/accounts/employee-lookup', requireAuth, requireAccountAdmin, asyncHandler(accountController.lookupEmployee));

  router.post(
    '/accounts',
    requireAuth,
    requireAccountAdmin,
    asyncHandler(accountController.createAccount)
  );

  router.patch(
    '/accounts/:id',
    requireAuth,
    requireManager,
    asyncHandler(accountController.updateAccount)
  );

  router.post(
    '/accounts/change-password',
    requireAuth,
    requireBodyFields(['newPassword', 'confirm']),
    asyncHandler(accountController.changePassword)
  );

  router.post(
    '/accounts/:id/lock',
    requireAuth,
    requireManager,
    asyncHandler(accountController.toggleAccountLock)
  );

  router.post(
    '/accounts/:id/reset-password',
    requireAuth,
    requireAccountAdmin,
    requireBodyFields(['newPassword']),
    asyncHandler(accountController.resetAccountPassword)
  );

  router.get(
    '/accounts/:id/keeper-detail',
    requireAuth,
    requireManager,
    asyncHandler(accountController.keeperDetail)
  );
};
