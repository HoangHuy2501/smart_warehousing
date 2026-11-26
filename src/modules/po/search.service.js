/**
 * SERVICE TÌM KIẾM — SearchServices (singleton), read-only.
 * Vai trò trong kiến trúc: tầng business logic cho 3 endpoint GET tìm
 * kiếm — gọi PoModel / SlotModel / ActivityModel singleton, KHÔNG chứa
 * HTTP handler hay SQL thô (SQL khai báo inline trong từng method của
 * repository/sql/*.repository.js). Điều phối đa bước (list + buckets)
 * nằm tại service theo mẫu Kanban (refactor 2026-10-26).
 *
 * Endpoint chỉ đọc:
 *   - searchPos      : GET /api/warehouse/pos — phân trang + tìm kiếm PO mở
*                     (không còn lọc theo số dư — được phép gán vượt
 *                     PO qty, sheetQty trả về chỉ để tham khảo)
 *                     + đếm số ĐƠN (poNumber duy nhất) theo bucket ETA
 *                     od1 / od2 / od3p / next3 / next7 (2026-10-20).
 *   - searchSlots    : GET /api/warehouse/slots?keyword= — danh sách mã kệ
 *                     khớp từ khóa (PO / NPL / vật tư / lô).
 *   - searchActivity : GET /api/warehouse/activity — phân trang + tìm kiếm
 *                     nhật ký thao tác.
 *
 * Endpoint chỉ đọc: tham số không hợp lệ KHÔNG báo lỗi — tự chuyển về giá
 * trị mặc định (mirror warehouse.service.ts NestJS): bucket sai → coi như
 * không truyền (null), page < 1 hoặc sai định dạng → 1, pageSize kẹp
 * 5..100 (PO mặc định 15, activity mặc định 20). Từ khóa luôn trim.
 *
 * Biến bucket ETA (2026-10-20) tính bằng HÀM DÙNG CHUNG
 * src/util/bucket-dates.js (computeBucketDates — date-only YYYY-MM-DD):
 * od1 = [ngày 1 tháng trước, hôm nay), od2 = [ngày 1 của 2 tháng trước,
 * ngày 1 tháng trước), od3p = cũ hơn (NULL del_date cũng thuộc od3p),
 * next3 = [hôm nay, +4), next7 = [+4, +8).
 *
 * KEEPER scope: @keeperEmpNo lấy TỪ SESSION (req.actor), KHÔNG BAO GIỜ
 * nhận từ query — KEEPER chỉ thấy NPL được phân công active (qua EXISTS
 * whs_keeper_material_assignment ended_at IS NULL).
 */

'use strict';

const { toApiActivity } = require('../../shared/mappers');
const { computeBucketDates } = require('../../util/bucket-dates');
/** @type {import('./po.repository').PoModel} */
const PoRepository = require('./po.repository');
/** @type {import('../slots/slot.repository').SlotModel} */
const SlotRepository = require('../slots/slot.repository');
/** @type {import('../activity/activity.repository').ActivityModel} */
const ActivityRepository = require('../activity/activity.repository');

/** Bucket hợp lệ của query /pos — giá trị khác → coi như không truyền. */
const VALID_BUCKETS = ['overdue', 'od1', 'od2', 'od3p', 'next3', 'next7'];

/** page >= 1; chuỗi rỗng / sai định dạng / NaN → 1. */
function parsePage(value) {
  return Math.max(1, parseInt(value ?? '1', 10) || 1);
}

/** pageSize kẹp 5..100; chuỗi rỗng / sai định dạng → fallback. */
function parsePageSize(value, fallback) {
  return Math.min(
    100,
    Math.max(5, parseInt(value ?? fallback, 10) || fallback)
  );
}

class SearchServices {
  /**
   * GET /pos — phân trang PO mở + đếm số đơn theo bucket ETA.
   * bucketCounts lọc theo keyword nhưng KHÔNG lọc bucket (FE làm tab).
   * Danh sách và các số đếm chạy đồng thời.
   *
   * @param {object} query - { keyword?, bucket?, page?, pageSize?, counts? }
   * @param {object} actor - Session người gọi (KEEPER bị scope NPL active)
   * @returns {Promise<object>} { items, total, page, pageSize, bucketCounts? }
   */
  async searchPos(query, actor) {
    const kw = String(query.keyword ?? '').trim();
    const bucket = VALID_BUCKETS.includes(query.bucket)
      ? query.bucket
      : null;
    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize, 15);
    const wantCounts = String(query.counts ?? '1') !== '0';
    // Biến bucket mới (2026-10-20): hàm dùng chung bucket-dates.js —
    const ranges = computeBucketDates();
    const base = {
      keyword: kw,
      bucket,
      ...ranges,
      // KEEPER chỉ thấy NPL được phân công — empNo lấy từ SESSION,
      // không nhận từ query (chống vượt quyền).
      keeperEmpNo: actor && actor.role === 'KEEPER' ? actor.empNo : null,
      page,
      pageSize,
    };
    const [{ rows, total, poTotal }, counts] = await Promise.all([
      PoRepository.searchPurchases(base),
      wantCounts ? PoRepository.countPurchaseBuckets(base) : null,
    ]);
    const items = rows.map(({ poSort, lotSort, ...row }) => ({ ...row, source: 'mock' }));
    const response = { items, total, poTotal: Number(poTotal), page, pageSize };
    if (counts) {
      response.bucketCounts = Object.fromEntries(counts.map(({ bucket, n }) => [bucket, Number(n)]));
    }
    return response;
  }

  /**
   * GET /slots?keyword= — danh sách mã kệ khớp từ khóa (DISTINCT).
   * @param {string} keyword - Từ khóa tìm kiếm (đã trim ở dưới)
   * @returns {Promise<{codes: string[]}>}
   */
  async searchSlots(keyword) {
    const codes = await SlotRepository.searchSlotCodes(
      String(keyword ?? '').trim()
    );
    return { codes };
  }

  /**
   * GET /activity — phân trang + tìm kiếm nhật ký thao tác.
   * @param {object} query - { keyword?, page?, pageSize? }
   * @returns {Promise<{items: object[], total: number, page: number, pageSize: number}>}
   */
  async searchActivity(query) {
    const kw = String(query.keyword ?? '').trim();
    const actionKey = String(query.actionKey ?? '').trim() || null;
    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize, 20);
    const { rows, total } = await ActivityRepository.searchActivitiesPage({
      keyword: kw,
      actionKey,
      page,
      pageSize,
    });
    return {
      items: rows.map(toApiActivity),
      total,
      page,
      pageSize,
    };
  }
}

module.exports = new SearchServices();
