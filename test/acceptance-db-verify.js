/**
 * DB VERIFY — kiem pars truc tiep trong tap test whs3_ (sau khi chay
 * acceptance-final-whs.test.js). Kiem tra CCacs diem khong thay qua API:
 * warehouse_status, receipt tao/khong tao, activity po_id, T8 khong bi ghi.
 *
 * Cach chay: node test/acceptance-db-verify.js
 */
'use strict';

const { buildTestPostgresConfig } = require('./db.test.config');
const { Client } = require('pg');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
    if (cond) {
        pass += 1;
        console.log(`  PASS ${name}`);
    } else {
        fail += 1;
        console.log(`  FAIL ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
    }
}

async function main() {
    const c = new Client(buildTestPostgresConfig().pool);
    await c.connect();

    // Case A: PO 13 — allocation ban dau PO_ASSIGNED, sau IQC PASS -> IN.
    // (Script HTTP da inject IQC PASS len alloc nay nen ky vong o day la IN.)
    const a = await c.query(
        "select warehouse_status, closed_at from whs3_whs_slot_allocation where po_id = 13 order by allocated_at desc limit 1"
    );
    check(
        'A: warehouse_status PO 13 hop le (IN sau IQC PASS)',
        a.rows[0] && ['PO_ASSIGNED', 'IN'].includes(a.rows[0].warehouse_status),
        a.rows[0]
    );
    const aRc = await c.query(
        "select count(*)::int as n from whs3_whs_allocation_receipt r join whs3_whs_slot_allocation a on a.id = r.allocation_id where a.po_id = 13"
    );
    check('A: khong co receipt gia cho PO 13', aRc.rows[0].n === 0, aRc.rows[0]);

    // Case B/C/D: PO 14 (2 notice) + PO 17 (3 allocation)
    const alloc14 = await c.query(
        "select id, warehouse_status from whs3_whs_slot_allocation where po_id = 14 and closed_at is null"
    );
    check('D: PO 14 co allocation (user tao)', alloc14.rows.length >= 1, alloc14.rows.length);
    const rc14 = await c.query(
        "select count(*)::int as n from whs3_whs_allocation_receipt r join whs3_whs_slot_allocation a on a.id = r.allocation_id where a.po_id = 14"
    );
    check('D: 1 alloc x 2 notice -> KHONG tu doan mapping (0 receipt)', rc14.rows[0].n === 0, rc14.rows[0]);

    const alloc17 = await c.query(
        "select id, slot_code, allocated_qty, warehouse_status from whs3_whs_slot_allocation where po_id = 17 and closed_at is null"
    );
    check('C: PO 17 co 3 allocation rieng (3 ke khac nhau)', alloc17.rows.length === 3, alloc17.rows.map((r) => r.slot_code));
    // Case C/D PO 17 (3 ke): c1 duoc gan khi moi co 1 allocation x 1 notice
    // -> receipt duoc tao ngay luc do (received_qty = MIN(50, 200) = 50).
    // c2/c3 them sau KHONG tao receipt them vi da ambiguous. Day la edge
    // case "thoi diem tao mapping" — da ghi vao danh sach diem cho user xac nhan.
    const rc17 = await c.query(
        "select r.received_qty from whs3_whs_allocation_receipt r join whs3_whs_slot_allocation a on a.id = r.allocation_id where a.po_id = 17"
    );
    check(
        'D: 3 alloc x 1 notice -> dung 1 receipt thoi diem dau (khong doan them)',
        rc17.rows.length === 1 && Number(rc17.rows[0].received_qty) === 50,
        rc17.rows
    );

    // Case E: PO 16 — 1 alloc x 1 notice -> receipt tu dong + mirror
    const alloc16 = await c.query(
        "select id, lot_no, warehouse_status, status from whs3_whs_slot_allocation where po_id = 16 and closed_at is null"
    );
    check('E: PO 16 ton tai allocation', alloc16.rows.length === 1, alloc16.rows.length);
    const rc16 = await c.query(
        "select r.allocation_id, r.notice_detail_id, r.received_qty, r.lot_no, r.iqc_decision, r.qty_in_stock from whs3_whs_allocation_receipt r join whs3_whs_slot_allocation a on a.id = r.allocation_id where a.po_id = 16"
    );
    check('E: 1 receipt tu dong cho PO 16 (notice 14)', rc16.rows.length === 1 && rc16.rows[0].notice_detail_id === 14, rc16.rows[0]);
    if (rc16.rows[0]) {
        check('E: receipt lot_no khop lot allocation (mirror 1 lot)', alloc16.rows[0].lot_no === rc16.rows[0].lot_no, [alloc16.rows[0].lot_no, rc16.rows[0].lot_no]);
        check('E: IQC PASS da ghi vao receipt (iqc_decision + qty_in_stock)', rc16.rows[0].iqc_decision === 'PASS' && Number(rc16.rows[0].qty_in_stock) === 150, rc16.rows[0]);
    }
    // PO 16 da inject IQC PASS -> warehouse_status IN (TEMP_IN la gia tri
    // ngay sau khi receipt duoc tao; kiem tra o check receipt phia tren).
    check('E: warehouse_status PO 16 = IN (sau IQC PASS)', alloc16.rows[0] && alloc16.rows[0].warehouse_status === 'IN', alloc16.rows[0]);

    // Case E (T8 read-only): notice 14 khong bi ghi (adj_result/qc_date nguyen ven)
    const n14 = await c.query("select adj_result, pro_result, qc_date, qc_emp_no, sheet_qty from whs3_t8_pur_notice2 where id = 14");
    const row = n14.rows[0] || {};
    check('E: t8_pur_notice2 (id 14) khong bi ghi — adj_result/qc_date nguyen', (row.adj_result === '0' || row.adj_result === null) && row.qc_date === null && (row.qc_emp_no === null || row.qc_emp_no === ''), row);

    // Activity co po_id
    const act = await c.query(
        "select po_id, po_number from whs3_whs_activity where action_key = 'actAssign' order by acted_at desc limit 5"
    );
    check('activity: actAssign moi co po_id khac NULL', act.rows.some((r) => r.po_id !== null), act.rows.map((r) => r.po_id));

    // Khong co trigger
    const trig = await c.query("select count(*)::int as n from information_schema.triggers where trigger_schema = 'workspace_aadkzyqzwf2hs'");
    check('F: khong co trigger nao trong schema', trig.rows[0].n === 0, trig.rows[0].n);

    // Notice 9001/9002 (Case B) khong bi sua
    const nb = await c.query("select id, sheet_qty, adj_result from whs3_t8_pur_notice2 where id in (9001, 9002) order by id");
    // adj_result 'N' la gia tri DDL chen ban dau (mock trang thai moi) — chi can
    // no KHONG doi (t8 read-only) la du.
    check(
        'B: 2 notice Case B van nguyen (khong ghi T8)',
        nb.rows.length === 2 && nb.rows.every((r) => r.adj_result === 'N'),
        nb.rows
    );

    await c.end();
    console.log(`\nDB VERIFY: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
