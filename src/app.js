/**
 * Express app — Smart Warehouse v3.
 * Layering theo smart_whs_v3/AGENTS.md:
 *   app.js (nhan request) -> routes -> middleware -> controller -> services -> repository.
 * Tat ca API warehouse mount tai /api/warehouse, khop contract shared/api.interface.ts.
 * Chi cau hinh Express — viec listen nam o src/server.js.
 */

'use strict';

const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');

const warehouseRoutes = require('./routes/warehouse.routes');
const { notFoundHandler, errorHandler } = require('./middleware/error.middleware');
const { requestLogger, attachErrorStack } = require('./middleware/request-logger.middleware');
const { buildSwaggerSpec } = require('../docs/swagger.spec');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Log moi request (method + url + status + thoi gian) — giup debug 500
// ma terminal khong hien thi gi. Xem ket qua o tab Terminal VS Code.
app.use(requestLogger);

app.get('/healthz', function (req, res) {
  res.json({ ok: true });
});
app.use('/api/warehouse', warehouseRoutes);

// Swagger UI — de team test truc tiep tat ca API warehouse tren trinh duyet.
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(buildSwaggerSpec()));
// Ban than tai lieu OpenAPI (json) — cho import vao Postman / Insomnia neu can.
app.get('/api-docs.json', function (req, res) {
  res.json(buildSwaggerSpec());
});

app.use(notFoundHandler);
app.use(attachErrorStack);
app.use(errorHandler);

module.exports = app;
