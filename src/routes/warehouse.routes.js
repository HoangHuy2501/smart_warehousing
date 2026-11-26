'use strict';

const express = require('express');

const router = express.Router();

require('../modules/auth/auth.routes')(router);
require('../modules/dashboard/dashboard.routes')(router);
require('../modules/accounts/accounts.routes')(router);
require('../modules/slots/slots.routes')(router);
require('../modules/lots/lots.routes')(router);
require('../modules/outbound/outbound.routes')(router);
require('../modules/po/po.routes')(router);
require('../modules/activity/activity.routes')(router);
require('../modules/reconciliation/reconciliation.routes')(router);
require('../modules/iqc/iqc.routes')(router);
require('../modules/inbound/inbound.routes')(router);
require('../modules/materials/materials.routes')(router);

module.exports = router;
