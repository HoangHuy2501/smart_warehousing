/**
 * CAU HINH DB TEST RIENG CUA MIAODA (chi dung trong sandbox) — KHONG phai production.
 *
 * - Sandbox khong co SQL Server, nen de test duoc day, server se ket noi vao
 *   PostgreSQL cua sandbox thong qua bien SUDA_DATABASE_URL (do platform cap).
 * - App da migrate sang schema moi: bang whs_* (Smart Warehouse) + t8_*
 *   (mock T8 ERP) nam san trong schema workspace cua app, nen khong can
 *   tien to whs3_ nua — SQL dung ten bang tran (whs_slots, t8_pur_order1, ...).
 * - Cac bang whs_* / t8_* duoc tao qua channel +db-execute cua platform vi
 *   tai khoan ket noi truc tiep khong co quyen CREATE TABLE.
 * - Khi chay o may cua team (co SQL Server), file nay khong bao gio duoc dung.
 */

'use strict';

// Schema workspace cua app tren PostgreSQL sandbox — moi bang whs_*/t8_* deu nam o day.
const TEST_SCHEMA = 'workspace_aadkzyqzwf2hs';

// Bang test dung truc tiep ten whs_*/t8_* trong schema workspace — khong con tien to.
const TEST_TABLE_PREFIX = '';

function buildTestPostgresConfig() {
  const url = new URL(process.env.SUDA_DATABASE_URL);
  // Bo sslmode trong URL de truyen tuy chon ssl rieng (certificate self-signed).
  url.searchParams.delete('sslmode');
  return {
    pool: {
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: false },
      max: 10,
      // Bang whs_*/t8_* nam trong schema workspace -> set search_path
      // de SQL dung ten bang tran (whs_slots, t8_pur_order2, ...).
      options: `-c search_path=${TEST_SCHEMA}`,
    },
    schema: TEST_SCHEMA,
    tablePrefix: TEST_TABLE_PREFIX,
  };
}

module.exports = { buildTestPostgresConfig, TEST_SCHEMA, TEST_TABLE_PREFIX };
