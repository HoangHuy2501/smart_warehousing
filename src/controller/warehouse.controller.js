/**
 * Barrel giữ tương thích — routes require file này.
 *
 * Bên trong chỉ gộp lại các controller theo domain (kiến trúc Kanban),
 * KHÔNG chứa logic. Lỗi async do asyncHandler (routes) chuyển sang
 * error.middleware để giữ nguyên error shape { error: { code, ... } }.
 */

'use strict';

module.exports = Object.assign(
  {},
  require('./auth.controller'),
  require('./overview.controller'),
  require('./search.controller'),
  require('./lot.controller'),
  require('./slot.controller'),
  require('./account.controller'),
  require('./material.controller'),
  require('./reconcile.controller')
);
