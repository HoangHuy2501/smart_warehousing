'use strict';

const overviewController = require('../dashboard/overview.controller');
const searchController = require('./search.controller');
const { requireAuth } = require('../../middleware/auth.middleware');
const { limitSqlReads } = require('../../middleware/sql-load.middleware');

module.exports = function registerPoRoutes(router) {
  router.get('/incoming-pos', requireAuth, limitSqlReads(overviewController.listIncomingPos));

  router.get('/pos', requireAuth, limitSqlReads(searchController.searchPos));
};
