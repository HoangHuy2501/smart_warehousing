'use strict';

const outbound = require('../services/outbound.service');
const { err } = require('../services/shared');

async function list(req, res) {
    res.json(await outbound.notifications(req.actor));
}

async function confirm(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) err('invalid_outbound_id');
    res.json(await outbound.confirm(id, req.actor));
}

module.exports = { list, confirm };
