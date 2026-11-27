'use strict';

const lotController = require('../lots/lot.controller');
const { requireBodyFields } = require('../../middleware/validate.middleware');
const { requireAuth, requireWarehouseOperator } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');

// Đăng ký API kiểm tra IQC và middleware kiểm tra quyền.
module.exports = function registerIqcRoutes(router) {
  router.post(
    '/lots/:id/iqc',
    requireAuth,
    requireWarehouseOperator,
    requireBodyFields(['decision']),
    asyncHandler(lotController.injectDecision)
  );
};
