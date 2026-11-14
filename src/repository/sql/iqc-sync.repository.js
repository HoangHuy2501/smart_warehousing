'use strict';

/**
 * Repository IQC Sync — primitive đọc T8 (READ ONLY) + đọc/ghi WHS.
 *
 * Tách khỏi receipt-sync.repository vì vòng đời khác (allocation đã ở
 * WAITING_IQC / WAITING_STOCK, receipt đã có lot) — không copy business decision nào:
 * mapping adj_result/pro_result, chia quantity, derive status đều nằm ở
 * services/iqc-sync.service.js.
 *
 * Nhóm primitive:
 *   SWEEP
 *     - findIqcPendingAllocations(limit, cursor) : keyset cursor, chỉ
 *       allocation còn mở + status IQC còn theo dõi + có receipt AND TẤT CẢ
 *       receipt của allocation đã có lot (NOT EXISTS receipt chưa lot):
 *       allocation có receipt chưa lot sẽ KHÔNG được enqueue — tránh spam
 *       IQC sync rồi trả waiting_lot.
 *   ĐỌC WHS
 *     - findAllocationForIqc(allocationId, query?) : recheck trong tx.
 *     - findReceiptsForAllocation(allocationId, query?) : receipt mapping.
 *     - countActiveAllocationsByNoticeIds(noticeIds, query?) : phát hiện 1 notice
 *       đang chia cho nhiều allocation (partial IQC không được tự chia).
 *   ĐỌC T8 (READ ONLY — KHÔNG BAO GIỜ GHI)
 *     - findNoticeIdentitiesByIds(noticeDetailIds) : pur_notice2 identity.
 *     - findIqcDetailsByIdentity(identities) : v_pur_notice_detail theo
 *       ĐỦ 6 khóa (sheet_no + sheet_id + pur_no + pur_id + goods_no +
 *       made_lot). Không TOP 1, không fallback theo goods_no + lot.
 *   GHI WHS
 *     - updateAllocationIqcSummary(allocationId, patch, query?) : mirror
 *       tổng hợp IQC lên allocation (receipt do ReceiptRepository ghi —
 *       không duplicate builder ở đây).
 *
 * SQL viết theo cú pháp SQL Server, `toDialect()` chuyển sang PostgreSQL
 * cho sandbox test (bracket alias, NVARCHAR, tiền tố bảng). Tham số luôn
 * bind qua placeholder `?` — không nối chuỗi giá trị.
 *
 * DB_MODE=memory thì module.exports swap sang cắt lát iqcSync của memory
 * repository (xem cuối file).
 */

const db = require('../../config/db');
const { previousMonthCutoff } = require('../../util/month-cutoff');
const { TABLES } = require('./tables');

/** Tên bảng logic (viết trong SQL) -> tên thật (kèm tiền tố nếu có). */
const TABLE_PAIRS = [
    ['pur_notice2', TABLES.notice2],
    ['v_pur_notice_detail', TABLES.noticeDetailView],
    ['whs_slot_allocation', TABLES.allocation],
    ['whs_allocation_receipt', TABLES.receipt],
];

// ==================== PRIVATE: HỖ TRỢ DIALECT ====================

/** Dialect hiện tại có phải PostgreSQL (chỉ dùng cho sandbox test)? */
function isPg() {
    return db.getDialect() === 'pg';
}

/**
 * Chuyển câu SQL (cú pháp SQL Server) sang PostgreSQL khi chạy sandbox.
 * Bộ rule tối thiểu repo này cần: bracket alias, NVARCHAR, tiền tố bảng.
 * @param {string} text câu SQL gốc (placeholder ?)
 * @returns {string} câu SQL theo dialect hiện tại
 */
function toDialect(text) {
    if (!isPg()) return text;
    let out = text;
    out = out.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');
    out = out.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
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
            '[iqc-sync.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
        );
    }
}

/**
 * Cursor keyset hợp lệ (allocated_at, allocationId) cho sweep.
 * @param {{ allocatedAt: unknown, allocationId: unknown } | null | undefined} cursor
 * @returns {boolean}
 */
function hasCursor(cursor) {
    return Boolean(
        cursor &&
        cursor.allocatedAt !== undefined &&
        cursor.allocatedAt !== null &&
        cursor.allocationId
    );
}

/**
 * Danh sách placeholder `?, ?, ...` cho mệnh đề IN.
 * @param {number} count
 * @returns {string}
 */
function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Dựng câu UPDATE động từ patch có key = TÊN CỘT DB (snake_case).
 * Vị trí mệnh đề trả về dòng vừa ghi khác nhau theo dialect: mssql đặt
 * OUTPUT TRƯỚC WHERE, pg bắt RETURNING ở CUỐI câu.
 * @param {string} table tên bảng thật (đã qua TABLES)
 * @param {Record<string, unknown>} patch object key = tên cột DB sẽ SET
 * @param {string} whereCol tên cột điều kiện
 * @param {unknown} whereValue giá trị cột điều kiện
 * @returns {{ text: string, values: unknown[] } | null} null nếu patch rỗng
 */
function buildRawUpdate(table, patch, whereCol, whereValue) {
    const keys = Object.keys(patch);
    if (keys.length === 0) return null;

    const sets = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => patch[key]);
    values.push(whereValue);

    const text = isPg()
        ? `UPDATE ${table} SET ${sets} WHERE ${whereCol} = ? RETURNING ${whereCol}`
        : `UPDATE ${table} SET ${sets} OUTPUT inserted.${whereCol} WHERE ${whereCol} = ?`;

    return { text, values };
}

// ==================== CLASS REPOSITORY ====================

class IqcSyncRepository {
    /**
     * Sweep candidate — allocation còn mở, còn theo dõi IQC và đã có ít nhất
     * 1 receipt mang lot thật (lot_no non-empty). Allocation chưa có lot
     * KHÔNG được enqueue IQC (spec case A). EXISTS giữ đúng 1 dòng/allocation
     * dù notice bị chia nhiều receipt.
     *
     * Cursor keyset (allocated_at, id) như Receipt Sync: trượt cửa sổ qua
     * các lượt để không bỏ đói allocation nằm ngoài batch đầu.
     *
     * @param {number} limit số allocation tối đa mỗi lượt
     * @param {{ allocatedAt: Date | string, allocationId: string } | null} [cursor]
     * @returns {Promise<Array<{ allocationId: string, allocatedAt: Date | string }>>}
     */
    async findIqcPendingAllocations(limit, cursor) {
        const keyset = hasCursor(cursor)
            ? `
      AND (a.allocated_at > ? OR (a.allocated_at = ? AND a.id > ?))`
            : '';
        const sql = `
    -- DECLARE @limit INT = 200;
    SELECT
      a.id AS [allocationId],
      a.allocated_at AS [allocatedAt]
    FROM whs_slot_allocation a
    WHERE a.closed_at IS NULL
      AND (
        a.status IN ('WAITING_IQC', 'WAITING_STOCK')
        OR (
          a.status = 'RETURNED'
          AND (
            a.iqc_decision = 'MIXED'
            OR (a.iqc_decision = 'FAIL_RETURN' AND (a.last_iqc_at IS NULL OR a.last_iqc_at >= ?))
          )
        )
      )
      AND COALESCE(a.warehouse_status, '') <> 'IN'
      AND EXISTS (
        SELECT 1
        FROM whs_allocation_receipt r
        WHERE r.allocation_id = a.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM whs_allocation_receipt r
        WHERE r.allocation_id = a.id
          AND (r.lot_no IS NULL OR LTRIM(RTRIM(r.lot_no)) = '')
      )${keyset}
    ORDER BY a.allocated_at ASC, a.id ASC
    OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY;
  `;
        const params = [previousMonthCutoff()];
        if (hasCursor(cursor)) {
            params.push(cursor.allocatedAt, cursor.allocatedAt, cursor.allocationId);
        }
        params.push(limit);
        guardParams(params);
        const { rows } = await db.query(toDialect(sql), params);
        return rows;
    }

    /**
     * Trạng thái hiện tại của allocation — dùng cho bước FIRST CHECK và
     * RECHECK bên trong transaction (Undo / Receipt Sync có thể đổi giữa
     * chừng).
     * @param {string} allocationId PK whs_slot_allocation
     * @param {Function} [query] executor (mặc định db.query; tx truyền txQuery)
     * @param {boolean} [lock] giữ khóa dòng đến hết transaction khi ghi IQC
     * @returns {Promise<{
     *   allocationId: string, status: string, warehouseStatus: string,
     *   iqcDecision: string | null, hasWarning: boolean, closedAt: unknown,
     *   qtyInStock: number | null, qtyReturn: number | null, lastIqcAt: unknown
     * } | null>}
     */
    async findAllocationForIqc(allocationId, query = db.query, lock = false) {
        const lockHint = lock && !isPg() ? ' WITH (UPDLOCK)' : '';
        const lockClause = lock && isPg() ? ' FOR UPDATE' : '';
        const sql = `
    -- DECLARE @allocationId VARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [allocationId],
      a.status AS [status],
      a.warehouse_status AS [warehouseStatus],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [lastIqcAt],
      a.status_recorded_at AS [statusRecordedAt],
      a.closed_at AS [closedAt]
    FROM whs_slot_allocation a${lockHint}
    WHERE a.id = ?${lockClause};
  `;
        const params = [allocationId];
        guardParams(params);
        const { rows } = await query(toDialect(sql), params);
        return rows[0] || null;
    }

    /**
     * Toàn bộ receipt mapping của allocation (nguồn số lượng thật của IQC:
     * receipt.received_qty, KHÔNG lấy allocation.allocated_qty).
     * @param {string} allocationId PK whs_slot_allocation
     * @param {Function} [query] executor (mặc định db.query; tx truyền txQuery)
     * @returns {Promise<Array<{
     *   id: string, allocationId: string, noticeDetailId: number,
     *   receivedQty: number, lotNo: string | null,
     *   iqcDecision: string | null, qtyInStock: number | null,
     *   qtyReturn: number | null, hasWarning: boolean, qcDate: unknown
     * }>>}
     */
    async findReceiptsForAllocation(allocationId, query = db.query) {
        const sql = `
    -- DECLARE @allocationId VARCHAR(40) = 'al_abc123';
    SELECT
      r.id AS [id],
      r.allocation_id AS [allocationId],
      r.notice_detail_id AS [noticeDetailId],
      CAST(r.received_qty AS FLOAT) AS [receivedQty],
      r.lot_no AS [lotNo],
      r.iqc_decision AS [iqcDecision],
      CAST(r.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(r.qty_return AS FLOAT) AS [qtyReturn],
      r.has_warning AS [hasWarning],
      r.qc_date AS [qcDate]
    FROM whs_allocation_receipt r
    WHERE r.allocation_id = ?
    ORDER BY r.notice_detail_id;
  `;
        const params = [allocationId];
        guardParams(params);
        const { rows } = await query(toDialect(sql), params);
        return rows;
    }

    /**
     * Số allocation ĐANG MỞ cùng tham chiếu tới từng notice — notice chia
     * cho nhiều allocation thì partial IQC không được tự chia (case M).
     * @param {number[]} noticeDetailIds
     * @returns {Promise<Array<{ noticeDetailId: number, activeAllocations: number }>>}
     */
    async countActiveAllocationsByNoticeIds(noticeDetailIds, query = db.query) {
        if (!Array.isArray(noticeDetailIds) || noticeDetailIds.length === 0) {
            return [];
        }
        const sql = `
    SELECT
      r.notice_detail_id AS [noticeDetailId],
      COUNT(DISTINCT r.allocation_id) AS [activeAllocations]
    FROM whs_allocation_receipt r
    INNER JOIN whs_slot_allocation a ON a.id = r.allocation_id
    WHERE r.notice_detail_id IN (${placeholders(noticeDetailIds.length)})
      AND a.closed_at IS NULL
    GROUP BY r.notice_detail_id;
  `;
        const params = noticeDetailIds.slice();
        guardParams(params);
        const { rows } = await query(toDialect(sql), params);
        return rows;
    }

    /**
     * Identity của notice T8 (pur_notice2) — cầu nối DUY NHẤT từ
     * receipt.notice_detail_id sang view IQC (spec §6: không query view chỉ
     * bằng lot).
     * @param {number[]} noticeDetailIds pur_notice2.id
     * @returns {Promise<Array<{
     *   noticeDetailId: number, sheetNo: string, sheetId: number,
     *   purNo: string, purId: number, goodsNo: string, madeLot: string | null,
     *   sheetQty: number
     * }>>}
     */
    async findNoticeIdentitiesByIds(noticeDetailIds) {
        if (!Array.isArray(noticeDetailIds) || noticeDetailIds.length === 0) {
            return [];
        }
        const sql = `
    SELECT
      n.id AS [noticeDetailId],
      n.sheet_no AS [sheetNo],
      n.sheet_id AS [sheetId],
      n.pur_no AS [purNo],
      n.pur_id AS [purId],
      n.goods_no AS [goodsNo],
      n.made_lot AS [madeLot],
      CAST(n.sheet_qty AS FLOAT) AS [sheetQty]
    FROM pur_notice2 n
    WHERE n.id IN (${placeholders(noticeDetailIds.length)});
  `;
        const params = noticeDetailIds.slice();
        guardParams(params);
        const { rows } = await db.query(toDialect(sql), params);
        return rows;
    }

    /**
     * IQC row(s) của view T8 theo ĐỦ 6 khóa identity. Trả về TẤT CẢ dòng
     * khớp (không TOP 1) — service quyết định >1 dòng là ambiguous.
     * `made_lot` bắt buộc non-null: không có lot thì không có IQC để match.
     * @param {Array<{
     *   sheetNo: string, sheetId: number, purNo: string,
     *   purId: number, goodsNo: string, madeLot: string
     * }>} identities
     * @returns {Promise<Array<{
     *   sheetNo: string, sheetId: number, purNo: string, purId: number,
     *   goodsNo: string, madeLot: string, sheetQty: number,
     *   returnQty: number | null,
     *   adjResult: unknown, proResult: unknown, qcDate: unknown
     * }>>}
     */
    async findIqcDetailsByIdentity(identities) {
        if (!Array.isArray(identities) || identities.length === 0) return [];

        const groupSql = `
      (LTRIM(RTRIM(iqc.sheet_no)) = LTRIM(RTRIM(?))
       AND iqc.sheet_id = ?
       AND LTRIM(RTRIM(iqc.pur_no)) = LTRIM(RTRIM(?))
       AND iqc.pur_id = ?
       AND LTRIM(RTRIM(iqc.goods_no)) = LTRIM(RTRIM(?))
       AND iqc.made_lot IS NOT NULL
       AND LTRIM(RTRIM(iqc.made_lot)) = LTRIM(RTRIM(?)))`;
        const sql = `
    SELECT
      iqc.sheet_no AS [sheetNo],
      iqc.sheet_id AS [sheetId],
      iqc.pur_no AS [purNo],
      iqc.pur_id AS [purId],
      iqc.goods_no AS [goodsNo],
      iqc.made_lot AS [madeLot],
      CAST(iqc.sheet_qty AS FLOAT) AS [sheetQty],
      CAST(iqc.return_qty AS FLOAT) AS [returnQty],
      iqc.adj_result AS [adjResult],
      iqc.pro_result AS [proResult],
      iqc.qc_date AS [qcDate]
    FROM v_pur_notice_detail iqc
    WHERE ${identities.map(() => groupSql.trim()).join('\n      OR ')};
  `;
        const params = [];
        for (const identity of identities) {
            params.push(
                identity.sheetNo,
                identity.sheetId,
                identity.purNo,
                identity.purId,
                identity.goodsNo,
                identity.madeLot
            );
        }
        guardParams(params);
        const { rows } = await db.query(toDialect(sql), params);
        return rows;
    }

    /**
     * Ghi tổng hợp IQC lên allocation (status / warehouse_status /
     * iqc_decision / qty_in_stock / qty_return / last_iqc_at / has_warning).
     * Receipt-level patch do ReceiptRepository.updateReceipt đảm nhiệm —
     * không duplicate builder ghi receipt ở đây.
     * @param {string} allocationId PK whs_slot_allocation
     * @param {Record<string, unknown>} patch key = tên cột DB (snake_case)
     * @param {Function} [query] executor (tx truyền txQuery)
     * @returns {Promise<boolean>} true nếu có dòng được cập nhật
     */
    async updateAllocationIqcSummary(allocationId, patch, query = db.query) {
        const update = buildRawUpdate(TABLES.allocation, patch, 'id', allocationId);
        if (!update) return false;
        guardParams(update.values);
        const { rows } = await query(toDialect(update.text), update.values);
        return Boolean(rows && rows[0]);
    }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
    module.exports = getMemoryRepository().iqcSync;
} else {
    module.exports = new IqcSyncRepository();
    module.exports.IqcSyncRepository = IqcSyncRepository;
}
