/**
 * Controller SEARCH — kiến trúc Kanban (controller mỏng).
 *
 * Vai trò module: controller mỏng — đọc params/body → gọi service
 * singleton → tạo HTTP response, không chứa business logic hay SQL.
 * Domain phụ trách: tìm kiếm read-only — PO (searchPos), kệ
 * (searchSlots), nhật ký hoạt động (searchActivity).
 * Lỗi async do asyncHandler ở routes chuyển sang error.middleware để
 * giữ nguyên error shape { error: { code, ... } }.
 */

'use strict';

const SearchService = require('../services/search.service');

// ---- TIM KIEM (GET read-only — query khong hop le tu ve mac dinh) ----

const searchPos = async (req, res) => {
  // Truyen actor (SESSION) xuong service — KEEPER chi thay NPL duoc phan;
  // KHONG nhan keeperEmpNo tu query.
  res.json(await SearchService.searchPos(req.query, req.actor));
};

const searchSlots = async (req, res) => {
  res.json(await SearchService.searchSlots(req.query.keyword));
};

const searchActivity = async (req, res) => {
  res.json(await SearchService.searchActivity(req.query));
};

module.exports = { searchPos, searchSlots, searchActivity };
