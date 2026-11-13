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

const { toApiPo, toApiActivity } = require('./mappers');
const { computeBucketDates } = require('../util/bucket-dates');
// @type cho từng require: module.exports repository bị swap theo DB_MODE
// (memory slice / new XxxModel()) nên editor không tự suy ra kiểu — gắn
// JSDoc để go-to-definition / F12 nhảy thẳng sang method của class.
/** @type {import('../repository/sql/po.repository').PoModel} */
const PoRepository = require('../repository/sql/po.repository');
/** @type {import('../repository/sql/slot.repository').SlotModel} */
const SlotRepository = require('../repository/sql/slot.repository');
/** @type {import('../repository/sql/activity.repository').ActivityModel} */
const ActivityRepository = require('../repository/sql/activity.repository');

/** Bucket hợp lệ của query /pos — giá trị khác → coi như không truyền. */
const VALID_BUCKETS = ['od1', 'od2', 'od3p', 'next3', 'next7'];

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
   * AUDIT PERFORMANCE 2026-10-19: 2 pipeline tách biệt —
   *   counts=1 (trang đầu / đổi keyword): LIST pipeline hẹp (bucket +
   *   keyword push sớm vào #PO) + COUNT pipeline rộng (không bucket).
   *   counts=0 (phân trang): CHỈ list pipeline — không chạy lại đếm
   *   bucket (nặng) khi chỉ next trang.
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
    // SQL mode và memory mode KHÔNG bao giờ lệch boundary.
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
    if (!wantCounts) {
      const { rows, total } = await PoRepository.searchPurchases(base);
      return { items: rows.map(toApiPo), total, page, pageSize };
    }
    // Điều phối 2 pipeline (refactor 2026-10-26): LIST (pipeline hẹp
    // — bucket + keyword push sớm) rồi BUCKETS (pipeline rộng — không
    // bucket). Thứ tự gọi giữ nguyên như searchPurchasesWithBuckets cũ
    // của repository; kết quả hai mode (sql / memory) không đổi vì cả
    // hai method đều dùng cùng bộ filter gốc.
    const { rows, total } = await PoRepository.searchPurchases(base);
    const buckets = await PoRepository.countPurchaseBuckets(base);
    return {
      items: rows.map(toApiPo),
      total,
      page,
      pageSize,
      bucketCounts: buckets,
    };
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
