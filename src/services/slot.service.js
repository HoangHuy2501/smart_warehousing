/**
 * SERVICE MỤC KỆ HÀNG — SlotServices (singleton), bảng whs_slots +
 * bas_st_bit + whs_slot_movement. Vai trò trong kiến trúc: tầng business logic của
 * domain kệ — gọi SlotModel / LotModel / AccountModel singleton,
 * KHÔNG chứa HTTP handler hay SQL thô (SQL nằm ở
 * repository/sql/queries/slot.queries.js).
 *
 * Nghiệp vụ quản lý kệ:
 *   1. createSlot   : MANAGER tạo kệ mới (mã kệ = kho-hàng-tầng-vị trí).
 *   2. assignKeeper  : MANAGER gán / bỏ thủ kho cho nhiều kệ
 *                     (keeper_id = t8_bas_emp.emp_no).
 *   3. updateSlot    : khóa / đầy / vô hiệu hóa kệ (phân quyền theo từng
 *                     tác vụ); "kệ trống" = không còn allocation active.
 *   4. logQrPrint    : MANAGER ghi nhật ký in QR nhiều kệ.
 *
 * Ràng buộc chính: createSlot / assignKeeper / locked / active / logQrPrint
 * chỉ MANAGER (403 no_permission); full do MANAGER hoặc thủ kho được
 * phép thao tác kệ đó (SHELF PERMISSION §10 qua shared.canAccessSlot).
 */

'use strict';

const { err, shared, withTestProfile } = require('./shared');
const { toApiSlot } = require('./mappers');
const db = require('../config/db');
const T8Slots = require('../repository/sql/t8-slot.repository');
const { t8WarehouseNumbers } = require('../config/warehouse.config');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../repository/sql/slot.repository').SlotModel} */
const SlotRepository = require('../repository/sql/slot.repository');
/** @type {import('../repository/sql/account.repository').AccountModel} */
const AccountsRepository = require('../repository/sql/account.repository');

function warehouseNumber(slot) {
  const stNo = t8WarehouseNumbers[slot.warehouse];
  if (!stNo) err('t8_warehouse_unmapped', 409);
  return stNo;
}

async function lockSlot(code, query) {
  if (db.getMode() !== 'memory') await T8Slots.lock(code, query);
}

async function checkT8Slot(code, stNo, query) {
  const rows = await T8Slots.find(code, query);
  if (rows.length > 1 || (rows.length === 1 && rows[0].st_no?.trim() !== stNo)) {
    err('t8_slot_conflict', 409);
  }
  return rows.length === 1;
}

async function syncT8Slot(slot, actorId, query) {
  if (db.getMode() === 'memory') return;
  const stNo = warehouseNumber(slot);
  if (await checkT8Slot(slot.code, stNo, query)) {
    await T8Slots.update(slot, stNo, actorId, query);
  } else {
    await T8Slots.insert(slot, stNo, actorId, query);
  }
}

class SlotServices {
  /**
   * Tạo kệ mới — chỉ MANAGER. Lỗi code_exists nếu mã kệ đã tồn tại.
   * @param {object} dto - { actorId, warehouse, row, floor, position }
   * @returns {Promise<object>} Kệ vừa tạo (shape IShelfSlot)
   */
  async createSlot(dto) {
    const actor = await shared.getActor(dto.actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    const limits = { warehouse: 20, row: 5, floor: 2, position: 2 };
    const fields = {};
    for (const [key, limit] of Object.entries(limits)) {
      const value = dto[key];
      if (!['string', 'number'].includes(typeof value)) err('slot_invalid');
      fields[key] = String(value).trim().toUpperCase();
      if (!fields[key] || fields[key].length > limit) err('slot_invalid');
    }
    const code = `${fields.warehouse}-${fields.row}-${fields.floor}-${fields.position}`;
    if (code.length > 20) err('slot_code_too_long');

    try {
      const inserted = await db.withTransaction(async (query) => {
        await lockSlot(code, query);
        if (await SlotRepository.byCode(code, query)) err('code_exists');
        const slot = await SlotRepository.insert({
          code, ...fields, keeperId: null, locked: false, full: false, active: true,
        }, query);
        await syncT8Slot(slot, actor.id, query);
        await shared.logActivity({
          userId: actor.id, userName: actor.name, actionKey: 'actCreateSlot', slotCode: code,
        }, query);
        return slot;
      });
      return toApiSlot(inserted);
    } catch (error) {
      if ([2601, 2627].includes(error.number) || error.code === '23505') err('code_exists');
      throw error;
    }
  }

  /**
   * Gán / xóa thủ kho cho nhiều kệ cùng lúc (chỉ MANAGER).
   * Kệ không tồn tại thì bỏ qua (idempotent theo từng mã kệ).
   * keeperId = emp_no trong t8_bas_emp / whs_user_role.
   *
   * @param {object} dto - { actorId, codes: string[], keeperId: string|null }
   * @returns {Promise<void>}
   */
  async assignKeeper(dto) {
    const actor = await shared.getActor(dto.actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    // Fallback hồ sơ test áp tại service để tên thủ kho test hiển thị
    // đúng ngay cả khi t8_bas_emp chưa có dữ liệu thật.
    if (!Array.isArray(dto.codes) || dto.codes.some((code) =>
      typeof code !== 'string' || !code || code.length > 20)) err('slot_invalid');
    const accounts = (await AccountsRepository.list()).map(withTestProfile);
    const nameOf = (empNo) => {
      if (!empNo) return 'Chưa có thủ kho';
      const found = accounts.find((account) => account.id === empNo);
      return found ? found.name : empNo;
    };
    await db.withTransaction(async (query) => {
      for (const code of [...new Set(dto.codes)].sort()) {
        await lockSlot(code, query);
        const slot = await SlotRepository.byCode(code, query);
        if (!slot) continue;
        const updated = await SlotRepository.update(code, { keeperId: dto.keeperId || null }, query);
        await syncT8Slot(updated, actor.id, query);
        await shared.logActivity({
          userId: actor.id,
          userName: actor.name,
          actionKey: dto.keeperId ? 'actAssignKeeper' : 'actClearKeeper',
          slotCode: code,
          detail: `Trước: ${nameOf(slot.keeperId)} → Sau: ${nameOf(dto.keeperId)}`,
        }, query);
      }
    });
  }

  /**
   * Cập nhật trạng thái kệ — 3 tác vụ độc lập, phân quyền khác nhau:
   * - locked : chỉ MANAGER; khóa bất kể lúc nào (kệ có hàng vẫn khóa được —
   *   đừng nhận hàng tạm thời), kệ không có giới hạn vật lý.
   * - full   : MANAGER hoặc thủ kho của kệ đó (SHELF PERMISSION §10:
   *   kệ chưa có chủ sở hữu thì KEEPER vẫn thao tác được).
   * - active : chỉ MANAGER; vô hiệu hóa khi kệ chỉ còn hàng RETURNED.
   *
   * @param {string} code - Mã kệ cần cập nhật
   * @param {object} dto - { actorId, locked?, full?, active? } (chỉ áp field truyền)
   * @returns {Promise<void>}
   * @throws {ApiError} not_found (404) / no_permission (403) /
   *   cannot_deactivate khi còn hàng chưa RETURNED trên kệ
   */
  async updateSlot(code, dto) {
    const actor = await shared.getActor(dto.actorId);
    const patch = {};
    for (const key of ['locked', 'full', 'active']) {
      if (dto[key] === undefined) continue;
      if (typeof dto[key] !== 'boolean') err('slot_invalid');
      patch[key] = dto[key];
    }
    if ((patch.locked !== undefined || patch.active !== undefined) && actor.role !== 'MANAGER') {
      err('no_permission', 403);
    }
    await db.withTransaction(async (query) => {
      await lockSlot(code, query);
      const slot = await SlotRepository.byCode(code, query);
      if (!slot) err('not_found', 404);
      if (patch.full !== undefined && !shared.canAccessSlot(actor, slot)) err('no_permission', 403);
      if (patch.active === false && await SlotRepository.hasNonReturnedAllocation(code, query)) {
        err('cannot_deactivate');
      }
      if (!Object.keys(patch).length) return;
      const updated = await SlotRepository.update(code, patch, query);
      await syncT8Slot(updated, actor.id, query);

      const actions = {
        locked: ['actUnlockSlot', 'actLockSlot'],
        full: ['actUnfullSlot', 'actFullSlot'],
        active: ['actDeactivateSlot', 'actActivateSlot'],
      };
      for (const key of Object.keys(patch)) {
        await shared.logActivity({
          userId: actor.id, userName: actor.name,
          actionKey: actions[key][Number(patch[key])], slotCode: code,
        }, query);
      }
    });
  }

  async deleteSlot(code, actorId) {
    const actor = await shared.getActor(actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    try {
      await db.withTransaction(async (query) => {
        await lockSlot(code, query);
        const slot = await SlotRepository.byCode(code, query);
        if (!slot) err('not_found', 404);
        if (await SlotRepository.hasReferences(code, query)) err('slot_in_use', 409);
        if (db.getMode() !== 'memory') {
          const stNo = warehouseNumber(slot);
          await checkT8Slot(code, stNo, query);
          if (await T8Slots.hasReferences(stNo, code, query)) err('t8_slot_in_use', 409);
          await T8Slots.remove(stNo, code, query);
        }
        await SlotRepository.deleteByCode(code, query);
      });
    } catch (error) {
      if (error.number === 547 || error.code === '23503') err('slot_in_use', 409);
      throw error;
    }
  }

  /**
   * Ghi nhật ký in QR cho nhiều kệ — chỉ MANAGER.
   * @param {object} dto - { actorId, codes: string[] }
   * @returns {Promise<void>}
   */
  async logQrPrint(dto) {
    const actor = await shared.getActor(dto.actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    for (const code of dto.codes) {
      await shared.logActivity({
        userId: actor.id,
        userName: actor.name,
        actionKey: 'actPrint',
        slotCode: code,
      });
    }
  }
}

module.exports = new SlotServices();
