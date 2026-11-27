'use strict';

const dashboard = require('./it-dashboard.service');

// Trả tình trạng các worker và hàng đợi kho.
async function workers(req, res) {
    res.json(await dashboard.workers(req.actor.id));
}

// Trả nhật ký kiểm toán theo bộ lọc.
async function audit(req, res) {
    res.json(await dashboard.audit(req.query, req.actor.id));
}

module.exports = { workers, audit };
