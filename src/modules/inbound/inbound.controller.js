'use strict';

const SendStockService = require('./send-stock.service');
const { bindActor } = require('../../shared/bind-actor');

// Trả dữ liệu xem trước khi gửi phiếu nhập T8.
const previewSendStock = async (req, res) => {
  res.json(await SendStockService.preview(req.params.id, {
    actorId: req.actor.id,
    slotCode: req.query.slotCode,
  }));
};

// Xác nhận yêu cầu gửi phiếu nhập T8.
const sendStock = async (req, res) => {
  bindActor(req);
  const result = await SendStockService.send(req.params.id, req.body);
  res.status(result.sheetNos.length ? 201 : 200).json(result);
};

module.exports = { previewSendStock, sendStock };
