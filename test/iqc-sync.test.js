/**
 * IQC SYNC TARGETED TEST (cases A–W) — CHỈ chạy với DB_MODE=test-postgres.
 *
 * Quy tắc vàng: IQC chạy TRƯỚC GRN — KHÔNG test nào được tạo
 * pur_in1 / pur_in2 (GRN) để làm in_qty = sheet_qty. Các case
 * PASS / EXEMPT / FAIL_ACCEPT / multi-allocation PASS / partial phải
 * chứng minh IQC MATCHED ngay khi in_qty = 0 (chưa có GRN).
 *
 * Không cần HTTP server / Redis: gọi thẳng
 *   repository/sql/iqc-sync.repository.js (primitive đọc candidate + state)
 *   services/iqc-sync.service.js (business sync 1 allocation)
 * sau khi seed dữ liệu trực tiếp vào PostgreSQL sandbox.
 *
 * Dữ liệu test dùng tiền tố riêng (iqct- / IQCT-) và được dọn sạch ở cuối
 * (kể cả khi fail giữa chừng) — không đụng bảng thật của app.
 *
 * Cách chạy:
 *   cd smart_whs_v3
 *   DB_MODE=test-postgres node test/iqc-sync.test.js
 */

'use strict';

process.env.DB_MODE = process.env.DB_MODE || 'test-postgres';

const fs = require('fs');
const path = require('path');

const db = require('../src/config/db');
const { TABLES } = require('../src/repository/sql/tables');
const IqcSyncRepository = require('../src/repository/sql/iqc-sync.repository');
const iqcSyncService = require('../src/services/iqc-sync.service');
const OverviewService = require('../src/services/overview.service');
const { manualIqcDisabled } = require('../src/services/lot.service');

const STATES = iqcSyncService.IQC_SYNC_STATES;

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
    if (cond) {
        pass += 1;
        console.log(`  PASS ${name}`);
    } else {
        fail += 1;
        console.log(
            `  FAIL ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''
            }`
        );
    }
}

// ==================== SEED HELPERS ====================

const NOTICE_ID_BASE = 990000;
let noticeSeq = 0;
let allocationSeq = 0;
let receiptSeq = 0;

let slotCode = null;
let createdSlot = false;
let empNo = null;

// File source IQC — dùng cho case S/T (static guard: không IN_STOCK,
// không ghi T8).
const IQC_SOURCE_FILES = [
    'src/services/iqc-sync.service.js',
    'src/services/jobs/iqc-sync.job.js',
    'src/worker/iqc-sync.worker.js',
    'src/repository/sql/iqc-sync.repository.js',
    'src/queues/iqc-sync.queue.js',
].map((file) => path.join(__dirname, '..', file));

/** Tìm (hoặc tạo) 1 kệ dùng cho allocation test. */
async function ensureSlot() {
    if (slotCode) return slotCode;
    const { rows } = await db.query(
        `SELECT code FROM ${TABLES.slots} ORDER BY code LIMIT 1`
    );
    if (rows.length > 0) {
        slotCode = rows[0].code;
        return slotCode;
    }
    slotCode = 'IQCT-SLOT';
    await db.query(
        `INSERT INTO ${TABLES.slots}
      (code, warehouse, slot_row, floor, position, keeper_emp_no, locked, is_full, active)
     VALUES (?, 'GIF3', 'I1', '01', '01', NULL, FALSE, FALSE, TRUE)`,
        [slotCode]
    );
    createdSlot = true;
    return slotCode;
}

/** emp_no hợp lệ (nếu DB có ràng buộc) — fallback account test. */
async function ensureEmpNo() {
    if (empNo) return empNo;
    const { rows } = await db.query(
        `SELECT emp_no FROM ${TABLES.userRole} LIMIT 1`
    );
    empNo = rows.length > 0 ? rows[0].emp_no : 'TEST-KPR';
    return empNo;
}

/**
 * Seed 1 dòng pur_notice2 (identity + trạng thái IQC).
 * @param {{ sheetQty: number, returnQty?: number, adjResult?: string,
 *   proResult?: string | null, qcDate?: string | null }} options
 */
async function createNotice(options) {
    const seq = (noticeSeq += 1);
    const id = NOTICE_ID_BASE + seq;
    const notice = {
        id,
        sheetNo: `IQCT-${seq}`,
        sheetId: id,
        purNo: `IQCT-PO-${seq}`,
        purId: id,
        goodsNo: `IQCT-G${seq}`,
        madeLot: `IQCT-LOT-${seq}`,
    };
    await db.query(
        `INSERT INTO ${TABLES.notice2}
      (id, sheet_id, sheet_no, pur_no, pur_id, goods_no, unit_no, st_no,
       sheet_qty, check_qty, bad_qty, return_qty, qc_level, adj_result,
       pro_result, qc_date, qc_user_no, qc_emp_no, made_lot, sheet_lot)
     VALUES (?, ?, ?, ?, ?, ?, 'KG', '01', ?, 0, 0, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
            notice.id,
            notice.sheetId,
            notice.sheetNo,
            notice.purNo,
            notice.purId,
            notice.goodsNo,
            Number(options.sheetQty),
            Number(options.returnQty || 0),
            options.adjResult === undefined ? '0' : options.adjResult,
            options.proResult === undefined ? null : options.proResult,
            options.qcDate === undefined ? null : options.qcDate,
            notice.madeLot,
            notice.madeLot,
        ]
    );
    return notice;
}

/**
 * Seed 1 allocation. Mỗi allocation dùng po_id riêng để không vướng
 * unique index (po_id, slot_code) WHERE closed_at IS NULL.
 * @param {{ status?: string, warehouseStatus?: string, allocatedQty?: number,
 *   hasWarning?: boolean, closedAt?: string | null, goodsNo?: string }} [options]
 */
async function createAllocation(options = {}) {
    const seq = (allocationSeq += 1);
    const id = `iqct-al-${seq}`;
    const code = await ensureSlot();
    const allocatedBy = await ensureEmpNo();
    await db.query(
        `INSERT INTO ${TABLES.allocation}
      (id, po_id, goods_no, lot_no, warehouse_status, slot_code,
       allocated_qty, status, iqc_decision, has_warning, qty_in_stock,
       qty_return, qty_aod, last_iqc_at, allocated_by_emp_no, allocated_at,
       closed_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        [
            id,
            NOTICE_ID_BASE + 20000 + seq,
            options.goodsNo || 'IQCT-GOODS',
            options.warehouseStatus || 'TEMP_IN',
            code,
            Number(options.allocatedQty || 100),
            options.status || 'WAITING_IQC',
            Boolean(options.hasWarning),
            allocatedBy,
            new Date().toISOString(),
            options.closedAt === undefined ? null : options.closedAt,
        ]
    );
    return id;
}

/**
 * Seed 1 receipt mapping (allocation ↔ notice).
 * @param {{ allocationId: string, noticeId: number, receivedQty: number,
 *   lotNo: string | null, iqcDecision?: string | null }} options
 */
async function addReceipt(options) {
    const seq = (receiptSeq += 1);
    const id = `iqct-rc-${seq}`;
    await db.query(
        `INSERT INTO ${TABLES.receipt}
      (id, allocation_id, notice_detail_id, received_qty, lot_no,
       iqc_decision, qty_in_stock, qty_return, qty_aod, has_warning, qc_date,
       confirmed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, FALSE, NULL, NOW(), NOW())`,
        [
            id,
            options.allocationId,
            Number(options.noticeId),
            Number(options.receivedQty),
            options.lotNo === undefined ? null : options.lotNo,
            options.iqcDecision === undefined ? null : options.iqcDecision,
        ]
    );
    return id;
}

// ==================== READ HELPERS ====================

async function readAllocation(allocationId) {
    return IqcSyncRepository.findAllocationForIqc(allocationId);
}

async function readReceipts(allocationId) {
    return IqcSyncRepository.findReceiptsForAllocation(allocationId);
}

/** Dựng đủ fixture 1 notice + 1 allocation + 1 receipt (full lot). */
async function fixtureSingle(options) {
    const notice = await createNotice(options.notice);
    const allocationId = await createAllocation(options.allocation);
    await addReceipt({
        allocationId,
        noticeId: notice.id,
        receivedQty: options.receivedQty || options.notice.sheetQty,
        lotNo: notice.madeLot,
    });
    return { notice, allocationId };
}

// ==================== CLEANUP ====================

async function cleanup() {
    await db.query(
        `DELETE FROM ${TABLES.receipt} WHERE allocation_id LIKE 'iqct-%'`
    );
    await db.query(`DELETE FROM ${TABLES.allocation} WHERE id LIKE 'iqct-%'`);
    await db.query(`DELETE FROM ${TABLES.notice2} WHERE sheet_no LIKE 'IQCT-%'`);
    if (createdSlot) {
        await db.query(`DELETE FROM ${TABLES.slots} WHERE code = ?`, [slotCode]);
    }
}

// ==================== CASES ====================

async function runCases() {
    // ---- A. Chưa có lot → sweep KHÔNG enqueue ----
    const noticeA = await createNotice({ sheetQty: 100 });
    const allocA = await createAllocation({});
    await addReceipt({
        allocationId: allocA,
        noticeId: noticeA.id,
        receivedQty: 100,
        lotNo: null,
    });
    const candidatesA = await IqcSyncRepository.findIqcPendingAllocations(500, null);
    check(
        'A: receipt chưa có lot → sweep không trả allocation',
        !candidatesA.some((row) => row.allocationId === allocA),
        candidatesA.map((row) => row.allocationId).slice(0, 5)
    );
    const resultA = await iqcSyncService.syncAllocation(allocA);
    check('A: sync chưa có lot → WAITING_IQC', resultA.state === STATES.WAITING_IQC, resultA);
    const allocAfterA = await readAllocation(allocA);
    check(
        'A: allocation vẫn WAITING_IQC / TEMP_IN',
        allocAfterA.status === 'WAITING_IQC' &&
        allocAfterA.warehouseStatus === 'TEMP_IN',
        allocAfterA
    );

    // ---- A2. Còn 1 receipt chưa lot → sweep KHÔNG enqueue (harden) ----
    // Allocation có receipt có lot + receipt chưa lot (2 notice khác
    // nhau — UQ (allocation_id, notice_detail_id)) → sweep phải bỏ qua.
    const noticeA2a = await createNotice({ sheetQty: 30, adjResult: '1' });
    const noticeA2b = await createNotice({ sheetQty: 20 });
    const allocA2 = await createAllocation({ allocatedQty: 50 });
    await addReceipt({
        allocationId: allocA2,
        noticeId: noticeA2a.id,
        receivedQty: 30,
        lotNo: noticeA2a.madeLot,
    });
    await addReceipt({
        allocationId: allocA2,
        noticeId: noticeA2b.id,
        receivedQty: 20,
        lotNo: null,
    });
    const candidatesA2 = await IqcSyncRepository.findIqcPendingAllocations(
        500,
        null
    );
    check(
        'A2: còn 1 receipt chưa lot → sweep không enqueue allocation',
        !candidatesA2.some((row) => row.allocationId === allocA2),
        candidatesA2.map((row) => row.allocationId).slice(0, 5)
    );
    const resultA2 = await iqcSyncService.syncAllocation(allocA2);
    check(
        'A2: service guard hasLot → WAITING_IQC (không spam waiting_lot)',
        resultA2.state === STATES.WAITING_IQC,
        resultA2
    );

    // ---- B. adj_result = 0 → WAITING, không đổi qty ----
    const b = await fixtureSingle({
        notice: { sheetQty: 100, adjResult: '0' },
        receivedQty: 100,
    });
    const candidatesB = await IqcSyncRepository.findIqcPendingAllocations(500, null);
    check(
        'B: sweep includes an open WAITING_IQC allocation with all lots',
        candidatesB.some((row) => row.allocationId === b.allocationId)
    );
    const afterB = await IqcSyncRepository.findIqcPendingAllocations(500, {
        allocatedAt: candidatesB.find((row) => row.allocationId === b.allocationId).allocatedAt,
        allocationId: b.allocationId,
    });
    check('B: keyset sweep excludes the cursor itself', !afterB.some(
        (row) => row.allocationId === b.allocationId
    ));
    const resultB = await iqcSyncService.syncAllocation(b.allocationId);
    const receiptsB = await readReceipts(b.allocationId);
    const allocB = await readAllocation(b.allocationId);
    check('B: adj_result=0 → WAITING_IQC', resultB.state === STATES.WAITING_IQC, resultB);
    check(
        'B: receipt chưa ghi IQC/qty',
        receiptsB[0].iqcDecision === null &&
        receiptsB[0].qtyInStock === null &&
        receiptsB[0].qtyReturn === null,
        receiptsB[0]
    );
    check('B: allocation giữ WAITING_IQC', allocB.status === 'WAITING_IQC', allocB);

    // ---- C. PASS, NO GRN, in_qty = 0 (acceptance bắt buộc) ----
    // Spec: sheet_qty 100, in_qty 0 (chưa GRN), return_qty 0, adj_result 1,
    // receipt.received_qty 60 → PASS, qty_in_stock = 60, WAITING_STOCK.
    const c = await fixtureSingle({
        notice: {
            sheetQty: 100,
            adjResult: '1',
            qcDate: '2026-11-10T08:00:00+07:00',
        },
        receivedQty: 60,
    });
    const { rows: in2RowsC } = await db.query(
        `SELECT COUNT(*) AS n FROM ${TABLES.in2} WHERE notice_id = ?`,
        [c.notice.id]
    );
    check(
        'C: NO GRN — không có pur_in2 cho notice (in_qty = 0)',
        Number(in2RowsC[0].n) === 0,
        in2RowsC[0]
    );
    const resultC = await iqcSyncService.syncAllocation(c.allocationId);
    const receiptsC = await readReceipts(c.allocationId);
    const allocC = await readAllocation(c.allocationId);
    check(
        'C: PASS TRƯỚC GRN (in_qty = 0) → vẫn MATCHED',
        resultC.state === STATES.MATCHED,
        resultC
    );
    check(
        'C: receipt PASS qty_in_stock = received_qty (60)',
        receiptsC[0].iqcDecision === 'PASS' &&
        Number(receiptsC[0].qtyInStock) === 60 &&
        Number(receiptsC[0].qtyReturn) === 0,
        receiptsC[0]
    );
    check(
        'C: allocation WAITING_STOCK / TEMP_IN',
        allocC.status === 'WAITING_STOCK' &&
        allocC.warehouseStatus === 'TEMP_IN',
        allocC
    );

    // ---- D. EXEMPT ----
    const d = await fixtureSingle({
        notice: { sheetQty: 40, adjResult: '3', qcDate: '2026-11-10T09:00:00+07:00' },
        receivedQty: 40,
    });
    const resultD = await iqcSyncService.syncAllocation(d.allocationId);
    const receiptsD = await readReceipts(d.allocationId);
    const allocD = await readAllocation(d.allocationId);
    check('D: EXEMPT → MATCHED', resultD.state === STATES.MATCHED, resultD);
    check(
        'D: receipt EXEMPT + qty_in_stock = received',
        receiptsD[0].iqcDecision === 'EXEMPT' && Number(receiptsD[0].qtyInStock) === 40,
        receiptsD[0]
    );
    check(
        'D: allocation WAITING_STOCK',
        allocD.status === 'WAITING_STOCK',
        allocD
    );

    // ---- E. FAIL_ACCEPT (adj 2 + pro 2) ----
    const e = await fixtureSingle({
        notice: {
            sheetQty: 50,
            adjResult: '2',
            proResult: '2',
            qcDate: '2026-11-10T10:00:00+07:00',
        },
        receivedQty: 50,
    });
    const resultE = await iqcSyncService.syncAllocation(e.allocationId);
    const receiptsE = await readReceipts(e.allocationId);
    const allocE = await readAllocation(e.allocationId);
    check(
        'E: FAIL_ACCEPT → receipt qty_in_stock = received',
        receiptsE[0].iqcDecision === 'FAIL_ACCEPT' &&
        Number(receiptsE[0].qtyInStock) === 50,
        receiptsE[0]
    );
    check(
        'E: allocation WAITING_STOCK',
        resultE.state === STATES.MATCHED && allocE.status === 'WAITING_STOCK',
        [resultE, allocE]
    );

    // ---- F. FAIL_RETURN (adj 2 + pro 0) ----
    const f = await fixtureSingle({
        notice: {
            sheetQty: 60,
            adjResult: '2',
            proResult: '0',
            returnQty: 60,
            qcDate: '2026-11-10T11:00:00+07:00',
        },
        receivedQty: 60,
    });
    const resultF = await iqcSyncService.syncAllocation(f.allocationId);
    const receiptsF = await readReceipts(f.allocationId);
    const allocF = await readAllocation(f.allocationId);
    check(
        'F: FAIL_RETURN → receipt qty_return = received',
        receiptsF[0].iqcDecision === 'FAIL_RETURN' &&
        Number(receiptsF[0].qtyReturn) === 60 &&
        Number(receiptsF[0].qtyInStock) === 0,
        receiptsF[0]
    );
    check(
        'F: allocation RETURNED / RETURN',
        resultF.state === STATES.RETURNED &&
        allocF.status === 'RETURNED' &&
        allocF.warehouseStatus === 'RETURN',
        [resultF, allocF]
    );

    // ---- G. 2 receipt PASS → SUM ----
    const noticeG1 = await createNotice({
        sheetQty: 60,
        adjResult: '1',
        qcDate: '2026-11-10T12:00:00+07:00',
    });
    const noticeG2 = await createNotice({
        sheetQty: 40,
        adjResult: '1',
        qcDate: '2026-11-10T12:05:00+07:00',
    });
    const allocG = await createAllocation({ allocatedQty: 100 });
    await addReceipt({
        allocationId: allocG,
        noticeId: noticeG1.id,
        receivedQty: 60,
        lotNo: noticeG1.madeLot,
    });
    await addReceipt({
        allocationId: allocG,
        noticeId: noticeG2.id,
        receivedQty: 40,
        lotNo: noticeG2.madeLot,
    });
    const resultG = await iqcSyncService.syncAllocation(allocG);
    const receiptsG = await readReceipts(allocG);
    const allocGAfter = await readAllocation(allocG);
    const sumInG = receiptsG.reduce((sum, r) => sum + Number(r.qtyInStock || 0), 0);
    check('G: 2 receipt PASS → SUM qty_in_stock = 100', sumInG === 100, receiptsG);
    check(
        'G: allocation WAITING_STOCK + iqc_decision PASS',
        resultG.state === STATES.MATCHED &&
        allocGAfter.status === 'WAITING_STOCK' &&
        allocGAfter.iqcDecision === 'PASS',
        allocGAfter
    );

    // ---- H. Mixed PASS 70 + FAIL_RETURN 30 ----
    const noticeH1 = await createNotice({
        sheetQty: 70,
        adjResult: '1',
        qcDate: '2026-11-10T13:00:00+07:00',
    });
    const noticeH2 = await createNotice({
        sheetQty: 30,
        adjResult: '2',
        proResult: '0',
        returnQty: 30,
        qcDate: '2026-11-10T13:10:00+07:00',
    });
    const allocH = await createAllocation({ allocatedQty: 100 });
    await addReceipt({
        allocationId: allocH,
        noticeId: noticeH1.id,
        receivedQty: 70,
        lotNo: noticeH1.madeLot,
    });
    await addReceipt({
        allocationId: allocH,
        noticeId: noticeH2.id,
        receivedQty: 30,
        lotNo: noticeH2.madeLot,
    });
    const resultH = await iqcSyncService.syncAllocation(allocH);
    const receiptsH = await readReceipts(allocH);
    const allocHAfter = await readAllocation(allocH);
    const sumInH = receiptsH.reduce((sum, r) => sum + Number(r.qtyInStock || 0), 0);
    const sumReturnH = receiptsH.reduce(
        (sum, r) => sum + Number(r.qtyReturn || 0),
        0
    );
    check('H: qty_in_stock = 70 / qty_return = 30', sumInH === 70 && sumReturnH === 30, {
        sumInH,
        sumReturnH,
    });
    check(
        'H: allocation WAITING_STOCK + MIXED',
        resultH.state === STATES.MATCHED &&
        allocHAfter.status === 'WAITING_STOCK' &&
        allocHAfter.iqcDecision === 'MIXED',
        allocHAfter
    );

    // ---- I. Một receipt vẫn WAITING → allocation WAITING_IQC ----
    const noticeI1 = await createNotice({
        sheetQty: 20,
        adjResult: '1',
        qcDate: '2026-11-10T14:00:00+07:00',
    });
    const noticeI2 = await createNotice({ sheetQty: 20, adjResult: '0' });
    const allocI = await createAllocation({ allocatedQty: 40 });
    await addReceipt({
        allocationId: allocI,
        noticeId: noticeI1.id,
        receivedQty: 20,
        lotNo: noticeI1.madeLot,
    });
    await addReceipt({
        allocationId: allocI,
        noticeId: noticeI2.id,
        receivedQty: 20,
        lotNo: noticeI2.madeLot,
    });
    const resultI = await iqcSyncService.syncAllocation(allocI);
    const allocIAfter = await readAllocation(allocI);
    check(
        'I: còn 1 receipt WAITING → allocation WAITING_IQC',
        resultI.state === STATES.WAITING_IQC &&
        allocIAfter.status === 'WAITING_IQC',
        [resultI, allocIAfter]
    );

    // ---- J. Multi-allocation full PASS → mỗi allocation nhận received_qty ----
    const noticeJ = await createNotice({
        sheetQty: 100,
        adjResult: '1',
        qcDate: '2026-11-10T15:00:00+07:00',
    });
    const allocJ1 = await createAllocation({ allocatedQty: 60 });
    const allocJ2 = await createAllocation({ allocatedQty: 40 });
    await addReceipt({
        allocationId: allocJ1,
        noticeId: noticeJ.id,
        receivedQty: 60,
        lotNo: noticeJ.madeLot,
    });
    await addReceipt({
        allocationId: allocJ2,
        noticeId: noticeJ.id,
        receivedQty: 40,
        lotNo: noticeJ.madeLot,
    });
    const resultJ1 = await iqcSyncService.syncAllocation(allocJ1);
    const resultJ2 = await iqcSyncService.syncAllocation(allocJ2);
    const receiptsJ1 = await readReceipts(allocJ1);
    const receiptsJ2 = await readReceipts(allocJ2);
    check(
        'J: mỗi allocation nhận đúng received_qty (60 / 40)',
        Number(receiptsJ1[0].qtyInStock) === 60 &&
        Number(receiptsJ2[0].qtyInStock) === 40,
        [receiptsJ1[0], receiptsJ2[0]]
    );
    check(
        'J: cả 2 allocation WAITING_STOCK',
        resultJ1.state === STATES.MATCHED && resultJ2.state === STATES.MATCHED,
        [resultJ1, resultJ2]
    );

    // ---- K. Multi-allocation full RETURN ----
    const noticeK = await createNotice({
        sheetQty: 100,
        adjResult: '2',
        proResult: '0',
        returnQty: 100,
        qcDate: '2026-11-10T15:30:00+07:00',
    });
    const allocK1 = await createAllocation({ allocatedQty: 60 });
    const allocK2 = await createAllocation({ allocatedQty: 40 });
    await addReceipt({
        allocationId: allocK1,
        noticeId: noticeK.id,
        receivedQty: 60,
        lotNo: noticeK.madeLot,
    });
    await addReceipt({
        allocationId: allocK2,
        noticeId: noticeK.id,
        receivedQty: 40,
        lotNo: noticeK.madeLot,
    });
    await iqcSyncService.syncAllocation(allocK1);
    await iqcSyncService.syncAllocation(allocK2);
    const receiptsK1 = await readReceipts(allocK1);
    const receiptsK2 = await readReceipts(allocK2);
    const allocK1After = await readAllocation(allocK1);
    check(
        'K: mỗi allocation qty_return = received_qty (60 / 40)',
        Number(receiptsK1[0].qtyReturn) === 60 &&
        Number(receiptsK2[0].qtyReturn) === 40,
        [receiptsK1[0], receiptsK2[0]]
    );
    check(
        'K: allocation RETURNED / RETURN',
        allocK1After.status === 'RETURNED' &&
        allocK1After.warehouseStatus === 'RETURN',
        allocK1After
    );

    // ---- L. Partial single-allocation 100 → 70 / 30 ----
    const l = await fixtureSingle({
        notice: {
            sheetQty: 100,
            adjResult: '1',
            returnQty: 30,
            qcDate: '2026-11-10T16:00:00+07:00',
        },
        receivedQty: 100,
    });
    const resultL = await iqcSyncService.syncAllocation(l.allocationId);
    const receiptsL = await readReceipts(l.allocationId);
    check(
        'L: partial single-allocation → 70 / 30',
        Number(receiptsL[0].qtyInStock) === 70 &&
        Number(receiptsL[0].qtyReturn) === 30,
        receiptsL[0]
    );
    check('L: MATCHED (có hàng nhận)', resultL.state === STATES.MATCHED, resultL);

    // ---- M. Partial multi-allocation → warning, WAITING_IQC ----
    const noticeM = await createNotice({
        sheetQty: 100,
        adjResult: '1',
        returnQty: 30,
        qcDate: '2026-11-10T16:30:00+07:00',
    });
    const allocM1 = await createAllocation({ allocatedQty: 60 });
    const allocM2 = await createAllocation({ allocatedQty: 40 });
    await addReceipt({
        allocationId: allocM1,
        noticeId: noticeM.id,
        receivedQty: 60,
        lotNo: noticeM.madeLot,
    });
    await addReceipt({
        allocationId: allocM2,
        noticeId: noticeM.id,
        receivedQty: 40,
        lotNo: noticeM.madeLot,
    });
    const resultM1 = await iqcSyncService.syncAllocation(allocM1);
    const resultM2 = await iqcSyncService.syncAllocation(allocM2);
    const allocM1After = await readAllocation(allocM1);
    const receiptsM1 = await readReceipts(allocM1);
    check(
        'M: partial multi-allocation → PARTIAL_AMBIGUOUS',
        resultM1.state === STATES.PARTIAL_AMBIGUOUS &&
        resultM2.state === STATES.PARTIAL_AMBIGUOUS,
        [resultM1, resultM2]
    );
    check(
        'M: giữ WAITING_IQC + has_warning',
        allocM1After.status === 'WAITING_IQC' && allocM1After.hasWarning === true,
        allocM1After
    );
    check(
        'M: KHÔNG ghi quantity vào receipt',
        receiptsM1[0].qtyInStock === null && receiptsM1[0].qtyReturn === null,
        receiptsM1[0]
    );

    // ---- N. Allocation đã Undo (không tồn tại) → NO_OP ----
    const resultN = await iqcSyncService.syncAllocation('iqct-al-missing');
    check('N: allocation missing → NO_OP', resultN.state === STATES.NO_OP, resultN);

    // ---- O. Allocation đã vào tồn kho → old job NO_OP ----
    const noticeO = await createNotice({
        sheetQty: 30,
        adjResult: '1',
        qcDate: '2026-11-10T17:00:00+07:00',
    });
    const allocO = await createAllocation({
        status: 'IN_STOCK',
        warehouseStatus: 'IN',
        allocatedQty: 30,
    });
    await addReceipt({
        allocationId: allocO,
        noticeId: noticeO.id,
        receivedQty: 30,
        lotNo: noticeO.madeLot,
    });
    const sweepO = await IqcSyncRepository.findIqcPendingAllocations(200);
    check('O: sweep excludes IN_STOCK', !sweepO.some((row) => row.allocationId === allocO), sweepO);
    const resultO = await iqcSyncService.syncAllocation(allocO);
    const allocOAfter = await readAllocation(allocO);
    check(
        'O: status đã tiến → NO_OP, không rollback',
        resultO.state === STATES.NO_OP &&
        resultO.reason === 'status_advanced' && allocOAfter.status === 'IN_STOCK',
        [resultO, allocOAfter]
    );

    // ---- P. adj_result = 99 (unknown) → warning, WAITING_IQC ----
    // Schema thật khai báo adj_result CHAR(1) → không chứa được '99'.
    // '9' là mã ngoài rule tương đương, vẫn chứng minh "không đoán".
    let unknownNotice;
    try {
        unknownNotice = await createNotice({ sheetQty: 25, adjResult: '99' });
    } catch {
        unknownNotice = await createNotice({ sheetQty: 25, adjResult: '9' });
    }
    const allocP = await createAllocation({ allocatedQty: 25 });
    await addReceipt({
        allocationId: allocP,
        noticeId: unknownNotice.id,
        receivedQty: 25,
        lotNo: unknownNotice.madeLot,
    });
    const p = { notice: unknownNotice, allocationId: allocP };
    const resultP = await iqcSyncService.syncAllocation(p.allocationId);
    const allocPAfter = await readAllocation(p.allocationId);
    check(
        'P: adj_result ngoài rule → warning + WAITING_IQC',
        resultP.state === STATES.PARTIAL_AMBIGUOUS &&
        allocPAfter.status === 'WAITING_IQC' &&
        allocPAfter.hasWarning === true,
        [resultP, allocPAfter]
    );

    // ---- Q. Idempotency: chạy lại C không cộng qty lần 2 ----
    const beforeQ = await readReceipts(c.allocationId);
    const resultQ = await iqcSyncService.syncAllocation(c.allocationId);
    const afterQ = await readReceipts(c.allocationId);
    const allocQ = await readAllocation(c.allocationId);
    check(
        'Q: chạy lại không tăng qty lần 2 / không thêm receipt',
        afterQ.length === beforeQ.length &&
        Number(afterQ[0].qtyInStock) === Number(beforeQ[0].qtyInStock) &&
        Number(afterQ[0].qtyReturn) === Number(beforeQ[0].qtyReturn),
        { beforeQ, afterQ }
    );
    check(
        'Q: same result is a NO_OP after rechecking T8',
        resultQ.state === STATES.NO_OP && resultQ.reason === 'iqc_unchanged' &&
        allocQ.status === 'WAITING_STOCK',
        [resultQ, allocQ]
    );

    // ---- R. Recheck completed lots; stop when returned or in stock ----
    const recheck = await fixtureSingle({ notice: { sheetQty: 100, adjResult: '1' } });
    await iqcSyncService.syncAllocation(recheck.allocationId);
    const corrections = [
        { adj: '2', pro: '2', returned: 30, status: 'WAITING_STOCK', received: 70 },
        { adj: '3', pro: '0', returned: 0, status: 'WAITING_STOCK', received: 100 },
        { adj: '0', pro: '0', returned: 0, status: 'WAITING_IQC', received: 0 },
        { adj: '1', pro: '0', returned: 0, status: 'WAITING_STOCK', received: 100 },
        { adj: '2', pro: '0', returned: 100, status: 'RETURNED', received: 0 },
    ];
    for (const correction of corrections) {
        const candidates = await IqcSyncRepository.findIqcPendingAllocations(200);
        check('R: sweep includes the open lot before its correction',
            candidates.some((row) => row.allocationId === recheck.allocationId), correction);
        await db.query(
            `UPDATE ${TABLES.notice2} SET adj_result = ?, pro_result = ?, return_qty = ? WHERE id = ?`,
            [correction.adj, correction.pro, correction.returned, recheck.notice.id]
        );
        const result = await iqcSyncService.syncAllocation(recheck.allocationId);
        const allocation = await readAllocation(recheck.allocationId);
        const [receipt] = await readReceipts(recheck.allocationId);
        const waiting = correction.status === 'WAITING_IQC';
        check(`R: correction changes the lot to ${correction.status} with absolute quantities`,
            allocation.status === correction.status &&
            allocation.qtyInStock === correction.received &&
            allocation.qtyReturn === correction.returned &&
            receipt.qtyInStock === (waiting ? null : correction.received) &&
            receipt.qtyReturn === (waiting ? null : correction.returned) &&
            (!waiting || result.state === STATES.WAITING_IQC),
            { result, allocation, receipt });
    }

    const returnedCandidates = await IqcSyncRepository.findIqcPendingAllocations(200);
    check('R: sweep includes open RETURNED with initial FAIL_RETURN',
        returnedCandidates.some((row) => row.allocationId === recheck.allocationId),
        returnedCandidates);

    await db.query(
        `UPDATE ${TABLES.notice2} SET pro_result = '2', return_qty = 30 WHERE id = ?`,
        [recheck.notice.id]
    );
    const accepted = await iqcSyncService.syncAllocation(recheck.allocationId);
    const acceptedLot = await readAllocation(recheck.allocationId);
    check('R: pro_result 0 → 2 reopens an initial return and updates quantities',
        accepted.state === STATES.MATCHED && acceptedLot.status === 'WAITING_STOCK' &&
        acceptedLot.iqcDecision === 'FAIL_ACCEPT' && acceptedLot.qtyInStock === 70 &&
        acceptedLot.qtyReturn === 30,
        { accepted, acceptedLot });

    await db.query(
        `UPDATE ${TABLES.notice2} SET adj_result = '1', return_qty = 0 WHERE id = ?`,
        [recheck.notice.id]
    );
    const passed = await iqcSyncService.syncAllocation(recheck.allocationId);
    check('R: a corrected adj_result is also applied',
        passed.state === STATES.MATCHED && passed.iqcDecision === 'PASS' &&
        passed.qtyInStock === 100 && passed.qtyReturn === 0, passed);

    await db.query(
        `UPDATE ${TABLES.notice2} SET adj_result = '2', pro_result = '0', return_qty = 100 WHERE id = ?`,
        [recheck.notice.id]
    );
    await iqcSyncService.syncAllocation(recheck.allocationId);
    await db.query(`UPDATE ${TABLES.allocation} SET closed_at = NOW() WHERE id = ?`,
        [recheck.allocationId]);
    const closedCandidates = await IqcSyncRepository.findIqcPendingAllocations(200);
    const closedJob = await iqcSyncService.syncAllocation(recheck.allocationId);
    check('R: a closed return is skipped by sweep and queued jobs',
        !closedCandidates.some((row) => row.allocationId === recheck.allocationId) &&
        closedJob.state === STATES.NO_OP && closedJob.reason === 'allocation_closed',
        closedJob);

    // ---- U. Quyết định và số lượng mâu thuẫn, hoặc lượng trả ngoài giới hạn ----
    const invalidCases = [
        ['PASS with full return', '1', null, 100, 'iqc_decision_quantity_mismatch'],
        ['EXEMPT with full return', '3', null, 100, 'iqc_decision_quantity_mismatch'],
        ['negative return', '1', null, -0.00000001, 'iqc_invalid_quantity'],
        ['return above sheet quantity', '2', '0', 100.00000001, 'iqc_invalid_quantity'],
    ];
    for (const [label, adjResult, proResult, returnQty, reason] of invalidCases) {
        const fixture = await fixtureSingle({
            notice: { sheetQty: 100, adjResult, proResult, returnQty },
            receivedQty: 100,
        });
        const result = await iqcSyncService.syncAllocation(fixture.allocationId);
        const allocation = await readAllocation(fixture.allocationId);
        const [receipt] = await readReceipts(fixture.allocationId);
        check(
            `U: ${label} keeps allocation pending with a warning`,
            result.state === STATES.DATA_ERROR && result.reason === reason &&
            allocation.status === 'WAITING_IQC' && allocation.hasWarning === true,
            [result, allocation]
        );
        check(
            `U: ${label} leaves IQC decision and quantities untouched`,
            receipt.iqcDecision === null && receipt.qtyInStock === null && receipt.qtyReturn === null,
            receipt
        );
    }

    // ---- V. T8 cập nhật kết quả hợp lệ sau khi có cảnh báo ----
    await db.query(
        `UPDATE ${TABLES.notice2} SET adj_result = '1', return_qty = 0 WHERE id = ?`,
        [p.notice.id]
    );
    await db.query(
        `UPDATE ${TABLES.receipt} SET has_warning = TRUE WHERE allocation_id = ?`,
        [p.allocationId]
    );
    const resultV = await iqcSyncService.syncAllocation(p.allocationId);
    const allocationV = await readAllocation(p.allocationId);
    const [receiptV] = await readReceipts(p.allocationId);
    check(
        'V: successful retry clears allocation and receipt warnings',
        resultV.state === STATES.MATCHED && allocationV.status === 'WAITING_STOCK' &&
        allocationV.hasWarning === false && receiptV.hasWarning === false,
        [resultV, allocationV, receiptV]
    );

    // ---- W. Cả hai mã xử lý FAIL đều dùng số lượng trả từ T8 ----
    const failFixtures = [];
    for (const [proResult, decision] of [['0', 'FAIL_RETURN'], ['2', 'FAIL_ACCEPT']]) {
        for (const returnQty of [0, 30, 100]) {
            const fixture = await fixtureSingle({
                notice: { sheetQty: 100, adjResult: '2', proResult, returnQty },
                receivedQty: 100,
            });
            const result = await iqcSyncService.syncAllocation(fixture.allocationId);
            const allocation = await readAllocation(fixture.allocationId);
            const [receipt] = await readReceipts(fixture.allocationId);
            const fullReturn = returnQty === 100;
            check(
                `W: FAIL pro_result=${proResult}, return_qty=${returnQty} records shelf quantities`,
                result.state === (fullReturn ? STATES.RETURNED : STATES.MATCHED) &&
                allocation.status === (fullReturn ? 'RETURNED' : 'WAITING_STOCK') &&
                allocation.warehouseStatus === (fullReturn ? 'RETURN' : 'TEMP_IN') &&
                allocation.hasWarning === false &&
                allocation.iqcDecision === decision &&
                Number(receipt.qtyInStock) === 100 - returnQty &&
                Number(receipt.qtyReturn) === returnQty,
                [result, allocation, receipt]
            );
            failFixtures.push({ id: fixture.allocationId, returnQty });
        }
    }

    const lots = await OverviewService.listLots();
    for (const { id, returnQty } of failFixtures) {
        const lot = lots.find((item) => item.id === id);
        check(
            'W: lots API payload includes shelf and IQC quantities',
            lot?.shelfCode === slotCode && Number(lot.qtyReturn) === returnQty &&
            Number(lot.qtyInStock) === 100 - returnQty &&
            lot.status === (returnQty === 100 ? 'RETURNED' : 'WAITING_STOCK'),
            lot
        );
    }

    // ---- R. Manual IQC endpoint: DB_MODE=sqlserver → blocked ----
    check(
        'R: manual IQC disable khi DB_MODE=sqlserver',
        manualIqcDisabled('sqlserver') === true
    );
    check(
        'R: manual IQC còn mở cho simulator (memory / test-postgres)',
        manualIqcDisabled('memory') === false &&
        manualIqcDisabled('test-postgres') === false
    );

    // ---- S. IQC worker không có path nào set IN_STOCK ----
    for (const file of IQC_SOURCE_FILES) {
        const content = fs.readFileSync(file, 'utf8');
        check(
            `S: ${path.basename(file)} không set IN_STOCK`,
            !/(['"])IN_STOCK\1/.test(content)
        );
    }

    // ---- T. IQC worker không ghi T8 (READ ONLY) ----
    for (const file of IQC_SOURCE_FILES) {
        const content = fs.readFileSync(file, 'utf8');
        check(
            `T: ${path.basename(file)} không ghi hoặc đổi schema T8`,
            !/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE(?:\s+INTO)?|(?:CREATE|ALTER|DROP)\s+(?:TABLE|VIEW)|TRUNCATE\s+TABLE)\s+(?:dbo\.)?(?:t8_|pur_|bas_|v_pur_)/i.test(content)
        );
    }
}

(async () => {
    if (db.getMode() !== 'test-postgres') {
        console.error(`Test chỉ chạy DB_MODE=test-postgres (hiện tại: ${db.getMode()})`);
        process.exit(1);
    }
    try {
        await runCases();
    } catch (error) {
        fail += 1;
        console.error('  FATAL', error);
    } finally {
        try {
            await cleanup();
        } catch (cleanupError) {
            fail += 1;
            console.error('  CLEANUP FAILED', cleanupError);
        }
    }
    console.log(`\nIQC SYNC TEST: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
})();
