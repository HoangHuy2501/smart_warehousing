/**
 * Controller PHÂN CÔNG THỦ KHO NPL — kiến trúc Kanban (controller mỏng).
 *
 * Vai trò module: controller mỏng — đọc params/body → gọi service
 * singleton → tạo HTTP response, không chứa business logic hay SQL.
 * Domain phụ trách: phân công thủ kho NPL (whs_keeper_material_assignment)
 * — chỉ MANAGER — gồm: liệt kê NPL (listMaterials), gán thủ kho
 * (assignMaterialKeeper), xem lịch sử (materialHistory), kết thúc phân
 * công (endMaterialAssignment).
 * Lỗi async do asyncHandler ở routes chuyển sang error.middleware để
 * giữ nguyên error shape { error: { code, ... } }.
 */

'use strict';

const MaterialService = require('../services/material.service');

// ---- PHAN CONG THU KHO NPL (whs_keeper_material_assignment) — chi MANAGER ----

const listMaterials = async (req, res) => {
  res.json(await MaterialService.listMaterials(req.query));
};

const assignMaterialKeeper = async (req, res) => {
  res.status(201).json(
    await MaterialService.assignMaterialKeeper(req.body, req.actor)
  );
};

const materialHistory = async (req, res) => {
  res.json(await MaterialService.materialHistory(req.params.goodsNo));
};

// REMOVE NPL: ket thuc phan cong active cua (goodsNo, keeperEmpNo) —
// chi set ended_at, khong DELETE history.
const endMaterialAssignment = async (req, res) => {
  res.status(201).json(
    await MaterialService.endMaterialAssignment(req.body, req.actor)
  );
};

module.exports = {
  listMaterials,
  assignMaterialKeeper,
  materialHistory,
  endMaterialAssignment,
};
