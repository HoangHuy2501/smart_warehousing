/**
 * SERVICE ĐĂNG NHẬP / JWT — AuthServices (singleton) — auth thật thay
 * actorId demo. Vai trò trong kiến trúc: tầng business logic của domain
 * xác thực — gọi AccountModel singleton, KHÔNG chứa HTTP handler hay SQL
 * thô (SQL nằm ở repository/sql/queries/account.queries.js).
 *
 * Nghiệp vụ phụ trách:
 *   1. login        : kiểm tra emp_no + password trên whs_user_role
 *                     (JOIN t8_bas_emp lấy name/email — tái dùng
 *                     AccountsRepository.byId; fallback hồ sơ test-accounts
 *                     là business logic nên áp tại service bằng
 *                     withTestProfile từ shared — refactor 2026-10-26).
 *                     Dùng JWT (thư viện jsonwebtoken, HS256):
 *                     token có hạn 1 NĂM (365d), FE lưu vào localStorage
 *                     và gửi header x-auth-token.
 *   2. authenticate : jwt.verify → trả session từ payload, null nếu
 *                     token sai / hết hạn / đã logout (revoked).
 *   3. logout       : đưa token vào danh sách revoked (in-memory, theo jti)
 *                     đến khi hết hạn — restart server sẽ xóa danh sách
 *                     (demo, không cần Redis).
 *   4. me           : refetch account mới nhất theo payload.sub.
 *
 * Ràng buộc chính: secret lấy từ env JWT_SECRET, thiếu thì dùng default
 * dev 'gws-dev-secret-change-me' (chỉ dùng demo — khi lên production
 * bắt buộc đặt JWT_SECRET); token đã logout bị từ chối theo jti cho đến
 * khi hết hạn.
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { err, withTestProfile } = require('./shared');
const { toApiAccount } = require('./mappers');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../repository/sql/account.repository').AccountModel} */
const AccountsRepository = require('../repository/sql/account.repository');

/** Hạn token: 1 năm (yêu cầu user 2026-10-20). */
const TOKEN_TTL = '365d';
/** Secret ký JWT — ưu tiên env JWT_SECRET, fallback dev default cho demo. */
const JWT_SECRET = process.env.JWT_SECRET || 'gws-dev-secret-change-me';

class AuthServices {
  constructor() {
    /** Map<jti, expiresAtMs> — token đã logout, chưa hết hạn thì từ chối. */
    this.revoked = new Map();
  }

  /**
   * Đăng nhập bằng mã nhân sự + mật khẩu.
   * Sai empNo / password, active = 0 hoặc locked = 1 → 401 invalid_credentials
   * (không tiện lộ tài khoản bị khóa, để FE xử lý như sai thông tin).
   * Trả { token, account } — account dùng shape GET /accounts item.
   *
   * @param {string} empNo - Mã nhân sự (id trên whs_user_role)
   * @param {string} password - Mật khẩu thô so sánh trực tiếp
   * @returns {Promise<{token: string, account: object}>} JWT 365 ngày + tài khoản
   * @throws {ApiError} invalid_credentials (401)
   */
  async login(empNo, password) {
    // Fallback hồ sơ test áp tại service — repo chỉ trả raw row từ DB.
    const account = withTestProfile(await AccountsRepository.byId(empNo));
    if (
      !account ||
      String(account.password) !== String(password) ||
      !account.active ||
      account.locked
    ) {
      err('invalid_credentials', 401);
    }
    const token = jwt.sign(
      {
        empNo: account.employeeCode,
        role: account.role,
        name: account.name ?? account.id,
        email: account.email ?? null,
      },
      JWT_SECRET,
      {
        subject: account.id,
        expiresIn: TOKEN_TTL,
        jwtid: crypto.randomUUID(),
      }
    );
    return { token, account: toApiAccount(account) };
  }

  /**
   * Trả session cho token — null nếu sai / hết hạn / đã revoked.
   * @param {string} token - JWT từ header x-auth-token
   * @returns {object|null} Session { id, empNo, role, name, email }
   */
  authenticate(token) {
    if (typeof token !== 'string' || token === '') return null;
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return null;
    }
    if (payload.jti && this.revoked.has(payload.jti)) return null;
    return {
      id: payload.sub,
      empNo: payload.empNo,
      role: payload.role,
      name: payload.name,
      email: payload.email ?? null,
    };
  }

  /**
   * Đăng xuất — revoke token (theo jti) đến khi hết hạn.
   * @param {string} token - JWT cần thu hồi
   * @returns {boolean} true nếu token hợp lệ đã được revoke, false nếu token sai
   */
  logout(token) {
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return false;
    }
    if (!payload.jti || !payload.exp) return false;
    this.pruneRevoked();
    this.revoked.set(payload.jti, payload.exp * 1000);
    return true;
  }

  /** Dọn các entry revoked đã hết hạn (chạy mỗi lần logout). */
  pruneRevoked() {
    const now = Date.now();
    for (const [jti, expMs] of this.revoked) {
      if (expMs <= now) this.revoked.delete(jti);
    }
  }

  /**
   * GET /auth/me — refetch account theo payload.sub để lấy dữ liệu mới nhất
   * (tên/role/locked có thể đổi sau khi login). Tài khoản bị xóa → 401.
   *
   * @param {object} session - Session từ authenticate(token)
   * @returns {Promise<object>} Account mới nhất (shape IAccount)
   * @throws {ApiError} unauthorized (401) nếu tài khoản không còn tồn tại
   */
  async me(session) {
    const account = withTestProfile(
      await AccountsRepository.byId(session.id)
    );
    if (!account) err('unauthorized', 401);
    return toApiAccount(account);
  }
}

module.exports = new AuthServices();
