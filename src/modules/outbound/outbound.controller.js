'use strict';

const outbound = require('./outbound.service');
const { err } = require('../../shared/shared');
const { readOutboundRevision, publishOutboundRevision } = require('../../util/worker/outbound-revision');

// Trả danh sách thông báo xuất kho.
async function list(req, res) {
    res.json(await outbound.notifications(req.actor));
}

// Xác nhận lượt lấy hàng xuất kho.
async function confirm(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) err('invalid_outbound_id');
    const { status, changed } = await outbound.confirm(id, req.actor);
    res.json({ status });
    if (changed) void publishOutboundRevision();
}

// Trả phiên bản thông báo để FE biết khi nào cần tải lại.
async function revision(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json(await readOutboundRevision());
}

module.exports = { list, confirm, revision };
