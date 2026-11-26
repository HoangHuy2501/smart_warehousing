'use strict';

const OverviewService = require('./overview.service');
const { bindActor } = require('../../shared/bind-actor');

// ---- GET THEO DOMAIN (moi domain 1 endpoint rieng) ----

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
  listAccounts,
  listSlots,
  listLots,
  listIncomingPos,
  reset,
};
