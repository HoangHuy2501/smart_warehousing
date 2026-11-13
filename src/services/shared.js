/**
 * HÀM DÙNG CHUNG cho toàn bộ service layer (không phải domain riêng):
 * - err(): ném ApiError với mã lỗi business + HTTP status.
 * - genId(): sinh id ngắn dễ đọc (lot-..., act-..., mov-...).
 * - shared: singleton SharedService (getActor / canAccessSlot /
 *   logActivity) để các domain service dùng chung mà không lặp lại code.
 * - parsePaging(): parse query phân trang cho các GET list.
 * - withTestProfile(): fallback hồ sơ test khi t8_bas_emp chưa có dữ
 *   liệu thật (chuyển từ repository sang service 2026-10-26 — đây là
 *   quy tắc nghiệp vụ demo, không phải thao tác database).
 *
 * Vai trò trong kiến trúc: tiện ích + tác vụ cắt ngang các domain — chỉ
 * gọi AccountModel / ActivityModel singleton, KHÔNG chứa HTTP handler
 * hay SQL thô.
 *
 * Actor = dòng whs_user_role JOIN t8_bas_emp (account.repository):
 * id = emp_no, name = emp_name — dùng làm allocated_by_emp_no khi gán kệ.
 */

'use strict';

const { ApiError } = require('../util/api-error');
const { findTestProfile } = require('../config/test-accounts');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../repository/sql/account.repository').AccountModel} */
const AccountsRepository = require('../repository/sql/account.repository');
/** @type {import('../repository/sql/activity.repository').ActivityModel} */
const ActivityRepository = require('../repository/sql/activity.repository');

/**
 * 2026-10-24 (user): whs_activity chỉ ghi log gán kệ — mọi action_key
 * ngoài danh sách này bị bỏ qua, không ghi vào DB.
 */
// 2026-10-24 (user yêu cầu) whs_activity chỉ ghi log gán kệ; 2026-11-07
// bổ sung UNDO_ASSIGN — Hoàn tác gán kệ là audit bắt buộc (#7 spec Undo).
const ACTIVITY_LOG_KEYS = new Set(['actAssign', 'UNDO_ASSIGN']);

/** Ném lỗi business — controller/error.middleware sẽ đổi thành { error: { code, ... } }. */
function err(code, httpStatus = 400) {
  throw new ApiError(code, httpStatus);
}

/**
 * Fallback hồ sơ test (KHÔNG làm được bằng SQL — dữ liệu nằm trong code
 * config/test-accounts.js): khi name/email/password từ DB (LEFT JOIN
 * t8_bas_emp) là null, điền từ findTestProfile(emp_no). Quy tắc demo:
 * dữ liệu thật chưa có t8_bas_emp nên 2 tài khoản test cần tên/email/mật
 * khẩu khả dụng để đăng nhập — t8 thật có dữ liệu thì fallback tự vô hiệu
 * (row.name đã có giá trị). Refactor 2026-10-26: chuyển từ
 * account.repository sang service vì đây là business logic, repository
 * chỉ trả nguyên recordset từ DB.
 * @param {Record<string, unknown> | null} row dòng tài khoản từ repository
 * @returns {Record<string, unknown> | null} row đã bổ sung fallback test
 */
function withTestProfile(row) {
  if (!row) return null;
  const profile = row.name ? null : findTestProfile(row.id ?? row.employeeCode);
  return {
    ...row,
    name: row.name ?? (profile ? profile.emp_name : null),
    email: row.email ?? (profile ? profile.email : null),
    password: row.password ?? (profile ? profile.password : null),
  };
}

/** Sinh id duy nhất kèm prefix (VD: 'lot-1730092800000-ab12'). */
function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Tác vụ dùng chung giữa các domain service (singleton).
 * Chứa các tác vụ dùng lại nhiều lần: lấy + kiểm tra actor, kiểm tra quyền kệ,
 * ghi nhật ký hoạt động (whs_activity — key camelCase, repository tự map cột).
 */
class SharedService {
  /**
   * Lấy thông tin actor theo actorId (FE truyền trong body — demo auth).
   * Lỗi: 404 not_found nếu không tồn tại; 403 no_permission nếu bị khóa.
   * @param {string} actorId - Mã nhân sự của người thao tác
   * @returns {Promise<object>} Dòng account (JOIN t8_bas_emp)
   */
  async getActor(actorId) {
    // Fallback hồ sơ test áp TẠI SERVICE — repository chỉ trả raw row.
    const actor = withTestProfile(await AccountsRepository.byId(actorId));
    if (!actor) err('not_found', 404);
    if (actor.locked) err('no_permission', 403);
    return actor;
  }

  /**
   * Kiểm tra actor có được thao tác trên kệ này không (SHELF PERMISSION
   * §10, 2026-10-20 — BE enforce, không chỉ FE disable):
   * MANAGER toàn quyền; KEEPER thao tác được kệ của mình VÀ kệ chưa có
   * chủ sở hữu (keeper_emp_no NULL); kệ của keeper KHÁC → 403.
   * Owner hiện hành = whs_slots.keeper_emp_no (không tạo table mới,
   * history tái dùng whs_activity).
   *
   * @param {object} actor - Actor từ getActor
   * @param {object} slot - Dòng whs_slots (chỉ dùng role + keeperId)
   * @returns {boolean} true nếu được phép thao tác
   */
  canAccessSlot(actor, slot) {
    if (actor.role === 'MANAGER') return true;
    if (!slot.keeperId) return true;
    return slot.keeperId === actor.id;
  }

  /**
   * Ghi 1 dòng nhật ký hoạt động vào whs_activity.
   * entry: { userId, userName, actionKey, allocationId?, noticeDetailId?,
   * poId?, poNumber?, slotCode?, qty?, unit?, detail? } — actedAt mặc định = now.
   * poId (logical → pur_order2.id) cần thiết vì activity Assign Shelf
   * xảy ra TRƯỚC khi có notice (yêu cầu user 2026-10-17).
   *
   * @param {object} entry - Dữ liệu nhật ký (key camelCase)
   * @returns {Promise<void>}
   */
  /**
   * @param {object} entry activity entry (actionKey, allocationId, ...)
   * @param {Function} [query] executor (mặc định db.query) — caller giữ
   *   transaction (Undo #12) truyền txQuery để activity ghi atomic cùng
   *   DELETE allocation/receipt; với transaction postgres, truyền đúng
   *   executor của withTransaction.
   */
  async logActivity(entry, query) {
    if (!ACTIVITY_LOG_KEYS.has(entry.actionKey)) return;
    await ActivityRepository.insert(
      {
        id: genId('act'),
        ...entry,
        // user_name NOT NULL — nếu tài khoản chưa có hồ sơ t8_bas_emp
        // (ghi t8 đang tắt) thì dùng mã nhân sự để nhật ký không crash.
        userName: entry.userName ?? entry.userId,
      },
      query
    );
  }
}

const shared = new SharedService();

/**
 * Parse query phân trang cho GET /accounts, /slots, /lots, /incoming-pos.
 * Không truyền page/pageSize → null (gọi list full như cũ).
 * Truyền bất kỳ → { page (>=1, mặc định 1), pageSize (1..200, mặc định 100) }.
 * @param {object} query - Query params của request
 * @returns {object|null} null khi không phân trang
 */
function parsePaging(query) {
  const page = Number.parseInt(String(query.page), 10);
  const pageSize = Number.parseInt(String(query.pageSize), 10);
  if (!Number.isFinite(page) && !Number.isFinite(pageSize)) return null;
  return {
    page: Number.isFinite(page) ? Math.max(1, page) : 1,
    pageSize: Number.isFinite(pageSize)
      ? Math.min(200, Math.max(1, pageSize))
      : 100,
  };
}

module.exports = { err, genId, parsePaging, shared, withTestProfile };
