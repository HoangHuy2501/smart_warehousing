/**
 * SERVICE MỤC KỆ HÀNG — SlotServices (singleton), bảng whs_slots +
 * bas_st_bit + whs_slot_movement. Vai trò trong kiến trúc: tầng business logic của
 * domain kệ — gọi SlotModel / LotModel / AccountModel singleton,
 * KHÔNG chứa HTTP handler hay SQL thô (SQL nằm ở
 * modules/slots/slot.repository.js).
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

const { err, shared, withTestProfile } = require('../../shared/shared');
const { toApiSlot } = require('../../shared/mappers');
const db = require('../../config/db');
const audit = require('../../util/sql-audit');
const T8Slots = require('./t8-slot.repository');
const { t8WarehouseNumbers } = require('../../config/warehouse.config');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('./slot.repository').SlotModel} */
const SlotRepository = require('./slot.repository');
/** @type {import('../accounts/account.repository').AccountModel} */
const AccountsRepository = require('../accounts/account.repository');

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

function t8ModifyUser(actor) {
  const empNo = String(actor.employeeCode ?? actor.id).trim();
  return empNo.slice(0, 4).toUpperCase() === 'TEST' ? 'ADM' : empNo;
}

function slotFields(dto) {
  const limits = { warehouse: 20, row: 5, floor: 2, position: 2 };
  const fields = {};
  for (const [key, limit] of Object.entries(limits)) {
    const value = dto[key];
    if (!['string', 'number'].includes(typeof value)) err('slot_invalid');
    fields[key] = String(value).trim().toUpperCase();
    if (!fields[key] || fields[key].length > limit || fields[key].includes('-')) err('slot_invalid');
  }
  const code = `${fields.warehouse}-${fields.row}-${fields.floor}-${fields.position}`;
  if (code.length > 20) err('slot_code_too_long');
  return { code, ...fields };
}

async function createT8Slot(slot, actor, query) {
  if (db.getMode() === 'memory') return;
  const stNo = warehouseNumber(slot);
  if (await checkT8Slot(slot.code, stNo, query)) {
    await T8Slots.rename(slot.code, slot.code, stNo, t8ModifyUser(actor), query);
  } else {
    await T8Slots.insert(slot, stNo, t8ModifyUser(actor), query);
  }
}

async function renameT8Slot(oldSlot, newSlot, actor, query) {
  if (db.getMode() === 'memory') return;
  const stNo = warehouseNumber(oldSlot);
  const exists = await checkT8Slot(oldSlot.code, stNo, query);
  if ((await T8Slots.find(newSlot.code, query)).length) err('t8_slot_conflict', 409);
  if (await T8Slots.hasReferences(stNo, oldSlot.code, query)) err('t8_slot_in_use', 409);
  if (exists) {
    await T8Slots.rename(oldSlot.code, newSlot.code, stNo, t8ModifyUser(actor), query);
  } else {
    await T8Slots.insert(newSlot, stNo, t8ModifyUser(actor), query);
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
    const { code, ...fields } = slotFields(dto);

    try {
      const inserted = await db.withTransaction(async (query) => {
        await lockSlot(code, query);
        if (await SlotRepository.byCode(code, query)) err('code_exists');
        const slot = await SlotRepository.insert({
          code, ...fields, keeperId: null, locked: false, full: false, active: true,
        }, query);
        await createT8Slot(slot, actor, query);
        await shared.logActivity({
          userId: actor.id, userName: actor.name, actionKey: 'actCreateSlot', slotCode: code,
          detail: audit.insert('whs_slots', {
            code, warehouse: fields.warehouse, slot_row: fields.row,
            floor: fields.floor, position: fields.position,
            keeper_emp_no: null, locked: false, is_full: false, active: true,
          }),
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
    const accounts = (await AccountsRepository.list()).map(withTestProfile);
    const nameOf = (empNo) => {
      if (!empNo) return 'Chưa có thủ kho';
      const found = accounts.find((account) => account.id === empNo);
      return found ? found.name : empNo;
    };
    for (const code of dto.codes) {
      const slot = await SlotRepository.byCode(code);
      if (!slot) continue;
      await SlotRepository.update(code, { keeperId: dto.keeperId || null });
      await shared.logActivity({
        userId: actor.id,
        userName: actor.name,
        actionKey: dto.keeperId ? 'actAssignKeeper' : 'actClearKeeper',
        slotCode: code,
        detail: `Trước: ${nameOf(slot.keeperId)} → Sau: ${nameOf(dto.keeperId)}`,
      });
    }
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
    let renamed;
    if (dto.code !== undefined) {
      if (typeof dto.code !== 'string') err('slot_invalid');
      const parts = dto.code.trim().split('-');
      if (parts.length !== 4) err('slot_invalid');
      renamed = slotFields({ warehouse: parts[0], row: parts[1], floor: parts[2], position: parts[3] });
    }
    if ((renamed || patch.locked !== undefined || patch.active !== undefined) && actor.role !== 'MANAGER') {
      err('no_permission', 403);
    }
    try {
      await db.withTransaction(async (query) => {
        for (const lockedCode of [...new Set([code, renamed?.code].filter(Boolean))].sort()) {
          await lockSlot(lockedCode, query);
        }
        const slot = await SlotRepository.byCode(code, query);
        if (!slot) err('not_found', 404);
        if (patch.full !== undefined && !shared.canAccessSlot(actor, slot)) err('no_permission', 403);
        if (patch.active === false && await SlotRepository.hasNonReturnedAllocation(code, query)) {
          err('cannot_deactivate');
        }
        const changingCode = renamed && renamed.code !== slot.code;
        if (changingCode) {
          if (renamed.warehouse !== slot.warehouse) err('slot_warehouse_change_not_allowed', 409);
          if (await SlotRepository.byCode(renamed.code, query)) err('code_exists');
          if (await SlotRepository.hasReferences(code, query)) err('slot_in_use', 409);
          await renameT8Slot(slot, { ...slot, ...renamed }, actor, query);
          Object.assign(patch, renamed);
        }
        if (!Object.keys(patch).length) return;
        await SlotRepository.update(code, patch, query);
        if (changingCode) {
          await shared.logActivity({
            userId: actor.id, userName: actor.name, actionKey: 'actRenameSlot',
            slotCode: renamed.code,
            detail: audit.update('whs_slots', {
              code: patch.code, warehouse: patch.warehouse, slot_row: patch.row,
              floor: patch.floor, position: patch.position,
              locked: patch.locked, is_full: patch.full, active: patch.active,
            }, { code }),
          }, query);
        }


        const actions = {
          locked: ['actUnlockSlot', 'actLockSlot'],
          full: ['actUnfullSlot', 'actFullSlot'],
          active: ['actDeactivateSlot', 'actActivateSlot'],
        };
        for (const key of ['locked', 'full', 'active']) {
          if (patch[key] === undefined) continue;
          await shared.logActivity({
            userId: actor.id, userName: actor.name,
            actionKey: actions[key][Number(patch[key])], slotCode: renamed?.code || code,
          }, query);
        }
      });
    } catch (error) {
      if ([2601, 2627].includes(error.number) || error.code === '23505') err('code_exists');
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
