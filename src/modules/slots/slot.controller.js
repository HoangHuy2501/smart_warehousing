/**
 * Controller KỆ HÀNG — kiến trúc Kanban (controller mỏng).
 *
 * Vai trò module: controller mỏng — đọc params/body → gọi service
 * singleton → tạo HTTP response, không chứa business logic hay SQL.
 * Domain phụ trách: kệ hàng (whs_slots) — tạo kệ (createSlot), gán
 * thủ kho (assignKeeper), cập nhật kệ (updateSlot), ghi log in QR
 * (logQrPrint).
 * Lỗi async do asyncHandler ở routes chuyển sang error.middleware để
 * giữ nguyên error shape { error: { code, ... } }.
 */

'use strict';

const SlotService = require('./slot.service');
const { bindActor } = require('../../shared/bind-actor');

// ---- KE HANG (whs_slots) ----

// Xử lý yêu cầu tạo kệ mới.
const createSlot = async (req, res) => {
  bindActor(req);
  res.status(201).json(await SlotService.createSlot(req.body));
};

// Gán thủ kho phụ trách kệ.
const assignKeeper = async (req, res) => {
  bindActor(req);
  await SlotService.assignKeeper(req.body);
  res.status(201).json({ ok: true });
};

// Xử lý yêu cầu cập nhật kệ.
const updateSlot = async (req, res) => {
  bindActor(req);
  await SlotService.updateSlot(req.params.code, req.body);
  res.json({ ok: true });
};

// Ghi nhận thao tác in QR cho kệ.
const logQrPrint = async (req, res) => {
  bindActor(req);
  await SlotService.logQrPrint(req.body);
  res.status(201).json({ ok: true });
};

module.exports = { createSlot, assignKeeper, updateSlot, logQrPrint };
