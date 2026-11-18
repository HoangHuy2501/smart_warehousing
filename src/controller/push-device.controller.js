'use strict';

const pushDevices = require('../services/push-device.service');

function config(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json(pushDevices.config());
}

async function register(req, res) {
    await pushDevices.register(req.actor.id, req.body);
    res.json({ ok: true });
}

async function unregister(req, res) {
    await pushDevices.unregister(req.actor.id, req.body);
    res.json({ ok: true });
}

module.exports = { config, register, unregister };
