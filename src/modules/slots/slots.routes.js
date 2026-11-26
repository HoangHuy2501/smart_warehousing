'use strict';

const overviewController = require('../dashboard/overview.controller');
const searchController = require('../po/search.controller');
const slotController = require('./slot.controller');
const { requireBodyFields } = require('../../middleware/validate.middleware');
const { requireAuth } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../util/async-handler');

module.exports = function registerSlotsRoutes(router) {
  router.get('/slots', requireAuth, asyncHandler(overviewController.listSlots));

  router.get('/slots/search', requireAuth, asyncHandler(searchController.searchSlots));

  router.post(
    '/slots',
    requireAuth,
    requireBodyFields(['warehouse', 'row', 'floor', 'position']),
    asyncHandler(slotController.createSlot)
  );

  router.post(
    '/slots/assign-keeper',
    requireAuth,
    requireBodyFields(['codes']),
    asyncHandler(slotController.assignKeeper)
  );

  router.patch(
    '/slots/:code',
    requireAuth,
    asyncHandler(slotController.updateSlot)
  );
};
