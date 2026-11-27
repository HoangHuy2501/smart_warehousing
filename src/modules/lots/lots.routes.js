'use strict';

const overviewController = require('../dashboard/overview.controller');
const lotController = require('./lot.controller');
const { requireBodyFields } = require('../../middleware/validate.middleware');
const { requireAuth, requireWarehouseOperator } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');
const { limitSqlReads } = require('../../middleware/sql-load.middleware');

// Đăng ký API lô hàng và middleware kiểm tra quyền.
module.exports = function registerLotsRoutes(router) {
  router.get('/lots', requireAuth, limitSqlReads(overviewController.listLots));

  router.post(
    '/assign',
    requireAuth,
    requireWarehouseOperator,
    requireBodyFields(['poId', 'slotCode', 'qty']),
    asyncHandler(lotController.assignShelf)
  );

  router.post(
    '/lots/:id/move',
    requireAuth,
    requireWarehouseOperator,
    requireBodyFields(['targetSlotCode', 'qty']),
    asyncHandler(lotController.moveLot)
  );

  router.post(
    '/lots/:id/undo',
    requireAuth,
    requireWarehouseOperator,
    requireBodyFields(['reason']),
    asyncHandler(lotController.undoLot)
  );
};
