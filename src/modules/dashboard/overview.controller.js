'use strict';

const OverviewService = require('./overview.service');
const { bindActor } = require('../../shared/bind-actor');

// ---- GET THEO DOMAIN (moi domain 1 endpoint rieng) ----

// Trả danh sách tài khoản kho.
const listAccounts = async (req, res) => {
  res.json(await OverviewService.listAccounts(req.query));
};

// Trả danh sách kệ kho.
const listSlots = async (req, res) => {
  res.json(await OverviewService.listSlots(req.query));
};

// Trả danh sách lô hàng đã gán kệ.
const listLots = async (req, res) => {
  res.json(await OverviewService.listLots(req.query));
};

// Chuyển yêu cầu đặt lại dữ liệu đến service.
const reset = async (req, res) => {
  bindActor(req);
  res.status(201).json(await OverviewService.reset());
};

module.exports = {
  listAccounts,
  listSlots,
  listLots,
  reset,
};
