'use strict';

const searchController = require('./search.controller');
const { requireAuth } = require('../../middleware/auth.middleware');
const { limitSqlReads } = require('../../middleware/sql-load.middleware');

// Đăng ký API đơn mua hàng và middleware kiểm tra quyền.
module.exports = function registerPoRoutes(router) {
  router.get('/pos', requireAuth, limitSqlReads(searchController.searchPos));
};
