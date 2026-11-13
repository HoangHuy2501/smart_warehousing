/**
 * Bộ đổi kiểu (mappers) — tầng service, thuần hàm, không gọi repository.
 * Vai trò trong kiến trúc: chuyển domain object (output của
 * sql/*.repository.js — camelCase, null cho trường rỗng) → shape JSON trả
 * về cho FE theo contract shared/api.interface.ts (ILotV2 / IAccount /
 * IShelfSlot / IIncomingPo / IActivity). KHÔNG thêm field ngoài contract,
 * KHÔNG đổi tên field.
 */

'use strict';

/** Chuyển null/undefined thành undefined (FE đăng ký optional field). */
function opt(value) {
  return value === null || value === undefined ? undefined : value;
}

/** Account → JSON cho FE (ẩn mật khẩu). */
function toApiAccount(account) {
  return {
    id: account.id,
    name: account.name ?? account.id,
    employeeCode: account.employeeCode,
    email: account.email ?? null,
    // username: account.username,
    role: account.role,
    locked: account.locked,
  };
}

/** Slot → JSON cho FE. */
function toApiSlot(slot) {
  return {
    code: slot.code,
    warehouse: slot.warehouse,
    row: slot.row,
    floor: slot.floor,
    position: slot.position,
    keeperId: opt(slot.keeperId),
    locked: slot.locked,
    full: slot.full,
    active: slot.active,
  };
}

/**
 * Lot (dòng allocation đã map camelCase) → ILotV2 cho FE.
 * Luồng mới: lot_no ban đầu NULL (chưa match receipt). KHÔNG fallback
 * made_lot của PO (chưa được Receipt Sync xác nhận) — chỉ hiển thị lot
 * thực tế từ pur_notice2.made_lot khi đã có receipt mapping.
 * @param {object} lot - Dòng allocation enriched từ LotRepository.byId/list
 * @returns {object} Shape ILotV2
 */
function toApiLot(lot) {
  // PO identity fix 2026-10-29 (§17): lotCode derive từ receipt mapping thực
  // — 1 distinct lot (dù nhiều receipt) → hiển thị lot đó; ≥2 distinct lot →
  // giữ NULL (FE hiển thị "N lots" + chi tiết từ receiptLots); chưa receipt →
  // giữ lot_no mirror, KHÔNG fallback madeLot của PO (chưa được Receipt Sync
  // xác nhận) để tránh gán nhầm lot cho kệ.
  const receiptLots = Array.isArray(lot.receiptLots) ? lot.receiptLots : [];
  const distinctLotMap = new Map();
  for (const r of receiptLots) {
    if (!r.lotNo) continue;
    distinctLotMap.set(
      r.lotNo,
      (distinctLotMap.get(r.lotNo) || 0) + Number(r.receivedQty || 0)
    );
  }
  const distinctLots = [...distinctLotMap.entries()];
  const derivedLotCode =
    distinctLots.length === 1
      ? distinctLots[0][0]
      : distinctLots.length > 1
        ? ''
        : (lot.lotCode ?? '');
  return {
    id: lot.id,
    poNumber: lot.poNumber ?? '',
    poLine: lot.poLine ?? '',
    itemCode: lot.itemCode ?? '',
    material: lot.material ?? '',
    lotCode: derivedLotCode,
    supplier: lot.supplier ?? '',
    qty: lot.qty ?? 0,
    unit: lot.unit ?? '',
    receivedAt: lot.receivedAt ?? lot.assignedAt ?? '',
    shelfCode: opt(lot.shelfCode),
    assignedBy: opt(lot.allocatedByName ?? lot.assignedBy),
    assignedAt: opt(lot.assignedAt),
    status: lot.status,
    iqcDecision: opt(lot.iqcDecision),
    hasWarning: opt(lot.hasWarning),
    qtyInStock: opt(lot.qtyInStock),
    qtyReturn: opt(lot.qtyReturn),
    iqcUpdatedAt: opt(lot.iqcUpdatedAt),
    /** Allocation đã rời kệ (closed_at) — FE cần để không tính kệ là đang có hàng */
    closedAt: opt(lot.closedAt),
    receiptLots: distinctLots.map(([lotNo, receivedQty]) => ({
      lotNo,
      receivedQty: Number(receivedQty),
    })),
    source: 'mock',
  };
}

/**
 * PO (mapPoRow của po.repository) → IIncomingPo cho FE.
 * assignedQty = tổng số lượng đã gán kệ (allocation active) — FE dùng
 * tính số dư trực tiếp (GET /pos và bootstrap).
 * @param {object} po - Dòng PO đã map camelCase
 * @returns {object} Shape IIncomingPo
 */
function toApiPo(po) {
  return {
    id: po.id,
    poNumber: po.poNumber,
    poLine: po.poLine,
    itemCode: po.itemCode,
    material: po.material,
    supplier: po.supplier,
    qty: po.qty,
    /** Số lượng gốc của dòng PO (tham khảo — KHÔNG phải maximum) */
    sheetQty: opt(po.sheetQty),
    unit: po.unit,
    unitPrice: po.unitPrice,
    confirmed: opt(po.confirmed),
    eta: po.eta,
    arrived: po.arrived,
    grnRef: opt(po.grnRef),
    lotNo: opt(po.lotNo),
    assignedQty: opt(po.assignedQty),
    source: 'mock',
  };
}

/** Activity (mapActivityRow) → IActivity cho FE. */
function toApiActivity(entry) {
  return {
    id: entry.id,
    time: entry.time ?? entry.actedAt,
    userId: entry.userId,
    // userName: entry.userName,
    actionKey: entry.actionKey,
    poNumber: opt(entry.poNumber),
    slotCode: opt(entry.slotCode),
    qty: opt(entry.qty),
    unit: opt(entry.unit),
    detail: opt(entry.detail),
  };
}

module.exports = {
  toApiAccount,
  toApiSlot,
  toApiLot,
  toApiPo,
  toApiActivity,
};
