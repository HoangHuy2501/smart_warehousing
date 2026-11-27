'use strict';

const pushDevices = require('./push-device.service');

// Trả cấu hình push cho ứng dụng khách.
function config(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json(pushDevices.config());
}

// Đăng ký thiết bị nhận thông báo.
async function register(req, res) {
    await pushDevices.register(req.actor.id, req.body);
    res.json({ ok: true });
}

// Hủy đăng ký thiết bị nhận thông báo.
async function unregister(req, res) {
    await pushDevices.unregister(req.actor.id, req.body);
    res.json({ ok: true });
}

module.exports = { config, register, unregister };
