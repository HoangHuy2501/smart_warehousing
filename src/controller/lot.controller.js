/**
 * Controller LÔ HÀNG — kiến trúc Kanban (controller mỏng).
 *
 * Vai trò module: controller mỏng — đọc params/body → gọi service
 * singleton → tạo HTTP response, không chứa business logic hay SQL.
 * Domain phụ trách: lô hàng (whs_slot_allocation) — gán kệ
 * (assignShelf), nhận quyết định IQC (injectDecision), di chuyển lô
 * (moveLot), hoàn tác gán kệ (undoLot).
 * Lỗi async do asyncHandler ở routes chuyển sang error.middleware để
 * giữ nguyên error shape { error: { code, ... } }.
 */

'use strict';

const LotService = require('../services/lot.service');
const SendStockService = require('../services/send-stock.service');
const { bindActor } = require('./bind-actor');

// ---- LO HANG (whs_slot_allocation) ----

const assignShelf = async (req, res) => {
  bindActor(req);
  res.status(201).json(await LotService.assignShelf(req.body));
};

const injectDecision = async (req, res) => {
  bindActor(req);
  res.status(201).json(await LotService.injectIqcResult(req.params.id, req.body));
};

const moveLot = async (req, res) => {
  bindActor(req);
  await LotService.moveLot(req.params.id, req.body);
  res.status(201).json({ ok: true });
};
const undoLot = async (req, res) => {
  bindActor(req);
  res.status(200).json(await LotService.undoAssign(req.params.id, req.body));
};

const previewSendStock = async (req, res) => {
  res.json(await SendStockService.preview(req.params.id, {
    actorId: req.actor.id,
    slotCode: req.query.slotCode,
  }));
};

const sendStock = async (req, res) => {
  bindActor(req);
  const result = await SendStockService.send(req.params.id, req.body);
  res.status(result.sheetNos.length ? 201 : 200).json(result);
};

module.exports = { previewSendStock, sendStock, assignShelf, injectDecision, moveLot, undoLot };
