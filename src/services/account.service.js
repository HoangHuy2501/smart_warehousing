/**
 * SERVICE MỤC TÀI KHOẢN — AccountServices (singleton).
 * Vai trò trong kiến trúc: tầng business logic của domain tài khoản — gọi
 * các repository singleton (AccountModel / T8Model / SlotModel /
 * MaterialModel), KHÔNG chứa HTTP handler hay SQL thô (SQL khai báo
 * inline trong từng method của repository/sql/*.repository.js).
 * Fallback hồ sơ test (withTestProfile từ shared) áp TẠI ĐÂY khi đọc
 * account — repository chỉ trả raw recordset (refactor 2026-10-26).
 *
 * Nghiệp vụ phụ trách (bảng whs_user_role JOIN t8_bas_emp):
 *   1. createAccount        : MANAGER tạo tài khoản mới (mật khẩu mặc định
 *                             123456). Hồ sơ nhân viên (tên/email) do
 *                             T8-simulator tạo trong t8_bas_emp.
 *   2. updateAccount        : MANAGER cập nhật thông tin cá nhân (tên/email
 *                             trên t8_bas_emp, username trên whs_user_role,
 *                             đổi mã nhân sự → rename tham chiếu).
 *   3. toggleAccountLock    : MANAGER khóa / mở khóa tài khoản.
 *   4. resetAccountPassword : MANAGER đặt lại mật khẩu cho người khác.
 *   5. changePassword       : người dùng tự đổi mật khẩu của chính mình.
 *   6. keeperSections       : kệ + NPL đang đảm nhiệm của 1 thủ kho (từ
 *                             whs_slots.keeper_emp_no + assignment active)
 *                             — dùng cho Profile /auth/me và keeperDetail.
 *   7. keeperDetail          : GET /accounts/:id/keeper-detail (MANAGER) —
 *                             thông tin thủ kho + kệ + NPL đang quản lý.
 *
 * Ràng buộc chính: mọi thao tác quản trị yêu cầu role MANAGER, sai vai
 * trò → 403 no_permission; keeperDetail bắt buộc tài khoản đích có
 * role = KEEPER (lỗi not_keeper).
 */

'use strict';

const { err, shared, withTestProfile } = require('./shared');
const { toApiAccount, toApiSlot } = require('./mappers');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../repository/sql/account.repository').AccountModel} */
const AccountsRepository = require('../repository/sql/account.repository');
/** @type {import('../repository/sql/t8.repository').T8Model} */
const T8Repository = require('../repository/sql/t8.repository');
/** @type {import('../repository/sql/slot.repository').SlotModel} */
const SlotRepository = require('../repository/sql/slot.repository');
/** @type {import('../repository/sql/material.repository').MaterialModel} */
const MaterialRepository = require('../repository/sql/material.repository');

class AccountServices {
  /**
   * Tạo tài khoản mới — chỉ MANAGER.
   * @param {object} dto - { actorId, employeeCode, role, ... }
   * @returns {Promise<object>} Tài khoản vừa tạo (shape IAccount, đã ẩn mật khẩu)
   * @throws {ApiError} no_permission (403) / code_exists / not_found (404)
   */
  async createAccount(dto) {
    const actor = await shared.getActor(dto.actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    const existing = await AccountsRepository.byId(dto.employeeCode);
    if (existing) err('code_exists');

    // Ghi t8_* ĐANG TẮT (2026-10-16, user chọn giữ tắt + báo lỗi rõ):
    // hồ sơ nhân viên phải có SẴN trong t8_bas_emp (T8 là nguồn sự
    // thật). Nếu mã nhân sự chưa tồn tại thì báo not_found — không tự
    // tạo hồ sơ mới; tên/email lấy từ JOIN t8_bas_emp, bỏ qua name/email
    // FE truyền vào.
    // => TẠM TẮT (2026-10-16, user: dữ liệu thật chưa có t8_bas_emp,
    // chỉ comment không xóa — bật lại khi dữ liệu thật đã có hồ sơ
    // nhân viên):
    // const empProfile = await repo.t8.findEmpByNo(dto.employeeCode);
    // if (!empProfile) err('not_found', 404);
    await AccountsRepository.insert({
      employeeCode: dto.employeeCode,
      // username: dto.username,
      role: dto.role,
      locked: false,
      password: '123456', // sau nhớ truyền biến vào (ko để mặc định)
      active: true,
    });
    // Đọc lại để lấy tên/email từ JOIN t8_bas_emp; fallback hồ sơ test
    // là quy tắc nghiệp vụ demo nên áp tại service (không nằm repo).
    const created = withTestProfile(
      await AccountsRepository.byId(dto.employeeCode)
    );
    await shared.logActivity({
      userId: actor.id,
      // userName: actor.name,
      actionKey: 'actCreateAccount',
      detail: dto.name,
    });
    return toApiAccount(created);
  }

  /**
   * Cập nhật thông tin tài khoản — chỉ MANAGER, chỉ các trường được truyền:
   * name/email → t8_bas_emp; username → whs_user_role; employeeCode khác
   * cũ → đổi mã nhân sự (rename tham chiếu cả t8_bas_emp và whs_*).
   * @param {string} id - Mã nhân sự hiện tại của tài khoản đang sửa
   * @param {object} dto - { actorId, employeeCode?, name?, email?, username? }
   * @returns {Promise<void>}
   * @throws {ApiError} no_permission (403) nếu không phải MANAGER hoặc sửa trường T8 read-only
   */
  async updateAccount(id, dto) {
    const actor = await shared.getActor(dto.actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    const target = withTestProfile(await AccountsRepository.byId(id));
    if (!target) err('not_found', 404);

    // Ghi t8_* ĐANG TẮT (2026-10-16): name / email / employeeCode là hồ
    // sơ t8_bas_emp (read-only từ WHS) — chỉ cho sửa khi giá trị KHÔNG
    // đổi; đổi thật chỉ cho phép với username (whs_user_role).
    const norm = (v) => String(v ?? '').trim();
    // Tên hiển thị ra API có fallback về mã nhân sự khi chưa có hồ sơ
    // T8 — so sánh với cùng giá trị fallback đó để FE gửi lại giá trị
    // vừa đọc được thì không bị lỗi.
    const currentName = norm(target.name) || norm(id);
    if (
      dto.employeeCode !== undefined &&
      norm(dto.employeeCode) !== norm(id)
    ) {
      err('no_permission', 403);
    }
    if (dto.name !== undefined && norm(dto.name) !== currentName) {
      err('no_permission', 403);
    }
    if (dto.email !== undefined && norm(dto.email) !== norm(target.email)) {
      err('no_permission', 403);
    }

    let empNo = id;
    if (dto.employeeCode !== undefined && dto.employeeCode !== id) {
      const taken = await AccountsRepository.byId(dto.employeeCode);
      if (taken) err('code_exists');
      await T8Repository.renameEmployee(id, dto.employeeCode);
      await AccountsRepository.renameEmpNo(id, dto.employeeCode);
      empNo = dto.employeeCode;
    }

    const empPatch = {};
    if (dto.name !== undefined) empPatch.empName = dto.name;
    if (dto.email !== undefined) empPatch.email = dto.email;
    if (Object.keys(empPatch).length > 0) {
      await T8Repository.updateEmployee(empNo, empPatch);
    }
    if (dto.username !== undefined) {
      await AccountsRepository.update(empNo, { username: dto.username });
    }
    await shared.logActivity({
      userId: actor.id,
      // userName: actor.name,
      actionKey: 'actUpdateAccount',
      detail: dto.name !== undefined ? dto.name : empNo,
    });
  }

  /**
   * Khóa / mở khóa tài khoản — chỉ MANAGER.
   * @param {string} id - Mã nhân sự của tài khoản
   * @param {string} actorId - Mã nhân sự của người thao tác
   * @returns {Promise<void>}
   */
  async toggleAccountLock(id, actorId) {
    const actor = await shared.getActor(actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    const target = withTestProfile(await AccountsRepository.byId(id));
    if (!target) err('not_found', 404);
    await AccountsRepository.update(id, { locked: !target.locked });
    await shared.logActivity({
      userId: actor.id,
      // userName: actor.name,
      actionKey: target.locked ? 'actUnlockAccount' : 'actLockAccount',
      detail: target.name,
    });
  }

  /**
   * MANAGER đặt lại mật khẩu cho người khác (tối thiểu 6 ký tự).
   * @param {string} id - Mã nhân sự của tài khoản cần reset
   * @param {object} dto - { actorId, newPassword }
   * @returns {Promise<void>}
   * @throws {ApiError} pw_short / not_found (404)
   */
  async resetAccountPassword(id, dto) {
    const actor = await shared.getActor(dto.actorId);
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    if (String(dto.newPassword).length < 6) err('pw_short');
    const updated = await AccountsRepository.update(id, {
      password: dto.newPassword,
    });
    if (!updated) err('not_found', 404);
    await shared.logActivity({
      userId: actor.id,
      // userName: actor.name,
      actionKey: 'actResetPw',
    });
  }

  /**
   * Người dùng tự đổi mật khẩu của mình — cần xác nhận lại mật khẩu mới.
   * @param {object} dto - { actorId, newPassword, confirm }
   * @returns {Promise<void>}
   * @throws {ApiError} pw_mismatch nếu confirm khác newPassword; pw_short nếu < 6 ký tự
   */
  async changePassword(dto) {
    const actor = await shared.getActor(dto.actorId);
    if (dto.newPassword !== dto.confirm) err('pw_mismatch');
    if (String(dto.newPassword).length < 6) err('pw_short');
    await AccountsRepository.update(actor.id, { password: dto.newPassword });
    await shared.logActivity({
      userId: actor.id,
      // userName: actor.name,
      actionKey: 'actChangePw',
    });
  }

  /**
   * Kệ + NPL đang đảm nhiệm của 1 thủ kho — suy ra từ ownership hiện hành
   * (whs_slots.keeper_emp_no) + assignment active, KHÔNG tạo bảng mới.
   * Dùng cho Profile /auth/me (KEEPER) và Manager Keeper Detail.
   *
   * @param {string} empNo - Mã nhân sự của thủ kho cần tra cứu
   * @returns {Promise<{shelves: object[], managedWarehouses: object[], managedMaterials: object[]}>}
   *   shelves: danh sách kệ thủ kho giữ; managedWarehouses: nhóm theo kho
   *   + số kệ; managedMaterials: NPL đang được phân công active
   */
  async keeperSections(empNo) {
    const [shelfRows, materialRows] = await Promise.all([
      SlotRepository.byKeeper(empNo),
      MaterialRepository.activeByKeeper(empNo),
    ]);
    // Kho đảm nhiệm: DISTINCT warehouse + số kệ tương ứng (từ list kệ).
    const byWarehouse = new Map();
    for (const shelf of shelfRows) {
      const count = byWarehouse.get(shelf.warehouse) || 0;
      byWarehouse.set(shelf.warehouse, count + 1);
    }
    const managedWarehouses = [...byWarehouse.entries()].map(
      ([warehouse, shelfCount]) => ({ warehouse, shelfCount })
    );
    return {
      shelves: shelfRows.map(toApiSlot),
      managedWarehouses,
      managedMaterials: materialRows,
    };
  }
  /**
   * GET /accounts/:id/keeper-detail (chỉ MANAGER): thông tin thủ kho + kệ +
   * NPL đang quản lý. selectedEmpNo là resource id (path param) — BE validate
   * tài khoản tồn tại + role = KEEPER; quyền gọi chỉ MANAGER (routes).
   *
   * @param {string} selectedEmpNo - Mã nhân sự của thủ kho được xem (path param)
   * @param {object} actor - Session người gọi (đã qua auth middleware, phải là MANAGER)
   * @returns {Promise<object>} { account, shelves, managedWarehouses, managedMaterials }
   * @throws {ApiError} no_permission (403) nếu không phải MANAGER;
   *   not_found (404) nếu tài khoản không tồn tại; not_keeper (400) nếu
   *   tài khoản đích không có role KEEPER
   */
  async keeperDetail(selectedEmpNo, actor) {
    if (actor.role !== 'MANAGER') err('no_permission', 403);
    const account = withTestProfile(
      await AccountsRepository.byId(selectedEmpNo)
    );
    if (!account) err('not_found', 404);
    if (account.role !== 'KEEPER') err('not_keeper', 400);
    return {
      account: toApiAccount(account),
      ...(await this.keeperSections(selectedEmpNo)),
    };
  }
}

module.exports = new AccountServices();
