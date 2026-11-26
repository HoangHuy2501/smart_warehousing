'use strict';

const dashboard = require('./it-dashboard.service');

async function workers(req, res) {
    res.json(await dashboard.workers(req.actor.id));
}

async function audit(req, res) {
    res.json(await dashboard.audit(req.query, req.actor.id));
}

module.exports = { workers, audit };
