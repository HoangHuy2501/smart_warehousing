'use strict';

const outbound = require('./outbound.controller');
const pushDevices = require('./push-device.controller');
const { requireAuth, requireWarehouseOperator } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');
const { limitSqlReads } = require('../../middleware/sql-load.middleware');

module.exports = function registerOutboundRoutes(router) {
  router.get('/push-devices/config', requireAuth, requireWarehouseOperator, asyncHandler(pushDevices.config));

  router.post('/push-devices', requireAuth, requireWarehouseOperator, asyncHandler(pushDevices.register));

  router.delete('/push-devices', requireAuth, requireWarehouseOperator, asyncHandler(pushDevices.unregister));

  router.get('/outbound-notifications/revision', requireAuth, requireWarehouseOperator, asyncHandler(outbound.revision));

  router.get('/outbound-notifications', requireAuth, requireWarehouseOperator, limitSqlReads(outbound.list));

  router.post('/outbound-notifications/:id/confirm', requireAuth, requireWarehouseOperator, asyncHandler(outbound.confirm));
};
