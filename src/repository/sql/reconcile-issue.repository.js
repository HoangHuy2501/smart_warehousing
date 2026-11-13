'use strict';

/**
 * Repository whs_reconcile_issue — PERSIST LỆCH RECONCILE của Receipt Sync
 * Worker (#33-#36): SHORTAGE / EXCESS / AMBIGUOUS / T8_CHANGED.
 *
 * TẠI SAO PHẢI CÓ BẢNG: kết quả reconcile trước đây chỉ nằm trong log —
 * worker chạy lại không còn dấu vết, user không thấy cảnh báo tồn tại
 * bao lâu. Bảng này là kênh audit + danh sách cảnh báo cho user/manager.
 *
 * IDEMPOTENCY (#36): dedup_key = type|allocationId|noticeDetailId, filtered
 * unique index CHỈ trên status='OPEN' → worker chạy lại 10 lần KHÔNG tạo
 * 10 issue OPEN (upsert cập nhật dòng OPEN cũ: difference/note/updated_at).
 * Vòng đời: OPEN → (lệch hết) → RESOLVED — hàng history giữ lại phục vụ audit.
 *
 * ⚠️ BẢNG CHƯA CÓ TRÊN SQL SERVER THẬT — đây là ĐỀ XUẤT DDL (chờ user
 * approve): db/migrations/2026-10-26-whs-reconcile-issue.sql. Khi bảng
 * còn thiếu, mọi method log warn 'reconcile_issue_table_missing' (kèm 1
 * dòng/15s tránh spam) và trả kết quả rỗng — CORE RECEIPT PATH KHÔNG
 * bị chặn, chỉ mất kênh audit cho tới khi approve. Đây là degradation
 * CÓ LOG + CÓ KẾ HOẠCH, không phải swallow lặng.
 *
 * DDL sandbox (test-postgres) được test tự tạo qua lark-cli +db-execute —
 * bảng thật của user CHỈ tạo khi user chạy migration proposal.
 *
 * DB_MODE=memory thì module.exports swap sang cắt lát của memory
 * repository (bảng in-memory luôn "tồn tại" → test logic thật).
 */

const db = require('../../config/db');
const { TABLES } = require('./tables');
const { createWorkerLogger } = require('../../util/worker/logger');

const logger = createWorkerLogger('reconcile-issue.repository');

/** Tên bảng logic (viết trong SQL) -> tên thật (kèm tiền tố nếu có). */
const TABLE_PAIRS = [['whs_reconcile_issue', TABLES.reconcileIssue]];

// ==================== PRIVATE: HỖ TRỢ DIALECT ====================

function isPg() {
    return db.getDialect() === 'pg';
}

function toDialect(text) {
    if (!isPg()) return text;
    let out = text;
    out = out.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');
    out = out.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
    out = out.replace(/\bLIKE\b/g, 'ILIKE');
    out = out.replace(/\bGETDATE\s*\(\s*\)/gi, 'NOW()');
    // mssql TOP n … ORDER BY … → pg … ORDER BY … LIMIT n (find TOP 1 trong
    // upsertOpenIssue) — giữ inner join/where nguyên vẹn, chỉ thêm LIMIT cuối.
    out = out.replace(
        /(SELECT\s+)TOP\s+(\d+)([\s\S]*?)(;)/gi,
        (match, sel, top, body) => `${sel}${body} LIMIT ${top};`
    );
    // mssql OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY → pg LIMIT ? (listOpenIssues;
    // placeholder `?` giữ nguyên cho db.js đánh số $n).
    out = out.replace(
        /OFFSET\s+\d+\s+ROWS\s+FETCH\s+NEXT\s+(\?)\s+ROWS\s+ONLY/gi,
        'LIMIT $1'
    );
    for (const [logical, actual] of TABLE_PAIRS) {
        if (logical === actual) continue;
        out = out.replace(new RegExp(`\\b${logical}\\b`, 'g'), actual);
    }
    return out;
}

function guardParams(params) {
    if (params.includes(undefined)) {
        throw new Error(
            '[reconcile-issue.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
        );
    }
}

/**
 * Bảng whs_reconcile_issue chưa được tạo (mssql 208 / pg 42P01)?
 * Drizzle/proxy pg có thể giấu code trong cause chain.
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingTable(error) {
    const anyError = /** @type {any} */ (error);
    if (Number(anyError.number) === 208) return true;
    let current = error;
    for (
        let depth = 0;
        current && typeof current === 'object' && depth < 4;
        depth += 1
    ) {
        const code = String((/** @type {any} */ (current)).code);
        if (code === '42P01' || code === '42502') return true;
        current = (/** @type {any} */ (current)).cause;
    }
    return false;
}

/** Thời điểm log 'table_missing' gần nhất — 15s/lần, không spam log. */
let lastMissingTableWarnAt = 0;

/**
 * Bọc write/read: bảng còn thiếu → warn (giới hạn tần suất) + trả
 * fallback — caller xem kết quả null/[] là "chưa có kênh audit".
 * @template T
 * @param {string} action nhãn log
 * @param {() => Promise<T>} fn
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function softGuardTable(action, fn, fallback) {
    try {
        return await fn();
    } catch (error) {
        if (!isMissingTable(error)) throw error;
        const now = Date.now();
        if (now - lastMissingTableWarnAt > 15000) {
            lastMissingTableWarnAt = now;
            logger.warn('reconcile_issue_table_missing', {
                action,
                hint: 'Chạy db/migrations/2026-10-26-whs-reconcile-issue.sql trên SQL Server để bật kênh audit lệch reconcile (core sync KHÔNG bị ảnh hưởng)',
            });
        }
        return fallback;
    }
}

/**
 * Dedup key idempotency — 3 phần tách bằng '|', KHÔNG chứa thông tin
 * nhạy cảm, dài tối đa ~120 ký tự (cột VARCHAR(120)).
 * @param {{ type: string, allocationId: string | null,
 *   noticeDetailId: number | null }} issue
 * @returns {string}
 */
function buildDedupKey(issue) {
    return `${issue.type}|${issue.allocationId || ''}|${issue.noticeDetailId || ''}`;
}

class ReconcileIssueRepository {
    /**
     * Upsert issue OPEN — dòng OPEN cùng dedup_key thì CẬP NHẬT
     * (difference_qty/note/updated_at), không nhân bản (#36).
     * Race 2 writer cùng insert (hiếm — filtered UQ chỉ chặn khi đều OPEN)
     * → bắt unique violation → refetch + update (idempotent).
     *
     * @param {{ type: string, allocationId: string | null, poId: number,
     *   goodsNo: string, slotCode: string | null,
     *   noticeDetailId: number | null, differenceQty: number, note: string }} issue
     * @param {Function} [query] bộ query — truyền txQuery để chạy trong tx
     * @returns {Promise<string | null>} id issue OPEN (null = bảng chưa tạo)
     */
    async upsertOpenIssue(issue, query = db.query) {
        const dedupKey = buildDedupKey(issue);
        const nowIso = new Date().toISOString();

        return softGuardTable('upsertOpenIssue', async () => {
            const findSql = `
      -- DECLARE @dedupKey NVARCHAR(120) = 'EXCESS|al_xxx|340417';
      SELECT TOP 1
        id AS [id],
        status AS [status]
      FROM whs_reconcile_issue
      WHERE dedup_key = ? AND status = 'OPEN'
      ORDER BY updated_at DESC;
    `;
            const findParams = [dedupKey];
            guardParams(findParams);
            const found = await query(toDialect(findSql), findParams);
            const existing = found.rows && found.rows[0] ? found.rows[0] : null;

            if (existing) {
                const updSql = `
        UPDATE whs_reconcile_issue
        SET po_id = ?, goods_no = ?, slot_code = ?, difference_qty = ?,
            note = ?, updated_at = ?
        WHERE id = ? AND status = 'OPEN';
      `;
                const updParams = [
                    issue.poId,
                    issue.goodsNo,
                    issue.slotCode,
                    issue.differenceQty,
                    issue.note,
                    nowIso,
                    existing.id,
                ];
                guardParams(updParams);
                await query(toDialect(updSql), updParams);
                return String(existing.id);
            }

            const insSql = `
      INSERT INTO whs_reconcile_issue (
        id, dedup_key, issue_type, allocation_id, notice_detail_id,
        po_id, goods_no, slot_code, difference_qty, status, note,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?);
    `;
            const newId = `rci-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
            const insParams = [
                newId,
                dedupKey,
                issue.type,
                issue.allocationId,
                issue.noticeDetailId,
                issue.poId,
                issue.goodsNo,
                issue.slotCode,
                issue.differenceQty,
                issue.note,
                nowIso,
                nowIso,
            ];
            guardParams(insParams);
            try {
                await query(toDialect(insSql), insParams);
                return newId;
            } catch (error) {
                const { isUniqueViolation } = require('../../util/worker/errors');
                if (!isUniqueViolation(error)) throw error;
                // Thằng khác vừa insert cùng dedup_key — update dòng đó.
                const refetch = await query(toDialect(findSql), findParams);
                const row = refetch.rows && refetch.rows[0] ? refetch.rows[0] : null;
                if (!row) return null;
                const updParams = [
                    issue.poId,
                    issue.goodsNo,
                    issue.slotCode,
                    issue.differenceQty,
                    issue.note,
                    nowIso,
                    row.id,
                ];
                guardParams(updParams);
                await query(toDialect(updSql), updParams);
                return String(row.id);
            }
        }, null);
    }

    /**
     * Dọn MỌI issue OPEN của 1 allocation (allocation đã nhận đủ / đã sạch
     * ở revalidation). History giữ nguyên (status=RESOLVED + resolved_at).
     * @param {string} allocationId
     * @param {Function} [query]
     * @returns {Promise<number | null>} số dòng đã resolve (null = bảng chưa tạo)
     */
    async resolveOpenIssuesForAllocation(allocationId, query = db.query) {
        return softGuardTable('resolveOpenIssuesForAllocation', async () => {
            const sql = `
      UPDATE whs_reconcile_issue
      SET status = 'RESOLVED', updated_at = ?, resolved_at = ?
      WHERE allocation_id = ? AND status = 'OPEN';
    `;
            const params = [new Date().toISOString(), new Date().toISOString(), allocationId];
            guardParams(params);
            const result = await query(toDialect(sql), params);
            const affected = Number(
                (result && result.rowsAffected) || (result && result.rowCount) || 0
            );
            return affected;
        }, null);
    }
    /**
  * UNDO ASSIGN (2026-11-07): resolve MỌI issue OPEN của 1 allocation bị
  * hoàn tác — KHÔNG delete history, chỉ OPEN → RESOLVED kèm người
  * resolve và note lý do undo (issue_type / difference_qty giữ nguyên làm
  * source-of-truth). KHÔNG đụng issue của allocation khác hay issue
  * allocation_id IS NULL. Chạy trong transaction Undo của service.
  * @param {string} allocationId PK allocation
  * @param {{ resolvedByEmpNo: string, note: string }} undoInfo người thực
  *   hiện undo (không phải người gán kệ) + note lý do, ≤ 500 ký tự
  * @param {Function} [query] executor (mặc định db.query; Undo truyền
  *   txQuery để resolve trong cùng transaction)
  * @returns {Promise<number | null>} số dòng đã resolve (null = bảng
  *   chưa tạo — soft guard như resolveOpenIssuesForAllocation)
  */
    async resolveOpenIssuesForUndo(allocationId, undoInfo, query = db.query) {
        return softGuardTable('resolveOpenIssuesForUndo', async () => {
            const now = new Date().toISOString();
            const sql = `
      UPDATE whs_reconcile_issue
      SET status = 'RESOLVED',
          updated_at = ?,
          resolved_at = ?,
          resolved_by_emp_no = ?,
          note = ?
      WHERE allocation_id = ? AND status = 'OPEN';
    `;
            const params = [
                now,
                now,
                undoInfo.resolvedByEmpNo,
                String(undoInfo.note || '').slice(0, 500),
                allocationId,
            ];
            guardParams(params);
            const result = await query(toDialect(sql), params);
            const affected = Number(
                (result && result.rowsAffected) || (result && result.rowCount) || 0
            );
            return affected;
        }, null);
    }
    /**
     * Dọn issue OPEN cho CẢ BATCH allocation sạch trong 1 câu UPDATE
     * (sweep phase-2 gọi sau khi recheck xong — tránh N+1: 1 UPDATE cho
     * N allocation, #46; bản đơn chiếc resolveOpenIssuesForAllocation
     * vẫn giữ cho sync path chạy trong tx).
     * @param {string[]} allocationIds danh sách id allocation sạch
     * @param {Function} [query]
     * @returns {Promise<number | null>} số dòng đã resolve (null = bảng chưa tạo)
     */
    async resolveOpenIssuesForAllocationIds(allocationIds, query = db.query) {
        return softGuardTable(
            'resolveOpenIssuesForAllocationIds',
            async () => {
                if (!allocationIds || allocationIds.length === 0) return 0;
                const nowIso = new Date().toISOString();
                const placeholders = allocationIds.map(() => '?').join(', ');
                const sql = `
        UPDATE whs_reconcile_issue
        SET status = 'RESOLVED', updated_at = ?, resolved_at = ?
        WHERE status = 'OPEN' AND allocation_id IN (${placeholders});
      `;
                const params = [nowIso, nowIso, ...allocationIds];
                guardParams(params);
                const result = await query(toDialect(sql), params);
                return Number(
                    (result && result.rowsAffected) || (result && result.rowCount) || 0
                );
            },
            null
        );
    }

    /**
     * Dọn issue OPEN cấp NOTICE (allocation_id IS NULL — SHORTAGE
     * notice-level) khi notice đã được reconcile đủ.
     * @param {number} noticeDetailId
     * @param {Function} [query]
     * @returns {Promise<number | null>}
     */
    async resolveOpenIssuesForNotice(noticeDetailId, query = db.query) {
        return softGuardTable('resolveOpenIssuesForNotice', async () => {
            const sql = `
      UPDATE whs_reconcile_issue
      SET status = 'RESOLVED', updated_at = ?, resolved_at = ?
      WHERE notice_detail_id = ? AND allocation_id IS NULL AND status = 'OPEN';
    `;
            const params = [new Date().toISOString(), new Date().toISOString(), noticeDetailId];
            guardParams(params);
            const result = await query(toDialect(sql), params);
            const affected = Number(
                (result && result.rowsAffected) || (result && result.rowCount) || 0
            );
            return affected;
        }, null);
    }

    /**
     * Dọn issue OPEN THEO (allocation, type) — resolve có scope (#29): khi
     * allocation nhận đủ, chỉ EXCESS/AMBIGUOUS của allocation hết hiệu lực;
     * T8_CHANGED của notice khác + SHORTAGE notice-level phải GIỮ OPEN để
     * user đối chiếu. Blanket resolve theo allocation là sai ở điểm này.
     * @param {string} issueType EXCESS / AMBIGUOUS / T8_CHANGED …
     * @param {string} allocationId
     * @param {Function} [query] truyền txQuery để chạy trong tx
     * @returns {Promise<number | null>} số dòng đã resolve (null = bảng chưa tạo)
     */
    async resolveOpenIssuesByTypeForAllocation(
        issueType,
        allocationId,
        query = db.query
    ) {
        return softGuardTable(
            'resolveOpenIssuesByTypeForAllocation',
            async () => {
                const sql = `
      UPDATE whs_reconcile_issue
      SET status = 'RESOLVED', updated_at = ?, resolved_at = ?
      WHERE issue_type = ? AND allocation_id = ? AND status = 'OPEN';
    `;
                const params = [
                    new Date().toISOString(),
                    new Date().toISOString(),
                    issueType,
                    allocationId,
                ];
                guardParams(params);
                const result = await query(toDialect(sql), params);
                return Number(
                    (result && result.rowsAffected) || (result && result.rowCount) || 0
                );
            },
            null
        );
    }

    /**
     * Allocation còn issue OPEN nào không — phục vụ recompute has_warning
     * (#30): sau resolve/upsert trong tx, gọi 1 câu EXISTS nhẹ này rồi mirror
     * kết quả vào whs_slot_allocation.has_warning (giữ IQC FAIL bên service).
     * @param {string} allocationId
     * @param {Function} [query] truyền txQuery để chạy trong tx
     * @returns {Promise<boolean>} true nếu còn ≥1 issue OPEN (bảng chưa tạo → false)
     */
    async hasOpenIssueForAllocation(allocationId, query = db.query) {
        return softGuardTable(
            'hasOpenIssueForAllocation',
            async () => {
                const sql = `
      SELECT TOP 1 1 AS [hasOpen]
      FROM whs_reconcile_issue
      WHERE allocation_id = ? AND status = 'OPEN';
    `;
                const params = [allocationId];
                guardParams(params);
                const { rows } = await query(toDialect(sql), params);
                return Boolean(rows && rows[0]);
            },
            false
        );
    }

    /**
     * Danh sách issue OPEN mới nhất trước (dùng cho debug / list cảnh báo).
     * @param {number} [limit=100]
     * @param {Function} [query]
     * @returns {Promise<Array<object>>} row camelCase (rỗng nếu bảng chưa tạo)
     */
    async listOpenIssues(limit = 100, query = db.query) {
        return softGuardTable('listOpenIssues', async () => {
            const sql = `
      -- DECLARE @limit INT = 100;
      SELECT
        id AS [id],
        dedup_key AS [dedupKey],
        issue_type AS [type],
        allocation_id AS [allocationId],
        notice_detail_id AS [noticeDetailId],
        po_id AS [poId],
        goods_no AS [goodsNo],
        slot_code AS [slotCode],
        CAST(difference_qty AS FLOAT) AS [differenceQty],
        status AS [status],
        note AS [note],
        created_at AS [createdAt],
        updated_at AS [updatedAt],
        resolved_at AS [resolvedAt]
      FROM whs_reconcile_issue
      WHERE status = 'OPEN'
      ORDER BY updated_at DESC
      OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY;
    `;
            const params = [limit];
            guardParams(params);
            const { rows } = await query(toDialect(sql), params);
            return rows;
        }, []);
    }

    /**
     * Issue OPEN của 1 allocation — phục vụ test/verify.
     * @param {string} allocationId
     * @param {Function} [query]
     * @returns {Promise<Array<object>>}
     */
    async findOpenByAllocation(allocationId, query = db.query) {
        return softGuardTable('findOpenByAllocation', async () => {
            const sql = `
      SELECT
        id AS [id],
        issue_type AS [type],
        notice_detail_id AS [noticeDetailId],
        CAST(difference_qty AS FLOAT) AS [differenceQty],
        status AS [status],
        note AS [note],
        updated_at AS [updatedAt]
      FROM whs_reconcile_issue
      WHERE allocation_id = ? AND status = 'OPEN'
      ORDER BY updated_at DESC;
    `;
            const params = [allocationId];
            guardParams(params);
            const { rows } = await query(toDialect(sql), params);
            return rows;
        }, []);
    }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
    module.exports = getMemoryRepository().reconcileIssue;
} else {
    module.exports = new ReconcileIssueRepository();
    module.exports.ReconcileIssueRepository = ReconcileIssueRepository;
}
