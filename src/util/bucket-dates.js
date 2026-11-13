'use strict';

/**
 * Bien bucket ETA cua GET /pos (2026-10-20) — HAM DUNG CHUNG cho
 * SQL mode (search.service) va memory mode (memory.repository) de
 * 2 mode KHONG BAO GIO lech boundary.
 *
 * 5 moc date-only YYYY-MM-DD (tinh theo ngay chay server):
 *   today             = hom nay
 *   prevMonthStart    = ngay 1 cua thang truoc
 *   twoMonthsAgoStart = ngay 1 cua 2 thang truoc
 *   next3End          = today + 4 ngay
 *   next7End          = today + 8 ngay
 * (VD today = 2026-10-20 => 2026-10-20 / 2026-09-01 / 2026-08-01 /
 *  2026-10-24 / 2026-10-28)
 *
 * Bucket tuong ung (NULL del_date thuoc od3p — giu behavior cu):
 *   od1   = [prevMonthStart, today)
 *   od2   = [twoMonthsAgoStart, prevMonthStart)
 *   od3p  = < twoMonthsAgoStart (ke ca NULL)
 *   next3 = [today, next3End)
 *   next7 = [next3End, next7End)
 *   (del_date >= next7End nam NGOAI 5 bucket — khong dem vao
 *   bucketCounts, van hien thi khi khong loc bucket)
 */

function toIsoDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Tra 5 moc ngay tren. Cho phep truyen `now` de test; mac dinh lay
 * thoi diem hien tai cua server.
 */
function computeBucketDates(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (date, days) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return {
    today: toIsoDay(today),
    prevMonthStart: toIsoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    twoMonthsAgoStart: toIsoDay(
      new Date(now.getFullYear(), now.getMonth() - 2, 1)
    ),
    next3End: toIsoDay(shift(today, 4)),
    next7End: toIsoDay(shift(today, 8)),
  };
}

/**
 * Đồng hồ tạm nhập 24h (2026-10-28) — dùng chung cho SQL mode (đối ứng
 * DATEADD(HOUR, -24, GETDATE()) trong po.repository) và memory mode
 * (memory.repository) để 2 mode KHÔNG BAO GIỜ lệch mốc: lô tạm nhập quá
 * 24h kể từ notice1.create_date thì ẩn khỏi /pos và /incoming-pos.
 */
const NOTICE_CLOCK_MS = 24 * 60 * 60 * 1000;

/** Mốc cắt 24h trước `now` (mặc định thời điểm hiện tại của server). */
function noticeCutoffDate(now = new Date()) {
  return new Date(now.getTime() - NOTICE_CLOCK_MS);
}

module.exports = { computeBucketDates, NOTICE_CLOCK_MS, noticeCutoffDate };
