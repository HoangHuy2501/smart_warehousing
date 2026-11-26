'use strict';

const inboundController = require('./inbound.controller');
const { requireBodyFields } = require('../../middleware/validate.middleware');
const { requireAuth, requireWarehouseOperator } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');

module.exports = function registerInboundRoutes(router) {
  router.get('/lots/:id/t8-receipt', requireAuth, requireWarehouseOperator,
    asyncHandler(inboundController.previewSendStock));

  router.post(
    '/lots/:id/t8-receipt',
    requireAuth,
    requireWarehouseOperator,
    requireBodyFields(['slotCode']),
    asyncHandler(inboundController.sendStock)
  );
};
