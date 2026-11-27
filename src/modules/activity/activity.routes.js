'use strict';

const searchController = require('../po/search.controller');
const slotController = require('../slots/slot.controller');
const { requireBodyFields } = require('../../middleware/validate.middleware');
const { requireAuth, requireWarehouseOperator } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');

// Đăng ký API nhật ký hoạt động và middleware kiểm tra quyền.
module.exports = function registerActivityRoutes(router) {
  router.get('/activity', requireAuth, asyncHandler(searchController.searchActivity));

  router.post(
    '/activity/qr-print',
    requireAuth,
    requireWarehouseOperator,
    requireBodyFields(['codes']),
    asyncHandler(slotController.logQrPrint)
  );
};
