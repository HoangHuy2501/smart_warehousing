/**
 * Repository in-memory (chế độ KHÔNG DB) — fallback khi không cấu hình DB
 * nào (DB_MODE=memory), dùng cho dev / demo.
 *
 * VAI TRÒ: mô phỏng ĐẦY ĐỦ interface của các sql/*.repository.js (các bảng
 * whs_* + t8_* mock, FINAL WHS DATABASE CORRECTION 2026-10-17). Dữ liệu nằm
 * trong các array snake_case trùng key seed-data.js; allocation × notice
 * nằm trong data.receipts (mirror whs_allocation_receipt).
 *
 * RÀNG BUỘC QUAN TRỌNG NHẤT: file này PHẢI mirror hành vi SQL mode một cách
 * CHÍNH XÁC — cùng bộ lọc (eligibility NPL M1-M6 + A2 qua regex
 * ELIGIBLE_NPL_RE = /^(M[1-6]|A2)/, keyword, bucket ETA), cùng guard null
 * ('=== null' / '!== null' trên closed_at, ended_at...), cùng thứ tự nghiệp
 * vụ (ORDER BY, close-then-insert...). Nếu SQL mode đổi thì file này phải
 * đổi theo — hai mode không được lệch kết quả.
 *
 * CẤU TRÚC: makeMemoryRepository() là factory xây store; mọi access đi qua
 * getMemoryRepository() — singleton dùng chung để các file sql/*.repository.js
 * ở chế độ memory chia sẻ cùng một instance.
 *
 * LƯU Ý SEED: dòng seed có thể thiếu field nullable (undefined) nên được
 * chuẩn hóa ngay khi clone (ví dụ closed_at: a.closed_at ?? null) — xem
 * chú thích tại data.allocations bên dưới; từng gây bug, giữ nguyên hành vi.
 *
 * MẤT dữ liệu khi restart server.
 */

'use strict';

const { previousMonthCutoff } = require('../util/month-cutoff');
const { buildSeed } = require('../config/seed-data');
const { TEST_ACCOUNTS } = require('../config/test-accounts');
const { noticeCutoffDate } = require('../util/bucket-dates');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Đổi giá trị ngày giờ thành chuỗi ISO (null giữ nguyên). */
function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

/** NUMERIC chuẩn hóa về number (null giữ nguyên). */
function numOrNull(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/**
 * Seed phân công thủ kho NPL (whs_keeper_material_assignment) — key
 * camelCase theo store của slice materials: mỗi goods chỉ 1 dòng active
 * (endedAt = null). TEST-KPR / EMP001 = KEEPER, TEST-MGR / EMP003 = MANAGER.
 */
// 2026-10-21 (CR): bỏ các dòng seed ITEM-* — eligibility NPL giờ là
// M1-M6 + A2 (dữ liệu cũ ITEM-SPCC/PIPE/CR không còn hợp lệ).
// TEST-KPR chỉ thấy M1001/M2002, EMP001 thấy M3003/M4004,
// EMP002 thấy M6006, M5005 đã kết thúc → không ai phụ trách.
const SEED_MATERIAL_ASSIGNMENTS = [
  {
    id: 'kma-seed-06',
    goodsNo: 'M1001',
    keeperEmpNo: 'TEST-KPR',
    assignedByEmpNo: 'TEST-MGR',
    assignedAt: '2026-10-19T02:00:00.000Z',
    endedAt: null,
    note: 'NPL thép tấm',
  },
  {
    id: 'kma-seed-07',
    goodsNo: 'M2002',
    keeperEmpNo: 'TEST-KPR',
    assignedByEmpNo: 'TEST-MGR',
    assignedAt: '2026-10-19T02:00:00.000Z',
    endedAt: null,
    note: 'NPL ống thép',
  },
  {
    id: 'kma-seed-08',
    goodsNo: 'M3003',
    keeperEmpNo: 'EMP001',
    assignedByEmpNo: 'EMP003',
    assignedAt: '2026-10-18T03:00:00.000Z',
    endedAt: null,
    note: null,
  },
  {
    id: 'kma-seed-09',
    goodsNo: 'M4004',
    keeperEmpNo: 'EMP001',
    assignedByEmpNo: 'EMP003',
    assignedAt: '2026-10-18T03:00:00.000Z',
    endedAt: null,
    note: null,
  },
  {
    id: 'kma-seed-10',
    goodsNo: 'M5005',
    keeperEmpNo: 'EMP002',
    assignedByEmpNo: 'EMP003',
    assignedAt: '2026-10-10T03:00:00.000Z',
    endedAt: '2026-10-15T03:00:00.000Z',
    note: 'Đã kết thúc — M5005 hiện không ai phụ trách',
  },
  {
    id: 'kma-seed-11',
    goodsNo: 'M6006',
    keeperEmpNo: 'EMP002',
    assignedByEmpNo: 'EMP003',
    assignedAt: '2026-10-17T03:00:00.000Z',
    endedAt: null,
    note: null,
  },
];

function makeMemoryRepository() {
  const seed = buildSeed();
  const data = {
    emps: clone(seed.emps),
    userRoles: clone(seed.userRoles),
    goods: clone(seed.goods),
    order1: clone(seed.order1),
    order2: clone(seed.order2),
    notice1: clone(seed.notice1),
    notice2: clone(seed.notice2),
    in1: clone(seed.in1),
    in2: clone(seed.in2),
    slots: clone(seed.slots),
    // KNOWN PITFALL (giữ nguyên, KHÔNG "sửa" hành vi): dòng seed có thể
    // thiếu field nullable (undefined) nên closed_at phải được chuẩn hóa về
    // null ngay khi clone — nếu bỏ, các guard chặt '=== null'/'!== null'
    // sẽ sai với undefined. Đây từng là bug; phép chuẩn hóa này là cố ý.
    allocations: clone(seed.allocations).map((a) => ({ ...a, closed_at: a.closed_at ?? null })),
    receipts: clone(seed.receipts),
    assignments: clone(SEED_MATERIAL_ASSIGNMENTS),
    movements: [],
    activity: clone(seed.activity),
    // whs_reconcile_issue — mirror của reconcile-issue.repository (memory
    // mode bảng luôn "tồn tại", test chạy logic persistence thật).
    reconcileIssues: [],
  };

  // Tài khoản test raw TEST-MGR / TEST-KPR (mirror ensureStartup của
  // repository/index.js — chế độ memory bỏ qua ensureStartup nên chèn tại
  // đây, idempotent: không ghi đè dữ liệu seed / user tạo sẵn).
  for (const acc of TEST_ACCOUNTS) {
    if (!data.userRoles.some((r) => r.emp_no === acc.emp_no)) {
      data.userRoles.push({
        emp_no: acc.emp_no,
        role: acc.role,
        password: acc.password,
        locked: acc.locked,
        active: acc.active,
      });
    }
    if (!data.emps.some((e) => e.emp_no === acc.emp_no)) {
      data.emps.push({
        id: 90001 + data.emps.length,
        emp_no: acc.emp_no,
        emp_name: acc.emp_name,
        email: acc.email,
        dept_no: 'GI-IT',
        org_no: 'GI',
        duty_no: 'NV',
        act_sw: 'Y',
      });
    }
  }

  // ---- Bộ tìm kiếm cơ bản (dòng snake_case) ----
  const findEmp = (empNo) => data.emps.find((e) => e.emp_no === empNo) || null;
  const findGoods = (no) => data.goods.find((g) => g.goods_no === no) || null;
  const findOrder2 = (id) =>
    data.order2.find((o) => String(o.id) === String(id)) || null;
  const findNotice2 = (id) =>
    data.notice2.find((n) => String(n.id) === String(id)) || null;
  const findSlotRow = (code) => data.slots.find((s) => s.code === code) || null;
  const findAlloc = (id) =>
    data.allocations.find((a) => a.id === id) || null;

  /** order1 theo khóa ĐÃ XÁC NHẬN: o1.sheet_no = o2.sheet_no. */
  const order1BySheetNo = (sheetNo) =>
    data.order1.find((o) => o.sheet_no === sheetNo) || null;

  /**
   * So sánh keyset (allocated_at, id) LỚN HƠN cursor — mirror ngữ nghĩa
   * `COALESCE > ? OR (= ? AND id > ?)` của bản SQL (cursor starvation #9).
   * Dùng cho findPendingAllocations / findRevalidationCandidates (memory).
   * @param {{ allocated_at: string | null, id: string }} a dòng allocation
   * @param {{ allocatedAt: Date | string, allocationId: string } | null} cursor
   * @returns {boolean}
   */
  function keysetAfter(a, cursor) {
    if (!cursor) return true;
    const at = String(a.allocated_at || '');
    const curAt = String(cursor.allocatedAt || '');
    if (at !== curAt) return at > curAt;
    return String(a.id) > String(cursor.allocationId);
  }

  /**
   * So khớp text kiểu SQL Server collation: trim + không phân biệt hoa
   * thường — mirror LTRIM(RTRIM(x)) của IQC Sync repository.
   * @param {unknown} a
   * @param {unknown} b
   * @returns {boolean}
   */
  function sameText(a, b) {
    const norm = (v) =>
      String(v === null || v === undefined ? '' : v).trim().toUpperCase();
    return norm(a) === norm(b);
  }

  /** Receipt đã có lot thật? (mirror LTRIM(RTRIM(lot_no)) <> '') */
  function hasLotValue(v) {
    return typeof v === 'string' && v.trim() !== '';
  }

  /** Mirror goods + assignment active (ended_at IS NULL) của material.repository. */
  function mapMaterialItem(g) {
    const active =
      data.assignments.find(
        (a) => a.goodsNo === g.goods_no && a.endedAt == null
      ) || null;
    const emp = active ? findEmp(active.keeperEmpNo) : null;
    return {
      goodsNo: g.goods_no,
      goodsName: g.goods_name,
      keeperEmpNo: active ? active.keeperEmpNo : null,
      keeperName: active && emp ? emp.emp_name : null,
      assignedAt: active ? isoOrNull(active.assignedAt) : null,
      isAssigned: active !== null,
    };
  }

  /** Mirror byGoodsHistory của material.repository (shape camelCase). */
  function mapMaterialHistoryRow(a) {
    const keeper = findEmp(a.keeperEmpNo);
    const assigner = findEmp(a.assignedByEmpNo);
    return {
      keeperEmpNo: a.keeperEmpNo,
      keeperName: keeper ? keeper.emp_name : null,
      assignedByEmpNo: a.assignedByEmpNo,
      assignedByName: assigner ? assigner.emp_name : null,
      assignedAt: isoOrNull(a.assignedAt),
      endedAt: isoOrNull(a.endedAt),
      note: a.note ?? null,
    };
  }

  /**
   * Lot đã GRN theo khóa ĐÃ XÁC NHẬN: pur_in2 (pur_no, goods_no,
   * made_lot) khớp pur_notice2 (pur_no, goods_no, made_lot).
   */
  function in2HasLot(n) {
    return data.in2.some(
      (i) =>
        i.pur_no === n.pur_no &&
        i.goods_no === n.goods_no &&
        i.made_lot === n.made_lot
    );
  }

  /**
   * Eligibility NPL 2026-10-21 (change request): goods_no bắt đầu M1..M6
   * hoặc A2 — mirror SQL LIKE 'M1%'..'M6%' + 'A2%'. Regex: /^(M[1-6]|A2)/.
   * TODO(PACKING): chưa có rule — KHÔNG đoán bằng goods_name.
   */
  const ELIGIBLE_NPL_RE = /^(M[1-6]|A2)/;

  /**
   * PO ứng viên cho /pos (mirror fillPoTemp của po.repository ở SQL mode):
   * order1 join theo sheet_no, close_sw IN ('N','0'), creator có hồ sơ
   * bas_emp và khác ADM. FILTER (2026-10-20, Phase 2):
   *   - approved: bỏ PO chưa duyệt (sheet_sta = '0' hoặc NULL — mirror
   *     SQL o1.sheet_sta <> '0': NULL cũng bị loại);
   *   - eligibility NPL M1..M6 / A2 (ELIGIBLE_NPL_RE);
   *   - keeper scope: KEEPER chỉ thấy NPL được phân công active cho chính
   *     mình (keeperEmpNo từ SESSION; manager => null => không lọc).
   * Trả về o1 nếu hợp lệ, ngược lại null.
   */
  function poCandidate(o2, keeperEmpNo) {
    const o1 = order1BySheetNo(o2.sheet_no);
    if (o1 === null) return null;
    if (o1.close_sw !== 'N' && o1.close_sw !== '0') return null;
    if (o1.sheet_sta == null || o1.sheet_sta === '0') return null;
    if (!ELIGIBLE_NPL_RE.test(String(o2.goods_no || ''))) return null;
    const emp = findEmp(o1.create_user);
    if (emp === null || emp.emp_name === 'ADM') return null;
    if (keeperEmpNo) {
      const assigned = data.assignments.some(
        (a) =>
          a.goodsNo === o2.goods_no &&
          a.keeperEmpNo === keeperEmpNo &&
          a.endedAt == null
      );
      if (!assigned) return null;
    }
    return o1;
  }

  /**
   * Ngày định dạng YYYY-MM-DD từ giá trị datetime (NULL / sai -> null).
   * Lấy trực tiếp tiền tố chuỗi (mirror CONVERT(DATE, x) của SQL Server —
   * không qua timezone của JS Date).
   */
  function dayKey(value) {
    if (value === null || value === undefined) return null;
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  /**
   * Notice khớp 1 dòng PO theo KEY FINAL [R2] (PO identity fix
   * 2026-10-29): pur_no = sheet_no + goods_no + def02 (null-safe) VÀ
   * pur_id = sheet_id — 1 PO nhiều dòng cùng goods/def02 phải tách dòng
   * bằng pur_id, notice của dòng khác KHÔNG fan-out. pur_id NULL (legacy)
   * không match dòng nào (safe unresolved). 2026-10-28 user duyệt bỏ điều
   * kiện ngày; sheet_lot ĐÃ BỊ CHỨNG MINH không phải khóa nên bỏ hoàn toàn.
   */
  function noticesOfOrder2(o2) {
    const o1 = order1BySheetNo(o2.sheet_no);
    if (o1 === null) return [];
    return data.notice2.filter(
      (n) =>
        n.pur_no === o1.sheet_no &&
        n.goods_no === o2.goods_no &&
        String(n.pur_id) === String(o2.sheet_id) &&
        String(n.def02 ?? '') === String(o2.def02 ?? '')
    );
  }

  /** Dòng PO khớp 1 notice theo KEY FINAL [R2] (đảo ngược noticesOfOrder2) —
   *  pur_id của notice trỏ về sheet_id DÒNG PO (PO identity fix 2026-10-29):
   *  notice pur_id NULL/invalid không map về dòng nào (safe unresolved). */
  function order2OfNotice(n) {
    return (
      data.order2.find(
        (o) =>
          o.sheet_no === n.pur_no &&
          o.goods_no === n.goods_no &&
          String(o.sheet_id) === String(n.pur_id) &&
          String(o.def02 ?? '') === String(n.def02 ?? '')
      ) || null
    );
  }

  /** Tổng GRN theo DÒNG PO (pur_no + pur_id = sheet_id + goods_no) — mirror
   *  subquery grn của lot/po.repository (PO identity fix 2026-10-29 —
   *  pur_in2.pur_id là SHEET_ID dòng PO, KHÔNG phải order2.id). */
  function grnAgg(purNo, sheetId, goodsNo) {
    const rows = data.in2.filter(
      (i) =>
        String(i.pur_no) === String(purNo) &&
        String(i.pur_id) === String(sheetId) &&
        i.goods_no === goodsNo
    );
    if (rows.length === 0) return null;
    let receivedAt = null;
    for (const row of rows) {
      const in1 = data.in1.find((h) => String(h.sheet_no) === String(row.sheet_no));
      const date = in1 ? in1.sheet_date : null;
      if (date && (!receivedAt || date > receivedAt)) receivedAt = date;
    }
    return {
      grnQty: rows.reduce((sum, row) => sum + Number(row.sheet_qty || 0), 0),
      grnNo: rows.map((row) => row.sheet_no).sort().pop() || null,
      receivedAt,
    };
  }

  // ---- Mappers (mirror sql/*.repository.js) ----

  function mapAccountRow(role, empName, email) {
    return {
      id: role.emp_no,
      name: empName,
      employeeCode: role.emp_no,
      email,
      role: role.role,
      locked: Boolean(role.locked),
      password: role.password,
      active: role.active,
    };
  }

  function mapSlotRow(row, occupied) {
    return {
      code: row.code,
      warehouse: row.warehouse,
      row: row.slot_row,
      floor: row.floor,
      position: row.position,
      keeperId: row.keeper_emp_no,
      locked: Boolean(row.locked),
      full: Boolean(row.is_full),
      active: row.active,
      occupiedCapacity: occupied,
    };
  }

  /** Mirror mapReceiptRow của receipt.repository.js. */
  function mapReceiptRow(row) {
    return {
      id: row.id,
      allocationId: row.allocation_id,
      noticeDetailId: row.notice_detail_id,
      receivedQty: numOrNull(row.received_qty),
      lotNo: row.lot_no ?? null,
      iqcDecision: row.iqc_decision ?? null,
      qtyInStock: numOrNull(row.qty_in_stock),
      qtyReturn: numOrNull(row.qty_return),
      qtyAod: numOrNull(row.qty_aod),
      hasWarning: Boolean(row.has_warning),
      qcDate: isoOrNull(row.qc_date),
      confirmedAt: isoOrNull(row.confirmed_at),
      updatedAt: isoOrNull(row.updated_at),
    };
  }

  function mapMovementRow(row) {
    return {
      id: row.id,
      sourceAllocationId: row.source_allocation_id,
      targetAllocationId: row.target_allocation_id,
      fromSlotCode: row.from_slot_code,
      toSlotCode: row.to_slot_code,
      qty: Number(row.qty),
      movedByEmpNo: row.moved_by_emp_no,
      movedAt: isoOrNull(row.moved_at),
      note: row.note,
    };
  }

  function mapNotice2Row(row) {
    const n1 =
      data.notice1.find((h) => String(h.sheet_no) === String(row.sheet_no)) || null;
    return {
      id: row.id,
      createdAt: isoOrNull(n1 ? n1.create_date : null),
      sheetId: row.sheet_id,
      sheetNo: row.sheet_no,
      purNo: row.pur_no,
      purId: row.pur_id,
      goodsNo: row.goods_no,
      unitNo: row.unit_no,
      stNo: row.st_no,
      sheetQty: numOrNull(row.sheet_qty),
      checkQty: numOrNull(row.check_qty),
      badQty: numOrNull(row.bad_qty),
      returnQty: numOrNull(row.return_qty),
      qcLevel: row.qc_level,
      adjResult: row.adj_result,
      proResult: row.pro_result,
      qcDate: isoOrNull(row.qc_date),
      qcUserNo: row.qc_user_no,
      qcEmpNo: row.qc_emp_no,
      madeLot: row.made_lot,
      sheetLot: row.sheet_lot,
    };
  }

  function mapPoRow(o2) {
    const o1 = order1BySheetNo(o2.sheet_no);
    const g = findGoods(o2.goods_no);
    const grn = grnAgg(o1 ? o1.sheet_no : null, o2.sheet_id, o2.goods_no);
    return {
      id: String(o2.id),
      poNumber: o1 ? o1.sheet_no : null,
      poLine: String(o2.id),
      itemCode: o2.goods_no,
      material: g ? g.goods_name : null,
      supplier: o1 ? o1.su_name11 : null,
      qty: numOrNull(o2.sheet_qty) ?? 0,
      sheetQty: numOrNull(o2.sheet_qty),
      unit: o2.unit_no,
      unitPrice: numOrNull(o2.sheet_pri) ?? 0,
      confirmed: o1 ? o1.check_sta === 'Y' : false,
      eta: isoOrNull(o2.del_date),
      arrived: grn !== null,
      grnRef: grn ? grn.grnNo : null,
      // lotNo (2026-10-29): KHÔNG expose pur_order2.made_lot — business lot
      // chỉ đến từ pur_notice2.made_lot (mirror SQL /incoming-pos lotNo NULL).
      lotNo: null,
      assignedQty: assignedQtyOf(o2.id),
      closed: o1 ? o1.close_sw === 'Y' : false,
      sheetDate: isoOrNull(o1 ? o1.sheet_date : null),
      delDate: isoOrNull(o2.del_date),
      source: 'mock',
    };
  }

  /** Mirror ALLOCATION_SELECT + mapAllocationRow của lot.repository.js. */
  function mapAllocationRow(a) {
    const o2 = findOrder2(a.po_id);
    const o1 = o2 ? order1BySheetNo(o2.sheet_no) : null;
    const g = findGoods(a.goods_no);
    const e = findEmp(a.allocated_by_emp_no);
    const grn = grnAgg(
      o1 ? o1.sheet_no : null,
      o2 ? o2.sheet_id : null,
      a.goods_no
    );
    return {
      id: a.id,
      poNumber: o1 ? o1.sheet_no : null,
      poLine: a.po_id !== null ? String(a.po_id) : null,
      itemCode: a.goods_no,
      material: g ? g.goods_name : null,
      lotCode: a.lot_no,
      supplier: o1 ? o1.su_name11 : null,
      qty: numOrNull(a.allocated_qty),
      unit: o2 ? o2.unit_no : null,
      receivedAt: isoOrNull(
        grn ? grn.receivedAt : o2 ? o2.del_date : null
      ),
      shelfCode: a.slot_code,
      assignedBy: a.allocated_by_emp_no,
      assignedAt: isoOrNull(a.allocated_at),
      status: a.status,
      iqcDecision: a.iqc_decision,
      hasWarning: Boolean(a.has_warning),
      qtyInStock: numOrNull(a.qty_in_stock),
      qtyReturn: numOrNull(a.qty_return),
      iqcUpdatedAt: isoOrNull(a.last_iqc_at),
      source: 'mock',
      poId: a.po_id,
      goodsNo: a.goods_no,
      lotNo: a.lot_no,
      warehouseStatus: a.warehouse_status,
      qtyAod: numOrNull(a.qty_aod),
      closedAt: isoOrNull(a.closed_at),
      order1Id: o1 ? o1.id : null,
      sheetQty: o2 ? numOrNull(o2.sheet_qty) : null,
      madeLot: o2 ? o2.made_lot : null,
      allocatedByName: e ? e.emp_name : null,
      grnNo: grn ? grn.grnNo : null,
      grnQty: grn ? grn.grnQty : null,
    };
  }

  function mapActivityRow(row) {
    return {
      id: row.id,
      time: isoOrNull(row.acted_at),
      userId: row.emp_no,
      actionKey: row.action_key,
      allocationId: row.allocation_id,
      poId: row.po_id === null || row.po_id === undefined ? null : Number(row.po_id),
      noticeDetailId: row.notice_detail_id,
      poNumber: row.po_number,
      slotCode: row.slot_code,
      qty: numOrNull(row.qty),
      unit: row.unit,
      detail: row.detail,
      source: 'mock',
    };
  }

  /** Tổng allocated_qty còn vật lý trên 1 kệ (closed_at IS NULL). */
  function occupiedOf(code) {
    return data.allocations
      .filter((a) => a.slot_code === code && a.closed_at === null)
      .reduce((sum, a) => sum + Number(a.allocated_qty || 0), 0);
  }

  /**
   * Tổng allocated_qty theo po_id (2026-10-28): KỂ CẢ allocation đã close
   * — mirror SQL mode (so sánh với pur_order2.sheet_qty để quyết định PO
   * còn hiện hay không).
   */
  function assignedQtyOf(poId) {
    return data.allocations
      .filter((a) => String(a.po_id) === String(poId))
      .reduce((sum, a) => sum + Number(a.allocated_qty || 0), 0);
  }

  /**
   * Đồng hồ tạm nhập 24h (2026-10-28) — mirror DATEADD(HOUR, -24,
   * GETDATE()) của SQL mode. NULL create_date = chưa biết giờ tạm nhập
   * = CÒN HIỆN (tránh ẩn toàn bộ dữ liệu thật trước khi T8 backfill).
   */
  function noticeFresh(createDate, now) {
    if (createDate === null || createDate === undefined) return true;
    const at = now ?? new Date();
    return new Date(createDate).getTime() >= noticeCutoffDate(at).getTime();
  }

  /**
   * Clock của 1 PO — MAX(notice1.create_date) trong nhóm notice khớp key
   * [R2]; chưa có notice hoặc chưa biết giờ nào = CÒN HIỆN.
   */
  function noticesClockFresh(notices, now) {
    if (!notices || notices.length === 0) return true;
    let latest = null;
    for (const n of notices) {
      const n1 =
        data.notice1.find((h) => String(h.sheet_no) === String(n.sheet_no)) || null;
      if (n1 && n1.create_date != null) {
        const ms = new Date(n1.create_date).getTime();
        if (latest === null || ms > latest) latest = ms;
      }
    }
    if (latest === null) return true;
    const at = now ?? new Date();
    return latest >= noticeCutoffDate(at).getTime();
  }

  /** Kiểm tra chuỗi chứa từ khóa (case-insensitive, NULL -> false). */
  function matchesCi(value, lowerKw) {
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().includes(lowerKw);
  }

  /** Epoch ms từ giá trị ngày giờ (NULL / sai định dạng -> null). */
  function toMs(value) {
    if (value === null || value === undefined) return null;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }

  /**
   * Xác định bucket ETA của dòng PO (2026-10-20, Phase 2) — mirror CASE
   * của countPurchaseBucketsFinal, so sánh NGÀY (dayKey YYYY-MM-DD)
   * với 5 mốc computeBucketDates (dùng chung bucket-dates.js):
   *   od1 = [prevMonthStart, today); od2 = [twoMonthsAgoStart,
   *   prevMonthStart); od3p = < twoMonthsAgoStart (NULL cũng od3p);
   *   next3 = [today, next3End); next7 = [next3End, next7End).
   *   del_date >= next7End → NGOÀI 5 bucket → null (không đếm vào
   *   bucketCounts, vẫn hiển thị khi không lọc bucket).
   */
  function bucketOfCase(o2, opts) {
    const day = dayKey(o2.del_date);
    if (day === null) return 'od3p';
    if (day < opts.twoMonthsAgoStart) return 'od3p';
    if (day < opts.prevMonthStart) return 'od2';
    if (day < opts.today) return 'od1';
    if (day < opts.next3End) return 'next3';
    if (day < opts.next7End) return 'next7';
    return null;
  }

  /**
   * Kiểm tra dòng PO rơi vào bucket — mirror WHERE searchPurchasesFinal
   * (CÙNG boundary với bucketOfCase — list và count không được lệch).
   * NULL del_date = od3p.
   */
  function inBucket(o2, bucket, opts) {
    return bucketOfCase(o2, opts) === bucket;
  }

  /**
   * Danh sách dòng tìm kiếm PO mở (DB_MODE=memory) — mirror UNION mới
   * (candidate-first 2026-10-19) của po.repository.searchPurchases:
   *   (1) Gap: phần sheet_qty PO chưa có notice (khớp pur_no + goods_no),
   *       trừ đi allocation chưa map receipt (gap_assigned).
   *   (2) Notice lot: từng dòng notice2 (khớp PO qua pur_no + goods_no)
   *       chưa liên kết hết (tổng receipt.received_qty) và chưa có trong
   *       pur_in2 (per-lot: pur_no + goods_no + made_lot).
   * HIỆN THỊ (rework 2026-10-29, no-max) — cả 2 nhánh: ĐÃ BỎ gate
   * "PO chưa gán hết theo pur_order" (tổng allocated được vượt PO,
   * sheet_qty chỉ là tham khảo); chỉ còn đồng hồ tạm nhập 24h từ
   * notice1.create_date còn chạy (NULL = hiện).
   * Mỗi dòng chứa đủ { o1, o2, g, n2 } để filterByKeyword / bucket sử dụng.
   */
  function searchRows(keeperEmpNo) {
    const out = [];
    // Nhánh 1: gap PO
    for (const o2 of data.order2) {
      const o1 = poCandidate(o2, keeperEmpNo);
      if (o1 === null) continue;
      const poAllocs = data.allocations.filter(
        (a) => String(a.po_id) === String(o2.id)
      );
      const assignedTotal = poAllocs.reduce(
        (sum, a) => sum + Number(a.allocated_qty || 0),
        0
      );
      // HIỆN THỊ (rework 2026-10-29, no-max): ĐÃ BỎ gate assignedTotal >=
      // sheet_qty — tổng allocated được vượt PO, PO không ẩn khi gán
      // đủ/vượt (mọi phân nhánh dùng chung).
      // HIỆN THỊ: đồng hồ tạm nhập 24h (chưa có notice = hiện).
      if (!noticesClockFresh(noticesOfOrder2(o2))) continue;
      const g = findGoods(o2.goods_no);
      const notices = noticesOfOrder2(o2);
      const noticedQty = notices.reduce(
        (sum, n) => sum + Number(n.sheet_qty || 0),
        0
      );
      const gapAssigned = poAllocs
        .filter((a) => !data.receipts.some((r) => r.allocation_id === a.id))
        .reduce((sum, a) => sum + Number(a.allocated_qty || 0), 0);
      const gapQty =
        Number(o2.sheet_qty || 0) - noticedQty - gapAssigned;
      // ẨN gap rỗng chỉ khi T8 đã tạm nhập đủ (sheet − noticed <= 0);
      // KHÔNG trừ gap_assigned — mirror SQL rework 2026-10-29: tổng
      // allocated đạt/vượt PO không làm row biến mất; over-assign phần
      // chưa tạm nhập thì qty có thể <= 0.
      if (Number(o2.sheet_qty || 0) - noticedQty > 0) {
        out.push({
          kind: 'gap',
          o1,
          o2,
          g,
          n2: null,
          qty: gapQty,
          assignedQty: assignedTotal,
          // Gap row chưa có tạm nhập — chưa có business lot (2026-10-29).
          lotNo: null,
          rowKey: String(o2.id),
        });
      }
    }
    // Nhánh 2: notice lot
    for (const n2 of data.notice2) {
      if (in2HasLot(n2)) continue;
      const o2 = order2OfNotice(n2);
      if (!o2) continue;
      const o1 = poCandidate(o2, keeperEmpNo);
      if (!o1) continue;
      const assignedTotal = data.allocations
        .filter((a) => String(a.po_id) === String(o2.id))
        .reduce((sum, a) => sum + Number(a.allocated_qty || 0), 0);
      // HIỆN THỊ (rework 2026-10-29, no-max): ĐÃ BỎ gate assignedTotal >=
      // sheet_qty — được phép gán vượt PO; chỉ còn đồng hồ 24h.
      // HIỆN THỊ: đồng hồ tạm nhập 24h từ notice1.create_date.
      const n1 =
        data.notice1.find((h) => String(h.sheet_no) === String(n2.sheet_no)) || null;
      if (!noticeFresh(n1 ? n1.create_date : null)) continue;
      const g = findGoods(n2.goods_no);
      // 2026-10-28: receipts KHÔNG còn làm ẩn dòng notice (mirror SQL —
      // hiển thị chỉ phụ thuộc PO gate + đồng hồ 24h + pur_in).
      out.push({
        kind: 'notice',
        o1,
        o2,
        g,
        n2,
        qty: Number(n2.sheet_qty || 0),
        assignedQty: assignedTotal,
        lotNo: n2.made_lot || null,
        rowKey: `${o2.id}-N${n2.id}`,
      });
    }
    return out;
  }

  /**
   * Đổi 1 dòng searchRows sang object camelCase — mirror mapSearchPoRow
   * của po.repository (kind 'notice' = lot cụ thể; 'gap' = phần PO chưa
   * có notice, gán theo poLine gốc).
   */
  function mapSearchRow(r) {
    const { o1, o2, g, n2 } = r;
    const grn =
      r.kind === 'gap'
        ? grnAgg(o1 ? o1.sheet_no : null, o2.sheet_id, o2.goods_no)
        : null;
    return {
      id: r.rowKey,
      poNumber: o1 ? o1.sheet_no : null,
      poLine: String(o2.id),
      itemCode: o2.goods_no,
      material: g ? g.goods_name : null,
      supplier: o1 ? o1.su_name11 : null,
      qty: r.qty,
      unit: n2 ? n2.unit_no : o2.unit_no,
      unitPrice: numOrNull(o2.sheet_pri) ?? 0,
      confirmed: o1 ? o1.check_sta === 'Y' : false,
      eta: isoOrNull(o2.del_date),
      arrived: r.kind === 'notice' ? true : grn !== null,
      grnRef: grn ? grn.grnNo : null,
      lotNo: r.lotNo,
      assignedQty: r.assignedQty,
      // no-max (2026-10-29): sheet_qty chỉ tham khảo — mirror SQL SELECT
      // [sheetQty] (po.repository) + mappers.opt(po.sheetQty).
      sheetQty: numOrNull(o2.sheet_qty),
      closed: o1 ? o1.close_sw === 'Y' : false,
      sheetDate: isoOrNull(o1 ? o1.sheet_date : null),
      delDate: isoOrNull(o2.del_date),
      source: 'mock',
    };
  }

  /** Bắt đầu bằng từ khóa (case-insensitive, NULL -> false). */
  function startsCi(value, lowerKw) {
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().startsWith(lowerKw);
  }

  /**
   * Lọc theo từ khóa (mirror SQL FINAL 2026-10-19): PO / goods / lot
   * (made_lot) ưu tiên PREFIX — hỗ trợ tìm 9 ký tự đầu made_lot cũng
   * chuyển; material / supplier dùng contains. Notice made_lot khớp qua
   * EXISTS SIẾT theo PO DETAIL (noticesOfOrder2 — key [R2]: pur_no +
   * goods_no + def02 + pur_id = sheet_id), không giữ tất cả detail cùng PO.
   */
  function filterByKeyword(rows, keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(
      ({ o1, o2, g, n2 }) =>
        startsCi(o1.sheet_no, kw) ||
        startsCi(o2.goods_no, kw) ||
        startsCi(n2 ? n2.made_lot : null, kw) ||
        noticesOfOrder2(o2).some((n2k) => startsCi(n2k.made_lot, kw)) ||
        matchesCi(g ? g.goods_name : null, kw) ||
        matchesCi(o1.su_name11, kw)
    );
  }

  return {
    mode: 'memory',

    // ================================================================
    // ACCOUNTS (whs_user_role JOIN t8_bas_emp) — mirror account.repository
    // ================================================================
    accounts: {
      /** Mirror listPaged của account.repository (ORDER BY r.emp_no). */
      async listPaged(page, pageSize) {
        const offset = (page - 1) * pageSize;
        const rows = [...data.userRoles]
          .sort((a, b) => a.emp_no.localeCompare(b.emp_no))
          .slice(offset, offset + pageSize)
          .map((role) => {
            const emp = findEmp(role.emp_no);
            return mapAccountRow(
              role,
              emp ? emp.emp_name : null,
              emp ? emp.email : null
            );
          });
        return { rows, total: data.userRoles.length };
      },
      async list() {
        return [...data.userRoles]
          .sort((a, b) => a.emp_no.localeCompare(b.emp_no))
          .map((role) => {
            const emp = findEmp(role.emp_no);
            return mapAccountRow(role, emp ? emp.emp_name : null, emp ? emp.email : null);
          });
      },
      async byId(empNo) {
        const role = data.userRoles.find((r) => r.emp_no === empNo);
        if (!role) return null;
        const emp = findEmp(empNo);
        return mapAccountRow(role, emp ? emp.emp_name : null, emp ? emp.email : null);
      },
      async insert(account) {
        const row = {
          emp_no: account.employeeCode,
          role: account.role,
          username: account.username,
          password: account.password,
          locked: Boolean(account.locked),
          active: account.active !== false,
        };
        data.userRoles.push(row);
        const emp = findEmp(row.emp_no);
        return mapAccountRow(row, emp ? emp.emp_name : null, emp ? emp.email : null);
      },
      async insertRaw(row) {
        data.userRoles.push(clone(row));
        return row;
      },
      async update(empNo, patch) {
        const role = data.userRoles.find((r) => r.emp_no === empNo);
        if (!role) return null;
        if (patch.username !== undefined) role.username = patch.username;
        if (patch.role !== undefined) role.role = patch.role;
        if (patch.locked !== undefined) role.locked = patch.locked;
        if (patch.password !== undefined) role.password = patch.password;
        if (patch.active !== undefined) role.active = patch.active;
        const emp = findEmp(empNo);
        return mapAccountRow(role, emp ? emp.emp_name : null, emp ? emp.email : null);
      },
      async renameEmpNo(oldEmpNo, newEmpNo) {
        for (const role of data.userRoles) {
          if (role.emp_no === oldEmpNo) role.emp_no = newEmpNo;
        }
        for (const slot of data.slots) {
          if (slot.keeper_emp_no === oldEmpNo) slot.keeper_emp_no = newEmpNo;
        }
        for (const alloc of data.allocations) {
          if (alloc.allocated_by_emp_no === oldEmpNo) {
            alloc.allocated_by_emp_no = newEmpNo;
          }
        }
      },
      async deleteAll() {
        data.userRoles = [];
      },
    },

    // ================================================================
    // SLOTS (whs_slots + whs_slot_movement) — mirror slot.repository
    // ================================================================
    slots: {
      /** Mirror listPaged của slot.repository (ORDER BY s.code). */
      async listPaged(page, pageSize) {
        const offset = (page - 1) * pageSize;
        const rows = [...data.slots]
          .sort((a, b) => a.code.localeCompare(b.code))
          .slice(offset, offset + pageSize)
          .map((row) => mapSlotRow(row, occupiedOf(row.code)));
        return { rows, total: data.slots.length };
      },
      async list() {
        return [...data.slots]
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((row) => mapSlotRow(row, occupiedOf(row.code)));
      },
      async byCode(code) {
        const row = findSlotRow(code);
        return row ? mapSlotRow(row, occupiedOf(code)) : null;
      },
      /** Mirror byKeeper: kệ đang thuộc 1 thủ kho (keeper detail). */
      async byKeeper(empNo) {
        return [...data.slots]
          .filter((s) => s.keeper_emp_no === empNo)
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((row) => mapSlotRow(row, occupiedOf(row.code)));
      },

      /**
       * Tìm mã kệ theo từ khóa (GET /api/warehouse/slots) — port từ
       * searchSlotCodes gốc: khớp slot_code / lot_no của allocation hoặc PO
       * liên quan (số đơn / mã NPL / tên hàng). Từ khóa rỗng -> [].
       */
      async searchSlotCodes(keyword) {
        const kw = String(keyword || '').trim().toLowerCase();
        if (!kw) return [];
        const codes = new Set();
        for (const a of data.allocations) {
          const o2 = findOrder2(a.po_id);
          const o1 = o2 ? order1BySheetNo(o2.sheet_no) : null;
          const g = o2 ? findGoods(o2.goods_no) : null;
          const hit =
            matchesCi(a.slot_code, kw) ||
            matchesCi(a.lot_no, kw) ||
            (o2 !== null &&
              o1 !== null &&
              (matchesCi(o1.sheet_no, kw) || matchesCi(o2.goods_no, kw))) ||
            (o2 !== null && g !== null && matchesCi(g.goods_name, kw));
          if (hit) codes.add(a.slot_code);
        }
        return [...codes].sort((a, b) => a.localeCompare(b));
      },
      async insert(slot) {
        const row = {
          code: slot.code,
          warehouse: slot.warehouse,
          slot_row: slot.row,
          floor: slot.floor,
          position: slot.position,
          keeper_emp_no: slot.keeperId ?? null,
          locked: Boolean(slot.locked),
          is_full: Boolean(slot.full),
          active: slot.active !== false,
        };
        data.slots.push(row);
        return mapSlotRow(row, 0);
      },
      async insertRaw(row) {
        data.slots.push(clone(row));
        return row;
      },
      async update(code, patch) {
        const row = findSlotRow(code);
        if (!row) return null;
        if (patch.keeperId !== undefined) row.keeper_emp_no = patch.keeperId;
        if (patch.locked !== undefined) row.locked = patch.locked;
        if (patch.full !== undefined) row.is_full = patch.full;
        if (patch.active !== undefined) row.active = patch.active;
        return mapSlotRow(row, occupiedOf(code));
      },
      async deleteAll() {
        data.slots = [];
      },
      async insertMovement(values) {
        const row = {
          id: values.id,
          source_allocation_id: values.source_allocation_id ?? null,
          target_allocation_id: values.target_allocation_id ?? null,
          from_slot_code: values.from_slot_code ?? null,
          to_slot_code: values.to_slot_code ?? null,
          qty: values.qty,
          moved_by_emp_no: values.moved_by_emp_no ?? null,
          moved_at: values.moved_at || new Date().toISOString(),
          note: values.note ?? null,
        };
        data.movements.push(row);
        return mapMovementRow(row);
      },
      /** Mirror countMovementsForAllocation — downstream check của Undo. */
      async countMovementsForAllocation(allocationId) {
        return data.movements.filter(
          (m) =>
            m.source_allocation_id === allocationId ||
            m.target_allocation_id === allocationId
        ).length;
      },
      async findMovements(limit = 50) {
        const mapped = [...data.movements]
          .sort((a, b) => String(b.moved_at).localeCompare(String(a.moved_at)))
          .map(mapMovementRow);
        return limit > 0 ? mapped.slice(0, limit) : mapped;
      },
      async deleteAllMovements() {
        data.movements = [];
      },
    },

    // ================================================================
    // PO (t8_pur_order1/2 + notice lookup + GRN) — mirror po.repository
    // ================================================================
    pos: {
      /**
       * Dòng PO còn HIỆN (rework 2026-10-29, no-max — mirror po.repository
       * SQL): ĐÃ BỎ gate chưa gán hết theo pur_order (tổng allocated được
       * vượt PO, sheet_qty chỉ tham khảo); chỉ còn đồng hồ tạm nhập 24h
       * từ notice1.create_date còn chạy (không có notice hoặc notice mới
       * nhất trong 24h; NULL = hiện). ORDER BY close_sw, del_date, id —
       * dùng chung cho list/listPaged.
       */
      listRemainingRows() {
        const now = new Date();
        return [...data.order2]
          .filter((o2) => noticesClockFresh(noticesOfOrder2(o2), now))
          .sort((a, b) =>
            String(order1BySheetNo(a.sheet_no)?.close_sw || '').localeCompare(
              String(order1BySheetNo(b.sheet_no)?.close_sw || '')
            ) ||
            String(a.del_date || '').localeCompare(String(b.del_date || '')) ||
            Number(a.id) - Number(b.id)
          )
          .map(mapPoRow);
      },
      async list() {
        return this.listRemainingRows();
      },
      /** Mirror listPaged của po.repository (cùng filter + ORDER BY). */
      async listPaged(page, pageSize) {
        const rows = this.listRemainingRows();
        const offset = (page - 1) * pageSize;
        return {
          rows: rows.slice(offset, offset + pageSize),
          total: rows.length,
        };
      },
      async byId(poId) {
        const row = findOrder2(poId);
        return row ? mapPoRow(row) : null;
      },
      async findOrder2ByPoId(poId) {
        const o2 = findOrder2(poId);
        if (!o2) return null;
        const o1 = order1BySheetNo(o2.sheet_no);
        return {
          id: o2.id,
          sheetId: o2.sheet_id,
          poNumber: o1 ? o1.sheet_no : null,
          goodsNo: o2.goods_no,
          unitNo: o2.unit_no,
          sheetQty: numOrNull(o2.sheet_qty),
          madeLot: o2.made_lot,
          delDate: isoOrNull(o2.del_date),
          suName11: o1 ? o1.su_name11 : null,
          suNo: o1 ? o1.su_no : null,
        };
      },
      /**
       * TOÀN BỘ notice khớp 1 dòng PO theo key [R2] (mirror
       * findNoticesForPoLine của po.repository) — ORDER BY n2.id.
       */
      async findNoticesForPoLine(poId, noticeIds) {
        const o2 = findOrder2(poId);
        if (!o2) return [];
        let candidates = noticesOfOrder2(o2).slice();
        if (Array.isArray(noticeIds) && noticeIds.length > 0) {
          // HINT (#37) — sweep đã có sẵn candidate IDs; relation [R2] vẫn
          // ép qua noticesOfOrder2 nên ID sai范围 tự loại.
          const idSet = new Set(noticeIds.map((nid) => Number(nid)));
          candidates = candidates.filter((n) => idSet.has(Number(n.id)));
        }
        return candidates
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map(mapNotice2Row);
      },
      /**
       * BATCH mirror findOrder2ByPoIds — nhiều po_id 1 lượt (memory mode
       * là array filter, không có khái niệm N+1 query).
       */
      async findOrder2ByPoIds(poIds) {
        const out = [];
        for (const poId of poIds || []) {
          const row = await this.findOrder2ByPoId(poId);
          if (row) out.push(row);
        }
        return out;
      },
      /**
       * BATCH mirror findNoticesForPoDetails — mỗi dòng kèm poId để
       * caller group theo PO, cùng relation [R2] như bản đơn.
       */
      async findNoticesForPoDetails(poIds) {
        const out = [];
        for (const poId of poIds || []) {
          const o2 = findOrder2(poId);
          if (!o2) continue;
          const notices = noticesOfOrder2(o2)
            .slice()
            .sort((a, b) => Number(a.id) - Number(b.id))
            .map(mapNotice2Row);
          for (const notice of notices) out.push({ ...notice, poId });
        }
        return out;
      },
      /**
       * Mirror findOrphanNoticesForPoLine (PO identity fix 2026-10-29 #9):
       * notice khớp key R2 3 trường (pur_no + goods_no + def02) nhưng
       * pur_id NULL/không trỏ về dòng nào của chính PO — dùng cho issue
       * DATA_ERROR, KHÔNG dùng sync receipt. ORDER BY n2.id.
       */
      async findOrphanNoticesForPoLine(poId) {
        const o2 = findOrder2(poId);
        if (!o2) return [];
        const o1 = order1BySheetNo(o2.sheet_no);
        if (o1 === null) return [];
        const validSheetIds = new Set(
          data.order2
            .filter((o) => o.sheet_no === o1.sheet_no)
            .map((o) => String(o.sheet_id))
        );
        return data.notice2
          .filter(
            (n) =>
              n.pur_no === o1.sheet_no &&
              n.goods_no === o2.goods_no &&
              String(n.def02 ?? '') === String(o2.def02 ?? '')
          )
          .filter(
            (n) =>
              n.pur_id == null || !validSheetIds.has(String(n.pur_id))
          )
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map(mapNotice2Row);
      },
      async sumAllocatedByPo(poId) {
        return data.allocations
          .filter(
            (a) => String(a.po_id) === String(poId) && a.closed_at === null
          )
          .reduce((sum, a) => sum + Number(a.allocated_qty || 0), 0);
      },
      /**
       * Phân trang + tìm kiếm PO mở (DB_MODE=memory) — mirror
       * searchPurchases UNION mới: lọc keyword → bucket → sắp xếp
       * del_date/po_id/notice_id asc → cắt trang. Trả { rows, total }.
       */
      async searchPurchases(opts) {
        let rows = searchRows(opts.keeperEmpNo);
        const kw = String(opts.keyword || '').trim();
        if (kw) rows = filterByKeyword(rows, kw);
        if (opts.bucket) {
          rows = rows.filter(({ o2 }) => inBucket(o2, opts.bucket, opts));
        }
        rows = [...rows].sort(
          (a, b) =>
            (toMs(a.o2.del_date) ?? 0) - (toMs(b.o2.del_date) ?? 0) ||
            Number(a.o2.id) - Number(b.o2.id) ||
            (a.n2 ? Number(a.n2.id) : 0) - (b.n2 ? Number(b.n2.id) : 0)
        );
        const total = rows.length;
        const offset = (opts.page - 1) * opts.pageSize;
        return {
          rows: rows
            .slice(offset, offset + opts.pageSize)
            .map(mapSearchRow),
          total,
        };
      },
      /**
       * Đếm số ĐƠN (sheet_no duy nhất) theo bucket ETA (DB_MODE=memory) —
       * mirror countPurchaseBuckets mới (dùng chung searchRows): áp dụng
       * keyword nhưng KHÔNG áp dụng lọc bucket. Trả { [bucket]: count }.
       */
      async countPurchaseBuckets(opts) {
        let rows = searchRows(opts.keeperEmpNo);
        const kw = String(opts.keyword || '').trim();
        if (kw) rows = filterByKeyword(rows, kw);
        const seen = new Map();
        for (const { o1, o2 } of rows) {
          const bucket = bucketOfCase(o2, opts);
          if (bucket === null) continue;
          const set = seen.get(bucket) ?? new Set();
          if (o1) set.add(o1.sheet_no);
          seen.set(bucket, set);
        }
        const counts = {};
        for (const [bucket, set] of seen) counts[bucket] = set.size;
        return counts;
      },
      // searchPurchasesWithBuckets đã xóa (refactor 2026-10-26 theo mẫu
      // Kanban): service tự điều phối searchPurchases + countPurchase
      // Buckets — cả hai đều dùng chung searchRows nên kết quả không đổi.
    },

    // ================================================================
    // MATERIALS (whs_keeper_material_assignment — phân công thủ kho NPL)
    // — mirror material.repository
    // ================================================================
    materials: {
      /** Mirror listPaged của material.repository (ORDER BY goods_no). */
      async listPaged(opts) {
        const kw = String(opts.search || '').trim().toLowerCase();
        // 2026-10-21 (change request): BASE FILTER eligibility M1..M6 / A2
        // — search không được phá vỡ eligibility (mirror SQL mode).
        let goods = [...data.goods]
          .filter((g) => ELIGIBLE_NPL_RE.test(String(g.goods_no || '')))
          .sort((a, b) => a.goods_no.localeCompare(b.goods_no));
        if (kw) {
          goods = goods.filter(
            (g) => matchesCi(g.goods_no, kw) || matchesCi(g.goods_name, kw)
          );
        }
        const total = goods.length;
        const offset = (opts.page - 1) * opts.pageSize;
        return {
          rows: goods.slice(offset, offset + opts.pageSize).map(mapMaterialItem),
          total,
        };
      },
      async byGoods(goodsNo) {
        const g = findGoods(goodsNo);
        return g ? mapMaterialItem(g) : null;
      },
      async history(goodsNo) {
        return data.assignments
          .filter((a) => a.goodsNo === goodsNo)
          .sort((a, b) =>
            String(b.assignedAt || '').localeCompare(String(a.assignedAt || ''))
          )
          .map(mapMaterialHistoryRow);
      },
      async validateGoods(goodsNo) {
        return findGoods(goodsNo) ? 1 : 0;
      },
      /** Mirror validateGoodsEligible: tồn tại + thuộc M1..M6 / A2. */
      async validateGoodsEligible(goodsNo) {
        const g = findGoods(goodsNo);
        return g && ELIGIBLE_NPL_RE.test(String(g.goods_no || '')) ? 1 : 0;
      },
      /** Mirror activeByKeeper: NPL active theo thủ kho (profile/detail). */
      async activeByKeeper(empNo) {
        return data.assignments
          .filter((a) => a.keeperEmpNo === empNo && a.endedAt == null)
          .sort((a, b) => String(a.goodsNo).localeCompare(String(b.goodsNo)))
          .map((a) => {
            const g = findGoods(a.goodsNo);
            const emp = findEmp(a.keeperEmpNo);
            return {
              goodsNo: a.goodsNo,
              goodsName: g ? g.goods_name : a.goodsNo,
              keeperEmpNo: a.keeperEmpNo,
              keeperName: emp ? emp.emp_name : null,
              assignedAt: isoOrNull(a.assignedAt),
            };
          });
      },
      /**
       * Mirror endAssignment của material.repository: CHỈ set endedAt
       * (đóng dòng active khớp goodsNo + keeperEmpNo), KHÔNG xóa dòng —
       * toàn bộ lịch sử vẫn đọc được qua history(). Không có dòng active
       * khớp → false.
       */
      async endAssignment(goodsNo, keeperEmpNo) {
        const row = data.assignments.find(
          (a) =>
            a.goodsNo === goodsNo &&
            a.keeperEmpNo === keeperEmpNo &&
            a.endedAt == null
        );
        if (!row) return false;
        row.endedAt = new Date().toISOString();
        return true;
      },
      async validateKeeper(empNo) {
        const ok = data.userRoles.some(
          (r) =>
            r.emp_no === empNo &&
            r.role === 'KEEPER' &&
            !r.locked &&
            r.active
        );
        return ok ? 1 : 0;
      },
      /**
       * Mirror assign của material.repository (SQL mode chạy 2 bước này
       * trong withTransaction): close-active-then-insert — đóng mọi dòng
       * active cũ của goodsNo (set endedAt = thời điểm gán, không vi phạm
       * filtered unique UQ_whs_kma_goods_active), push dòng mới vào history
       * (endedAt = null), rồi refetch bằng byGoods. Trả mapMaterialItem mới.
       */
      async assign(values) {
        const nowIso = values.assignedAt || new Date().toISOString();
        for (const a of data.assignments) {
          if (a.goodsNo === values.goodsNo && a.endedAt === null) {
            a.endedAt = nowIso;
          }
        }
        data.assignments.push(clone({ ...values, endedAt: null }));
        return this.byGoods(values.goodsNo);
      },
      /** Mirror bulkAssign: gán hàng loạt trong cùng 1 "transaction"
        * (memory không có tx nên chạy tuần tự là tương đương). Trả mảng
        * các material đã gán thành công (full shape). */
      async bulkAssign(values) {
        // Id do service sinh sẵn (values.ids, cùng thứ tự goodsNos) —
        // mirror material.repository, không phụ thuộc service layer.
        const pendingIds = Array.isArray(values.ids) ? [...values.ids] : [];
        const nowIso = values.assignedAt || new Date().toISOString();
        const goodsNos = [...new Set(values.goodsNos || [])];
        const results = [];
        for (const goodsNo of goodsNos) {
          const g = findGoods(goodsNo);
          if (!g) continue;
          if (!ELIGIBLE_NPL_RE.test(String(g.goods_no || ''))) continue;
          const id = pendingIds.shift();
          if (!id) {
            throw new Error(
              '[memory.repository] bulkAssign thiếu id cho dòng assignment mới'
            );
          }
          for (const a of data.assignments) {
            if (a.goodsNo === goodsNo && a.endedAt === null) {
              a.endedAt = nowIso;
            }
          }
          data.assignments.push(
            clone({
              id,
              goodsNo,
              keeperEmpNo: values.keeperEmpNo,
              assignedByEmpNo: values.assignedByEmpNo,
              assignedAt: nowIso,
              endedAt: null,
              note: values.note ?? null,
            })
          );
          results.push(goodsNo);
        }
        if (results.length === 0) return [];
        return results.map((goodsNo) => mapMaterialItem(findGoods(goodsNo)));
      },
    },

    // ================================================================
    // LOTS / ALLOCATION (whs_slot_allocation) — mirror lot.repository
    // ================================================================
    lots: {
      /** Mirror listPaged của lot.repository (ORDER BY allocated_at DESC, id DESC). */
      async listPaged(page, pageSize) {
        const offset = (page - 1) * pageSize;
        const rows = [...data.allocations]
          .sort(
            (a, b) =>
              String(b.allocated_at || '').localeCompare(
                String(a.allocated_at || '')
              ) || b.id.localeCompare(a.id)
          )
          .slice(offset, offset + pageSize)
          .map(mapAllocationRow);
        return { rows, total: data.allocations.length };
      },
      async findLots() {
        return [...data.allocations]
          .sort(
            (a, b) =>
              String(a.allocated_at || '').localeCompare(
                String(b.allocated_at || '')
              ) || a.id.localeCompare(b.id)
          )
          .map(mapAllocationRow);
      },
      /** Mirror findAllocationRow — allocation WHS-only, không JOIN T8 (Undo). */
      async findAllocationRow(id) {
        const a = data.allocations.find((x) => x.id === id);
        if (!a) return null;
        return {
          id: a.id,
          poId: a.po_id,
          goodsNo: a.goods_no,
          slotCode: a.slot_code,
          lotNo: a.lot_no ?? null,
          allocatedQty: Number(a.allocated_qty || 0),
          allocatedByEmpNo: a.allocated_by_emp_no ?? null,
          allocatedAt: a.allocated_at ?? null,
          status: a.status,
          warehouseStatus: a.warehouse_status ?? null,
          iqcDecision: a.iqc_decision ?? null,
          lastIqcAt: a.last_iqc_at ?? null,
          qtyInStock: Number(a.qty_in_stock || 0),
          qtyReturn: Number(a.qty_return || 0),
          qtyAod: Number(a.qty_aod || 0),
          hasWarning: a.has_warning ?? 0,
          closedAt: a.closed_at ?? null,
        };
      },
      /** Mirror deleteAllocation — hard delete của Undo Assign. */
      async deleteAllocation(id) {
        const before = data.allocations.length;
        data.allocations = data.allocations.filter((a) => a.id !== id);
        return before - data.allocations.length;
      },
      async findLotById(id) {
        const row = findAlloc(id);
        return row ? mapAllocationRow(row) : null;
      },
      async findActiveBySlot(slotCode) {
        return data.allocations
          .filter((a) => a.slot_code === slotCode && a.closed_at === null)
          .map(mapAllocationRow);
      },
      async findActiveByPo(poId) {
        return data.allocations
          .filter(
            (a) => String(a.po_id) === String(poId) && a.closed_at === null
          )
          .map(mapAllocationRow);
      },
      async findActiveAllocationByPoAndSlot(poId, slotCode) {
        const row = data.allocations.find(
          (a) =>
            String(a.po_id) === String(poId) &&
            a.slot_code === slotCode &&
            a.closed_at === null
        );
        return row ? mapAllocationRow(row) : null;
      },
      async insertAllocation(values) {
        const row = clone(values);
        data.allocations.push(row);
        return mapAllocationRow(row);
      },
      async updateAllocation(id, patch) {
        const row = findAlloc(id);
        if (!row) return null;
        Object.assign(row, clone(patch));
        return mapAllocationRow(row);
      },
      /** Mirror updateAllocationLight — WHS-only patch, trả boolean. */
      async updateAllocationLight(id, patch) {
        const row = findAlloc(id);
        if (!row) return false;
        Object.assign(row, clone(patch));
        return true;
      },
      /** Mirror applyIqcResult của lot.repository — cũng delegate updateAllocation. */
      async applyIqcResult(id, patch) {
        return this.updateAllocation(id, patch);
      },
      /**
       * Tăng allocated_qty của allocation active — dùng khi gộp thêm số
       * lượng vào kệ (mirror tăng của SQL mode). Allocation đã đóng
       * (closed_at !== null) → null.
       */
      async increaseAllocationQty(id, delta) {
        const row = findAlloc(id);
        if (!row || row.closed_at !== null) return null;
        row.allocated_qty = Number(row.allocated_qty) + Number(delta);
        return mapAllocationRow(row);
      },
      /**
       * Giảm allocated_qty của allocation active — dùng cho move KHÔNG
       * trọn (partial): phần còn lại giữ nguyên kệ nguồn. Guards (mirror
       * SQL): (1) không đủ số lượng (next < 0) → null; (2) BẢO VỆ RECEIPT
       * I4 — allocated mới phải >= tổng received_qty đã reconcile
       * (subquery SUM SQL-mode), chống move phần T8 đã confirm → null.
       */
      async decreaseAllocationQty(id, delta) {
        const row = findAlloc(id);
        if (!row || row.closed_at !== null) return null;
        const next = Number(row.allocated_qty) - Number(delta);
        if (next < 0) return null;
        const receivedTotal = data.receipts
          .filter((r) => r.allocation_id === id)
          .reduce((sum, r) => sum + Number(r.received_qty || 0), 0);
        if (next < receivedTotal - 1e-9) return null;
        row.allocated_qty = next;
        return mapAllocationRow(row);
      },
      /**
       * Move TRỌN lô: đổi slot_code của allocation active (service layer
       * gọi khi move toàn bộ). Move PARTIAL được service layer ghép từ
       * decreaseAllocationQty (kệ nguồn) + insertAllocation (kệ đích) —
       * memory mode mirror cùng luồng SQL mode. Allocation đã đóng → null.
       */
      async moveAllocationSlot(id, targetSlotCode) {
        const row = findAlloc(id);
        if (!row || row.closed_at !== null) return null;
        row.slot_code = targetSlotCode;
        return mapAllocationRow(row);
      },
      /** Đóng allocation (set closed_at — rời kệ, KHÔNG xóa dòng). */
      async closeAllocation(id, closedAt) {
        const row = findAlloc(id);
        if (!row) return null;
        row.closed_at =
          closedAt instanceof Date ? closedAt.toISOString() : closedAt;
        return mapAllocationRow(row);
      },
      async deleteAll() {
        data.allocations = [];
      },
      // Alias theo tên cũ để service layer gọi tiện
      list() {
        return this.findLots();
      },
      byId(id) {
        return this.findLotById(id);
      },
      byShelf(slotCode) {
        return this.findActiveBySlot(slotCode);
      },
    },

    // ================================================================
    // RECEIPTS (whs_allocation_receipt — allocation × pur_notice2 N-N)
    // — mirror receipt.repository
    // ================================================================
    receipts: {
      async findByAllocationId(allocationId) {
        return data.receipts
          .filter((r) => r.allocation_id === allocationId)
          .sort(
            (a, b) => Number(a.notice_detail_id) - Number(b.notice_detail_id)
          )
          .map(mapReceiptRow);
      },
      /** Mirror deleteReceiptsByAllocation — release mapping của Undo. */
      async deleteReceiptsByAllocation(allocationId) {
        const before = data.receipts.length;
        data.receipts = data.receipts.filter(
          (r) => r.allocation_id !== allocationId
        );
        return before - data.receipts.length;
      },
      /** Mirror findReceiptsByAllocationIds — batch receipt của nhiều
       * allocation (sweep phase-2 revalidation), trả kèm allocationId. */
      async findReceiptsByAllocationIds(allocationIds) {
        const ids = new Set(allocationIds || []);
        return data.receipts
          .filter((r) => ids.has(r.allocation_id))
          .sort(
            (a, b) =>
              String(a.allocation_id).localeCompare(String(b.allocation_id)) ||
              Number(a.notice_detail_id) - Number(b.notice_detail_id)
          )
          .map(mapReceiptRow);
      },
      async findByAllocationAndNotice(allocationId, noticeDetailId) {
        const row = data.receipts.find(
          (r) =>
            r.allocation_id === allocationId &&
            String(r.notice_detail_id) === String(noticeDetailId)
        );
        return row ? mapReceiptRow(row) : null;
      },
      async sumReceivedByNotice(noticeDetailId) {
        return data.receipts
          .filter((r) => String(r.notice_detail_id) === String(noticeDetailId))
          .reduce((sum, r) => sum + Number(r.received_qty || 0), 0);
      },
      /** Mirror sumReceivedByAllocation: tổng received của 1 allocation. */
      async sumReceivedByAllocation(allocationId) {
        return data.receipts
          .filter((r) => r.allocation_id === allocationId)
          .reduce((sum, r) => sum + Number(r.received_qty || 0), 0);
      },
      /**
       * Mirror sumReceivedByNoticeIds — trả Map noticeDetailId -> tổng,
       * notice không có receipt nào thì vẫn có key = 0.
       */
      async sumReceivedByNoticeIds(noticeIds) {
        const totals = new Map();
        for (const id of noticeIds || []) totals.set(Number(id), 0);
        for (const r of data.receipts) {
          const key = Number(r.notice_detail_id);
          if (totals.has(key)) {
            totals.set(key, totals.get(key) + Number(r.received_qty || 0));
          }
        }
        return totals;
      },
      async insertReceipt(values) {
        const row = clone(values);
        data.receipts.push(row);
        return mapReceiptRow(row);
      },
      async updateReceipt(id, patch) {
        const row = data.receipts.find((r) => r.id === id);
        if (!row) return null;
        Object.assign(row, clone(patch));
        return mapReceiptRow(row);
      },
      async deleteAll() {
        data.receipts = [];
      },
    },

    // ================================================================
    // RECEIPT SYNC (allocation + tổng receipt) — mirror
    // repository/sql/receipt-sync.repository.js (dùng bởi Receipt Sync
    // Worker trong DB_MODE=memory)
    // ================================================================
    receiptSync: {
      /** Mirror findAllocationForSync: allocation + tổng received đã ghi. */
      async findAllocationForSync(allocationId) {
        const row = findAlloc(allocationId);
        if (!row) return null;
        const receipts = data.receipts.filter(
          (r) => r.allocation_id === allocationId
        );
        const receivedTotal = receipts.reduce(
          (sum, r) => sum + Number(r.received_qty || 0),
          0
        );
        return {
          allocationId: row.id,
          poId: row.po_id,
          goodsNo: row.goods_no,
          slotCode: row.slot_code,
          lotNo: row.lot_no ?? null,
          warehouseStatus: row.warehouse_status,
          allocatedQty: Number(row.allocated_qty || 0),
          closedAt: row.closed_at ?? null,
          receivedTotal,
          receiptCount: receipts.length,
        };
      },

      /**
       * Mirror findAllocationsByIds (batch cho UI reconcile issue,
       * 2026-10-28 BỔ SUNG #1-#22): 1 vòng lặp thay vì N lần findAlloc.
       */
      async findAllocationsByIds(allocationIds) {
        if (!Array.isArray(allocationIds) || allocationIds.length === 0) {
          return [];
        }
        const seen = new Set();
        const rows = [];
        for (const allocationId of allocationIds) {
          if (seen.has(allocationId)) continue;
          seen.add(allocationId);
          const row = findAlloc(allocationId);
          if (!row) continue;
          const receipts = data.receipts.filter(
            (r) => r.allocation_id === row.id
          );
          const receivedTotal = receipts.reduce(
            (sum, r) => sum + Number(r.received_qty || 0),
            0
          );
          rows.push({
            allocationId: row.id,
            poId: row.po_id,
            goodsNo: row.goods_no,
            slotCode: row.slot_code,
            lotNo: row.lot_no ?? null,
            warehouseStatus: row.warehouse_status,
            allocatedQty: Number(row.allocated_qty || 0),
            closedAt: row.closed_at ?? null,
            receivedTotal,
            receiptCount: receipts.length,
          });
        }
        return rows;
      },

      /** Mirror listPendingAllocationIds: còn mở và chưa nhận đủ. */
      async listPendingAllocationIds(limit) {
        const pending = data.allocations.filter((a) => {
          if (a.closed_at !== null) return false;
          const receivedTotal = data.receipts
            .filter((r) => r.allocation_id === a.id)
            .reduce((sum, r) => sum + Number(r.received_qty || 0), 0);
          return receivedTotal < Number(a.allocated_qty || 0);
        });
        pending.sort(
          (a, b) =>
            String(a.allocated_at || '').localeCompare(
              String(b.allocated_at || '')
            ) || a.id.localeCompare(b.id)
        );
        return pending.slice(0, limit).map((a) => a.id);
      },

      /**
       * Mirror findPendingAllocations: ĐẦY ĐỦ dòng candidate (po_id,
       * goods_no, allocated, received) cho sweep phân loại batch — cùng
       * thứ tự + filter như bản SQL. Có cursor keyset để sweep KHÔNG bị
       * kẹt mãi ở batch đầu (#9) — batch < limit caller reset cursor.
       */
      async findPendingAllocations(limit, cursor) {
        const pending = data.allocations.filter((a) => {
          if (a.closed_at !== null) return false;
          if (!keysetAfter(a, cursor)) return false;
          const receivedTotal = data.receipts
            .filter((r) => r.allocation_id === a.id)
            .reduce((sum, r) => sum + Number(r.received_qty || 0), 0);
          return receivedTotal < Number(a.allocated_qty || 0);
        });
        pending.sort(
          (a, b) =>
            String(a.allocated_at || '').localeCompare(
              String(b.allocated_at || '')
            ) || a.id.localeCompare(b.id)
        );
        return pending.slice(0, limit).map((a) => ({
          allocationId: a.id,
          poId: a.po_id,
          goodsNo: a.goods_no,
          slotCode: a.slot_code,
          lotNo: a.lot_no ?? null,
          warehouseStatus: a.warehouse_status,
          allocatedAt: a.allocated_at ?? null,
          allocatedQty: Number(a.allocated_qty || 0),
          receivedTotal: data.receipts
            .filter((r) => r.allocation_id === a.id)
            .reduce((sum, r) => sum + Number(r.received_qty || 0), 0),
        }));
      },

      /**
       * Mirror findRevalidationCandidates (sweep PHASE-2 #29-#32):
       * allocation còn mở VÀ ĐÃ CÓ receipt (> 0) — sweep revalidate chống
       * T8 đổi sau khi sync. Cùng cursor keyset như trên.
       */
      async findRevalidationCandidates(limit, cursor) {
        const candidates = data.allocations.filter((a) => {
          if (a.closed_at !== null) return false;
          if (!keysetAfter(a, cursor)) return false;
          const receivedTotal = data.receipts
            .filter((r) => r.allocation_id === a.id)
            .reduce((sum, r) => sum + Number(r.received_qty || 0), 0);
          return receivedTotal > 0;
        });
        candidates.sort(
          (a, b) =>
            String(a.allocated_at || '').localeCompare(
              String(b.allocated_at || '')
            ) || a.id.localeCompare(b.id)
        );
        return candidates.slice(0, limit).map((a) => ({
          allocationId: a.id,
          poId: a.po_id,
          goodsNo: a.goods_no,
          slotCode: a.slot_code,
          lotNo: a.lot_no ?? null,
          allocatedAt: a.allocated_at ?? null,
          allocatedQty: Number(a.allocated_qty || 0),
          receivedTotal: data.receipts
            .filter((r) => r.allocation_id === a.id)
            .reduce((sum, r) => sum + Number(r.received_qty || 0), 0),
        }));
      },

      /**
       * Mirror acquireNoticeLock / acquireAllocationLock — memory mode
       * KHÔNG có transaction hay lock: no-op; worker memory mode chạy
       * đơn luồng trên cùng process.
       */
      async acquireNoticeLock() { },
      async acquireAllocationLock() { },
      /** Mirror refreshHasWarningMirror — (open issue) OR IQC FAIL_PENDING. */
      async refreshHasWarningMirror(allocationId, hasOpenIssue) {
        const row = findAlloc(allocationId);
        if (!row) return false;
        const openIssue =
          Boolean(hasOpenIssue) ||
          data.reconcileIssues.some(
            (r) => r.allocation_id === allocationId && r.status === 'OPEN'
          );
        row.has_warning = openIssue || row.iqc_decision === 'FAIL_PENDING' ? 1 : 0;
        return true;
      },
      /** Mirror refreshHasWarningMirrorForAllocationIds — batch sweep. */
      async refreshHasWarningMirrorForAllocationIds(allocationIds) {
        let count = 0;
        for (const id of allocationIds || []) {
          if (await this.refreshHasWarningMirror(id, false)) count += 1;
        }
        return count;
      },
    },

    // ================================================================
    // IQC SYNC (allocation còn theo dõi IQC + receipt đã có lot) — mirror
    // repository/sql/iqc-sync.repository.js (dùng bởi IQC Worker trong
    // DB_MODE=memory)
    // ================================================================
    iqcSync: {
      /**
       * Mirror findIqcPendingAllocations: còn mở + trạng thái còn theo dõi IQC + có
       * receipt mang lot non-empty. Cùng cursor keyset như Receipt Sync.
       */
      async findIqcPendingAllocations(limit, cursor) {
        const cutoff = previousMonthCutoff();
        const pending = data.allocations.filter((a) => {
          if (a.closed_at !== null) return false;
          const provisionalReturn = a.status === 'RETURNED' &&
            (a.iqc_decision === 'MIXED' ||
              (a.iqc_decision === 'FAIL_RETURN' &&
                (a.last_iqc_at == null || new Date(a.last_iqc_at) >= cutoff)));
          if (a.warehouse_status === 'IN' ||
              (!['WAITING_IQC', 'WAITING_STOCK'].includes(a.status) && !provisionalReturn)) return false;
          if (!keysetAfter(a, cursor)) return false;
          const receipts = data.receipts.filter((r) => r.allocation_id === a.id);
          return receipts.length > 0 && receipts.every((r) => hasLotValue(r.lot_no));
        });
        pending.sort(
          (a, b) =>
            String(a.allocated_at || '').localeCompare(
              String(b.allocated_at || '')
            ) || a.id.localeCompare(b.id)
        );
        return pending.slice(0, limit).map((a) => ({
          allocationId: a.id,
          allocatedAt: a.allocated_at ?? null,
        }));
      },

      /** Mirror findAllocationForIqc: trạng thái allocation để recheck. */
      async findAllocationForIqc(allocationId) {
        const row = findAlloc(allocationId);
        if (!row) return null;
        return {
          allocationId: row.id,
          status: row.status,
          warehouseStatus: row.warehouse_status,
          iqcDecision: row.iqc_decision ?? null,
          hasWarning: Boolean(row.has_warning),
          qtyInStock: numOrNull(row.qty_in_stock),
          qtyReturn: numOrNull(row.qty_return),
          lastIqcAt: isoOrNull(row.last_iqc_at),
          closedAt: row.closed_at ?? null,
        };
      },

      /** Mirror findReceiptsForAllocation: receipt mapping của allocation. */
      async findReceiptsForAllocation(allocationId) {
        return data.receipts
          .filter((r) => r.allocation_id === allocationId)
          .sort(
            (a, b) => Number(a.notice_detail_id) - Number(b.notice_detail_id)
          )
          .map((r) => ({
            id: r.id,
            allocationId: r.allocation_id,
            noticeDetailId: r.notice_detail_id,
            receivedQty: numOrNull(r.received_qty),
            lotNo: r.lot_no ?? null,
            iqcDecision: r.iqc_decision ?? null,
            qtyInStock: numOrNull(r.qty_in_stock),
            qtyReturn: numOrNull(r.qty_return),
            hasWarning: Boolean(r.has_warning),
            qcDate: isoOrNull(r.qc_date),
          }));
      },

      /**
       * Mirror countActiveAllocationsByNoticeIds: số allocation ĐANG MỞ
       * cùng tham chiếu từng notice (partial IQC không được tự chia).
       */
      async countActiveAllocationsByNoticeIds(noticeDetailIds) {
        const ids = new Set((noticeDetailIds || []).map((id) => Number(id)));
        const allocationsByNotice = new Map();
        for (const receipt of data.receipts) {
          const noticeId = Number(receipt.notice_detail_id);
          if (!ids.has(noticeId)) continue;
          const allocation = findAlloc(receipt.allocation_id);
          if (!allocation || allocation.closed_at !== null) continue;
          const allocationIds =
            allocationsByNotice.get(noticeId) || new Set();
          allocationIds.add(receipt.allocation_id);
          allocationsByNotice.set(noticeId, allocationIds);
        }
        return [...allocationsByNotice.entries()].map(
          ([noticeDetailId, allocationIds]) => ({
            noticeDetailId,
            activeAllocations: allocationIds.size,
          })
        );
      },

      /** Mirror findNoticeIdentitiesByIds: identity của pur_notice2. */
      async findNoticeIdentitiesByIds(noticeDetailIds) {
        const ids = new Set((noticeDetailIds || []).map((id) => Number(id)));
        return data.notice2
          .filter((n) => ids.has(Number(n.id)))
          .map((n) => ({
            noticeDetailId: n.id,
            sheetNo: n.sheet_no,
            sheetId: n.sheet_id,
            purNo: n.pur_no,
            purId: n.pur_id,
            goodsNo: n.goods_no,
            madeLot: n.made_lot ?? null,
            sheetQty: numOrNull(n.sheet_qty),
          }));
      },

      /**
       * Mirror findIqcDetailsByIdentity: đọc view IQC theo ĐỦ 6 khóa
       * identity (không fallback, không TOP 1). in_qty mirror
       * COALESCE(SUM(pur_in2.sheet_qty), 0) của view SQL.
       */
      async findIqcDetailsByIdentity(identities) {
        const rows = [];
        for (const identity of identities || []) {
          const match = data.notice2.find(
            (n) =>
              sameText(n.sheet_no, identity.sheetNo) &&
              sameText(n.sheet_id, identity.sheetId) &&
              sameText(n.pur_no, identity.purNo) &&
              sameText(n.pur_id, identity.purId) &&
              sameText(n.goods_no, identity.goodsNo) &&
              n.made_lot !== null &&
              n.made_lot !== undefined &&
              sameText(n.made_lot, identity.madeLot)
          );
          if (!match) continue;
          const inQty = data.in2
            .filter((r) => String(r.notice_id) === String(match.id))
            .reduce((sum, r) => sum + Number(r.sheet_qty || 0), 0);
          rows.push({
            sheetNo: match.sheet_no,
            sheetId: match.sheet_id,
            purNo: match.pur_no,
            purId: match.pur_id,
            goodsNo: match.goods_no,
            madeLot: match.made_lot,
            sheetQty: numOrNull(match.sheet_qty),
            inQty,
            returnQty: numOrNull(match.return_qty),
            adjResult: match.adj_result,
            proResult: match.pro_result,
            qcDate: isoOrNull(match.qc_date),
          });
        }
        return rows;
      },

      /** Mirror updateAllocationIqcSummary: ghi tổng hợp IQC lên allocation. */
      async updateAllocationIqcSummary(allocationId, patch) {
        const row = findAlloc(allocationId);
        if (!row) return false;
        Object.assign(row, clone(patch));
        return true;
      },
    },

    // ================================================================
    // RECONCILE ISSUE (whs_reconcile_issue — ĐỀ XUẤT DDL) — mirror
    // repository/sql/reconcile-issue.repository.js
    // ================================================================
    reconcileIssue: {
      /**
       * Mirror upsertOpenIssue — idempotent theo dedup key
       * (type|allocationId|noticeDetailId) trên dòng OPEN (#36).
       */
      async upsertOpenIssue(issue) {
        const dedupKey = `${issue.type}|${issue.allocationId || ''}|${issue.noticeDetailId || ''}`;
        const nowIso = new Date().toISOString();
        const existing = data.reconcileIssues.find(
          (r) => r.dedup_key === dedupKey && r.status === 'OPEN'
        );
        if (existing) {
          Object.assign(existing, {
            po_id: issue.poId,
            goods_no: issue.goodsNo,
            slot_code: issue.slotCode,
            difference_qty: issue.differenceQty,
            note: issue.note,
            updated_at: nowIso,
          });
          return existing.id;
        }
        const row = {
          id: `rci-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
          dedup_key: dedupKey,
          issue_type: issue.type,
          allocation_id: issue.allocationId,
          notice_detail_id: issue.noticeDetailId,
          po_id: issue.poId,
          goods_no: issue.goodsNo,
          slot_code: issue.slotCode,
          difference_qty: issue.differenceQty,
          status: 'OPEN',
          note: issue.note,
          created_at: nowIso,
          updated_at: nowIso,
          resolved_at: null,
          resolved_by_emp_no: null,
        };
        data.reconcileIssues.push(row);
        return row.id;
      },
      /** Mirror resolveOpenIssuesForAllocation — history giữ lại. */
      async resolveOpenIssuesForAllocation(allocationId) {
        const nowIso = new Date().toISOString();
        let count = 0;
        for (const r of data.reconcileIssues) {
          if (r.allocation_id === allocationId && r.status === 'OPEN') {
            r.status = 'RESOLVED';
            r.updated_at = nowIso;
            r.resolved_at = nowIso;
            count += 1;
          }
        }
        return count;
      },
      /** Mirror resolveOpenIssuesForUndo — gắn người resolve + note lý do undo. */
      async resolveOpenIssuesForUndo(allocationId, undoInfo) {
        const nowIso = new Date().toISOString();
        let count = 0;
        for (const r of data.reconcileIssues) {
          if (r.allocation_id === allocationId && r.status === 'OPEN') {
            r.status = 'RESOLVED';
            r.updated_at = nowIso;
            r.resolved_at = nowIso;
            r.resolved_by_emp_no = undoInfo.resolvedByEmpNo ?? null;
            r.note = String(undoInfo.note || '').slice(0, 500);
            count += 1;
          }
        }
        return count;
      },
      /** Mirror resolveOpenIssuesForAllocationIds — batch 1 lượt cho sweep. */
      async resolveOpenIssuesForAllocationIds(allocationIds) {
        const nowIso = new Date().toISOString();
        const idSet = new Set((allocationIds || []).map(String));
        let count = 0;
        for (const r of data.reconcileIssues) {
          if (idSet.has(String(r.allocation_id)) && r.status === 'OPEN') {
            r.status = 'RESOLVED';
            r.updated_at = nowIso;
            r.resolved_at = nowIso;
            count += 1;
          }
        }
        return count;
      },
      /** Mirror resolveOpenIssuesByTypeForAllocation — resolve CÓ scope (#29). */
      async resolveOpenIssuesByTypeForAllocation(issueType, allocationId) {
        const nowIso = new Date().toISOString();
        let count = 0;
        for (const r of data.reconcileIssues) {
          if (
            r.issue_type === issueType &&
            r.allocation_id === allocationId &&
            r.status === 'OPEN'
          ) {
            r.status = 'RESOLVED';
            r.updated_at = nowIso;
            r.resolved_at = nowIso;
            count += 1;
          }
        }
        return count;
      },
      /** Mirror hasOpenIssueForAllocation — còn issue OPEN nào không (#30). */
      async hasOpenIssueForAllocation(allocationId) {
        return data.reconcileIssues.some(
          (r) => r.allocation_id === allocationId && r.status === 'OPEN'
        );
      },
      /** Mirror resolveOpenIssuesForNotice — chỉ issue cấp notice. */
      async resolveOpenIssuesForNotice(noticeDetailId) {
        const nowIso = new Date().toISOString();
        let count = 0;
        for (const r of data.reconcileIssues) {
          if (
            String(r.notice_detail_id) === String(noticeDetailId) &&
            r.allocation_id == null &&
            r.status === 'OPEN'
          ) {
            r.status = 'RESOLVED';
            r.updated_at = nowIso;
            r.resolved_at = nowIso;
            count += 1;
          }
        }
        return count;
      },
      /** Mirror listOpenIssues — mới nhất trước, shape camelCase. */
      async listOpenIssues(limit = 100) {
        const rows = data.reconcileIssues
          .filter((r) => r.status === 'OPEN')
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
          .slice(0, limit)
          .map((r) => ({
            id: r.id,
            dedupKey: r.dedup_key,
            type: r.issue_type,
            allocationId: r.allocation_id,
            noticeDetailId: r.notice_detail_id,
            poId: r.po_id,
            goodsNo: r.goods_no,
            slotCode: r.slot_code,
            differenceQty: Number(r.difference_qty || 0),
            status: r.status,
            note: r.note,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            resolvedAt: r.resolved_at,
          }));
        return rows;
      },
      /** Mirror findOpenByAllocation — phục vụ test/verify. */
      async findOpenByAllocation(allocationId) {
        return data.reconcileIssues
          .filter(
            (r) => r.allocation_id === allocationId && r.status === 'OPEN'
          )
          .map((r) => ({
            id: r.id,
            type: r.issue_type,
            noticeDetailId: r.notice_detail_id,
            differenceQty: Number(r.difference_qty || 0),
            status: r.status,
            note: r.note,
            updatedAt: r.updated_at,
          }));
      },
    },

    // ================================================================
    // ACTIVITY (whs_activity) — mirror activity.repository
    // ================================================================
    activity: {
      async list(limit = 50) {
        const mapped = [...data.activity]
          .sort((a, b) =>
            String(b.acted_at).localeCompare(String(a.acted_at))
          )
          .map(mapActivityRow);
        return limit > 0 ? mapped.slice(0, limit) : mapped;
      },

      /**
       * Tìm kiếm + phân trang nhật ký (GET /api/warehouse/activity) — port
       * từ searchActivitiesPage gốc: từ khóa khớp case-insensitive trên
       * po_number / user_name / emp_no / slot_code / detail / action_key.
       */
      async searchActivitiesPage(opts) {
        const kw = String(opts.keyword || '').trim().toLowerCase();
        let rows = [...data.activity];
        if (kw) {
          rows = rows.filter(
            (a) =>
              matchesCi(a.po_number, kw) ||
              matchesCi(a.user_name, kw) ||
              matchesCi(a.emp_no, kw) ||
              matchesCi(a.slot_code, kw) ||
              matchesCi(a.detail, kw) ||
              matchesCi(a.action_key, kw)
          );
        }
        if (opts.actionKey) {
          rows = rows.filter((a) => a.action_key === opts.actionKey);
        }
        rows.sort(
          (a, b) =>
            String(b.acted_at).localeCompare(String(a.acted_at)) ||
            String(b.id).localeCompare(String(a.id))
        );
        const total = rows.length;
        const offset = (opts.page - 1) * opts.pageSize;
        const pageRows = rows.slice(offset, offset + opts.pageSize);
        return { rows: pageRows.map(mapActivityRow), total };
      },
      async insert(entry) {
        const row = {
          id: entry.id,
          acted_at: entry.actedAt || new Date().toISOString(),
          emp_no: entry.userId,
          user_name: entry.userName,
          action_key: entry.actionKey,
          allocation_id: entry.allocationId ?? null,
          po_id: entry.poId ?? null,
          notice_detail_id: entry.noticeDetailId ?? null,
          po_number: entry.poNumber ?? null,
          slot_code: entry.slotCode ?? null,
          qty: entry.qty ?? null,
          unit: entry.unit ?? null,
          detail: entry.detail ?? null,
        };
        data.activity.push(row);
        return mapActivityRow(row);
      },
      /** Mirror findByAllocationAndActionKey — idempotency của Undo Assign. */
      async findByAllocationAndActionKey(allocationId, actionKey) {
        const rows = data.activity
          .filter(
            (r) =>
              r.allocation_id === allocationId &&
              String(r.action_key) === String(actionKey)
          )
          .sort((a, b) => String(b.acted_at).localeCompare(String(a.acted_at)));
        return rows[0] ? mapActivityRow(rows[0]) : null;
      },
      async insertRaw(row) {
        const raw = clone(row);
        if (!raw.acted_at) raw.acted_at = new Date().toISOString();
        data.activity.push(raw);
        return mapActivityRow(raw);
      },
      async deleteAll() {
        data.activity = [];
      },
    },

    // ================================================================
    // T8 (mock Germton T8 — T8-simulator là layer duy nhất được ghi)
    // ================================================================
    t8: {
      async deleteAllEmps() {
        data.emps = [];
      },
      async deleteAllGoods() {
        data.goods = [];
      },
      async deleteAllOrder1() {
        data.order1 = [];
      },
      async deleteAllOrder2() {
        data.order2 = [];
      },
      async deleteAllNotice1() {
        data.notice1 = [];
      },
      async deleteAllNotice2() {
        data.notice2 = [];
      },
      async deleteAllIn1() {
        data.in1 = [];
      },
      async deleteAllIn2() {
        data.in2 = [];
      },
      async insertEmp(row) {
        data.emps.push(clone(row));
        return row;
      },
      async insertGoods(row) {
        data.goods.push(clone(row));
        return row;
      },
      async insertOrder1(row) {
        data.order1.push(clone(row));
        return row;
      },
      async insertOrder2(row) {
        data.order2.push(clone(row));
        return row;
      },
      async insertNotice1(row) {
        data.notice1.push(clone(row));
        return row;
      },
      async insertNotice2(row) {
        data.notice2.push(clone(row));
        return row;
      },
      async insertIn1(row) {
        data.in1.push(clone(row));
        return row;
      },
      async insertIn2(row) {
        data.in2.push(clone(row));
        return row;
      },
      async ensureNoticeForPo(poId) {
        const o2 = findOrder2(poId);
        if (!o2) return null;
        const o1 = order1BySheetNo(o2.sheet_no);

        // Notice khớp theo (pur_no, goods_no) — mirror t8.repository SQL.
        const rows = noticesOfOrder2(o2).sort(
          (a, b) => Number(b.id) - Number(a.id)
        );
        if (rows[0]) return mapNotice2Row(rows[0]);

        const n1Id =
          data.notice1.reduce((max, n) => Math.max(max, Number(n.id)), 0) + 1;
        const n2Id =
          data.notice2.reduce((max, n) => Math.max(max, Number(n.id)), 0) + 1;

        const nowIso = new Date().toISOString();
        const lotCode = o2.made_lot || `LOT-${Date.now()}`;
        const sheetNo = `PN-SIM-${String(Date.now()).slice(-10)}`;
        const etaIso = o2.del_date ? isoOrNull(o2.del_date) : nowIso;

        data.notice1.push({
          id: n1Id,
          sheet_no: sheetNo,
          sheet_date: nowIso,
          su_no: o1 ? o1.su_no : null,
          emp_no: o1 ? o1.emp_no : null,
          eta: etaIso,
          sheet_sta: 'Y',
          check_sta: 'Y',
        });
        const inserted = {
          id: n2Id,
          sheet_id: 1, // line seq của receipt mới — KHÔNG phải notice1.id
          sheet_no: sheetNo,
          pur_no: o1 ? o1.sheet_no : null,
          pur_id: o2.sheet_id,
          goods_no: o2.goods_no,
          unit_no: o2.unit_no,
          st_no: '01',
          sheet_qty: Number(o2.sheet_qty),
          check_qty: 0,
          bad_qty: 0,
          return_qty: 0,
          qc_level: null,
          adj_result: '0',
          pro_result: null,
          qc_date: null,
          qc_user_no: null,
          qc_emp_no: null,
          made_lot: lotCode,
          sheet_lot: lotCode,
          // KEY FINAL [R2] (2026-10-28 bỏ điều kiện ngày): notice mới phải
          // khớp lại dòng PO gốc theo def02 để /pos vẫn nhận ra notice này.
          def02: o2.def02 ?? null,
          def23: o2.del_date ? isoOrNull(o2.del_date) : nowIso,
        };
        delete inserted._syncSheetLot;
        data.notice2.push(inserted);
        return mapNotice2Row(inserted);
      },
      async setOrder2Lot(poId, lotCode) {
        const o2 = findOrder2(poId);
        if (!o2) return null;
        o2.made_lot = lotCode;
        return o2;
      },
      async setNoticeLot(noticeId, lotCode) {
        const n = findNotice2(noticeId);
        if (!n) return null;
        n.made_lot = lotCode;
        return n;
      },
      async pushIqcDecision(params) {
        const n = findNotice2(params.noticeDetailId);
        if (!n) return null;
        n.adj_result = params.adjResult;
        n.qc_date = params.qcDate
          ? params.qcDate instanceof Date
            ? params.qcDate.toISOString()
            : params.qcDate
          : new Date().toISOString();
        n.check_qty = params.checkQty ?? 0;
        n.bad_qty = params.badQty ?? 0;
        n.return_qty = params.returnQty ?? 0;
        return mapNotice2Row(n);
      },
      async createEmployee(params) {
        const row = {
          id: params.id,
          emp_no: params.emp_no,
          emp_name: params.emp_name,
          email: params.email,
          dept_no: 'GI',
          org_no: 'GI',
          duty_no: '10',
          act_sw: 'Y',
        };
        data.emps.push(row);
        return row;
      },
      async updateEmployee(empNo, patch) {
        const emp = findEmp(empNo);
        if (!emp) return null;
        if (patch.empName !== undefined) emp.emp_name = patch.empName;
        if (patch.email !== undefined) emp.email = patch.email;
        return emp;
      },
      async renameEmployee(oldEmpNo, newEmpNo) {
        const emp = findEmp(oldEmpNo);
        if (!emp) return null;
        emp.emp_no = newEmpNo;
        return emp;
      },
      async findMaxEmpId() {
        return (
          data.emps.reduce((max, e) => Math.max(max, Number(e.id)), 0) + 1
        );
      },
      async resetT8Mocks() {
        for (const n of data.notice2) {
          n.adj_result = '0';
          n.pro_result = null;
          n.qc_date = null;
          n.check_qty = 0;
          n.bad_qty = 0;
          n.return_qty = 0;
        }
      },
    },

    /**
     * Reset về dữ liệu seed ban đầu — cho nút "Reset demo data" ở FE.
     * (Endpoint POST /reset hiện đã bị service chặn với lỗi reset_disabled,
     * nhưng hàm vẫn giữ đủ để mirror interface SQL mode.)
     */
    async resetAll(seedData) {
      data.emps = clone(seedData.emps);
      data.userRoles = clone(seedData.userRoles);
      data.goods = clone(seedData.goods);
      data.order1 = clone(seedData.order1);
      data.order2 = clone(seedData.order2);
      data.notice1 = clone(seedData.notice1);
      data.notice2 = clone(seedData.notice2);
      data.in1 = clone(seedData.in1);
      data.in2 = clone(seedData.in2);
      data.slots = clone(seedData.slots);
      data.allocations = clone(seedData.allocations);
      data.receipts = clone(seedData.receipts);
      data.assignments = clone(SEED_MATERIAL_ASSIGNMENTS);
      data.movements = [];
      data.activity = clone(seedData.activity);
    },
  };
}

let memoryInstance = null;

/**
 * Singleton in-memory repository — mọi file sql/*.repository.js ở chế độ
 * memory đều gọi hàm này để nhận cùng một instance (state dùng chung).
 */
function getMemoryRepository() {
  if (!memoryInstance) memoryInstance = makeMemoryRepository();
  return memoryInstance;
}

module.exports = { makeMemoryRepository, getMemoryRepository };
