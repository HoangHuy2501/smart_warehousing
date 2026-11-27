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

const AccountService = require('./account.service');
const { bindActor } = require('../../shared/bind-actor');

// ---- TAI KHOAN (whs_user_role) ----

// Tra hồ sơ nhân viên theo mã.
const lookupEmployee = async (req, res) => {
  res.json(await AccountService.lookupEmployee(req.query.employeeCode, req.actor.id));
};

// Tạo tài khoản kho theo quyền của người thao tác.
const createAccount = async (req, res) => {
  res.status(201).json(await AccountService.createAccount({
    actorId: req.actor.id,
    employeeCode: req.body?.employeeCode,
    role: req.body?.role,
    password: req.body?.password,
  }));
};

// Cập nhật thông tin tài khoản kho.
const updateAccount = async (req, res) => {
  bindActor(req);
  await AccountService.updateAccount(req.params.id, req.body);
  res.json({ ok: true });
};

// Đổi mật khẩu của tài khoản đang đăng nhập.
const changePassword = async (req, res) => {
  bindActor(req);
  await AccountService.changePassword(req.body);
  res.status(201).json({ ok: true });
};

// Đổi trạng thái khóa tài khoản.
const toggleAccountLock = async (req, res) => {
  await AccountService.toggleAccountLock(req.params.id, req.actor.id);
  res.status(201).json({ ok: true });
};

// Đặt lại mật khẩu cho tài khoản được chọn.
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
  lookupEmployee,
  updateAccount,
  changePassword,
  toggleAccountLock,
  resetAccountPassword,
  keeperDetail,
};
