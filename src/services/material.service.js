/**
 * SERVICE PHÂN CÔNG THỦ KHO NPL — MaterialServices (singleton), bảng
 * whs_keeper_material_assignment. Vai trò trong kiến trúc: tầng business
 * logic của domain phân công thủ kho nguyên phụ liệu — gọi MaterialModel
 * singleton, KHÔNG chứa HTTP handler hay SQL thô (SQL nằm ở
 * repository/sql/queries/material.queries.js).
 *
 * Nghiệp vụ (chỉ MANAGER — routes gắn requireManager):
 *   1. listMaterials        : GET /materials?search=&page=&pageSize=
 *                             (pageSize mặc định 10, tối đa 50).
 *   2. assignMaterialKeeper  : POST /materials/assign-keeper — close dòng
 *                             active cũ + thêm dòng mới (1 active / goods),
 *                             refetch trả { material } full shape. Goods
 *                             phải thuộc NPL eligibility M1..M6 / A2.
 *   3. materialHistory       : GET /materials/:goodsNo/history (DESC).
 *   4. endMaterialAssignment : POST /materials/end-assignment — REMOVE NPL
 *                             (chỉ set ended_at, KHÔNG DELETE history).
 *
 * Ràng buộc chính: mỗi goods_no chỉ có tối đa 1 dòng active (filtered
 * unique index UQ_whs_kma_goods_active) — assign thực hiện close dòng active
 * cũ + insert dòng mới TRONG 1 transaction (db.withTransaction ở repository);
 * history giữ nguyên vĩnh viễn (ended_at chỉ đánh dấu kết thúc).
 */

'use strict';

const { err, genId, shared } = require('./shared');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../repository/sql/material.repository').MaterialModel} */
const MaterialRepository = require('../repository/sql/material.repository');

class MaterialServices {
  /**
   * GET /materials — { items, total, page, pageSize } (luôn phân trang).
   * @param {object} query - { search?, page?, pageSize? }
   * @returns {Promise<{items: object[], total: number, page: number, pageSize: number}>}
   */
  async listMaterials(query) {
    const search = String(query.search || '').trim();
    const page = Math.max(1, Number.parseInt(String(query.page), 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(1, Number.parseInt(String(query.pageSize), 10) || 10)
    );
    const { rows, total } = await MaterialRepository.listPaged({
      search: search || null,
      page,
      pageSize,
    });
    return { items: rows, total, page, pageSize };
  }

  /**
   * Gán / đổi thủ kho NPL — validate goods (t8_bas_goods) + keeper
   * (whs_user_role KEEPER active, không khóa) rồi mới ghi. assigned_by
   * lấy từ actor (req.actor.empNo), không tin FE.
   *
   * Repository assign chạy trong 1 transaction: close dòng active cũ
   * (set ended_at) + insert dòng mới — không vi phạm filtered unique
   * UQ_whs_kma_goods_active (1 active / goods).
   *
   * @param {object} dto - { goodsNo, keeperEmpNo, note? }
   * @param {object} actor - Session người gọi (MANAGER)
   * @returns {Promise<{material: object}>} Dòng active sau khi gán (full shape)
   * @throws {ApiError} goods_not_found / invalid_material (goods ngoài
   *   eligibility M1..M6 / A2) / invalid_keeper (400)
   */
  async assignMaterialKeeper(dto, actor) {
    const goodsOk = await MaterialRepository.validateGoods(dto.goodsNo);
    if (!goodsOk) err('goods_not_found', 400);
    // 2026-10-21 (change request): harden eligibility — goods ngoài
    // M1..M6 / A2 bị reject ở BE (regex goods_no /^(M[1-6]|A2)/ trong
    // query), không chỉ phụ thuộc FE.
    const eligibleOk = await MaterialRepository.validateGoodsEligible(
      dto.goodsNo
    );
    if (!eligibleOk) err('invalid_material', 400);
    const keeperOk = await MaterialRepository.validateKeeper(dto.keeperEmpNo);
    if (!keeperOk) err('invalid_keeper', 400);

    const material = await MaterialRepository.assign({
      id: genId('kma'),
      goodsNo: dto.goodsNo,
      keeperEmpNo: dto.keeperEmpNo,
      assignedByEmpNo: actor.empNo,
      assignedAt: new Date().toISOString(),
      note: dto.note ?? null,
    });
    if (!material) err('goods_not_found', 400);
    await shared.logActivity({
      userId: actor.id,
      actionKey: 'actAssignMaterial',
      detail: `${dto.goodsNo} -> ${dto.keeperEmpNo}`,
    });
    return { material };
  }

  /**
    * Gán / đổi thủ kho NPL hàng loạt — validate keeper trước rồi assign tất
    * cả goods trong mảng trong 1 transaction (dùng assignSteps của repository).
    * Goods không tồn tại / ngoài eligibility được bỏ qua (tương đối chấp nhận
    * được cho bulk — không fail nửa chừng).
    *
    * @param {{ goodsNos: string[], keeperEmpNo: string, note?: string }} dto
    * @param {object} actor - Session người gọi (MANAGER)
    * @returns {Promise<{updated: number, materials: object[]}>} số dòng và danh sách NPL sau gán
    * @throws {ApiError} invalid_keeper (400) / goods_list_empty (400)
    */
  async bulkAssignMaterialKeeper(dto, actor) {
    const goodsNos = Array.isArray(dto.goodsNos) ? dto.goodsNos : [];
    if (goodsNos.length === 0) err('goods_list_empty', 400);
    const keeperOk = await MaterialRepository.validateKeeper(dto.keeperEmpNo);
    if (!keeperOk) err('invalid_keeper', 400);

    const now = new Date().toISOString();
    // Dedupe TRƯỚC khi sinh id để mỗi goods có đúng 1 dòng assignment
    // mới; id sinh tại service (refactor 2026-10-26) — repository không
    // phụ thuộc ngược service layer, cùng thứ tự goodsNos đã dedupe.
    const goodsList = [...new Set(goodsNos)];
    const materials = await MaterialRepository.bulkAssign({
      goodsNos: goodsList,
      ids: goodsList.map(() => genId('kma')),
      keeperEmpNo: dto.keeperEmpNo,
      assignedByEmpNo: actor.empNo,
      assignedAt: now,
      note: dto.note ?? null,
    });
    const updated = materials.length;
    if (updated > 0) {
      const list = materials.map((m) => m.goodsNo).join(', ');
      await shared.logActivity({
        userId: actor.id,
        actionKey: 'actBulkAssignMaterial',
        detail: `${updated} NPL -> ${dto.keeperEmpNo}: ${list}`,
      });
    }
    return { updated, materials };
  }

  /**
   * GET /materials/:goodsNo/history — { items } (assigned_at DESC).
  * @param {string} goodsNo - Mã goods cần xem lịch sử phân công
  * @returns {Promise<{items: object[]}>}
  * @throws {ApiError} goods_not_found (404)
  */
  async materialHistory(goodsNo) {
    const goodsOk = await MaterialRepository.validateGoods(goodsNo);
    if (!goodsOk) err('goods_not_found', 404);
    return { items: await MaterialRepository.history(goodsNo) };
  }

  /**
   * NPL active theo thủ kho — cho Profile + Manager Keeper Detail.
   * items: [{ goodsNo, goodsName, keeperEmpNo, keeperName, assignedAt }].
   * @param {string} empNo - Mã nhân sự thủ kho
   * @returns {Promise<{items: object[]}>} Chỉ các dòng chưa có ended_at
   */
  async keeperMaterials(empNo) {
    return { items: await MaterialRepository.activeByKeeper(empNo) };
  }

  /**
   * REMOVE NPL (Manager Keeper Detail): kết thúc phân công hiện hành của
   * (goodsNo, keeperEmpNo) — chỉ set ended_at trên dòng active, KHÔNG
   * DELETE dòng history (bảo toàn assignment history cho tra cứu sau).
   *
   * @param {object} dto - { goodsNo, keeperEmpNo }
   * @param {object} actor - Session người gọi (MANAGER)
   * @returns {Promise<{material: object|null}>} Dòng vừa ended (hoặc null nếu hết active)
   * @throws {ApiError} goods_not_found (400) / no_active_assignment (404)
   */
  async endMaterialAssignment(dto, actor) {
    const goodsOk = await MaterialRepository.validateGoods(dto.goodsNo);
    if (!goodsOk) err('goods_not_found', 400);
    const ended = await MaterialRepository.endAssignment(
      dto.goodsNo,
      dto.keeperEmpNo
    );
    if (!ended) err('no_active_assignment', 404);
    await shared.logActivity({
      userId: actor.id,
      actionKey: 'actRemoveMaterial',
      detail: `${dto.goodsNo} <- ${dto.keeperEmpNo}`,
    });
    return { material: await MaterialRepository.byGoods(dto.goodsNo) };
  }
}

module.exports = new MaterialServices();
module.exports.MaterialServices = MaterialServices;
