/**
 * SERVICE MỤC LÔ HÀNG — LotServices (singleton), bảng chính whs_slot_allocation.
 * Vai trò trong kiến trúc: tầng business logic của domain lô/allocation —
 * gọi các repository singleton (LotModel / SlotModel / PoModel /
 * ReceiptModel / T8Model / AccountModel / ActivityModel) và điều phối
 * receipt-sync.service, KHÔNG chứa HTTP handler hay SQL thô.
 *
 * Nghiệp vụ chính + đọc danh sách:
 *   1. assignShelf     : THỦ KHO gán PO lên kệ — INSERT allocation trực tiếp
 *                        từ pur_order2, KHÔNG cho pur_notice2.
 *   2. injectIqcResult : T8 SIMULATOR ONLY (giả lập T8 push) → chạy máy
 *                        trạng thái IQC + warehouse_status; DB_MODE=
 *                        sqlserver → 403 iqc_manual_disabled, production
 *                        chỉ chạy IQC Auto Sync Worker.
 *   3. moveLot         : chuyển một phần / toàn bộ số lượng sang kệ khác.
 *   4. getLots         : danh sách allocation (JOIN order2/order1 làm nguồn
 *                        chính; lot chi tiết nằm ở whs_allocation_receipt).
 *
 * FINAL WHS DATABASE CORRECTION 2026-10-17 — quan hệ receipt N-N:
 * - Assign: INSERT ngay từ pur_order2:
 *     po_id = pur_order2.id, goods_no = pur_order2.goods_no, lot_no NULL,
 *     warehouse_status = 'PO_ASSIGNED', status = 'WAITING_IQC'.
 *   KHÔNG còn notice_detail_id / notice_confirmed trên allocation — mapping
 *   notice giờ nằm ở whs_allocation_receipt, do receipt-sync.service tạo
 *   CHỈ KHI không ambiguous (đúng 1 allocation active + đúng 1 notice):
 *     có receipt → warehouse_status = 'TEMP_IN' + mirror lot_no
 *     ambiguous  → GIỮ chưa map (không FIFO / không chia đều / không đoán).
 *   Unique active (po_id, slot_code) WHERE closed_at IS NULL: nếu đã có
 *   allocation active cùng (po_id, slot_code) thì CỘNG DỒN allocated_qty,
 *   không INSERT duplicate.
 *
 * Máy trạng thái IQC (status FE + warehouse_status kho):
 *   PASS / EXEMPT   → IN_STOCK  + 'IN'
 *   FAIL_PENDING    → giữ WAITING_IQC + has_warning = 1, warehouse 'TEMP_IN'
 *   RETURN          → RETURNED  + 'RETURN'
 * Kết quả IQC được áp lên allocation (nguồn thật) và mirror xuống receipt;
 * phần tách số lượng chỉ mirror khi allocation có ĐÚNG 1 receipt (nhận
 * vật không ambiguous), nhiều receipt → chỉ cập nhật quyết định + qc_date.
 */

'use strict';

const { err, genId, shared } = require('./shared');
const { toApiLot } = require('./mappers');
const { createWorkerLogger } = require('../util/worker/logger');
const db = require('../config/db');
const logger = createWorkerLogger('lot-service');
/** @type {import('./receipt-sync.service').ReceiptSyncServices} */
const receiptSync = require('./receipt-sync.service');
const { enqueueReceiptSync } = require('../queues/receipt-sync.queue');
/** @type {import('../repository/sql/receipt-sync.repository').ReceiptSyncModel} */
const ReceiptSyncRepository = require('../repository/sql/receipt-sync.repository');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../repository/sql/lot.repository').LotModel} */
const LotRepository = require('../repository/sql/lot.repository');
/** @type {import('../repository/sql/slot.repository').SlotModel} */
const SlotRepository = require('../repository/sql/slot.repository');
/** @type {import('../repository/sql/po.repository').PoModel} */
const PoRepository = require('../repository/sql/po.repository');
/** @type {import('../repository/sql/receipt.repository').ReceiptModel} */
const ReceiptRepository = require('../repository/sql/receipt.repository');
/** @type {import('../repository/sql/t8.repository').T8Model} */
const T8Repository = require('../repository/sql/t8.repository');
/** @type {import('../repository/sql/account.repository').AccountModel} */
const AccountsRepository = require('../repository/sql/account.repository');
/** @type {import('../repository/sql/activity.repository').ActivityModel} */
const ActivityRepository = require('../repository/sql/activity.repository');
/** @type {import('../repository/sql/reconcile-issue.repository').ReconcileIssueModel} */
const ReconcileIssueRepository = require('../repository/sql/reconcile-issue.repository');
/**
 * Mã adj_result CHAR(1) mock của T8 (giống warehouse.t8.ts của NestJS) —
 * domain production đang PENDING, khi chốt chỉ cần đổi map này.
 */
const DECISION_TO_ADJ = {
  PASS: '1',
  FAIL_PENDING: '2',
  EXEMPT: '3',
  RETURN: '5',
};


// UNDO ASSIGN (2026-11-07) — Hoàn tác gán kệ khi gán nhầm PO/kệ.
/** action_key audit của Undo — dùng ở Undo + các test đối chiếu history. */
const UNDO_ACTION_KEY = 'UNDO_ASSIGN';
/** Reason bắt buộc của Undo (#9 spec) — free text, trim, không rỗng. */
const UNDO_REASON_MAX = 200;
class LotServices {
  /**
   * Danh sách toàn bộ allocation (mọi trạng thái) — nguồn chính là
   * pur_order2/pur_order1; lot chi tiết đọc từ whs_allocation_receipt.
   * @returns {Promise<object[]>} Danh sách lot shape ILotV2
   */
  async getLots() {
    return LotRepository.list();
  }

  /**
   * Gán PO lên kệ — INSERT allocation từ pur_order2 (không cho notice).
   * Kiểm tra: actor tồn tại, PO tồn tại, kệ hợp lệ (active/khóa/đầy),
   * qty > 0. KHÔNG giới hạn theo sheet_qty của PO — hàng thực tế có thể
   * về vượt PO, số lượng tạm nhập sẽ đối chiếu với T8 khi nhận hàng.
   * Nếu kệ đã có allocation active cùng (po_id, slot_code) → cộng dồn
   * allocated_qty (merge), không INSERT mới.
   *
 * @param {object} dto - { actorId, poId, slotCode, qty, note? }
   * @returns {Promise<object>} Allocation sau khi gán + sync receipt (shape ILotV2)
   * @throws {ApiError} not_found / no_permission (403) / slot_inactive /
   *   slot_locked / slot_full / qty_invalid / future_too_far
   */
  async assignShelf(dto) {
    const actor = await shared.getActor(dto.actorId);

    // poId = t8_pur_order2.id (FE truyền id dòng PO từ PoInbox).
    const poId = Number(dto.poId);
    if (!Number.isInteger(poId)) err('not_found', 404);
    const poLine = await PoRepository.findOrder2ByPoId(poId);
    if (!poLine) err('not_found', 404);

    const slot = await SlotRepository.byCode(dto.slotCode);
    if (!slot) err('not_found', 404);
    if (!shared.canAccessSlot(actor, slot)) err('no_permission', 403);
    if (!slot.active) err('slot_inactive');
    if (slot.locked) err('slot_locked');

    const qty = Number(dto.qty);
    if (!Number.isFinite(qty) || qty <= 0) err('qty_invalid');

    // Giới hạn ngày dự kiến: quá khứ (dù bao xa) và tương lai trong 15 ngày
    // → cho gán; tương lai quá 15 ngày → chặn (tránh gán nhầm PO còn xa).
    // "Chưa tới" chỉ là badge thông tin trên FE, không chặn assign.
    if (poLine.delDate) {
      const eta = new Date(poLine.delDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      eta.setHours(0, 0, 0, 0);
      const diffDays = Math.ceil((eta - today) / (1000 * 60 * 60 * 24));
      if (diffDays > 15) err('future_too_far');
    }

    // Kệ đã có allocation active cùng (po_id, slot_code)? → sẽ MERGE
    // (cộng dồn qty, không chiếm kệ mới) nên bỏ qua kiểm tra slot_full.
    const preExisting = await LotRepository.findActiveAllocationByPoAndSlot(
      poId,
      dto.slotCode
    );
    if (!preExisting && slot.full) err('slot_full');

    const now = new Date().toISOString();

    // Business lot (2026-10-29, final cleanup): Assign Shelf KHÔNG biết lot —
    // lot duy nhất đến từ pur_notice2.made_lot sau khi Receipt Worker sync.
    // dto.lotCode nếu FE legacy vẫn gửi sẽ bị IGNORE (không ghi, không log).

    // INSERT mới hoặc MERGE vào allocation active cùng (po_id, slot_code).
    const existing = preExisting;
    let allocationId;
    if (existing) {
      // Merge: cộng dồn số lượng, KHÔNG insert duplicate.
      const merged = await LotRepository.increaseAllocationQty(existing.id, qty);
      if (!merged) err('not_found', 404);
      allocationId = existing.id;
    } else {
      const inserted = await LotRepository.insertAllocation({
        id: genId('lot'),
        po_id: poId,
        goods_no: poLine.goodsNo,
        lot_no: null, // mirror hiển thị — chỉ set qua receipt khi 1 lot
        warehouse_status: 'PO_ASSIGNED',
        slot_code: dto.slotCode,
        allocated_qty: qty,
        status: 'WAITING_IQC',
        status_recorded_at: now,
        iqc_decision: null,
        has_warning: 0,
        qty_in_stock: null,
        qty_return: null,
        qty_aod: null,
        last_iqc_at: null,
        allocated_by_emp_no: actor.id,
        allocated_at: now,
        closed_at: null,
      });
      if (!inserted) err('not_found', 404);
      allocationId = inserted.id;
    }

    // Receipt sync chạy nền qua queue (worker riêng) — API không chờ.
    // Enqueue fail (Redis down) KHÔNG fallback inline (#8): log là đủ —
    // sweep 5 phút của worker sẽ khôi phục allocation còn thiếu sync.
    // Merge cũng vào đây: allocated_qty tăng → re-sync (existing receipt
    // sẽ được GROW lên theo — receipt-sync.service).
    const enqueued = await enqueueReceiptSync(allocationId);
    if (!enqueued) {
      logger.warn('receipt_sync_enqueue_failed', { allocationId });
    }

    // Tải dòng allocation sau khi (có thể) có receipt → TEMP_IN.
    const result = await LotRepository.byId(allocationId);
    if (!result) err('not_found', 404);

    // Sync giờ chạy async trong worker — tại thời điểm assign KHÔNG có
    // receipt nào (job mới tạo mapping sau đó) nên noticeDetailId = null.
    const detailParts = [`Dòng PO ${poId}`];
    if (dto.note) detailParts.push(dto.note);
    await shared.logActivity({
      userId: actor.id,
      userName: actor.name,
      actionKey: 'actAssign',
      allocationId,
      poId,
      noticeDetailId: null,
      poNumber: poLine.poNumber,
      slotCode: dto.slotCode,
      qty,
      unit: poLine.unitNo,
      detail: detailParts.join(' · '),
    });
    return toApiLot(result);
  }

  /**
   * Nhận quyết định IQC cho 1 allocation (T8 SIMULATOR — giả lập T8 đẩy
   * kết quả). DB_MODE=sqlserver → 403 iqc_manual_disabled (T8 thật chỉ
   * được IQC Auto Sync xử lý). Trước khi áp: thử đồng bộ receipt
   * (allocation x notice) — mapping chỉ được tạo khi không ambiguous;
   * nếu chưa có notice / ambiguous thì vẫn áp kết quả IQC lên allocation
   * như cũ (không báo not_found).
   *
   * @param {string} lotId - id allocation (prefix 'lot-')
   * @param {object} dto - { actorId, decision }
   * @returns {Promise<object>} Allocation sau khi áp IQC (shape ILotV2)
   * @throws {ApiError} iqc_manual_disabled (403) trên DB_MODE=sqlserver;
   *   not_found (404) nếu allocation đóng/không tồn tại; dup_iqc nếu lặp
   *   lại đúng quyết định cũ
   */
  async injectIqcResult(lotId, dto) {
    // (#6) MANUAL IQC = T8 SIMULATOR ONLY: endpoint này là đường IQC
    // giả lập cho memory/test — trên DB_MODE=sqlserver thật phải tắt để
    // không bypass IQC Auto Sync (IQC Worker là luồng production duy
    // nhất, và KHÔNG path nào được set IN_STOCK từ manual IQC).
    if (manualIqcDisabled(db.getMode())) err('iqc_manual_disabled', 403);
    const actor = await shared.getActor(dto.actorId);
    let lot = await LotRepository.byId(lotId);
    if (!lot || lot.closedAt) err('not_found', 404);
    if (lot.iqcDecision === dto.decision && lot.iqcUpdatedAt) {
      err('dup_iqc');
    }

    const now = new Date().toISOString();

    // Thử đồng bộ receipt TRƯỚC khi áp IQC (inline, theo allocationId —
    // không qua queue vì cần state mới ngay): nếu PO đã có notice thật
    // từ T8 và mapping không ambiguous thì tạo receipt (+ TEMP_IN).
    // Chưa có notice / ambiguous → giữ nguyên, vẫn áp IQC lên allocation
    // (không báo not_found — y/c user 2026-10-16 vẫn giữ nguyên).
    const sync = await receiptSync.syncAllocation(lotId);
    if (receiptSync.RECEIPT_MAPPED_STATES.has(sync.state)) {
      lot = await LotRepository.byId(lotId);
      if (!lot) err('not_found', 404);
    }

    // ---- Máy trạng thái IQC: status (FE) + warehouse_status (kho) ----
    let nextStatus = lot.status;
    let nextWarehouse = lot.warehouseStatus;
    let nextInStock = lot.qtyInStock;
    let nextReturn = lot.qtyReturn;
    let nextAod = lot.qtyAod;
    let nextWarning = lot.hasWarning;
    let checkQty = 0;
    let badQty = 0;
    let returnQty = 0;

    switch (dto.decision) {
      case 'PASS':
      case 'EXEMPT':
        nextStatus = 'IN_STOCK';
        nextWarehouse = 'IN';
        nextInStock = lot.qty;
        nextReturn = null;
        nextAod = null;
        nextWarning = false;
        checkQty = lot.qty;
        break;
      case 'FAIL_PENDING':
        // Giữ WAITING_IQC + bật cảnh báo; warehouse vẫn TEMP_IN.
        nextStatus = 'WAITING_IQC';
        nextWarehouse = 'TEMP_IN';
        nextInStock = null;
        nextReturn = null;
        nextAod = null;
        nextWarning = true;
        badQty = lot.qty;
        break;
      case 'RETURN':
        nextStatus = 'RETURNED';
        nextWarehouse = 'RETURN';
        nextInStock = null;
        nextReturn = lot.qty;
        nextAod = null;
        nextWarning = false;
        returnQty = lot.qty;
        break;
      default:
        err('not_found', 404);
    }

    // T8-simulator: đẩy kết quả IQC vào pur_notice2 (mock push) cho từng
    // receipt đã map của allocation (trên SQL thật method ghi đã TẮT).
    const receipts = await ReceiptRepository.findByAllocationId(lotId);
    for (const receipt of receipts) {
      await T8Repository.pushIqcDecision({
        noticeDetailId: receipt.noticeDetailId,
        adjResult: DECISION_TO_ADJ[dto.decision] ?? dto.decision,
        checkQty,
        badQty,
        returnQty,
        qcDate: now,
      });
    }

    // Áp kết quả IQC lên allocation (nguồn thật).
    const updated = await LotRepository.applyIqcResult(lotId, {
      status: nextStatus,
      ...(lot.status !== nextStatus ? { status_recorded_at: now } : {}),
      warehouse_status: nextWarehouse,
      iqc_decision: dto.decision,
      has_warning: nextWarning ? 1 : 0,
      qty_in_stock: nextInStock,
      qty_return: nextReturn,
      qty_aod: nextAod,
      last_iqc_at: now,
    });
    if (!updated) err('not_found', 404);

    // Mirror kết quả IQC xuống receipt: quyết định + qc_date áp cho mọi
    // receipt của allocation; phần TÁCH số lượng chỉ mirror khi allocation
    // có đúng 1 receipt (nhận vật không ambiguous) — nhiều receipt thì
    // không đoán cách chia (để null, chờ rule sau).
    for (const receipt of receipts) {
      const patch = {
        iqc_decision: dto.decision,
        qc_date: now,
        updated_at: now,
        has_warning: nextWarning ? true : false,
      };
      if (receipts.length === 1) {
        patch.qty_in_stock = nextInStock;
        patch.qty_return = nextReturn;
        patch.qty_aod = nextAod;
      }
      await ReceiptRepository.updateReceipt(receipt.id, patch);
    }

    // Refetch qua byId (join PO) để response đầy đủ
    // poNumber / material / supplier / unit như bootstrap.
    const enriched = await LotRepository.byId(lotId);
    const singleReceipt = receipts.length === 1 ? receipts[0] : null;

    await shared.logActivity({
      userId: actor.id,
      userName: actor.name,
      actionKey: 'actIqc',
      allocationId: lotId,
      poId: lot.poId,
      noticeDetailId: singleReceipt ? singleReceipt.noticeDetailId : null,
      poNumber: (enriched ?? updated).poNumber,
      slotCode: (enriched ?? updated).shelfCode,
      qty: (enriched ?? updated).qty,
      unit: (enriched ?? updated).unit,
      detail: dto.decision,
    });
    return toApiLot(enriched ?? updated);
  }

  /**
   * Chuyển allocation sang kệ khác (toàn bộ hoặc một phần):
   * - Kệ đích đã có allocation active cùng (po_id, slot_code) → CỘNG DỒN
   *   allocated_qty (merge), giảm phía nguồn; nguồn về 0 thì close.
   * - Chuyển toàn bộ (kệ đích chưa có allocation cùng PO) → đổi slot_code.
   * - Chuyển một phần → tạo allocation mới trên kệ đích (kéo theo trạng
   *   thái IQC), giảm qty phía nguồn.
   * Luôn ghi 1 dòng whs_slot_movement.
   *
   * @param {string} lotId - id allocation nguồn
   * @param {object} dto - { actorId, targetSlotCode, qty, note? }
   * @returns {Promise<void>}
   * @throws {ApiError} not_found (404) / no_permission (403) / same_slot /
   *   slot_inactive / slot_locked / slot_full / qty_invalid / qty_exceed
   */
  async moveLot(lotId, dto) {
    const actor = await shared.getActor(dto.actorId);
    const lot = await LotRepository.byId(lotId);
    if (!lot || !lot.shelfCode || lot.closedAt) err('not_found', 404);
    const sourceSlot = await SlotRepository.byCode(lot.shelfCode);
    if (!sourceSlot) err('not_found', 404);
    if (!shared.canAccessSlot(actor, sourceSlot)) err('no_permission', 403);
    const target = await SlotRepository.byCode(dto.targetSlotCode);
    if (!target) err('not_found', 404);
    if (!shared.canAccessSlot(actor, target)) err('no_permission', 403);
    if (dto.targetSlotCode === lot.shelfCode) err('same_slot');
    if (!target.active) err('slot_inactive');
    if (target.locked) err('slot_locked');

    const qty = Number(dto.qty);
    if (!Number.isFinite(qty) || qty <= 0) err('qty_invalid');
    if (qty > lot.qty + 1e-9) err('qty_exceed');

    // GUARD #17 (Option A — user chưa chốt rule chia receipt khi move):
    // phần hàng T8 đã confirmed (received_qty của allocation NGUỒN) không
    // được chuyển đi — sau move nguồn phải vẫn thỏa allocated >= received,
    // nếu không receipt ở nguồn sẽ vượt allocated (corrupt reconcile).
    // Chỉ cho move phần CHƯA nhận: qty <= allocated - received.
    // (Move toàn bộ khi chưa có receipt nào vẫn chạy bình thường —
    // moveAllocationSlot đổi slot_code, receipt giữ nguyên allocation.)
    // Đây là fast-fail NGOÀI tx cho UX — tính toán CHÍNH TẮC nằm trong
    // transaction bên dưới (allocation lock + recheck fresh #23-#26).
    const receivedTotal = await ReceiptRepository.sumReceivedByAllocation(
      lot.id
    );
    const maxMovable = Number(lot.qty) - receivedTotal;
    if (qty > maxMovable + 1e-9) err('qty_exceed');

    const now = new Date().toISOString();
    let targetAllocationId = null;

    // Kệ đích đã có allocation active cùng PO? → merge số lượng
    // (không chiếm kệ mới) nên bỏ qua kiểm tra slot_full.
    const targetAlloc = await LotRepository.findActiveAllocationByPoAndSlot(
      lot.poId,
      dto.targetSlotCode
    );
    if (!targetAlloc && target.full) err('slot_full');

    // RACE FIX #23-#26 (Worker-vs-Move): toàn bộ phần ghi số lượng chạy
    // trong 1 db.withTransaction, giữ CÙNG allocation advisory lock
    // (class 9202) với Receipt Worker — worker giữ lock này khi reconcile
    // receipt của allocation, nên move và receipt-sync KHÔNG THỂ xen kẽ
    // giữa lúc đọc tổng received và lúc giảm allocated_qty. Lock order:
    // move chỉ lấy allocation lock (1 lock — không thể deadlock với
    // worker vốn lấy theo thứ tự allocation → notice). Trong tx RE-READ
    // fresh allocated/received bằng câu WHS-only (không JOIN T8 display
    // #27) rồi mới quyết định; decreaseAllocationQty còn có guard atomic
    // SUM(received) ngay trong WHERE (tầng phòng thủ 2).
    let mergedIntoTarget = false;
    let createdNewAllocation = false;
    await db.withTransaction(async (txQuery) => {
      await ReceiptSyncRepository.acquireAllocationLock(lot.id, txQuery);
      const fresh = await ReceiptSyncRepository.findAllocationForSync(
        lot.id,
        txQuery
      );
      if (!fresh || fresh.closedAt) err('not_found', 404);
      if (qty > Number(fresh.allocatedQty) + 1e-9) err('qty_exceed');
      const freshMovable =
        Number(fresh.allocatedQty) - Number(fresh.receivedTotal);
      if (qty > freshMovable + 1e-9) err('qty_exceed');

      const isFullMove = qty >= Number(fresh.allocatedQty) - 1e-9;
      if (targetAlloc && targetAlloc.id !== lot.id) {
        // Merge: cộng qty vào allocation kệ đích + giảm nguồn.
        const increased = await LotRepository.increaseAllocationQty(
          targetAlloc.id,
          qty,
          txQuery
        );
        if (!increased) err('not_found', 404);
        targetAllocationId = targetAlloc.id;
        const decreased = await LotRepository.decreaseAllocationQty(
          lot.id,
          qty,
          txQuery
        );
        if (!decreased) err('qty_exceed');
        mergedIntoTarget = true;
        // Phần còn lại = 0 → đóng allocation nguồn (hạ khỏi kệ).
        if (isFullMove) {
          await LotRepository.closeAllocation(lot.id, now, txQuery);
        }
      } else if (isFullMove) {
        // Chuyển toàn bộ: đổi slot_code của allocation hiện tại.
        const moved = await LotRepository.moveAllocationSlot(
          lot.id,
          dto.targetSlotCode,
          txQuery
        );
        if (!moved) err('not_found', 404);
        targetAllocationId = lot.id;
      } else {
        // Chuyển một phần: tạo allocation mới trên kệ đích (cùng PO, khác
        // kệ nên không vi phạm unique active (po_id, slot_code)).
        // Receipt giữ nguyên phía allocation NGUỒN — không tự chia lại
        // mapping (chưa có rule xác nhận cho việc chia receipt giữa các kệ).
        // SEMANTIC KHỞI ĐẦU FRESH (#7-#9): phần move chỉ có thể là phần
        // CHƯA RECEIPT (guard freshMovable phía trên) → kệ đích KHÔNG
        // được copy lot_no/TEMP_IN/IQC từ nguồn (giả vờ T8 đã nhận phần
        // vừa move là corrupt). Đích bắt đầu như allocation chưa receipt:
        // lot_no NULL + PO_ASSIGNED + WAITING_IQC, không dữ liệu IQC;
        // enqueueReceiptSync(target) phía dưới sẽ tự đối chiếu T8.
        // Insert light: trong tx không refetch display JOIN T8 (#27).
        const created = await LotRepository.insertAllocation(
          {
            id: genId('lot'),
            po_id: lot.poId,
            goods_no: lot.goodsNo,
            lot_no: null,
            warehouse_status: 'PO_ASSIGNED',
            slot_code: dto.targetSlotCode,
            allocated_qty: qty,
            status: 'WAITING_IQC',
            status_recorded_at: now,
            iqc_decision: null,
            has_warning: 0,
            qty_in_stock: null,
            qty_return: null,
            qty_aod: null,
            last_iqc_at: null,
            allocated_by_emp_no: actor.id,
            allocated_at: now,
            closed_at: null,
          },
          txQuery,
          { light: true }
        );
        if (!created) err('not_found', 404);
        targetAllocationId = created.id;
        const decreased = await LotRepository.decreaseAllocationQty(
          lot.id,
          qty,
          txQuery
        );
        if (!decreased) err('qty_exceed');
        createdNewAllocation = true;
      }

      // Ghi lịch sử di chuyển giữa các kệ — cùng tx (chỉ WHS write).
      await SlotRepository.insertMovement(
        {
          id: genId('mov'),
          source_allocation_id: lot.id,
          target_allocation_id: targetAllocationId,
          from_slot_code: lot.shelfCode,
          to_slot_code: dto.targetSlotCode,
          qty,
          moved_by_emp_no: actor.id,
          moved_at: now,
          note: dto.note ?? null,
        },
        txQuery
      );
    });

    // #28: enqueue SAU commit — BullMQ add KHÔNG chạy trong DB transaction
    // (Redis chậm không được giữ khóa allocation). #4: cả hai allocation
    // đổi allocated_qty → re-sync receipt (target tăng — receipt target
    // nếu có sẽ grow; nguồn giảm — còn thiếu thì sweep/job đón). Move trọn
    // lô chỉ đổi slot_code, không đổi allocated/received → khỏi re-sync.
    if (mergedIntoTarget) {
      await enqueueReceiptSync(targetAlloc.id);
      await enqueueReceiptSync(lot.id);
    } else if (createdNewAllocation) {
      await enqueueReceiptSync(targetAllocationId);
      await enqueueReceiptSync(lot.id);
    }

    await shared.logActivity({
      userId: actor.id,
      userName: actor.name,
      actionKey: 'actMoveLot',
      allocationId: lot.id,
      poId: lot.poId,
      noticeDetailId: null, // không đọc từ allocation nữa — receipt mang N-N
      poNumber: lot.poNumber,
      slotCode: dto.targetSlotCode,
      qty,
      unit: lot.unit,
    });
  }
  // ==================== UNDO ASSIGN (2026-11-07) ====================
  // Hoàn tác gán kệ: HARD DELETE allocation + release receipt mapping +
  // resolve OPEN issue + ghi UNDO_ASSIGN activity — tất cả trong MỘT
  // transaction (#12 spec Undo). KHÔNG soft-delete, KHÔNG bảng history
  // mới (whs_activity là history). T8 READ ONLY tuyệt đối (#21).

  /**
   * Validate reason bắt buộc (#9) — trim, không rỗng, ≤ 200 ký tự.
   * @param {unknown} raw dto.reason
   * @returns {string} reason đã trim
   */
  #validateUndoReason(raw) {
    const reason = String(raw ?? '').trim();
    if (!reason) err('undo_reason_required', 400);
    if (reason.length > UNDO_REASON_MAX) err('undo_reason_too_long', 400);
    return reason;
  }

  /**
   * Chặn Undo khi allocation đã phát sinh nghiệp vụ downstream KHÔNG
   * THỂ ĐẢO NGƯỢC (#4 spec): IQC đã quyết, tồn kho/trả hàng/AOD đã ghi,
   * hoặc đã có movement di chuyển kệ (FK vật lý whs_slot_movement →
   * allocation chặn DELETE). Chạy trên dòng đã RE-READ trong transaction
   * nên quyết định luôn dựa trạng thái mới nhất.
   * 2026-11-12 (user yêu cầu): chặn thêm khi lot_no đã có — lô CHỜ IQC
   * mà đã nhận lot T8 (receipt sync đã gắn) thì KHÔNG được hoàn tác;
   * hoàn tác chỉ dành cho lô chưa có lot (gán từ dòng gap PO).
   * @param {Record<string, unknown>} row allocation từ findAllocationRow
   * @param {number} movementCount dòng movement tham chiếu allocation
   * @returns {void}
   */
  #assertUndoAllowed(row, movementCount) {
    if (row.lotNo != null && row.lotNo !== '') {
      err('allocation_has_lot_no', 409);
    }
    if (movementCount > 0) err('allocation_has_downstream_activity', 409);
    if (row.iqcDecision != null || row.lastIqcAt != null) {
      err('allocation_has_downstream_activity', 409);
    }
    if (
      Number(row.qtyInStock) > 0 ||
      Number(row.qtyReturn) > 0 ||
      Number(row.qtyAod) > 0
    ) {
      err('allocation_has_downstream_activity', 409);
    }
  }

  /**
   * Snapshot Undo tối giản cho whs_activity.detail (#8 spec) — đủ audit
   * (allocation đã delete vẫn tái tạo được bối cảnh), không dump nguyên
   * row DB, không serialize object nội bộ.
   * @param {string} reason lý do user nhập (đã trim)
   * @param {Record<string, unknown>} row allocation WHS đã re-read trong tx
   * @param {Record<string, unknown>[]} receipts mapping sắp release
   * @returns {string} JSON string
   */
  #buildUndoActivityDetail(reason, row, receipts) {
    return JSON.stringify({
      reason,
      allocation: {
        id: row.id,
        poId: row.poId,
        goodsNo: row.goodsNo,
        slotCode: row.slotCode,
        allocatedQty: row.allocatedQty,
        lotNo: row.lotNo,
        allocatedByEmpNo: row.allocatedByEmpNo,
        allocatedAt: row.allocatedAt,
      },
      releasedReceipts: receipts.map((r) => ({
        noticeDetailId: r.noticeDetailId,
        receivedQty: r.receivedQty,
        lotNo: r.lotNo,
      })),
    });
  }

  /**
   * Idempotency (#11 spec): allocation không còn tồn tại → nếu đã có
   * UNDO_ASSIGN trong history trả ALREADY_UNDONE (không ghi thêm
   * activity), không thì mới là 404. Chạy được trong tx (Undo re-read
   * không thấy dòng sau khi lock) và ngoài tx (request lặp).
   * @param {string} lotId PK allocation
   * @param {Function} [query] executor (mặc định db.query)
   * @returns {Promise<{ok: true, allocationId: string, state: string,
   *   releasedReceiptCount: number, releasedQty: number}>}
   */
  async #undoAlreadyDoneOrMissing(lotId, query = db.query) {
    const undo = await ActivityRepository.findByAllocationAndActionKey(
      lotId,
      UNDO_ACTION_KEY,
      query
    );
    if (undo) {
      return {
        ok: true,
        allocationId: lotId,
        state: 'ALREADY_UNDONE',
        // số liệu release của lần undo gốc nằm trong activity.detail
        // — response lặp không tái tạo được vì mapping đã delete.
        releasedReceiptCount: 0,
        releasedQty: 0,
      };
    }
    err('allocation_not_found', 404);
  }

  /**
   * HOÀN TÁC GÁN KỆ (V1: toàn bộ allocation tại kệ, không partial #3).
   * Flow atomic trong MỘT transaction (#12): lock allocation → re-read →
   * validate downstream → read receipts → resolve OPEN issues → release
   * receipts → delete allocation → ghi UNDO_ASSIGN activity → COMMIT.
   * T8 KHÔNG bị ghi (#21) — display data (po_number/unit) đọc TRƯỚC tx.
   *
   * Idempotency (#11): allocation còn → UNDONE; allocation mất nhưng có
   * UNDO_ASSIGN history → ALREADY_UNDONE; không history → 404.
   *
   * @param {string} lotId PK allocation (req.params.id)
   * @param {{ actorId?: string, reason?: unknown }} dto body request
   * @returns {Promise<{ok: boolean, allocationId: string, state: string,
   *   releasedReceiptCount: number, releasedQty: number}>}
   */
  async undoAssign(lotId, dto) {
    const actor = await shared.getActor(dto.actorId);
    const reason = this.#validateUndoReason(dto.reason);

    // ---- PRE-CHECK ngoài transaction: fail nhanh + lấy display data ----
    // (JOIN T8 chỉ chạy ở đây; trong tx chỉ WHS — #31 tách bạch IO).
    const lot = await LotRepository.byId(lotId);
    if (!lot) return this.#undoAlreadyDoneOrMissing(lotId);

    // SHELF PERMISSION §10: MANAGER toàn quyền; KEEPER chỉ undo kệ mình
    // phụ trách. Kệ đã bị xóa khỏi từ điển thì không thể chặn audit.
    const slot = await SlotRepository.byCode(lot.shelfCode);
    if (slot && !shared.canAccessSlot(actor, slot)) err('no_permission', 403);

    const display = { poNumber: lot.poNumber, unit: lot.unit };

    // ---- TRANSACTION ATOMIC (#12): mọi bước cùng commit/rollback ----
    return db.withTransaction(async (txQuery) => {
      // (1)+(2) lock + re-read — transaction postgres giữ dòng ổn định.
      await ReceiptSyncRepository.acquireAllocationLock(lotId, txQuery);
      const row = await LotRepository.findAllocationRow(lotId, txQuery);
      if (!row) return this.#undoAlreadyDoneOrMissing(lotId, txQuery);

      // (3) validate downstream trên dòng ĐÃ LOCK (không dùng data cũ).
      const movementCount = await SlotRepository.countMovementsForAllocation(
        lotId,
        txQuery
      );
      this.#assertUndoAllowed(row, movementCount);

      // (4) lock/read receipt mappings chuẩn bị release + snapshot.
      const receipts = await ReceiptRepository.findByAllocationId(
        lotId,
        txQuery
      );

      // (5)+(6) snapshot lý do undo vào issue OPEN của allocation này;
      // history giữ nguyên (status RESOLVED, KHÔNG delete — #6).
      await ReconcileIssueRepository.resolveOpenIssuesForUndo(
        lotId,
        {
          resolvedByEmpNo: actor.id,
          note: `Hoàn tác gán kệ — ${reason}`,
        },
        txQuery
      );

      // (7) release receipt mappings — receipt đã MATCHED vẫn được undo
      // (#5): mapping là dữ liệu derived, allocation đúng gán sau sẽ sync
      // lại và chiếm lại số lượng Notice.
      const releasedReceiptCount =
        await ReceiptRepository.deleteReceiptsByAllocation(lotId, txQuery);

      // (8) hard-delete allocation — 0 dòng nghĩa là có gì đó đổi giữa
      // lock và delete (không thể xảy ra sau lock, nhưng fail rõ ràng
      // thay vì im lặng).
      const deleted = await LotRepository.deleteAllocation(lotId, txQuery);
      if (deleted === 0 || releasedReceiptCount !== receipts.length) {
        err('undo_conflict', 409);
      }

      // (9) audit — activity ghi TRONG cùng tx; allocation_id giữ id của
      // allocation đã delete (logical key, không FK — #2 audit schema).
      const releasedQty = receipts.reduce(
        (sum, r) => sum + Number(r.receivedQty || 0),
        0
      );
      await shared.logActivity(
        {
          userId: actor.id, // NGƯỜI THỰC HIỆN UNDO, không phải người gán (#7)
          userName: actor.name,
          actionKey: UNDO_ACTION_KEY,
          allocationId: row.id,
          poId: row.poId,
          poNumber: display.poNumber,
          slotCode: row.slotCode,
          qty: row.allocatedQty, // allocated_qty TRƯỚC khi undo (#7)
          unit: display.unit,
          detail: this.#buildUndoActivityDetail(reason, row, receipts),
        },
        txQuery
      );

      // (#14) KHÔNG enqueue Receipt Sync cho allocation đã delete; worker
      // gặp allocation mất → NO_OP (receipt-sync.service #13).
      return {
        ok: true,
        allocationId: row.id,
        state: 'UNDONE',
        releasedReceiptCount,
        releasedQty: Number(releasedQty.toFixed(3)),
      };
    });
  }
}


/**
 * Manual IQC (T8 simulator) có bị tắt trên DB thật hay không.
 * Đứng ngoài class để test import mà không cần instance/DB.
 * @param {string} dbMode - giá trị DB_MODE hiện tại
 * @returns {boolean} true khi manual IQC bị disable (sqlserver)
 */
function manualIqcDisabled(dbMode) {
  return dbMode === 'sqlserver';
}

module.exports = new LotServices();
module.exports.manualIqcDisabled = manualIqcDisabled;
