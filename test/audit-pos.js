'use strict';
/**
 * AUDIT 2026-10-19 — Chung minh hanh vi GET /pos tren sandbox PG.
 * KHONG sua code san pham. Chay: node test/audit-pos.js
 */

process.env.DB_MODE = 'test-postgres';
process.env.DB_TABLE_PREFIX = 'whs3_';

const { buildSeed } = require('../src/config/seed-data');

async function main() {
  const db = require('../src/config/db');
  // 1) Kiem tra seed con du lieu (khong reset — doc thu du lieu hien tai)
  const check = await db.query('SELECT COUNT(*)::int AS n FROM whs3_t8_pur_order2', []);
  console.log('[data] t8_pur_order2 rows =', check.rows[0].n);

  const PoRepository = require('../src/repository/sql/po.repository');

  const t = (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  })();
  const addDays = (base, days) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
  const ranges = {
    windowStart: addDays(t, -10).toISOString(),
    windowEnd: addDays(t, 11).toISOString(),
    od12Start: addDays(t, -60).toISOString(),
    od23Start: addDays(t, -90).toISOString(),
  };

  const cases = [
    ['A. /pos bucket=today, KHONG keyword', { bucket: 'today', page: 1, pageSize: 15, ...ranges }],
    ['B. /pos bucket=today, keyword PO number (PO-250)', { bucket: 'today', keyword: 'PO-250', page: 1, pageSize: 15, ...ranges }],
    ['C. /pos bucket=null, keyword goods_no (ITEM-SPCC)', { bucket: null, keyword: 'ITEM-SPCC', page: 1, pageSize: 15, ...ranges }],
    ['D. /pos bucket=null, keyword made_lot (LOT-25014A)', { bucket: null, keyword: 'LOT-25014A', page: 1, pageSize: 15, ...ranges }],
    ['E. countPurchaseBuckets (khong keyword)', { page: 1, pageSize: 1, ...ranges }],
    ['F. countPurchaseBuckets (keyword ITEM-SPCC)', { page: 1, pageSize: 1, keyword: 'ITEM-SPCC', ...ranges }],
  ];

  for (const [label, opts] of cases) {
    // Chay 2 lan: lan 1 cold, lan 2 warm
    const results = [];
    for (let i = 0; i < 2; i += 1) {
      const started = process.hrtime.bigint();
      let out;
      if (label.startsWith('E.') || label.startsWith('F.')) {
        const buckets = await PoRepository.countPurchaseBuckets(opts);
        out = { buckets };
      } else {
        out = await PoRepository.searchPurchasesWithBuckets(opts);
      }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      results.push({ ms: ms.toFixed(1), out });
    }
    const cold = results[0];
    const warm = results[1];
    console.log(`\n=== ${label} ===`);
    console.log(`  cold: ${cold.ms}ms | warm: ${warm.ms}ms`);
    if (label.startsWith('E.') || label.startsWith('F.')) {
      console.log('  buckets =', JSON.stringify(warm.out.buckets));
    } else {
      const rows = warm.out.rows;
      console.log(`  total = ${warm.out.total}, rows tra ve = ${rows.length}`);
      for (const r of rows.slice(0, 6)) {
        console.log(
          `    id=${r.id} po=${r.poNumber} goods=${r.itemCode} lot=${r.lotNo ?? 'NULL'} qty=${r.qty} assignedQty=${r.assignedQty}`
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('AUDIT FAIL:', error);
    process.exit(1);
  });
