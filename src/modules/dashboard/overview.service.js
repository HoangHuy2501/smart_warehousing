'use strict';

// TẮT RESET TỰ ĐỘNG (yêu cầu 2026-10-16): reset() chỉ chạy khi người dùng
// chủ động gọi POST /api/warehouse/reset — không bao giờ tự chạy khi khởi động.
// const { buildSeed } = require('../../config/seed-data');
// const ResetRepository = require('./reset.repository');
const {
  toApiAccount,
  toApiSlot,
  toApiLot,
} = require('../../shared/mappers');
const { err, parsePaging, withTestProfile } = require('../../shared/shared');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../accounts/account.repository').AccountModel} */
const AccountsRepository = require('../accounts/account.repository');
/** @type {import('../slots/slot.repository').SlotModel} */
const SlotRepository = require('../slots/slot.repository');
/** @type {import('../lots/lot.repository').LotModel} */
const LotRepository = require('../lots/lot.repository');
/** @type {import('../po/po.repository').PoModel} */
const PoRepository = require('../po/po.repository');
/** @type {import('../lots/receipt.repository').ReceiptModel} */
const ReceiptRepository = require('../lots/receipt.repository');
const OutboundRepository = require('../outbound/outbound.repository');
class OverviewServices {
  /**
   * GET /accounts — danh sách tài khoản.
   * Không truyền page/pageSize → mảng full như cũ; truyền đi →
   * { items, total, page, pageSize } (phân trang SQL, ORDER BY r.emp_no).
   * @param {object} query - { page?, pageSize? }
   * @returns {Promise<object[]|object>} Mảng full hoặc object phân trang
   */
  async listAccounts(query = {}) {
    const paging = parsePaging(query);
    if (paging) {
      const { rows, total } = await AccountsRepository.listPaged(
        paging.page,
        paging.pageSize
      );
      return {
        // Fallback hồ sơ test (business logic demo) áp tại service —
        // repository trả raw recordset.
        items: rows.map((row) => toApiAccount(withTestProfile(row))),
        total,
        page: paging.page,
        pageSize: paging.pageSize,
      };
    }
    const accounts = await AccountsRepository.list();
    return accounts
      .map(withTestProfile)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(toApiAccount);
  }

  /**
   * GET /slots — danh sách kệ đầy đủ.
   * Hỗ trợ phân trang: truyền page/pageSize → { items, total, page, pageSize }.
   * @param {object} query - { page?, pageSize? }
   * @returns {Promise<object[]|object>} Mảng full hoặc object phân trang
   */
  async listSlots(query = {}) {
    const paging = parsePaging(query);
    if (paging) {
      const { rows, total } = await SlotRepository.listPaged(
        paging.page,
        paging.pageSize
      );
      return {
        items: rows.map(toApiSlot),
        total,
        page: paging.page,
        pageSize: paging.pageSize,
      };
    }
    const slots = await SlotRepository.list();
    return slots.map(toApiSlot);
  }

  /**
   * GET /lots — danh sách lô.
   * Hỗ trợ phân trang: truyền page/pageSize → { items, total, page, pageSize }
   * (ORDER BY allocated_at DESC, id DESC — giống thứ tự bên dưới).
   * @param {object} query - { page?, pageSize? }
   * @returns {Promise<object[]|object>} Mảng full hoặc object phân trang
   */
  async listLots(query = {}) {
    const paging = parsePaging(query);
    if (paging) {
      const { rows, total } = await LotRepository.listPaged(
        paging.page,
        paging.pageSize
      );
      const withReceipts = await this.attachReceiptLots(rows);
      return {
        items: withReceipts.map(toApiLot),
        total,
        page: paging.page,
        pageSize: paging.pageSize,
      };
    }
    const lots = await LotRepository.list();
    const withReceipts = await this.attachReceiptLots(lots);
    return withReceipts
      .sort(
        (a, b) =>
          String(b.assignedAt || '').localeCompare(
            String(a.assignedAt || '')
          ) || String(b.id).localeCompare(String(a.id))
      )
      .map(toApiLot);
  }

  /**
   * PO identity fix 2026-10-29 (§17): gắn receipt mapping (lot + received_qty)
   * vào mỗi allocation — 1 câu batch (IN list), không N+1. lotCode hiển thị
   * derive từ receipt (mappers.toApiLot), không từ madeLot PO khi multi-lot.
   * @param {object[]} rows allocation đã map camelCase (chưa qua toApiLot)
   */
  async attachReceiptLots(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    const ids = rows.map((r) => r.id);
    const receipts = await ReceiptRepository.findReceiptsByAllocationIds(ids);
    const byAllocation = new Map();
    for (const r of receipts) {
      const list = byAllocation.get(r.allocationId) || [];
      list.push({
        lotNo: r.lotNo ?? null,
        receivedQty: Number(r.receivedQty || 0),
      });
      byAllocation.set(r.allocationId, list);
    }
    const stockIds = rows.filter((row) => row.status === 'IN_STOCK').map((row) => row.id);
    const outbound = process.env.OUTBOUND_SYNC_START_DATE
      ? await OutboundRepository.quantitiesByAllocation(stockIds)
      : new Map();
    return rows.map((row) => ({
      ...row,
      outboundQuantities: outbound.get(row.id),
      receiptLots: byAllocation.get(row.id) || [],
    }));
  }

  /**
   * GET /incoming-pos — PO đến hàng.
   * Hỗ trợ phân trang: truyền page/pageSize → { items, total, page, pageSize }
   * (ORDER BY o1.close_sw, o2.del_date, o2.id — giống repo.pos.list()).
   * @param {object} query - { page?, pageSize? }
   * @returns {Promise<object[]|object>} Mảng full hoặc object phân trang
   */
  async listIncomingPos(query = {}) {
    const paging = parsePaging(query);
    if (paging) {
      const { rows, total } = await PoRepository.listPaged(
        paging.page,
        paging.pageSize
      );
      return {
        items: rows.map((row) => ({ ...row, source: 'mock' })),
        total,
        page: paging.page,
        pageSize: paging.pageSize,
      };
    }
    const incomingPos = await PoRepository.list();
    // PO id = t8_pur_order2.id (number) — sắp số thay vì chuỗi để
    // '2' < '10' đúng thứ tự.
    const byPoId = (a, b) =>
      Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);
    return incomingPos.sort(byPoId).map((row) => ({ ...row, source: 'mock' }));
  }

  /**
   * Reset dữ liệu về seed ban đầu (demo) — ĐÃ TẮT (2026-10-16):
   * tránh xóa nhầm dữ liệu thật của team; mở lại bằng cách uncomment
   * resetAll bên dưới khi cần demo từ đầu.
   * @returns {Promise<void>}
   * @throws {ApiError} reset_disabled (400) — luôn ném cho tới khi bật lại
   */
  async reset() {
    // await ResetRepository.resetAll(buildSeed());
    err('reset_disabled', 400);
  }
}

module.exports = new OverviewServices();
