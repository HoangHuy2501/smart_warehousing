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
 *   PASS / EXEMPT   → IN_STOCK  + 'IN_STOCK'
 *   FAIL_PENDING    → giữ WAITING_IQC + has_warning = 1, warehouse 'TEMP_IN'
 *   RETURN          → RETURNED  + 'RETURN'
 * Kết quả IQC được áp lên allocation (nguồn thật) và mirror xuống receipt;
 * phần tách số lượng chỉ mirror khi allocation có ĐÚNG 1 receipt (nhận
 * vật không ambiguous), nhiều receipt → chỉ cập nhật quyết định + qc_date.
 */

'use strict';

const { err, genId, shared } = require('../../shared/shared');
const { toApiLot } = require('../../shared/mappers');
const { createWorkerLogger } = require('../../util/worker/logger');
const db = require('../../config/db');
const audit = require('../../util/sql-audit');
const OutboundRepository = require('../outbound/outbound.repository');
const { publishOutboundRevision } = require('../../util/worker/outbound-revision');
const logger = createWorkerLogger('lot-service');
/** @type {import('./receipt-sync.service').ReceiptSyncServices} */
const receiptSync = require('./receipt-sync.service');
const { enqueueReceiptSync } = require('./receipt-sync.queue');
/** @type {import('./receipt-sync.repository').ReceiptSyncModel} */
const ReceiptSyncRepository = require('./receipt-sync.repository');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('./lot.repository').LotModel} */
const LotRepository = require('./lot.repository');
/** @type {import('../slots/slot.repository').SlotModel} */
const SlotRepository = require('../slots/slot.repository');
/** @type {import('../po/po.repository').PoModel} */
const PoRepository = require('../po/po.repository');
/** @type {import('./receipt.repository').ReceiptModel} */
const ReceiptRepository = require('./receipt.repository');
/** @type {import('../t8/t8.repository').T8Model} */
const T8Repository = require('../t8/t8.repository');
/** @type {import('../accounts/account.repository').AccountModel} */
const AccountsRepository = require('../accounts/account.repository');
/** @type {import('../activity/activity.repository').ActivityModel} */
const ActivityRepository = require('../activity/activity.repository');
/** @type {import('../reconciliation/reconcile-issue.repository').ReconcileIssueModel} */
const ReconcileIssueRepository = require('../reconciliation/reconcile-issue.repository');
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
    let activityDetail;
    if (existing) {
      // Merge: cộng dồn số lượng, KHÔNG insert duplicate.
      const merged = await LotRepository.increaseAllocationQty(existing.id, qty);
      if (!merged) err('not_found', 404);
      allocationId = existing.id;
      activityDetail = `UPDATE whs_slot_allocation SET allocated_qty = allocated_qty + ${audit.literal(qty)} WHERE id = ${audit.literal(existing.id)} AND closed_at IS NULL;`;
    } else {
      const allocationValues = {
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
      };
      const inserted = await LotRepository.insertAllocation(allocationValues);
      if (!inserted) err('not_found', 404);
      allocationId = inserted.id;
      activityDetail = audit.insert('whs_slot_allocation', allocationValues);
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
    const detailParts = [
      activityDetail,
      audit.context({ po_number: poLine.poNumber, unit: poLine.unitNo, note: dto.note }),
    ];
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
      detail: detailParts.join('\n'),
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
        nextWarehouse = 'IN_STOCK';
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
        nextWarehouse = 'RETURNED';
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
    const now = new Date().toISOString();
    const outboundEnabled = db.getMode() !== 'memory' && Boolean(process.env.OUTBOUND_SYNC_START_DATE);
    let resyncTargetId;
    let movedWhole = false;
    try {
      await db.withTransaction(async (txQuery) => {
        if (outboundEnabled) await OutboundRepository.lock(txQuery);
        await ReceiptSyncRepository.acquireAllocationLock(lot.id, txQuery);
        const fresh = await ReceiptSyncRepository.findAllocationForSync(lot.id, txQuery);
        if (!fresh || fresh.closedAt) err('not_found', 404);
        if (fresh.slotCode !== lot.shelfCode) err('lot_slot_changed', 409);
        if (fresh.status === 'SEND_STOCK') err('lot_awaiting_t8_approval', 409);
        const destination = await LotRepository.findActiveAllocationByPoAndSlot(lot.poId, dto.targetSlotCode, txQuery);
        if (destination) err('move_target_has_po', 409);
        if (target.full) err('slot_full');

        const isStock = fresh.status === 'IN_STOCK';
        const stock = Number(fresh.qtyInStock ?? 0);
        const returned = Number(fresh.qtyReturn ?? 0);
        const isReturned = fresh.status === 'RETURNED';
        const movable = isStock || isReturned || fresh.status === 'WAITING_STOCK'
          ? stock + returned : fresh.allocatedQty;
        if (qty > movable + 1e-9) err('qty_exceed');
        const whole = Math.abs(qty - movable) <= 1e-9;
        let targetAllocationId = lot.id;

        if (whole) {
          if (!await LotRepository.moveAllocationSlot(lot.id, dto.targetSlotCode, txQuery)) err('not_found', 404);
          if (outboundEnabled) await OutboundRepository.movePendingPicks(lot.id, dto.targetSlotCode, txQuery);
          movedWhole = true;
        } else {
          targetAllocationId = genId('lot');
          const receipts = await ReceiptRepository.findByAllocationId(lot.id, txQuery);
          if (receipts.length > 1 || (stock > 0 && returned > 0) || Number(fresh.qtyAod ?? 0) > 0) {
            err('move_split_ambiguous', 409);
          }
          const receipt = receipts[0];
          if (receipt) {
            await ReceiptSyncRepository.acquireNoticeLock(receipt.noticeDetailId, txQuery);
            if (qty >= Number(receipt.receivedQty) - 1e-9) err('move_split_ambiguous', 409);
          }
          const reserve = outboundEnabled && isStock
            ? await OutboundRepository.reservedForAllocation(lot.id, txQuery) : 0;
          if (isStock && qty > stock - reserve + 1e-9) err('move_qty_reserved', 409);

          const movedStock = fresh.qtyInStock == null ? null : (isReturned ? 0 : stock > 0 ? qty : 0);
          const movedReturn = fresh.qtyReturn == null ? null : (returned > 0 ? qty : 0);
          const created = await LotRepository.insertAllocation({
            id: targetAllocationId,
            po_id: fresh.poId,
            goods_no: fresh.goodsNo,
            lot_no: fresh.lotNo,
            warehouse_status: fresh.warehouseStatus,
            slot_code: dto.targetSlotCode,
            allocated_qty: qty,
            status: fresh.status,
            status_recorded_at: fresh.statusRecordedAt,
            iqc_decision: fresh.iqcDecision,
            has_warning: fresh.hasWarning,
            qty_in_stock: movedStock,
            qty_return: movedReturn,
            qty_aod: fresh.qtyAod,
            last_iqc_at: fresh.lastIqcAt,
            allocated_by_emp_no: actor.id,
            allocated_at: now,
            closed_at: null,
          }, txQuery, { light: true });
          if (!created) err('not_found', 404);

          if (receipt) {
            const receiptStock = receipt.qtyInStock == null ? null : (Number(receipt.qtyInStock) > 0 ? qty : 0);
            const receiptReturn = receipt.qtyReturn == null ? null : (Number(receipt.qtyReturn) > 0 ? qty : 0);
            if (Number(receiptStock) > Number(receipt.qtyInStock) ||
                Number(receiptReturn) > Number(receipt.qtyReturn) || Number(receipt.qtyAod ?? 0) > 0 ||
                (Number(receiptStock) > 0 && Number(receiptReturn) > 0)) err('move_split_ambiguous', 409);

            const updatedReceipt = await ReceiptRepository.updateReceipt(receipt.id, {
              received_qty: Number(receipt.receivedQty) - qty,
              qty_in_stock: receiptStock == null ? null : Number(receipt.qtyInStock) - receiptStock,
              qty_return: receiptReturn == null ? null : Number(receipt.qtyReturn) - receiptReturn,
              updated_at: now,
            }, txQuery);
            if (!updatedReceipt) err('not_found', 404);
            const splitReceipt = await ReceiptRepository.insertReceipt({
              id: genId('rc'),
              allocation_id: targetAllocationId,
              notice_detail_id: receipt.noticeDetailId,
              received_qty: qty,
              lot_no: receipt.lotNo,
              iqc_decision: receipt.iqcDecision,
              qty_in_stock: receiptStock,
              qty_return: receiptReturn,
              qty_aod: receipt.qtyAod,
              has_warning: receipt.hasWarning,
              qc_date: receipt.qcDate,
              confirmed_at: receipt.confirmedAt,
              updated_at: now,
            }, txQuery);
            if (!splitReceipt) err('not_found', 404);
          } else if (fresh.status === 'WAITING_IQC') {
            resyncTargetId = targetAllocationId;
          }

          if (!await LotRepository.decreaseAllocationQty(lot.id, qty, txQuery)) err('qty_exceed');
          if (!await LotRepository.updateAllocationLight(lot.id, {
            qty_in_stock: movedStock == null ? null : stock - movedStock,
            qty_return: movedReturn == null ? null : returned - movedReturn,
          }, txQuery)) err('not_found', 404);
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
    } catch (error) {
      if ([2601, 2627].includes(error.number) || error.code === '23505') {
        err('move_target_has_po', 409);
      }
      throw error;
    }

    if (resyncTargetId) {
      await enqueueReceiptSync(resyncTargetId);
      await enqueueReceiptSync(lot.id);
    }
    if (movedWhole && outboundEnabled) void publishOutboundRevision();

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
   * @returns {string} Mô tả SQL và dữ liệu đối chiếu trước khi hoàn tác
   */
  #buildUndoActivityDetail(reason, row, receipts, actorId) {
    const snapshot = {
      reason, allocation_id: row.id, po_id: row.poId, goods_no: row.goodsNo,
      slot_code: row.slotCode, allocated_qty: row.allocatedQty, lot_no: row.lotNo,
      allocated_by_emp_no: row.allocatedByEmpNo, allocated_at: row.allocatedAt,
    };
    const receiptDetails = receipts.map((receipt, index) => audit.context({
      [`receipt_${index + 1}_notice_detail_id`]: receipt.noticeDetailId,
      [`receipt_${index + 1}_received_qty`]: receipt.receivedQty,
      [`receipt_${index + 1}_lot_no`]: receipt.lotNo,
    }));
    return [
      audit.update('whs_reconcile_issue', {
        status: 'RESOLVED', resolved_by_emp_no: actorId,
        note: `Hoàn tác gán kệ — ${reason}`.slice(0, 500),
      }, { allocation_id: row.id, status: 'OPEN' }),
      audit.remove('whs_allocation_receipt', { allocation_id: row.id }),
      audit.remove('whs_slot_allocation', { id: row.id }),
      audit.context(snapshot), ...receiptDetails,
    ].join('\n');
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
          detail: this.#buildUndoActivityDetail(reason, row, receipts, actor.id),
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
