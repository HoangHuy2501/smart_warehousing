/**
 * Controller OVERVIEW — kiến trúc Kanban (controller mỏng).
 *
 * Vai trò module: controller mỏng — đọc params/body → gọi service
 * singleton → tạo HTTP response, không chứa business logic hay SQL.
 * Domain phụ trách: bootstrap tổng quan + các endpoint GET tách theo
 * domain (tài khoản, kệ, lô, PO đến) + reset demo (đang tắt).
 * Lỗi async do asyncHandler ở routes chuyển sang error.middleware để
 * giữ nguyên error shape { error: { code, ... } }.
 */

'use strict';

const OverviewService = require('../services/overview.service');
const { bindActor } = require('./bind-actor');

const bootstrap = async (req, res) => {
  res.json(await OverviewService.bootstrap());
};

// ---- GET THEO DOMAIN (tach bootstrap — moi domain 1 endpoint rieng) ----

const listAccounts = async (req, res) => {
  res.json(await OverviewService.listAccounts(req.query));
};

const listSlots = async (req, res) => {
  res.json(await OverviewService.listSlots(req.query));
};

const listLots = async (req, res) => {
  res.json(await OverviewService.listLots(req.query));
};

const listIncomingPos = async (req, res) => {
  res.json(await OverviewService.listIncomingPos(req.query));
};

// ---- RESET DEMO (dang tat — xem overview.service.js) ----

const reset = async (req, res) => {
  bindActor(req);
  res.status(201).json(await OverviewService.reset());
};

module.exports = {
  bootstrap,
  listAccounts,
  listSlots,
  listLots,
  listIncomingPos,
  reset,
};
