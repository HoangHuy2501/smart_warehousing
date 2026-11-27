/**
 * Controller AUTH / SESSION — kiến trúc Kanban (controller mỏng).
 *
 * Vai trò module: controller mỏng — đọc params/body → gọi service
 * singleton → tạo HTTP response, không chứa business logic hay SQL.
 * Domain phụ trách: đăng nhập (login), đăng xuất (logout), hồ sơ
 * phiên hiện tại (me).
 * Lỗi async do asyncHandler ở routes chuyển sang error.middleware để
 * giữ nguyên error shape { error: { code, ... } }.
 */

'use strict';

const AuthService = require('./auth.service');
const AccountService = require('../accounts/account.service');

// ---- AUTH / SESSION ----

// Xác thực thông tin đăng nhập và trả phiên.
const login = async (req, res) => {
  res.json(await AuthService.login(req.body.empNo, req.body.password));
};

// Kết thúc phiên đăng nhập hiện tại.
const logout = (req, res) => {
  AuthService.logout(req.get('x-auth-token'));
  res.json({ ok: true });
};

// Trả hồ sơ người dùng của phiên hiện tại.
const me = async (req, res) => {
  const account = await AuthService.me(req.actor);
  // 2026-10-21 (change request): KEEPER profile mo rong them kho + NPL
  // dam nhan (read-only, lay tu authenticated session — khong nhan tu FE).
  if (account.role === 'KEEPER') {
    const sections = await AccountService.keeperSections(req.actor.id);
    return res.json({ account, ...sections });
  }
  res.json({ account });
};

module.exports = { login, logout, me };
