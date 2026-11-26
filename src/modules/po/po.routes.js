'use strict';

const searchController = require('./search.controller');
const { requireAuth } = require('../../middleware/auth.middleware');
const { limitSqlReads } = require('../../middleware/sql-load.middleware');

module.exports = function registerPoRoutes(router) {
  router.get('/pos', requireAuth, limitSqlReads(searchController.searchPos));
};
