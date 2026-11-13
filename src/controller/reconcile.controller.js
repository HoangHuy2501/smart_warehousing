/**
 * Controller RECONCILE ISSUE — kiến trúc Kanban (controller mỏng).
 *
 * Vai trò module: controller mỏng — đọc query → gọi service singleton →
 * tạo HTTP response, không chứa business logic hay SQL. Domain phụ
 * trách: whs_reconcile_issue (EXCESS/SHORTAGE/AMBIGUOUS/T8_CHANGED) —
 * API structured DTO cho UI cảnh báo reconcile (2026-10-28 BỔ SUNG
 * #1-#22; FE KHÔNG parse note, KHÔNG tự suy candidates).
 */

'use strict';

const ReconcileIssueService = require('../services/reconcile-issue.service');

// GET /api/warehouse/reconcile-issues — danh sách issue OPEN kèm context
// (candidates AMBIGUOUS, change T8_CHANGED, số lượng có dấu).
const listReconcileIssues = async (req, res) => {
    const raw = Number(req.query.limit);
    const limit =
        Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 500) : 200;
    res.json(await ReconcileIssueService.listOpenIssueDtos({ limit }));
};

module.exports = { listReconcileIssues };
