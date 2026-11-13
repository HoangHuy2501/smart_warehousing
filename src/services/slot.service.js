/**
 * SERVICE MỤC KỆ HÀNG — SlotServices (singleton), bảng whs_slots +
 * whs_slot_movement. Vai trò trong kiến trúc: tầng business logic của
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
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../repository/sql/slot.repository').SlotModel} */
const SlotRepository = require('../repository/sql/slot.repository');
/** @type {import('../repository/sql/lot.repository').LotModel} */
const LotRepository = require('../repository/sql/lot.repository');
/** @type {import('../repository/sql/account.repository').AccountModel} */
const AccountsRepository = require('../repository/sql/account.repository');

class SlotServices {
  /**
   * Tạo kệ mới — chỉ MANAGER. Lỗi code_exists nếu mã kệ đã tồn tại.
   * @param {object} dto - { actorId, warehouse, row, floor, position }
   * @returns {Promise<object>} Kệ vừa tạo (shape IShelfSlot)
   */
  async createSlot(dto) {
    const actor = await shared.getActor(dto.actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    const code = `${dto.warehouse}-${dto.row}-${dto.floor}-${dto.position}`.toUpperCase();
    const existing = await SlotRepository.byCode(code);
    if (existing) err('code_exists');
    const inserted = await SlotRepository.insert({
      code,
      warehouse: String(dto.warehouse).toUpperCase(),
      row: String(dto.row).toUpperCase(),
      floor: dto.floor,
      position: dto.position,
      keeperId: null,
      locked: false,
      full: false,
      active: true,
    });
    await shared.logActivity({
      userId: actor.id,
      userName: actor.name,
      actionKey: 'actCreateSlot',
      slotCode: code,
    });
    return toApiSlot(inserted);
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
    const slot = await SlotRepository.byCode(code);
    if (!slot) err('not_found', 404);

    if (dto.locked !== undefined) {
      if (actor.role !== 'MANAGER') err('no_permission', 403);
      await SlotRepository.update(code, { locked: dto.locked });
      await shared.logActivity({
        userId: actor.id,
        userName: actor.name,
        actionKey: dto.locked ? 'actLockSlot' : 'actUnlockSlot',
        slotCode: code,
      });
    }

    if (dto.full !== undefined) {
      // SHELF PERMISSION §10: dùng chung canAccessSlot (kệ chưa có chủ
      // sở hữu → KEEPER thao tác được; kệ của keeper khác → 403).
      if (!shared.canAccessSlot(actor, slot)) {
        err('no_permission', 403);
      }
      await SlotRepository.update(code, { full: dto.full });
      await shared.logActivity({
        userId: actor.id,
        userName: actor.name,
        actionKey: dto.full ? 'actFullSlot' : 'actUnfullSlot',
        slotCode: code,
      });
    }

    if (dto.active !== undefined) {
      if (actor.role !== 'MANAGER') err('no_permission', 403);
      if (!dto.active) {
        const onSlot = await LotRepository.byShelf(code);
        if (onSlot.some((lot) => lot.status !== 'RETURNED')) {
          err('cannot_deactivate');
        }
      }
      await SlotRepository.update(code, { active: dto.active });
      await shared.logActivity({
        userId: actor.id,
        userName: actor.name,
        actionKey: dto.active ? 'actActivateSlot' : 'actDeactivateSlot',
        slotCode: code,
      });
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
