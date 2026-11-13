'use strict';

/**
 * Repository sync receipt — các truy vấn "candidate-first" dành riêng cho
 * Receipt Sync Worker (services/receipt-sync.service.js).
 *
 * KHÔNG chứa business decision (MATCHED/SHORTAGE/EXCESS/WAITING...) —
 * repository chỉ đọc/ghi WHS và trả data shape rõ ràng. Việc tìm notice
 * T8 (findNoticesForPoLine) và đọc dòng PO (findOrder2ByPoId) đã có sẵn
 * ở po.repository và được service gọi TRỰC TIẾP — không copy SQL sang đây.
 *
 * Method:
 *   - findAllocationForSync(allocationId, query?) : 1 dòng allocation +
 *     tổng received_qty đã ghi cho nó (LEFT JOIN 1 subquery gộp receipt —
 *     bảng whs nhỏ, KHÔNG chạm T8) → bước "FIRST CHECK" (#20/#21).
 *     Executor tùy chọn để chạy lại TRONG transaction trước khi ghi.
 *   - listPendingAllocationIds(limit)             : sweep candidate —
 *     allocation còn mở mà received < allocated (#24: pending WHS
 *     allocations → candidate PO keys, KHÔNG scan T8).
 *   - findPendingAllocations(limit, cursor?)     : như trên nhưng trả
 *     ĐẦY ĐỦ dòng candidate (po_id, goods_no, allocated, received) —
 *     sweep phân loại batch ngay trong memory thay vì fetch lại từng
 *     dòng (set-based #10/#46).
 *     CURSOR KEYSET (cursor starvation #9): sweep cũ luôn FETCH NEXT 200
 *     theo ORDER allocated_at ASC — 250 pending mà 200 đầu chưa có T8
 *     notice thì 50 sau KHÔNG BAO GIỜ được quét. Cursor (allocated_at, id)
 *     chuyền sang lượt kế → mọi pending cuối cùng đều được visited; hết
 *     cửa sổ (batch < limit) thì cursor reset về đầu (wrap-around). Keyset
 *     (không OFFSET) → index ORDER giữ nguyên, không degrade theo sâu.
 *   - findRevalidationCandidates(limit, cursor?)   : allocation còn mở,
 *     ĐÃ CÓ receipt (INNER JOIN SUM receipt) — sweep phase-2 revalidate
 *     chống T8 đổi/xóa notice SAU khi sync (#29-#32). Cùng cursor keyset.
 *   - acquireAllocationLock(allocationId, query?)  : khóa cấp ALLOCATION
 *     (thứ tự khóa THỐNG NHẤT: allocation → notice — moveLot của
 *     lot.service cũng lấy khóa allocation này, #24).
 *   - acquireNoticeLock(noticeDetailId, query?)    : khóa cấp NOTICE trước
 *     khi tính remaining trong tx (#41) — xem comment method.
 *
 * Truy cập T8 production READ ONLY. Chỉ write whs_* (ghi thật nằm ở
 * receipt.repository / lot.repository, được service gọi).
 *
 * DB_MODE=memory thì module.exports swap sang cắt lát của memory
 * repository (xem cuối file).
 */

const db = require('../../config/db');
const { TABLES } = require('./tables');

/** Tên bảng logic (viết trong SQL) -> tên thật (kèm tiền tố nếu có). */
const TABLE_PAIRS = [
    ['bas_emp', TABLES.emps],
    ['bas_goods', TABLES.goods],
    ['pur_order1', TABLES.order1],
    ['pur_order2', TABLES.order2],
    ['pur_notice1', TABLES.notice1],
    ['pur_notice2', TABLES.notice2],
    ['pur_in1', TABLES.in1],
    ['pur_in2', TABLES.in2],
    ['whs_user_role', TABLES.userRole],
    ['whs_slots', TABLES.slots],
    ['whs_slot_allocation', TABLES.allocation],
    ['whs_allocation_receipt', TABLES.receipt],
    ['whs_slot_movement', TABLES.movement],
    ['whs_activity', TABLES.activity],
];

// ==================== PRIVATE: HỖ TRỢ DIALECT ====================

/** Dialect hiện tại có phải PostgreSQL (chỉ dùng cho sandbox test)? */
function isPg() {
    return db.getDialect() === 'pg';
}

/**
 * Chuyển câu SQL (viết cú pháp SQL Server) sang PostgreSQL khi chạy
 * sandbox — cùng bộ rule rút gọn của receipt.repository (bracket alias,
 * NVARCHAR, LIKE, BIT, GETDATE, tiền tố bảng).
 * @param {string} text câu SQL gốc (cú pháp SQL Server, placeholder ?)
 * @returns {string} câu SQL theo dialect hiện tại
 */
function toDialect(text) {
    if (!isPg()) return text;
    let out = text;
    out = out.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');
    out = out.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
    out = out.replace(/\bLIKE\b/g, 'ILIKE');
    out = out.replace(/\bGETDATE\s*\(\s*\)/gi, 'NOW()');
    // OUTPUT inserted.X -> RETURNING X: mssql đặt OUTPUT TRƯỚC WHERE, pg bắt
    // RETURNING ở CUỐI câu — bọc marker \u0002 để dời xuống cuối (như
    // lot.repository, tránh RETURNING kẹt giữa UPDATE như bug 2026-10-21).
    out = out.replace(
        /\bOUTPUT\s+inserted\.(\*|[A-Za-z_][A-Za-z0-9_]*)/gi,
        (_m, col) => `\u0002RETURNING ${col}\u0002`
    );
    const returningClause = out.match(/\u0002(RETURNING (?:\*|[A-Za-z_][A-Za-z0-9_]*))\u0002/);
    if (returningClause) {
        out = out.replace(/\u0002RETURNING (?:\*|[A-Za-z_][A-Za-z0-9_]*)\u0002/, '');
        out = `${out.replace(/\s*;\s*$/, '').trimEnd()} ${returningClause[1]};`;
    }
    for (const [logical, actual] of TABLE_PAIRS) {
        if (logical === actual) continue;
        out = out.replace(new RegExp(`\\b${logical}\\b`, 'g'), actual);
    }
    return out;
}

/**
 * Chặn sớm tham số undefined trước khi xuống driver.
 * @param {unknown[]} params
 */
function guardParams(params) {
    if (params.includes(undefined)) {
        throw new Error(
            '[receipt-sync.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
        );
    }
}

/**
 * Cursor keyset hợp lệ (dùng cho findPendingAllocations /
 * findRevalidationCandidates — #9 cursor starvation).
 * @param {{ allocatedAt: unknown, allocationId: unknown } | null | undefined} cursor
 * @returns {boolean}
 */
function hasCursor(cursor) {
    return Boolean(
        cursor && cursor.allocatedAt !== undefined && cursor.allocatedAt !== null && cursor.allocationId
    );
}

class ReceiptSyncRepository {
    /**
     * Load trạng thái reconciliation của 1 allocation: allocated_qty
     * (số USER gán kệ — KHÔNG BAO GIỜ bị ghi đè) + tổng received_qty đã
     * reconcile. Trả null nếu allocation không tồn tại.
     *
     * Left JOIN 1 subquery gộp theo allocation_id trên bảng receipt (WHS,
     * nhỏ) — KHÔNG query T8 ở bước này.
     *
     * @param {string} allocationId PK của whs_slot_allocation
     * @param {Function} [query] bộ query (mặc định db.query) — service truyền
     *   txQuery để RECHECK trong cùng transaction trước khi ghi (#39)
     * @returns {Promise<{
     *   allocationId: string, poId: number, goodsNo: string, slotCode: string,
     *   lotNo: string | null, warehouseStatus: string,
     *   allocatedQty: number, closedAt: Date | null,
     *   receivedTotal: number, receiptCount: number
     * } | null>}
     */
    async findAllocationForSync(allocationId, query = db.query) {
        const sql = `
    -- DECLARE @allocationId NVARCHAR(40) = 'al_xxx';
    SELECT
      a.id AS [allocationId],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.slot_code AS [slotCode],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.allocated_qty AS FLOAT) AS [allocatedQty],
      a.closed_at AS [closedAt],
      CAST(COALESCE(r.receivedTotal, 0) AS FLOAT) AS [receivedTotal],
      COALESCE(r.receiptCount, 0) AS [receiptCount]
    FROM whs_slot_allocation a
    LEFT JOIN (
      SELECT allocation_id,
             SUM(received_qty) AS receivedTotal,
             COUNT(id) AS receiptCount
      FROM whs_allocation_receipt
      GROUP BY allocation_id
    ) r ON r.allocation_id = a.id
    WHERE a.id = ?;
  `;
        const params = [allocationId];
        guardParams(params);
        const { rows } = await query(toDialect(sql), params);
        return rows[0] || null;
    }

    /**
     * BATCH allocation theo ids (1 câu IN — chống N+1) cho UI reconcile
     * issue (2026-10-28 BỔ SUNG #1-#22): service enrich DTO cần
     * allocated_qty/slot_code/lot_no của MỌI allocation đang có issue OPEN.
     * KHÔNG gồm receivedTotal — service tự batch receipt riêng.
     * @param {string[]} allocationIds (rỗng → [])
     * @returns {Promise<Array<{
     *   allocationId: string, poId: number, goodsNo: string, slotCode: string,
     *   lotNo: string | null, warehouseStatus: string,
     *   allocatedQty: number, closedAt: unknown
     * }>>}
     */
    async findAllocationsByIds(allocationIds) {
        if (!Array.isArray(allocationIds) || allocationIds.length === 0) {
            return [];
        }
        const placeholders = allocationIds.map(() => '?').join(', ');
        const sql = `
    SELECT
      a.id AS [allocationId],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.slot_code AS [slotCode],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.allocated_qty AS FLOAT) AS [allocatedQty],
      a.closed_at AS [closedAt]
    FROM whs_slot_allocation a
    WHERE a.id IN (${placeholders});
  `;
        const params = allocationIds.slice();
        guardParams(params);
        const { rows } = await db.query(toDialect(sql), params);
        return rows;
    }

    /**
     * Danh sách allocation "pending receipt" cho lượt sweep (candidate-first
     * #24): còn mở (closed_at IS NULL) và CHƯA nhận đủ số lượng đã gán
     * (receivedTotal IS NULL hoặc < allocated_qty). Số lượng fetch bị chặn
     * bởi `limit` (RECEIPT_SYNC_BATCH_SIZE) — không full scan T8, chỉ quét
     * bảng WHS allocation + receipt.
     *
     * @param {number} limit số allocation tối đa mỗi lượt
     * @returns {Promise<string[]>} danh sách allocationId, cũ nhất trước
     */
    async listPendingAllocationIds(limit) {
        const sql = `
    -- DECLARE @limit INT = 200;
    SELECT a.id AS [allocationId]
    FROM whs_slot_allocation a
    LEFT JOIN (
      SELECT allocation_id, SUM(received_qty) AS receivedTotal
      FROM whs_allocation_receipt
      GROUP BY allocation_id
    ) r ON r.allocation_id = a.id
    WHERE a.closed_at IS NULL
      AND (r.receivedTotal IS NULL OR r.receivedTotal < a.allocated_qty)
    ORDER BY a.allocated_at ASC, a.id ASC
    OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY;
  `;
        const params = [limit];
        guardParams(params);
        const { rows } = await db.query(toDialect(sql), params);
        return rows.map((row) => row.allocationId);
    }

    /**
     * Batch version của listPendingAllocationIds — trả ĐẦY ĐỦ dòng candidate
     * để sweep phân loại ngay trong memory (READY / WAITING / ...), không
     * phải refetch từng allocation. 1 câu WHS cho cả batch (#10/#46).
     *
     * CURSOR KEYSET (cursor starvation #9): cursor = dòng CUỐI batch trước
     * ({ allocatedAt, allocationId }) — keyset so sánh (allocated_at, id)
     * LỚN HƠN theo tuple, cho phép allocated_at trùng lặp (COALESCE chống
     * NULL). Batch < limit → hết cửa sổ → caller reset cursor (wrap-around).
     * KHÔNG dùng OFFSET: đúng nghĩa keyset, index-friendly ở mọi độ sâu.
     *
     * @param {number} limit số allocation tối đa mỗi lượt
     * @param {{ allocatedAt: Date | string, allocationId: string } | null} [cursor]
     *   vị trí batch trước — null = quét từ đầu
     * @returns {Promise<Array<{
     *   allocationId: string, poId: number, goodsNo: string,
     *   slotCode: string, lotNo: string | null, warehouseStatus: string,
     *   allocatedAt: Date | string, allocatedQty: number, receivedTotal: number
     * }>>}
     */
    async findPendingAllocations(limit, cursor) {
        const keyset = hasCursor(cursor)
            ? `
      AND (
        COALESCE(a.allocated_at, '1900-01-01T00:00:00') > ?
        OR (
          COALESCE(a.allocated_at, '1900-01-01T00:00:00') = ?
          AND a.id > ?
        )
      )`
            : '';
        const sql = `
    -- DECLARE @limit INT = 200;
    SELECT
      a.id AS [allocationId],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.slot_code AS [slotCode],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      a.allocated_at AS [allocatedAt],
      CAST(a.allocated_qty AS FLOAT) AS [allocatedQty],
      CAST(COALESCE(r.receivedTotal, 0) AS FLOAT) AS [receivedTotal]
    FROM whs_slot_allocation a
    LEFT JOIN (
      SELECT allocation_id, SUM(received_qty) AS receivedTotal
      FROM whs_allocation_receipt
      GROUP BY allocation_id
    ) r ON r.allocation_id = a.id
    WHERE a.closed_at IS NULL
      AND (r.receivedTotal IS NULL OR r.receivedTotal < a.allocated_qty)${keyset}
    ORDER BY COALESCE(a.allocated_at, '1900-01-01T00:00:00') ASC, a.id ASC
    OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY;
  `;
        const params = [];
        if (hasCursor(cursor)) {
            params.push(cursor.allocatedAt, cursor.allocatedAt, cursor.allocationId);
        }
        params.push(limit);
        guardParams(params);
        const { rows } = await db.query(toDialect(sql), params);
        return rows;
    }

    /**
     * Sweep PHASE-2 (#29-#32): allocation còn mở (closed_at IS NULL) và ĐÃ CÓ
     * receipt (INNER JOIN SUM receipt > 0 dòng) — tức “đã sync xong”. Lượt
     * sweep revalidate những allocation này chống T8 THAY ĐỔI SAU KHI SYNC
     * (notice bị xóa, sheet_qty giảm, made_lot đổi) — KHÔNG NO_OP mù.
     * Cùng cursor keyset như findPendingAllocations. Chỉ quét WHS (bảng
     * nhỏ) — T8 chỉ được chạm ở bước classification theo candidate keys.
     *
     * @param {number} limit số allocation tối đa mỗi lượt
     * @param {{ allocatedAt: Date | string, allocationId: string } | null} [cursor]
     * @returns {Promise<Array<{
     *   allocationId: string, poId: number, goodsNo: string,
     *   slotCode: string, lotNo: string | null,
     *   allocatedAt: Date | string, allocatedQty: number, receivedTotal: number
     * }>>}
     */
    async findRevalidationCandidates(limit, cursor) {
        const keyset = hasCursor(cursor)
            ? `
      AND (
        COALESCE(a.allocated_at, '1900-01-01T00:00:00') > ?
        OR (
          COALESCE(a.allocated_at, '1900-01-01T00:00:00') = ?
          AND a.id > ?
        )
      )`
            : '';
        const sql = `
    -- DECLARE @limit INT = 200;
    SELECT
      a.id AS [allocationId],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.slot_code AS [slotCode],
      a.lot_no AS [lotNo],
      a.allocated_at AS [allocatedAt],
      CAST(a.allocated_qty AS FLOAT) AS [allocatedQty],
      CAST(r.receivedTotal AS FLOAT) AS [receivedTotal]
    FROM whs_slot_allocation a
    INNER JOIN (
      SELECT allocation_id, SUM(received_qty) AS receivedTotal
      FROM whs_allocation_receipt
      GROUP BY allocation_id
    ) r ON r.allocation_id = a.id
    WHERE a.closed_at IS NULL${keyset}
    ORDER BY COALESCE(a.allocated_at, '1900-01-01T00:00:00') ASC, a.id ASC
    OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY;
  `;
        const params = [];
        if (hasCursor(cursor)) {
            params.push(cursor.allocatedAt, cursor.allocatedAt, cursor.allocationId);
        }
        params.push(limit);
        guardParams(params);
        const { rows } = await db.query(toDialect(sql), params);
        return rows;
    }

    /**
     * KHÓA CẤP ALLOCATION (#24 — Move-vs-Receipt race).
     *
     * TẠI SAO PHẢI KHÓA: scenario nguy hiểm — moveLot thấy received=0, worker
     * cùng lúc reconcile 50, move trừ allocated 30 → allocated=20 <
     * received=50 (vi phạm I4). Receipt tx và Move tx cùng giành KHÓA THEO
     * ALLOCATION này → tuần tự hóa; move tính movableQty = allocated -
     * SUM(received) FRESH dưới khóa → không bao giờ trừ xuống dưới received.
     *
     * THỨ TỰ KHÓA THỐNG NHẤT (chống deadlock, #24): receipt tx lấy
     * ALLOCATION lock TRƯỚC, NOTICE lock SAU; move tx chỉ lấy allocation
     * lock. Mọi transaction lấy khóa theo cùng thứ tự → không chờ vòng.
     *
     * Cơ chế giống acquireNoticeLock — tự release khi transaction end:
     *   - pg  : pg_advisory_xact_lock(9202, hashtext(allocationId)) — 9202
     *          magic class id riêng (khác 9201 của notice); allocationId là
     *          VARCHAR nên dùng hashtext làm int key (collision chỉ gây
     *          serialize thừa, vô hại).
     *   - mssql: sp_getapplock resource 'whs-alloc-lock-<id>'.
     *
     * @param {string} allocationId PK whs_slot_allocation
     * @param {Function} [query] PHẢI là txQuery của transaction đang mở
     * @returns {Promise<void>}
     */
    async acquireAllocationLock(allocationId, query = db.query) {
        const params = [allocationId];
        guardParams(params);
        if (isPg()) {
            await query(
                'SELECT pg_advisory_xact_lock(9202, hashtext(?)) IS NULL AS "locked";',
                params
            );
            return;
        }
        // T-SQL: tham số EXEC phải là biến/hằng, KHÔNG được là biểu thức
        // ('..'+?) → build resource vào biến @resource trước (giá trị vẫn
        // bind qua placeholder @pN — không interpolate raw input).
        const sql = `
    -- DECLARE @allocationId NVARCHAR(40) = 'al_xxx';
    DECLARE @lockResult INT;
    DECLARE @resource NVARCHAR(255);
    SET @resource = N'whs-alloc-lock-' + CAST(? AS NVARCHAR(100));
    EXEC @lockResult = sys.sp_getapplock
      @Resource = @resource,
      @LockMode = 'Exclusive',
      @LockOwner = 'Transaction',
      @LockTimeout = 15000;
    IF @lockResult < 0
    BEGIN
      RAISERROR('allocation_lock_timeout', 16, 1);
    END
    SELECT 1 AS [locked];
  `;
        await query(sql, params);
    }

    /**
     * KHÓA CẤP NOTICE — chốt tuần tự hóa reconcile trên 1 notice (#41).
     *
     * TẠI SAO PHẢI KHÓA: received_qty của notice = tổng nhiều allocation;
     * nếu 2 worker cùng tính remaining rồi ghi, tổng sẽ vượt sheet_qty
     * (over-consume). Khóa theo notice (scope nhỏ nhất — không khóa bảng,
     * không khóa allocation) + TÍNH LẠI remaining SAU khi có khóa → thằng
     * sau luôn thấy tổng mới nhất. KHÔNG dùng NOLOCK cho dữ liệu quyết
     * định quantity.
     *
     * Cơ chế theo dialect — đều tự release khi transaction end (commit /
     * rollback / crash), không cần unlock thủ công:
     *   - pg   : pg_advisory_xact_lock(classId 9201, noticeId) — khóa
     *            session-scope, transaction end là rơi. 9201 = magic class
     *            id riêng Receipt Sync (tránh đụng advisory khác của app).
     *            Chặn đến khi có khóa (tx ngắn + concurrency thấp → chấp
     *            nhận; session chết là khóa rỡ ngay).
     *   - mssql: sp_getapplock @LockOwner='Transaction' — bám transaction
     *            của db.withTransaction, commit/rollback tự release;
     *            @LockTimeout 15s → hết giờ RAISERROR → worker technical
     *            retry (lỗi lạ mã 50000 ≥ → classify là retryable).
     *
     * @param {number} noticeDetailId pur_notice2.id
     * @param {Function} [query] bộ query — PHẢI là txQuery của transaction
     *   đang mở (lock sống trong tx đó)
     * @returns {Promise<void>}
     */
    async acquireNoticeLock(noticeDetailId, query = db.query) {
        const params = [noticeDetailId];
        guardParams(params);
        if (isPg()) {
            // `IS NULL AS locked` ép cột ra về boolean thay vì void — vài proxy
            // PG (sandbox Miaoda) không trả được cột void; lock vẫn là side-effect
            // y nguyên trên PG thật.
            await query('SELECT pg_advisory_xact_lock(9201, ?) IS NULL AS "locked";', params);
            return;
        }
        // T-SQL: EXEC param không nhận biểu thức → biến @resource trước
        // (placeholder @pN vẫn bind giá trị, không nội chuỗi raw input).
        const sql = `
    -- DECLARE @noticeDetailId INT = 9001;
    DECLARE @lockResult INT;
    DECLARE @resource NVARCHAR(255);
    SET @resource = N'whs-receipt-notice-' + CAST(? AS NVARCHAR(20));
    EXEC @lockResult = sys.sp_getapplock
      @Resource = @resource,
      @LockMode = 'Exclusive',
      @LockOwner = 'Transaction',
      @LockTimeout = 15000;
    IF @lockResult < 0
    BEGIN
      RAISERROR('notice_lock_timeout', 16, 1);
    END
    SELECT 1 AS [locked];
  `;
        await query(sql, params);
    }

    /**
     * Mirror has_warning của allocation (#30) — chạy CUỐI receipt tx, sau mọi
     * upsert/resolve issue: has_warning = (còn issue OPEN của allocation)
     * OR (IQC đã chốt FAIL_PENDING). KHÔNG blanket-clear khi resolve 1 issue
     * mà issue OPEN khác còn treo; cũng KHÔNG xóa warning IQC FAIL khi
     * revalidation không phát hiện lệch receipt.
     *
     * WHS-only: 1 câu UPDATE, không refetch JOIN T8 (#27).
     * @param {string} allocationId PK whs_slot_allocation
     * @param {boolean} hasOpenIssue kết quả hasOpenIssueForAllocation
     * @param {Function} [query] truyền txQuery để chạy trong tx
     * @returns {Promise<boolean>} true nếu có dòng được UPDATE
     */
    async refreshHasWarningMirror(allocationId, hasOpenIssue, query = db.query) {
        // PG: has_warning là boolean — biểu thức server-side phải ra boolean
        // (CASE THEN 1 sinh integer → lỗi 42804). T-SQL không gán được biểu
        // thức boolean trực tiếp nên giữ CASE cho mssql BIT.
        const sql = isPg()
            ? `UPDATE whs_slot_allocation
           SET has_warning = (CAST(? AS INT) = 1
             OR COALESCE(iqc_decision = 'FAIL_PENDING', FALSE))
         WHERE id = ?
         RETURNING id;`
            : `
    -- DECLARE @hasOpenIssue INT = 1;
    -- DECLARE @allocationId NVARCHAR(40) = 'al_abc123';
    UPDATE whs_slot_allocation
    SET has_warning = CASE
      WHEN CAST(? AS INT) = 1 OR iqc_decision = 'FAIL_PENDING'
        THEN 1
        ELSE 0
    END
    OUTPUT inserted.id
    WHERE id = ?;
  `;
        const params = [hasOpenIssue ? 1 : 0, allocationId];
        guardParams(params);
        const { rows } = await query(toDialect(sql), params);
        return Boolean(rows && rows[0]);
    }

    /**
     * Batch của refreshHasWarningMirror cho sweep phase-2 (batch allocation
     * sạch sau resolve) — 1 câu UPDATE cho N allocation, KHÔNG N+1 (#46).
     * Semantics giống hệt bản đơn: EXISTS(issue OPEN) OR IQC FAIL_PENDING.
     *
     * whs_reconcile_issue chưa được tạo (chờ user approve migration) →
     * catch missing-table (mssql 208 / pg 42P01) và fallback: tính chỉ theo
     * IQC FAIL_PENDING — đúng nghĩa "không còn kênh issue = không còn
     * issue OPEN", không để 1 câu mirror làm cả batch sweep fail.
     * @param {string[]} allocationIds
     * @param {Function} [query] truyền txQuery để chạy trong tx
     * @returns {Promise<number>} số dòng UPDATE
     */
    async refreshHasWarningMirrorForAllocationIds(
        allocationIds,
        query = db.query
    ) {
        if (!Array.isArray(allocationIds) || allocationIds.length === 0) return 0;
        const placeholders = allocationIds.map(() => '?').join(', ');
        const baseWhere = `WHERE id IN (${placeholders})`;
        // Dialect riêng như refreshHasWarningMirror: PG boolean column cần biểu
        // thức boolean (CASE int → lỗi 42804), mssql BIT cần CASE.
        const fullSql = isPg()
            ? `UPDATE whs_slot_allocation
           SET has_warning = (
             EXISTS (
               SELECT 1
               FROM whs_reconcile_issue
               WHERE whs_reconcile_issue.allocation_id = whs_slot_allocation.id
                 AND whs_reconcile_issue.status = 'OPEN'
             ) OR COALESCE(iqc_decision = 'FAIL_PENDING', FALSE))
         ${baseWhere};`
            : `
      UPDATE whs_slot_allocation
      SET has_warning = CASE
        WHEN EXISTS (
          SELECT 1
          FROM whs_reconcile_issue
          WHERE whs_reconcile_issue.allocation_id = whs_slot_allocation.id
            AND whs_reconcile_issue.status = 'OPEN'
        ) OR iqc_decision = 'FAIL_PENDING'
          THEN 1
          ELSE 0
      END
      ${baseWhere};
    `;
        const fallbackSql = isPg()
            ? `UPDATE whs_slot_allocation
           SET has_warning = COALESCE(iqc_decision = 'FAIL_PENDING', FALSE)
         ${baseWhere};`
            : `
      UPDATE whs_slot_allocation
      SET has_warning = CASE
        WHEN iqc_decision = 'FAIL_PENDING' THEN 1 ELSE 0
      END
      ${baseWhere};
    `;
        const params = allocationIds.slice();
        guardParams(params);
        let result;
        try {
            result = await query(toDialect(fullSql), params);
        } catch (error) {
            const anyError = /** @type {any} */ (error);
            let missing = Number(anyError.number) === 208;
            let current = error;
            for (
                let depth = 0;
                current && typeof current === 'object' && depth < 4;
                depth += 1
            ) {
                if (String((/** @type {any} */ (current)).code) === '42P01') {
                    missing = true;
                    break;
                }
                current = (/** @type {any} */ (current)).cause;
            }
            if (!missing) throw error;
            result = await query(toDialect(fallbackSql), params);
        }
        return Number(
            (result && result.rowsAffected) || (result && result.rowCount) || 0
        );
    }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
    module.exports = getMemoryRepository().receiptSync;
} else {
    module.exports = new ReceiptSyncRepository();
    module.exports.ReceiptSyncRepository = ReceiptSyncRepository;
}
