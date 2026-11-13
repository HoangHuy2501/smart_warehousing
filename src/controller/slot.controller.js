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

const SlotService = require('../services/slot.service');
const { bindActor } = require('./bind-actor');

// ---- KE HANG (whs_slots) ----

const createSlot = async (req, res) => {
  bindActor(req);
  res.status(201).json(await SlotService.createSlot(req.body));
};

const assignKeeper = async (req, res) => {
  bindActor(req);
  await SlotService.assignKeeper(req.body);
  res.status(201).json({ ok: true });
};

const updateSlot = async (req, res) => {
  bindActor(req);
  await SlotService.updateSlot(req.params.code, req.body);
  res.json({ ok: true });
};

const logQrPrint = async (req, res) => {
  bindActor(req);
  await SlotService.logQrPrint(req.body);
  res.status(201).json({ ok: true });
};

module.exports = { createSlot, assignKeeper, updateSlot, logQrPrint };
