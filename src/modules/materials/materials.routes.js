'use strict';

const materialController = require('./material.controller');
const { requireBodyFields } = require('../../middleware/validate.middleware');
const { requireAuth, requireManager } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');

// Đăng ký API nguyên liệu và middleware kiểm tra quyền.
module.exports = function registerMaterialsRoutes(router) {
  router.get(
    '/materials',
    requireAuth,
    requireManager,
    asyncHandler(materialController.listMaterials)
  );

  router.post(
    '/materials/assign-keeper',
    requireAuth,
    requireManager,
    requireBodyFields(['goodsNo', 'keeperEmpNo']),
    asyncHandler(materialController.assignMaterialKeeper)
  );

  router.post(
    '/materials/end-assignment',
    requireAuth,
    requireManager,
    requireBodyFields(['goodsNo', 'keeperEmpNo']),
    asyncHandler(materialController.endMaterialAssignment)
  );

  router.get(
    '/materials/:goodsNo/history',
    requireAuth,
    requireManager,
    asyncHandler(materialController.materialHistory)
  );
};
