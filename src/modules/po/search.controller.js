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

const SearchService = require('./search.service');

// ---- TIM KIEM (GET read-only — query khong hop le tu ve mac dinh) ----

// Xử lý yêu cầu tìm kiếm PO có phân trang.
const searchPos = async (req, res) => {
  // Truyen actor (SESSION) xuong service — KEEPER chi thay NPL duoc phan;
  // KHONG nhan keeperEmpNo tu query.
  res.json(await SearchService.searchPos(req.query, req.actor));
};

// Tìm mã kệ theo từ khóa.
const searchSlots = async (req, res) => {
  res.json(await SearchService.searchSlots(req.query.keyword));
};

// Tìm kiếm nhật ký hoạt động theo bộ lọc.
const searchActivity = async (req, res) => {
  res.json(await SearchService.searchActivity(req.query));
};

// lấy danh sách Po theo đếm tổng trạng thái
const searchPosCount = async (req, res) => {
  res.json(await SearchService.searchCountPoByStatus())
}
// nhà cung cấp giao chậm thiếu
const supplierLate = async (req, res) => {
  res.json(await SearchService.supplierLate())
}

module.exports = { searchPos, searchSlots, searchActivity, searchPosCount, supplierLate };
