'use strict';

const SendStockService = require('./send-stock.service');
const { bindActor } = require('../../shared/bind-actor');

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

module.exports = { previewSendStock, sendStock };
