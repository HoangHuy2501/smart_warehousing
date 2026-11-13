/**
 * Controller TÀI KHOẢN — kiến trúc Kanban (controller mỏng).
 *
 * Vai trò module: controller mỏng — đọc params/body → gọi service
 * singleton → tạo HTTP response, không chứa business logic hay SQL.
 * Domain phụ trách: tài khoản (whs_user_role) — tạo tài khoản
 * (createAccount), cập nhật (updateAccount), đổi mật khẩu
 * (changePassword), khóa/mở khóa (toggleAccountLock), reset mật khẩu
 * (resetAccountPassword), chi tiết thủ kho (keeperDetail).
 * Lỗi async do asyncHandler ở routes chuyển sang error.middleware để
 * giữ nguyên error shape { error: { code, ... } }.
 */

'use strict';

const AccountService = require('../services/account.service');
const { bindActor } = require('./bind-actor');

// ---- TAI KHOAN (whs_user_role) ----

const createAccount = async (req, res) => {
  bindActor(req);
  res.status(201).json(await AccountService.createAccount(req.body));
};

const updateAccount = async (req, res) => {
  bindActor(req);
  await AccountService.updateAccount(req.params.id, req.body);
  res.json({ ok: true });
};

const changePassword = async (req, res) => {
  bindActor(req);
  await AccountService.changePassword(req.body);
  res.status(201).json({ ok: true });
};

const toggleAccountLock = async (req, res) => {
  await AccountService.toggleAccountLock(req.params.id, req.actor.id);
  res.status(201).json({ ok: true });
};

const resetAccountPassword = async (req, res) => {
  bindActor(req);
  await AccountService.resetAccountPassword(req.params.id, req.body);
  res.status(201).json({ ok: true });
};

// Manager Keeper Detail: thong tin thu kho + ke + NPL dang quan ly.
const keeperDetail = async (req, res) => {
  res.json(await AccountService.keeperDetail(req.params.id, req.actor));
};

module.exports = {
  createAccount,
  updateAccount,
  changePassword,
  toggleAccountLock,
  resetAccountPassword,
  keeperDetail,
};
