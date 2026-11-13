'use strict';

/**
 * Repository đọc T8 mua hàng (mock Germton T8) — PO inbox / lịch sử / GET /pos.
 *
 * Kiến trúc (refactor 2026-10-26 lần 2 theo yêu cầu user — SQL thực thi trực
 * tiếp trong method, không còn tầng hàm sqlXxx/exec):
 * PoModel là class singleton (module.exports = new); MỖI public method tự khai
 * báo câu SQL ngay trong thân method (`const sql = ...`) rồi tự gọi
 * db.query(toDialect(sql), params) — hoặc query(toDialect(sql), params) với
 * method nhận executor của transaction (pipeline temp table / assign flow).
 * Không còn hàm private sqlXxx() trả { text, params }, không còn wrapper thực
 * thi chung: SQL nằm NGUYÊN trong method, chỉ còn toDialect() làm nhiệm vụ
 * chuyển cú pháp dialect. Tham số bind QUA PLACEHOLDER `?` — db.js tự đổi
 * thành @p1.. (SQL Server) hoặc $1.. (PostgreSQL), tuyệt đối KHÔNG nối giá trị
 * trực tiếp vào chuỗi SQL. Alias [camelCase] giữ đúng shape service/FE cần —
 * SQL tự alias đủ nên KHÔNG cần row-mapper.
 *
 * guardParams(): chặn sớm tham số undefined trước khi xuống driver — giữ hành
 * vi guard cũ (trước đây nằm trong exec/sql-params, đã loại bỏ theo yêu cầu
 * user). Gọi ngay trước MỌI lần thực thi SQL tĩnh.
 *
 * Test SSMS: copy câu SQL (kèm comment -- DECLARE) sang SSMS, uncomment dòng
 * DECLARE, thay placeholder bằng biến tương ứng là chạy được ngay.
 *
 * LƯU Ý COMMENT: comment nằm NGUYÊN trong text nên mọi comment bên trong
 * câu SQL TUYỆT ĐỐI không được chứa ký tự placeholder (db.js đếm mọi dấu
 * placeholder trong text để đánh số tham số).
 *
 * DUAL DIALECT (SQL Server production + PostgreSQL sandbox test):
 * SQL viết theo cú pháp SQL Server; toDialect() chỉ chuyển những chỗ PG
 * không chấp nhận nguyên văn (xem JSDoc của toDialect) — gồm cả rule 5b
 * temp table của pipeline /pos (#PO -> po_candidate...). Phân trang dùng
 * cú pháp chuẩn OFFSET ... FETCH NEXT ... — đã xác minh trên PG sandbox là
 * chạy được với tham số bind nên KHÔNG hoán đổi thành LIMIT/OFFSET.
 *
 * QUAN HỆ ĐÃ XÁC NHẬN BẰNG DỮ LIỆU THẬT (user test 2026-10-19):
 *   [1] order1 <-> order2 : o1.sheet_no = o2.sheet_no
 *   [2] allocation.po_id  : = pur_order2.id
 *   [3] lot nghiệp vụ     : pur_notice2.made_lot / pur_in2.made_lot
 *   [4] loại lot đã GRN   : pur_in2 (pur_no, goods_no, made_lot)
 *   [5] close_sw PO mở    : IN ('N', '0')  (mock 'N', T8 thật '0')
 *   [6] ADM filter        : e.emp_no = o1.create_user AND e.emp_name <> 'ADM'
 *   [7] order2 -> notice2 (PO identity fix 2026-10-29): khớp ĐỒNG THỜI
 *       pur_no = sheet_no, goods_no, def02 (null-safe) VÀ pur_id = sheet_id
 *       (pur_id của notice trỏ về DÒNG PO — sheet_id, không phải order2.id;
 *       2026-10-28 user duyệt bỏ điều kiện ngày def23). KHÔNG dùng sheet_lot.
 *   [8] order2 -> pur_in2 (GRN): i2.pur_no = o1.sheet_no VÀ i2.pur_id =
 *       o2.sheet_id VÀ i2.goods_no = o2.goods_no — arrived/grnRef theo DÒNG.
 *
 * Lưu ý kiểu dữ liệu (thay cho row-mapper cũ):
 *   - số  : CAST(col AS FLOAT) — null giữ nguyên null (KHÔNG COALESCE 0)
 *   - bool: CAST(CASE WHEN ... THEN 1 ELSE 0 END AS BIT) — passthrough BIT
 *   - id INT -> string: CAST(o2.id AS VARCHAR(20))
 *   - ngày: alias thẳng cột (driver trả về Date, JSON hóa thành ISO string)
 *
 * Nhóm truy vấn chính, mỗi nhóm là method tự chứa SQL của mình:
 *   (1) inbox PO đơn giản — list / listPaged / byId;
 *   (2) tra cứu dòng PO — findOrder2ByPoId / findNoticesForPoLine /
 *       sumAllocatedByPo;
 *   (3) pipeline #temp cho GET /pos — fillTempTables / dropTempTables /
 *       searchPurchases / countPurchaseBuckets
 *       (chi tiết ở header pipeline giữa file; service tự điều phối
 *       list + buckets — refactor 2026-10-26).
 *
 * Điểm đặc thù của repo này: pipeline 3 bảng tạm #PO -> #Notice -> #PurIn cho
 * /pos (xem fillTempTables) — mọi câu của 1 pipeline bắt buộc chạy TRÊN CÙNG
 * 1 connection + transaction, nên searchPurchases / countPurchaseBuckets bọc
 * db.withTransaction và chuyền `query` fn xuống.
 *
 * DB_MODE=memory thì module.exports swap sang cắt lát của memory repository
 * (xem cuối file).
 */

const db = require('../../config/db');
const { TABLES } = require('./tables');

// ==================== PRIVATE: HỖ TRỢ DIALECT + GUARD ====================

/** Dialect hiện tại có phải PostgreSQL (chỉ dùng cho sandbox test)? */
function isPg() {
  return db.getDialect() === 'pg';
}

/**
 * Tên bảng logic (viết trong SQL) -> tên thật (kèm tiền tố nếu có) — quy tắc
 * 6 của toDialect quét qua từng cặp để thay.
 */
const TABLE_PAIRS = [
  ['bas_emp', TABLES.emps],
  ['bas_goods', TABLES.goods],
  ['pur_order1', TABLES.order1],
  ['pur_order2', TABLES.order2],
  ['pur_notice1', TABLES.notice1],
  ['pur_notice2', TABLES.notice2],
  ['v_pur_notice_detail', TABLES.noticeDetailView],
  ['pur_in1', TABLES.in1],
  ['pur_in2', TABLES.in2],
  ['whs_user_role', TABLES.userRole],
  ['whs_slots', TABLES.slots],
  ['whs_slot_allocation', TABLES.allocation],
  ['whs_allocation_receipt', TABLES.receipt],
  ['whs_slot_movement', TABLES.movement],
  ['whs_activity', TABLES.activity],
  ['whs_keeper_material_assignment', TABLES.keeperMaterialAssignment],
];

/**
 * Bảng tạm của pipeline /pos: mssql dùng #PO/#Notice/#PurIn, pg không có tiền
 * tố # nên đổi sang tên TEMP_MAP (pg: TEMP TABLE thuộc session — cùng kết nối
 * là thấy, xem fillTempTables).
 */
const TEMP_MAP = {
  PO: 'po_candidate',
  Notice: 'notice_candidate',
  PurIn: 'purin_candidate',
};

/**
 * Chuyển câu SQL (viết cú pháp SQL Server) sang PostgreSQL khi chạy sandbox.
 * Port nguyên các rule mà repo PO cần (đúng thứ tự áp dụng của binder cũ):
 *   2. LIKE -> ILIKE (PG LIKE phân biệt hoa thường — ILIKE giữ hành vi tìm
 *      kiếm case-insensitive như collation mặc định của SQL Server)
 *   3. NVARCHAR(n) -> VARCHAR(n) (PG không có NVARCHAR — UTF-8 mặc định);
 *      GETDATE()/SYSUTCDATETIME() -> NOW()
 *   4a. CAST(CASE ... END AS BIT) -> CASE ... TRUE/FALSE (PG có kiểu boolean
 *      thật, không BIT 0/1)
 *   4b. CAST(1 AS BIT)/CAST(0 AS BIT) -> TRUE/FALSE (hằng boolean)
 *   5. Alias [camelCase] -> "camelCase" (PG không hiểu bracket alias; PG phân
 *      biệt hoa thường với identifier trong nháy kép nên giữ nguyên chữ)
 *   5b. #temp pipeline /pos: OBJECT_ID('tempdb..#X') -> DROP TABLE IF EXISTS
 *      <temp>; #PO/#Notice/#PurIn -> tên TEMP_MAP; CREATE TABLE <temp> ->
 *      CREATE TEMP TABLE <temp>
 *   5b2. SELECT ... INTO <temp> -> CREATE TEMP TABLE <temp> AS SELECT ...
 *      (mssql SELECT INTO giúp cột temp THỪA KẾ độ rộng thực của cột nguồn T8
 *      — chống truncated; PG tương đương là CTAS. Khác binder cũ ở chỗ: text
 *      nay còn comment -- DECLARE phía trước nên anchor ^SELECT phải bỏ qua
 *      được các dòng comment — comment vẫn được giữ lại phía trước CTAS)
 *   5c. Hàm ngày SQL Server: DATEADD(DAY, n, CONVERT(DATE, x)) ->
 *      (CAST(x AS DATE) + n * INTERVAL '1 day'), DATEADD(DAY, n, x) ->
 *      (x + n * INTERVAL '1 day'), CONVERT(DATE, x) -> CAST(x AS DATE),
 *      DATETIME -> TIMESTAMP
 *   6. Tiền tố bảng sandbox — thay tên logic bằng tên thật từ tables.js
 * SQL Server trả về nguyên văn từng ký tự.
 * @param {string} text câu SQL gốc (cú pháp SQL Server, placeholder ?)
 * @returns {string} câu SQL theo dialect hiện tại
 */
function toDialect(text) {
  if (!isPg()) return text;
  let out = text;
  // 2. LIKE -> ILIKE — giữ hành vi case-insensitive như mssql collation.
  out = out.replace(/\bLIKE\b/g, 'ILIKE');
  // 3. NVARCHAR(n) -> VARCHAR(n); GETDATE()/SYSUTCDATETIME() -> NOW().
  out = out.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
  out = out.replace(/\bGETDATE\s*\(\s*\)/gi, 'NOW()');
  out = out.replace(/\bSYSUTCDATETIME\s*\(\s*\)/gi, 'NOW()');
  // 4a. CAST(CASE WHEN ... THEN 1 ELSE 0 END AS BIT) -> CASE ... TRUE/FALSE.
  out = out.replace(
    /\bCAST\s*\(\s*CASE\b([\s\S]*?)\bEND\s+AS\s+BIT\s*\)/gi,
    (_m, body) =>
      `CASE${String(body)
        .replace(/\bTHEN\s+1\b/gi, 'THEN TRUE')
        .replace(/\bELSE\s+0\b/gi, 'ELSE FALSE')}END`
  );
  // 4b. CAST(1 AS BIT) / CAST(0 AS BIT) -> TRUE / FALSE (hằng boolean).
  out = out.replace(/\bCAST\s*\(\s*([01])\s+AS\s+BIT\s*\)/gi, (_m, bit) =>
    bit === '1' ? 'TRUE' : 'FALSE'
  );
  // 5. [aliasBracket] -> "alias" — pg bọc identifier bằng nháy kép.
  out = out.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');
  // 5b. #temp pipeline /pos: DROP theo OBJECT_ID, rồi đổi tên #X -> TEMP_MAP,
  // rồi CREATE TABLE <temp> -> CREATE TEMP TABLE <temp>.
  out = out.replace(
    /IF\s+OBJECT_ID\('tempdb\.\.#(\w+)'\)\s+IS\s+NOT\s+NULL\s+DROP\s+TABLE\s+#\1\s*;?/gi,
    (_m, t) => `DROP TABLE IF EXISTS ${TEMP_MAP[t] ?? t};`
  );
  out = out.replace(/#(PO|Notice|PurIn)\b/g, (_m, t) => TEMP_MAP[t] ?? t);
  out = out.replace(
    /\bCREATE\s+TABLE\s+(po_candidate|notice_candidate|purin_candidate)\b/gi,
    (_m, t) => `CREATE TEMP TABLE ${t}`
  );
  // 5b2. SELECT ... INTO <temp> -> CREATE TEMP TABLE <temp> AS SELECT ...
  const selectIntoTemp = out.match(
    /^(\s*(?:--[^\n]*\n\s*)*)SELECT\s+([\s\S]+?)\s+INTO\s+(po_candidate|notice_candidate|purin_candidate)\b\s+(FROM[\s\S]*?)\s*;?\s*$/i
  );
  if (selectIntoTemp) {
    out = `${selectIntoTemp[1]}CREATE TEMP TABLE ${selectIntoTemp[3]} AS SELECT ${selectIntoTemp[2]} ${selectIntoTemp[4]}`;
  }
  // 5c. Hàm ngày SQL Server không có trong pg.
  out = out.replace(
    /DATEADD\s*\(\s*DAY\s*,\s*(\d+)\s*,\s*CONVERT\s*\(\s*DATE\s*,\s*([A-Za-z_][\w.]*)\s*\)\s*\)/gi,
    (_m, n, col) => `(CAST(${col} AS DATE) + ${n} * INTERVAL '1 day')`
  );
  out = out.replace(
    /DATEADD\s*\(\s*DAY\s*,\s*(\d+)\s*,\s*([A-Za-z_][\w.]*)\s*\)/gi,
    (_m, n, col) => `(${col} + ${n} * INTERVAL '1 day')`
  );
  // Đồng hồ tạm nhập 24h (2026-10-28): DATEADD(HOUR, -n, GETDATE()) đã
  // thành DATEADD(HOUR, -n, NOW()) sau rule 3 -> (NOW() - n * INTERVAL '1 hour').
  out = out.replace(
    /DATEADD\s*\(\s*HOUR\s*,\s*-(\d+)\s*,\s*NOW\s*\(\s*\)\s*\)/gi,
    (_m, n) => `(NOW() - ${n} * INTERVAL '1 hour')`
  );
  out = out.replace(
    /CONVERT\s*\(\s*DATE\s*,\s*([A-Za-z_][\w.]*)\s*\)/gi,
    (_m, col) => `CAST(${col} AS DATE)`
  );
  out = out.replace(/\bDATETIME\b/g, 'TIMESTAMP');
  // 6. Tiền tố bảng sandbox — thay tên logic bằng tên thật (kèm tiền tố).
  for (const [logical, actual] of TABLE_PAIRS) {
    if (logical === actual) continue;
    out = out.replace(new RegExp(`\\b${logical}\\b`, 'g'), actual);
  }
  return out;
}

/**
 * Chặn sớm tham số undefined trước khi xuống driver — giữ hành vi guard
 * cũ (trước đây nằm trong exec/sql-params, đã loại bỏ theo yêu cầu user).
 * @param {unknown[]} params tham số theo thứ tự placeholder
 */
function guardParams(params) {
  if (params.includes(undefined)) {
    throw new Error(
      '[po.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

/**
 * ====================================================================
 * GET /pos — PIPELINE #TEMP (SPEC FINAL, user xác nhận 2026-10-19)
 * ====================================================================
 * Pipeline candidate-first #PO -> #Notice -> #PurIn, chạy theo thứ tự
 * DROP temp (dropTempTables) -> fillTempTables (fill #PO -> index #PO ->
 * fill #Notice -> index #Notice -> fill #PurIn -> index #PurIn) ->
 * searchPurchases (câu list + câu count fallback khi trang vượt cuối) /
 * countPurchaseBuckets.
 *
 * RELATION FINAL (test trực tiếp trên dữ liệu T8 thật — KHÔNG quay lại các
 * relation cũ đã bị chứng minh sai):
 *   [R1] order1 <-> order2 : o1.sheet_no = o2.sheet_no
 *        (KHÔNG dùng o1.id = o2.sheet_id)
 *   [R2] order2 -> notice2 (PO identity fix 2026-10-29): khớp ĐỒNG THỜI 4 trường
 *        n2.pur_no   = o2.sheet_no   (PO)
 *        n2.goods_no = o2.goods_no   (vật tư)
 *        n2.def02    = o2.def02      (Customer Style)
 *        n2.pur_id   = o2.sheet_id   (DÒNG PO — PO identity fix)
 *        (2026-10-28 user duyệt BỎ điều kiện def23; 2026-10-29 thêm pur_id:
 *        1 PO có NHIỀU DÒNG cùng goods_no + def02 — thiếu pur_id làm notice
 *        fan-out match sai dòng, rn=1 gán về dòng nhỏ nhất ⇒ allocation sai
 *        po_id + worker AMBIGUOUS giả. pur_id NULL/invalid (legacy) KHÔNG
 *        match — được báo qua findOrphanNoticesForPoLine → issue DATA_ERROR)
 *        def02 khớp NULL-SAFE: (n2.def02 IS NULL AND o2.def02 IS NULL)
 *        OR n2.def02 = o2.def02 — trong SQL NULL = NULL không khớp, nên hai
 *        phía cùng NULL phải dùng nhánh OR IS NULL riêng.
 *   [R3] notice2 -> pur_in2 : i2.pur_no + i2.goods_no + i2.made_lot
 *        (dùng để loại lot đã GRN của notice; KHÔNG dùng i2.notice_id)
 *   [R6] order2 -> pur_in2 (GRN theo DÒNG, PO identity fix 2026-10-29):
 *        i2.pur_no = o1.sheet_no AND i2.pur_id = o2.sheet_id
 *        AND i2.goods_no = o2.goods_no — dùng cho arrived/grnRef của gap.
 *        KHÔNG dùng i2.pur_id = o2.id (sai — pur_id là sheet_id, không phải id).
 *   [R4] lot nghiệp vụ = made_lot (KHÔNG dùng sheet_lot);
 *        9 ký tự đầu made_lot = cùng một chuyến (search prefix).
 *   [R5] allocation.po_id = pur_order2.id;
 *        receipt.notice_detail_id = pur_notice2.id (KHÔNG đổi)
 *
 * KIẾN TRÚC HIỆN NAY — lọc sớm theo candidate (tránh GROUP BY toàn bộ
 * pur_in2 / pur_notice2 trước khi lọc PO — query cũ mất 6-7 phút):
 * lọc candidate PO NGAY TỪ ĐẦU (#PO nhỏ) rồi mới build #Notice / #PurIn từ
 * candidate đó, thay vì full scan Notice/PurIn trước #PO:
 *   Candidate PO  ->  relevant Notice  ->  relevant pur_in2
 *     ->  WHS allocation/receipt  ->  Final Result
 *
 *   #PO     : candidate PO mở (lọc close_sw + ADM ngay từ đầu)
 *   #Notice : notice khớp key 3 trường [R2] của #PO
 *   #PurIn  : in2 liên quan tới PO của #PO (loại lot đã GRN + arrived)
 *
 * PUSHDOWN LỌC SỚM (user yêu cầu 2026-10-19 — audit performance):
 *   LIST pipeline (#PO hẹp): bucket + keyword ĐƯỢC ĐẨY NGAY vào câu fill #PO
 *   trong fillTempTables để candidate PO nhỏ cực đại TRƯỚC khi build #Notice /
 *   #PurIn:
 *     - bucket : lọc khoảng del_date theo bucket (thuộc tính PO — cả gap lẫn
 *       notice đều lấy del_date từ #PO nên an toàn đẩy sớm).
 *     - keyword: predicate "PO khớp trực tiếp (po/goods/made_lot của order2,
 *       material, supplier) HOẶC CÓ notice made_lot khớp" (EXISTS trên
 *       pur_notice2, siết theo PO DETAIL key [R2]: pur_no + goods_no + def02
 *       (không giữ tất cả detail cùng PO) — việc search made_lot của
 *       notice VẪN DÙNG (không mất Notice
 *       result).
 *
 * FILTER MỚI (2026-10-20, Phase 2 — CHỈ THÊM, không đổi match logic cũ),
 * toàn bộ nằm TRONG câu fill #PO của fillTempTables (cả list lẫn count đều
 * qua #PO đã lọc):
 *     - approved : o1.sheet_sta <> '0' (bỏ PO chưa duyệt).
 *     - M1-M6+A2 : goods_no LIKE 'M1%'..'M6%' + 'A2%' (SARGable) —
 *       eligibility NPL hợp lệ, KHÔNG dùng 'M%' / 'A%' rộng hơn.
 *     - keeper   : KEEPER chỉ thấy NPL được phân công — EXISTS
 *       whs_keeper_material_assignment CHỈ lọc assignment active
 *       (ended_at IS NULL; assignment đã ended không áp);
 *       keeperEmpNo lấy từ SESSION (manager => NULL = không lọc).
 *   COUNT pipeline (bucketCounts — #PO rộng): KHÔNG push bucket (phải đếm
 *   TẤT CẢ bucket), chỉ push keyword + các filter mới (approved / M1-M6 /
 *   keeper) — nhờ vậy số bucket tính đúng scope quyền của người xem (keeper
 *   thấy đúng NPL của mình). List và count KHÔNG dùng chung #PO (user chấp
 *   nhận 2026-10-19) để list không phải scan toàn bộ lịch sử khi có bucket
 *   cụ thể.
 *   Câu final vẫn giữ nguyên predicate keyword + bucket (safety net — trùng
 *   lặp vô hướng).
 *   Pagination (OFFSET/FETCH) chạy CUỐI CÙNG; ORDER BY deterministic:
 *   del_date, po_sort (= po_id), lot_sort (= notice_id hoặc 0).
 *
 * NULL del_date — THỐNG NHẤT (user yêu cầu 2026-10-19): NULL = không rõ ngày
 * dự kiến, rơi vào bucket od3p Ở CẢ list lẫn count (trước đây count bỏ vào
 * od3p nhưng filter tab od3p ẩn dòng NULL — card khác so với dòng khi click).
 *
 * BUCKET MỚI (2026-10-20, Phase 2 — bỏ today/upcoming/od12/od23 cũ):
 *   5 mốc ngày tính bằng JS (src/util/bucket-dates.js — dùng chung với
 *   memory mode), bind 5 tham số, KHÔNG CONVERT o2.del_date trong WHERE:
 *     od1   = [prevMonthStart, today)
 *     od2   = [twoMonthsAgoStart, prevMonthStart)
 *     od3p  = < twoMonthsAgoStart (NULL del_date cũng thuộc od3p)
 *     next3 = [today, next3End)        (next3End = today + 4)
 *     next7 = [next3End, next7End)     (next7End  = today + 8)
 *   del_date >= next7End nằm NGOÀI 5 bucket: không đếm vào bucketCounts
 *   (FE label od3p = "Quá dự kiến trên 3 tháng" — KHÔNG đổi boundary).
 *
 * Temp table (SELECT ... INTO — cột THỪA KẾ độ rộng thực của bảng T8, chống
 * "String or binary data would be truncated" trên dữ liệu thật; index CHỈ
 * trên #temp — không CREATE INDEX bảng T8 production):
 *   #PO     : ix (po_number, item_code, def02, del_day)
 *   #Notice : ix (po_id) + ix (pur_no, goods_no, made_lot)
 *   #PurIn  : ix (pur_no, goods_no, made_lot) + ix (pur_no, goods_no)
 */

// ==================== PRIVATE: THAM SỐ TÌM KIẾM ====================

/**
 * Đổi opts tìm kiếm PO sang tham số cho các câu SQL pipeline /pos.
 * Filter tùy chọn viết dạng
 * "CAST(? AS NVARCHAR(n)) IS NULL OR (...)" trong SQL — nên JS chỉ việc
 * truyền null khi không dùng filter (pg không suy diễn kiểu cho "$n IS NULL"
 * trần, mssql chấp nhận chung 1 viết pháp).
 *
 * Tìm kiếm 2 loại pattern (SPEC FINAL 2026-10-19):
 *   prefixPattern   = 'kw%'  — PO / goods / lot (made_lot) ưu tiên prefix
 *                     (9 ký tự đầu made_lot = cùng chuyền)
 *   containsPattern = '%kw%' — material / supplier contains
 * @param {{ keyword?: string, bucket?: string | null, today?: string | null,
 *   prevMonthStart?: string | null, twoMonthsAgoStart?: string | null,
 *   next3End?: string | null, next7End?: string | null,
 *   keeperEmpNo?: string | null }} opts bộ lọc từ service
 * @returns {{ bucket: string | null, today: string | null,
 *   prevMonthStart: string | null, twoMonthsAgoStart: string | null,
 *   next3End: string | null, next7End: string | null,
 *   keeperEmpNo: string | null, prefixPattern: string | null,
 *   containsPattern: string | null }} tham số dùng để dựng mảng params
 */
function searchParams(opts) {
  const kw = String(opts.keyword || '').trim();
  return {
    bucket: opts.bucket ?? null,
    // 5 mốc bucket mới (2026-10-20) — date-only YYYY-MM-DD từ service
    today: opts.today ?? null,
    prevMonthStart: opts.prevMonthStart ?? null,
    twoMonthsAgoStart: opts.twoMonthsAgoStart ?? null,
    next3End: opts.next3End ?? null,
    next7End: opts.next7End ?? null,
    // Keeper NPL permission — TỪ SESSION, không bao giờ nhận từ client;
    // manager => null (không lọc)
    keeperEmpNo: opts.keeperEmpNo ?? null,
    prefixPattern: kw ? `${kw}%` : null,
    containsPattern: kw ? `%${kw}%` : null,
  };
}

// ==================== CLASS REPOSITORY ====================

class PoModel {
  /**
   * Danh sách dòng PO còn số lượng chưa gán (inbox + history) — GET
   * /incoming-pos. SQL khai báo trực tiếp trong method, KHÔNG dùng pipeline
   * temp table.
   *
   * FIX TIMEOUT 2026-10-21 (mirror audit /pos 2026-10-19): bản cũ quét TOÀN BỘ
   * pur_order2 (kể cả PO đóng + chưa duyệt + mọi loại hàng) và chứa 2
   * anti-pattern chết người: (1) subquery tương quan SUM(allocation) TRONG
   * WHERE — chạy từng dòng trên toàn lịch sử PO; (2) LEFT JOIN GROUP BY toàn
   * bảng pur_in2 — aggregate cả bảng trước khi lọc PO. Trên SQL Server thật
   * query này treo pool (FE note 2026-10-17: BE kẹt pool vì query này).
   *
   * Bản mới đẩy lọc sớm GIỐNG HỆT #PO của pipeline /pos (cùng scope user đã
   * duyệt khi audit /pos): chỉ PO mở close_sw IN ('N','0'), đã duyệt
   * sheet_sta <> '0', người tạo có hồ sơ bas_emp và khác ADM, NPL M1-M6/A2.
   * HIỆN THỊ (rework 2026-10-29, no-max): BỎ gate assigned < sheet_qty —
   * sheet_qty chỉ là tham khảo, tổng allocated được vượt PO, PO KHÔNG ẩn
   * khi gán đủ/vượt. Chỉ còn đồng hồ tạm nhập 24h từ notice1.create_date
   * (chưa có notice hoặc notice trong 24h).
   * Phần còn thiếu thay bằng: (a) LEFT JOIN aggregate 1 lần của
   * whs_slot_allocation (bảng app nhỏ) thay subquery tương quan; (b) arrived/
   * grnRef là subquery theo pur_id CHỈ chạy trên dòng kết quả (index lookup),
   * không GROUP BY toàn bộ pur_in2.
   *
   * Tham số `?` = confirmedFlag — giá trị check_sta được coi là "đã xác nhận"
   * ('Y').
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async list() {
    const sql = `
    -- DECLARE @confirmedFlag CHAR(1) = 'Y';
    SELECT
      CAST(o2.id AS VARCHAR(20)) AS [id],
      o1.sheet_no AS [poNumber],
      CAST(o2.id AS VARCHAR(20)) AS [poLine],
      o2.goods_no AS [itemCode],
      g.goods_name AS [material],
      o1.su_name11 AS [supplier],
      CAST(o2.sheet_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      CAST(o2.sheet_pri AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN o1.check_sta = ? THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      o2.del_date AS [eta],
      CAST(CASE WHEN EXISTS (
        SELECT 1 FROM pur_in2 i2
        WHERE i2.pur_no = o1.sheet_no AND i2.pur_id = o2.sheet_id
          AND i2.goods_no = o2.goods_no
      ) THEN 1 ELSE 0 END AS BIT) AS [arrived],
      (SELECT MAX(i2g.sheet_no) FROM pur_in2 i2g
        WHERE i2g.pur_no = o1.sheet_no AND i2g.pur_id = o2.sheet_id
          AND i2g.goods_no = o2.goods_no) AS [grnRef],
      -- lotNo (2026-10-29): KHÔNG expose pur_order2.made_lot — business lot
      -- chỉ đến từ pur_notice2.made_lot (notice branch /pos). Giữ field = NULL.
      CAST(NULL AS VARCHAR(40)) AS [lotNo],
      CAST(COALESCE(alloc.assigned, 0) AS FLOAT) AS [assignedQty],
      CAST(CASE WHEN o1.close_sw = 'Y' THEN 1 ELSE 0 END AS BIT) AS [closed],
      o1.sheet_date AS [sheetDate],
      o2.del_date AS [delDate],
      'mock' AS [source]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    JOIN bas_emp e ON e.emp_no = o1.create_user AND e.emp_name <> 'ADM'
    LEFT JOIN bas_goods g ON g.goods_no = o2.goods_no
    LEFT JOIN (
      SELECT x.po_id, SUM(x.allocated_qty) AS assigned
      FROM whs_slot_allocation x
      GROUP BY x.po_id
    ) alloc ON alloc.po_id = o2.id
    -- Đồng hồ tạm nhập 24h (2026-10-28): notice1.create_date của notice
    -- khớp key [R2] của PO — MAX vì 1 PO có thể khớp nhiều đợt tạm nhập
    -- (2026-10-29 thêm pur_id = sheet_id — chỉ notice của đúng DÒNG PO)
    LEFT JOIN (
      SELECT o2c.id AS po_id, MAX(n1.create_date) AS latest_create
      FROM pur_order2 o2c
      JOIN pur_order1 o1c ON o1c.sheet_no = o2c.sheet_no
      JOIN pur_notice2 n2c
        ON n2c.pur_no = o1c.sheet_no
       AND n2c.goods_no = o2c.goods_no
       AND ((n2c.def02 IS NULL AND o2c.def02 IS NULL) OR n2c.def02 = o2c.def02)
       AND n2c.pur_id = o2c.sheet_id
      JOIN pur_notice1 n1 ON n1.sheet_no = n2c.sheet_no
      GROUP BY o2c.id
    ) nclock ON nclock.po_id = o2.id
    WHERE o1.close_sw IN ('N', '0')
      AND o1.sheet_sta <> '0'
      AND (
        o2.goods_no LIKE 'M1%' OR o2.goods_no LIKE 'M2%'
        OR o2.goods_no LIKE 'M3%' OR o2.goods_no LIKE 'M4%'
          OR o2.goods_no LIKE 'M5%' OR o2.goods_no LIKE 'M6%'
          OR o2.goods_no LIKE 'A2%'
        )
        -- HIỆN THỊ (rework 2026-10-29, no-max): BỎ gate assigned <
        -- sheet_qty — tổng allocated được vượt PO, PO KHÔNG ẩn khi gán
        -- đủ/vượt. Chỉ còn đồng hồ tạm nhập 24h từ notice1.create_date
        -- (chưa có notice, hoặc notice mới nhất trong 24h; NULL = hiện)
        AND (
          nclock.po_id IS NULL
          OR nclock.latest_create IS NULL
          OR nclock.latest_create >= DATEADD(HOUR, -24, GETDATE())
        )
    ORDER BY o1.close_sw, o2.del_date, o2.id;
  `;
    const params = ['Y'];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows; // SQL đã alias đầy đủ camelCase
  }

  /**
   * Phân trang PO đến hàng (GET /incoming-pos). total = COUNT(*) OVER() ngay
   * trong câu rows (cùng fix timeout của list(): pushdown lọc sớm + JOIN
   * aggregate 1 lần, KHÔNG subquery tương quan trong WHERE, KHÔNG GROUP BY
   * toàn bộ pur_in2). Trang vượt cuối (page > 1, rows rỗng) mới chạy câu
   * count riêng cùng bộ lọc.
   * @param {number} page trang 1-indexed
   * @param {number} pageSize số dòng mỗi trang
   * @returns {Promise<{ rows: Record<string, unknown>[], total: number }>}
   */
  async listPaged(page, pageSize) {
    const offset = (page - 1) * pageSize;
    const sql = `
    -- DECLARE @confirmedFlag CHAR(1) = 'Y';
    -- DECLARE @offset INT = 0;
    -- DECLARE @pageSize INT = 20;
    SELECT p.*, COUNT(*) OVER() AS [totalCnt]
    FROM (
      SELECT
        CAST(o2.id AS VARCHAR(20)) AS [id],
        o1.sheet_no AS [poNumber],
        CAST(o2.id AS VARCHAR(20)) AS [poLine],
        o2.goods_no AS [itemCode],
        g.goods_name AS [material],
        o1.su_name11 AS [supplier],
        CAST(o2.sheet_qty AS FLOAT) AS [qty],
        o2.unit_no AS [unit],
        CAST(o2.sheet_pri AS FLOAT) AS [unitPrice],
        CAST(CASE WHEN o1.check_sta = ? THEN 1 ELSE 0 END AS BIT) AS [confirmed],
        o2.del_date AS [eta],
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM pur_in2 i2
          WHERE i2.pur_no = o1.sheet_no AND i2.pur_id = o2.sheet_id
            AND i2.goods_no = o2.goods_no
        ) THEN 1 ELSE 0 END AS BIT) AS [arrived],
        (SELECT MAX(i2g.sheet_no) FROM pur_in2 i2g
          WHERE i2g.pur_no = o1.sheet_no AND i2g.pur_id = o2.sheet_id
            AND i2g.goods_no = o2.goods_no) AS [grnRef],
        -- lotNo (2026-10-29): KHÔNG expose pur_order2.made_lot — giữ NULL.
        CAST(NULL AS VARCHAR(40)) AS [lotNo],
        CAST(COALESCE(alloc.assigned, 0) AS FLOAT) AS [assignedQty],
        CAST(CASE WHEN o1.close_sw = 'Y' THEN 1 ELSE 0 END AS BIT) AS [closed],
        o1.sheet_date AS [sheetDate],
        o2.del_date AS [delDate],
        'mock' AS [source]
      FROM pur_order2 o2
      JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
      JOIN bas_emp e ON e.emp_no = o1.create_user AND e.emp_name <> 'ADM'
      LEFT JOIN bas_goods g ON g.goods_no = o2.goods_no
      LEFT JOIN (
        SELECT x.po_id, SUM(x.allocated_qty) AS assigned
        FROM whs_slot_allocation x
        GROUP BY x.po_id
      ) alloc ON alloc.po_id = o2.id
      -- Đồng hồ tạm nhập 24h (2026-10-28): MAX(notice1.create_date) theo key [R2]
      LEFT JOIN (
        SELECT o2c.id AS po_id, MAX(n1.create_date) AS latest_create
        FROM pur_order2 o2c
        JOIN pur_order1 o1c ON o1c.sheet_no = o2c.sheet_no
        JOIN pur_notice2 n2c
          ON n2c.pur_no = o1c.sheet_no
         AND n2c.goods_no = o2c.goods_no
         AND ((n2c.def02 IS NULL AND o2c.def02 IS NULL) OR n2c.def02 = o2c.def02)
         AND n2c.pur_id = o2c.sheet_id
        JOIN pur_notice1 n1 ON n1.sheet_no = n2c.sheet_no
        GROUP BY o2c.id
      ) nclock ON nclock.po_id = o2.id
      WHERE o1.close_sw IN ('N', '0')
        AND o1.sheet_sta <> '0'
        AND (
          o2.goods_no LIKE 'M1%' OR o2.goods_no LIKE 'M2%'
          OR o2.goods_no LIKE 'M3%' OR o2.goods_no LIKE 'M4%'
          OR o2.goods_no LIKE 'M5%' OR o2.goods_no LIKE 'M6%'
          OR o2.goods_no LIKE 'A2%'
        )
        -- HIỆN THỊ (rework 2026-10-29, no-max): bỏ gate assigned <
        -- sheet_qty (được phép gán vượt PO); chỉ còn đồng hồ tạm nhập
        -- 24h (chưa có notice hoặc notice trong 24h)
        AND (
          nclock.po_id IS NULL
          OR nclock.latest_create IS NULL
          OR nclock.latest_create >= DATEADD(HOUR, -24, GETDATE())
        )
    ) p
    ORDER BY p.[closed], p.[eta], p.[id]
    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
  `;
    const params = ['Y', offset, pageSize];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    if (rows.length === 0 && page > 1) {
      // Fallback đếm riêng khi trang vượt cuối (rows rỗng) — cùng bộ lọc của
      // câu rows ở trên. Không tham số trong SQL — comment DECLARE chỉ để
      // tài liệu.
      const sqlCount = `
    -- DECLARE @confirmedFlag CHAR(1) = 'Y';
    SELECT COUNT(*) AS [total]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    JOIN bas_emp e ON e.emp_no = o1.create_user AND e.emp_name <> 'ADM'
    LEFT JOIN (
      SELECT x.po_id, SUM(x.allocated_qty) AS assigned
      FROM whs_slot_allocation x
      GROUP BY x.po_id
    ) alloc ON alloc.po_id = o2.id
    -- Đồng hồ tạm nhập 24h (2026-10-28) — MAX(notice1.create_date) theo key [R2]
    -- (2026-10-29 thêm pur_id = sheet_id — chỉ notice của đúng DÒNG PO)
    LEFT JOIN (
      SELECT o2c.id AS po_id, MAX(n1.create_date) AS latest_create
      FROM pur_order2 o2c
      JOIN pur_order1 o1c ON o1c.sheet_no = o2c.sheet_no
      JOIN pur_notice2 n2c
        ON n2c.pur_no = o1c.sheet_no
       AND n2c.goods_no = o2c.goods_no
       AND ((n2c.def02 IS NULL AND o2c.def02 IS NULL) OR n2c.def02 = o2c.def02)
       AND n2c.pur_id = o2c.sheet_id
      JOIN pur_notice1 n1 ON n1.sheet_no = n2c.sheet_no
      GROUP BY o2c.id
    ) nclock ON nclock.po_id = o2.id
    WHERE o1.close_sw IN ('N', '0')
      AND o1.sheet_sta <> '0'
      AND (
        o2.goods_no LIKE 'M1%' OR o2.goods_no LIKE 'M2%'
        OR o2.goods_no LIKE 'M3%' OR o2.goods_no LIKE 'M4%'
        OR o2.goods_no LIKE 'M5%' OR o2.goods_no LIKE 'M6%'
        OR o2.goods_no LIKE 'A2%'
      )
      -- HIỆN THỊ (rework 2026-10-29, no-max): bỏ gate assigned < sheet_qty
      -- (được phép gán vượt PO); chỉ còn đồng hồ 24h
      AND (
        nclock.po_id IS NULL
        OR nclock.latest_create IS NULL
        OR nclock.latest_create >= DATEADD(HOUR, -24, GETDATE())
      );
  `;
      const countParams = [];
      guardParams(countParams);
      const countedResult = await db.query(toDialect(sqlCount), countParams);
      return {
        rows: [],
        total: Number(countedResult.rows[0] ? countedResult.rows[0].total : 0),
      };
    }
    return {
      rows,
      total: rows.length > 0 ? Number(rows[0].totalCnt) : 0,
    };
  }

  /**
   * Tìm dòng PO theo po_id (= pur_order2.id).
   * @param {number|string} poId po_id = pur_order2.id
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async byId(poId) {
    const sql = `
    -- DECLARE @confirmedFlag CHAR(1) = 'Y';
    -- DECLARE @poId INT = 3;
    SELECT
      CAST(o2.id AS VARCHAR(20)) AS [id],
      o1.sheet_no AS [poNumber],
      CAST(o2.id AS VARCHAR(20)) AS [poLine],
      o2.goods_no AS [itemCode],
      g.goods_name AS [material],
      o1.su_name11 AS [supplier],
      CAST(o2.sheet_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      CAST(o2.sheet_pri AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN o1.check_sta = ? THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      o2.del_date AS [eta],
      CAST(CASE WHEN EXISTS (
        SELECT 1 FROM pur_in2 i2
        WHERE i2.pur_no = o1.sheet_no AND i2.pur_id = o2.sheet_id
          AND i2.goods_no = o2.goods_no
      ) THEN 1 ELSE 0 END AS BIT) AS [arrived],
      (SELECT MAX(i2g.sheet_no) FROM pur_in2 i2g
        WHERE i2g.pur_no = o1.sheet_no AND i2g.pur_id = o2.sheet_id
          AND i2g.goods_no = o2.goods_no) AS [grnRef],
      -- lotNo (2026-10-29): KHÔNG expose pur_order2.made_lot — giữ NULL.
      CAST(NULL AS VARCHAR(40)) AS [lotNo],
      CAST((SELECT COALESCE(SUM(x.allocated_qty), 0)
            FROM whs_slot_allocation x
            WHERE x.po_id = o2.id) AS FLOAT) AS [assignedQty],
      CAST(CASE WHEN o1.close_sw = 'Y' THEN 1 ELSE 0 END AS BIT) AS [closed],
      o1.sheet_date AS [sheetDate],
      o2.del_date AS [delDate],
      'mock' AS [source]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = o2.goods_no
    WHERE o2.id = ?;
  `;
    const params = ['Y', poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * 1 dòng PO đầy đủ từ order2 + order1 (join theo sheet_no ĐÃ XÁC NHẬN).
   * @param {string} poId po_id = pur_order2.id
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async findOrder2ByPoId(poId) {
    const sql = `
    -- DECLARE @poId INT = 3;
    SELECT o2.id AS [id],
           o2.sheet_id AS [sheetId],
           o1.sheet_no AS [poNumber],
           o2.goods_no AS [goodsNo],
           o2.unit_no AS [unitNo],
           CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
           o2.made_lot AS [madeLot],
           o2.del_date AS [delDate],
           o1.su_name11 AS [suName11],
           o1.su_no AS [suNo]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE o2.id = ?;
  `;
    const params = [poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * Notice khớp 1 dòng PO theo KEY FINAL [R2]: pur_no + goods_no + def02
   * + pur_id = sheet_id (PO identity fix 2026-10-29 — 1 PO nhiều dòng cùng
   * goods/def02 phải tách bằng pur_id; 2026-10-28 user duyệt bỏ điều kiện
   * ngày def23/del_date; KHÔNG dùng sheet_lot).
   * Shape = mapNotice2Row (camelCase).
   * @param {string} poId po_id = pur_order2.id
   * @param {number[]} [noticeIds] HINT candidate IDs (sweep đã có sẵn —
   *   job chỉ re-read đúng các ID này thay vì re-run full PO/date search;
   *   relation [R2] vẫn được ép đầy đủ trong SQL nên ID sai范围 tự loại).
   *   Bỏ trống/rỗng → full query như cũ. KHÔNG được dùng hint làm con số
   *   quyết định ghi receipt — service vẫn tính FRESH trong tx.
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findNoticesForPoLine(poId, noticeIds) {
    const idFilter =
      Array.isArray(noticeIds) && noticeIds.length > 0
        ? `AND n2.id IN (${noticeIds.map(() => '?').join(', ')})`
        : '';
    const sql = `
    -- DECLARE @poId INT = 3;
    SELECT
      n2.id AS [id],
      n2.sheet_id AS [sheetId],
      n2.sheet_no AS [sheetNo],
      n2.pur_no AS [purNo],
      n2.pur_id AS [purId],
      n2.goods_no AS [goodsNo],
      n2.unit_no AS [unitNo],
      n2.st_no AS [stNo],
      CAST(n2.sheet_qty AS FLOAT) AS [sheetQty],
      CAST(n2.check_qty AS FLOAT) AS [checkQty],
      CAST(n2.bad_qty AS FLOAT) AS [badQty],
      CAST(n2.return_qty AS FLOAT) AS [returnQty],
      n2.qc_level AS [qcLevel],
      n2.adj_result AS [adjResult],
      n2.pro_result AS [proResult],
      n2.qc_date AS [qcDate],
      n2.qc_user_no AS [qcUserNo],
      n2.qc_emp_no AS [qcEmpNo],
      n2.made_lot AS [madeLot],
      n2.sheet_lot AS [sheetLot],
      -- Giờ tạm nhập của notice (từ header notice1) — dùng cho DTO
      -- candidates AMBIGUOUS (spec #15 createdAt), KHÔNG dùng làm matching key.
      n1.create_date AS [createdAt]
    FROM pur_notice2 n2
    JOIN pur_order2 o2 ON o2.id = ?
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN pur_notice1 n1 ON n1.sheet_no = n2.sheet_no
    WHERE n2.pur_no = o1.sheet_no
      AND n2.goods_no = o2.goods_no
      AND ((n2.def02 IS NULL AND o2.def02 IS NULL) OR n2.def02 = o2.def02)
      -- PO identity fix 2026-10-29: pur_id trỏ về DÒNG PO (sheet_id) —
      -- notice của dòng khác (cùng PO + goods + def02) KHÔNG match ở đây.
      AND n2.pur_id = o2.sheet_id
      ${idFilter}
    ORDER BY n2.id;
  `;
    const params = [poId];
    if (idFilter) {
      for (const nid of noticeIds) {
        const value = Number(nid);
        if (!Number.isFinite(value)) {
          throw new Error(
            '[po.repository] findNoticesForPoLine: noticeIds chứa ID không hợp lệ'
          );
        }
        params.push(value);
      }
    }
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * BATCH SET-BASED của findOrder2ByPoId (#11/#46 — sweep phân loại cả
   * lượt candidate bằng 1 câu thay vì N câu theo từng allocation):
   * po_id chính là candidate key từ WHS pending — KHÔNG scan toàn
   * pur_order2 (#12). Shape giống findOrder2ByPoId; caller tự map
   * theo id.
   * @param {number[]} poIds danh sách pur_order2.id (rỗng → [])
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findOrder2ByPoIds(poIds) {
    if (!Array.isArray(poIds) || poIds.length === 0) return [];
    const placeholders = poIds.map(() => '?').join(', ');
    const sql = `
    -- DECLARE @poIds TABLE (id INT);
    SELECT o2.id AS [id],
           o2.sheet_id AS [sheetId],
           o1.sheet_no AS [poNumber],
           o2.goods_no AS [goodsNo],
           o2.unit_no AS [unitNo],
           CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
           o2.made_lot AS [madeLot],
           o2.del_date AS [delDate],
           o1.su_name11 AS [suName11],
           o1.su_no AS [suNo]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE o2.id IN (${placeholders});
  `;
    const params = poIds.slice();
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * BATCH SET-BASED của findNoticesForPoLine (#11/#46): candidate-first
   * — JOIN o2 theo candidate po_ids rồi áp cùng relation [R2] (KHÔNG đổi
   * matching rule, KHÔNG GROUP toàn pur_notice2 #12, KHÔNG dùng
   * n2.pur_id = o2.id). Mỗi dòng kèm [poId] để caller group theo PO
   * trong memory. ORDER BY o2.id, n2.id.
   * @param {number[]} poIds danh sách pur_order2.id (rỗng → [])
   * @returns {Promise<Array<Record<string, unknown> & { poId: number }>>}
   */
  async findNoticesForPoDetails(poIds) {
    if (!Array.isArray(poIds) || poIds.length === 0) return [];
    const placeholders = poIds.map(() => '?').join(', ');
    const sql = `
    -- DECLARE @poIds TABLE (id INT);
    SELECT
      o2.id AS [poId],
      n2.id AS [id],
      n2.sheet_id AS [sheetId],
      n2.sheet_no AS [sheetNo],
      n2.pur_no AS [purNo],
      n2.pur_id AS [purId],
      n2.goods_no AS [goodsNo],
      n2.unit_no AS [unitNo],
      n2.st_no AS [stNo],
      CAST(n2.sheet_qty AS FLOAT) AS [sheetQty],
      CAST(n2.check_qty AS FLOAT) AS [checkQty],
      CAST(n2.bad_qty AS FLOAT) AS [badQty],
      CAST(n2.return_qty AS FLOAT) AS [returnQty],
      n2.qc_level AS [qcLevel],
      n2.adj_result AS [adjResult],
      n2.pro_result AS [proResult],
      n2.qc_date AS [qcDate],
      n2.qc_user_no AS [qcUserNo],
      n2.qc_emp_no AS [qcEmpNo],
      n2.made_lot AS [madeLot],
      n2.sheet_lot AS [sheetLot]
    FROM pur_notice2 n2
    JOIN pur_order2 o2 ON o2.id IN (${placeholders})
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE n2.pur_no = o1.sheet_no
      AND n2.goods_no = o2.goods_no
      AND ((n2.def02 IS NULL AND o2.def02 IS NULL) OR n2.def02 = o2.def02)
      -- PO identity fix 2026-10-29: pur_id = sheet_id (đúng dòng PO)
      AND n2.pur_id = o2.sheet_id
    ORDER BY o2.id, n2.id;
  `;
    const params = poIds.slice();
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Notice "mồ côi" theo key [R2] 3 trường cũ (pur_no + goods_no + def02)
   * nhưng pur_id NULL hoặc KHÔNG trỏ về dòng nào của chính PO đó
   * (PO identity fix 2026-10-29 — dữ liệu legacy thiếu/ sai pur_id).
   * Các notice này KHÔNG được dùng để sync receipt; worker dùng danh sách
   * này để mở issue DATA_ERROR (type VARCHAR(20) — không cần DDL).
   * Shape tối thiểu: id, sheetNo, purNo, purId, goodsNo, sheetQty, madeLot.
   * @param {string} poId po_id = pur_order2.id
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findOrphanNoticesForPoLine(poId) {
    const sql = `
    -- DECLARE @poId INT = 3;
    SELECT
      n2.id AS [id],
      n2.sheet_id AS [sheetId],
      n2.sheet_no AS [sheetNo],
      n2.pur_no AS [purNo],
      n2.pur_id AS [purId],
      n2.goods_no AS [goodsNo],
      CAST(n2.sheet_qty AS FLOAT) AS [sheetQty],
      n2.made_lot AS [madeLot]
    FROM pur_notice2 n2
    JOIN pur_order2 o2 ON o2.id = ?
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE n2.pur_no = o1.sheet_no
      AND n2.goods_no = o2.goods_no
      AND ((n2.def02 IS NULL AND o2.def02 IS NULL) OR n2.def02 = o2.def02)
      -- Mồ côi: pur_id trống hoặc không trỏ về dòng nào của PO này
      AND (
        n2.pur_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM pur_order2 o2x
          WHERE o2x.sheet_no = o1.sheet_no AND o2x.sheet_id = n2.pur_id
        )
      )
    ORDER BY n2.id;
  `;
    const params = [poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Tổng allocated_qty còn active (closed_at IS NULL) theo po_id.
   * @param {string} poId po_id = pur_order2.id
   * @returns {Promise<number>}
   */
  async sumAllocatedByPo(poId) {
    const sql = `
    -- DECLARE @poId INT = 3;
    SELECT COALESCE(SUM(allocated_qty), 0) AS [total]
    FROM whs_slot_allocation
    WHERE po_id = ? AND closed_at IS NULL;
  `;
    const params = [poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return Number(rows[0] ? rows[0].total : 0);
  }

  /**
   * Nạp 3 bảng tạm #PO -> #Notice -> #PurIn trong transaction hiện tại
   * (SPEC PERFORMANCE 2026-10-19 — câu fill #PO nhận searchParams để PUSHDOWN
   * lọc sớm: bucket + keyword + eligibility NPL M1..M6/A2 + keeper lọc NGAY
   * TẠI #PO, trước khi JOIN pur_notice2 / pur_in2 — tập ứng viên nhỏ cực đại,
   * không scan toàn bộ lịch sử khi có bucket).
   *
   * Thứ tự + số câu CỐ ĐỊNH, chạy TUẦN TỰ trên CÙNG một executor `query`:
   * drop #PurIn -> drop #Notice -> drop #PO -> fill #PO -> index #PO ->
   * fill #Notice -> index #Notice -> fill #PurIn -> index #PurIn.
   *
   * TẠI SAO 3 bảng tạm phải cùng 1 connection + transaction (query fn được
   * chuyền xuyên suốt):
   *   - mssql: #temp table thuộc SESSION. Nếu mỗi câu chạy qua
   *     sp_executesql (kiểu .query() của driver) thì temp table tạo trong
   *     scope đó bị DROP ngay khi scope kết thúc — câu sau không thấy #PO
   *     nữa. Vì vậy db.js chạy request.batch() (SQL_BATCH, scope session)
   *     thay cho sp_executesql, và mọi câu của pipeline phải cùng
   *     request/connection đó.
   *   - pg: TEMP TABLE cũng thuộc session — withTransaction giữ đúng 1 client
   *     cho cả pipeline (toDialect đổi tên #PO -> po_candidate).
   *   - Transaction còn đảm bảo DROP TABLE cuối pipeline nhất quán: nếu giữa
   *     chừng lỗi thì rollback, connection trả pool không dính temp table rơi
   *     rác của lần chạy trước (mỗi lần vào vẫn DROP IF EXISTS đầu tiên cho
   *     chắc).
   *
   * SELECT ... INTO #PO (mssql): cột temp table THỪA KẾ độ rộng thực của cột
   * nguồn T8 — chống truncated (CREATE TABLE tường minh + biểu thức tính toán
   * có thể bị suy kiểu hẹp hơn; NVARCHAR tối đa chỉ 4000 ký tự, tổng chiều
   * dài dòng giới hạn 8152 byte). Bên pg tương đương là
   * CREATE TEMP TABLE ... AS SELECT (rule 5b2 của toDialect).
   *
   * Câu fill #PO: chỉ PO MỞ (close_sw IN ('N','0') — FIX AUDIT 2026-10-19:
   * trước đây thiếu filter này nên PO đóng còn gap lot vào kết quả), người
  * tạo có hồ sơ bas_emp và khác ADM. HIỆN THỊ (rework 2026-10-29, no-max):
   * ĐÃ BỎ pushdown gate COALESCE(pa.assigned_total, 0) < sheet_qty —
   * sheet_qty chỉ là tham khảo, tổng allocated được vượt PO, PO không ẩn
   * khi gán đủ/vượt; áp cho cả list lẫn count (bucket đếm đúng tập hiển thị).
   *
   * FILTER KEEPER dùng EXISTS whs_keeper_material_assignment
   * (ended_at IS NULL) thay vì JOIN: JOIN có thể NHÂN BẢN dòng PO khi 1 goods
   * có nhiều dòng assignment (lịch sử); EXISTS giữ đúng 1 dòng PO mỗi dòng PO
   * gốc. Pushdown sớm nghĩa là điều kiện này chạy trong #PO (không JOIN
   * assignment ở câu SELECT cuối).
   *
   *   fillParams.bucket = null  => #PO RỘNG (base đếm tất cả bucket)
   *   fillParams.bucket != null => #PO HẸP (list theo bucket cụ thể)
   * @private
   * @param {Function} query query fn của withTransaction (cùng connection)
   * @param {{ keeperEmpNo: string | null, bucket: string | null,
   *   twoMonthsAgoStart: string | null, prevMonthStart: string | null,
   *   today: string | null, next3End: string | null, next7End: string | null,
   *   prefixPattern: string | null, containsPattern: string | null }} fillParams
   * @returns {Promise<void>}
   */
  async fillTempTables(query, fillParams) {
    const {
      keeperEmpNo,
      bucket,
      twoMonthsAgoStart,
      prevMonthStart,
      today,
      next3End,
      next7End,
      prefixPattern,
      containsPattern,
    } = fillParams;

    // DROP #PurIn -> #Notice -> #PO (thứ tự cũ, giữ nguyên).
    const dropPurInSql = `
    IF OBJECT_ID('tempdb..#PurIn') IS NOT NULL DROP TABLE #PurIn;
  `;
    const dropPurInParams = [];
    guardParams(dropPurInParams);
    await query(toDialect(dropPurInSql), dropPurInParams);

    const dropNoticeSql = `
    IF OBJECT_ID('tempdb..#Notice') IS NOT NULL DROP TABLE #Notice;
  `;
    const dropNoticeParams = [];
    guardParams(dropNoticeParams);
    await query(toDialect(dropNoticeSql), dropNoticeParams);

    const dropPoSql = `
    IF OBJECT_ID('tempdb..#PO') IS NOT NULL DROP TABLE #PO;
  `;
    const dropPoParams = [];
    guardParams(dropPoParams);
    await query(toDialect(dropPoSql), dropPoParams);

    // Nạp candidate PO (SELECT ... INTO #PO — cột thừa kế độ rộng thực của
    // T8, chống truncated). Eligibility M1-M6+A2 + approved + KEEPER EXISTS
    // (ended_at IS NULL) + bucket + keyword đều nằm trong câu này: lọc sớm để
    // #PO nhỏ cực đại trước khi build #Notice / #PurIn.
    const fillPoSql = `
    -- DECLARE @bucket NVARCHAR(10) = NULL;
    -- DECLARE @today DATETIME = '2026-10-20';
    -- DECLARE @prevMonthStart DATETIME = '2026-09-01';
    -- DECLARE @twoMonthsAgoStart DATETIME = '2026-08-01';
    -- DECLARE @next3End DATETIME = '2026-10-24';
    -- DECLARE @next7End DATETIME = '2026-10-28';
    -- DECLARE @keeperEmpNo NVARCHAR(20) = NULL;
    -- DECLARE @prefixPattern NVARCHAR(140) = NULL;
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    SELECT
      o2.id AS po_id,
      o1.sheet_no AS po_number,
      o1.su_name11 AS supplier,
      o1.sheet_date AS sheet_date,
      o1.check_sta AS check_sta,
      o2.goods_no AS item_code,
      g.goods_name AS material,
      o2.unit_no AS unit,
      o2.sheet_qty AS sheet_qty,
      o2.sheet_pri AS unit_price,
      o2.del_date AS del_date,
      CONVERT(DATE, o2.del_date) AS del_day,
      o2.def02 AS def02,
      o2.sheet_id AS sheet_id,
      o2.made_lot AS made_lot,
      COALESCE(pa.assigned_total, 0) AS assigned_total,
      COALESCE(pa.gap_assigned, 0) AS gap_assigned
    INTO #PO
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    JOIN bas_emp e
      ON e.emp_no = o1.create_user AND e.emp_name <> 'ADM'
    LEFT JOIN bas_goods g ON g.goods_no = o2.goods_no
    -- Tổng allocation theo PO (2026-10-28): assigned_total KỂ CẢ allocation
    -- đã close (so sánh với pur_order2.sheet_qty); gap_assigned = phần
    -- chưa map receipt (dùng trừ trong nhánh gap). Aggregate 1 lần —
    -- không subquery tương quan từng dòng.
    LEFT JOIN (
      -- SQL Server cấm SUM chứa subquery (NOT EXISTS bên trong CASE) —
      -- thay bằng LEFT JOIN DISTINCT allocation_id: mỗi allocation tối đa
      -- 1 dòng receipt khớp nên SUM không bị nhân đôi khi 1 allocation
      -- có nhiều receipt.
      SELECT x.po_id,
        SUM(x.allocated_qty) AS assigned_total,
        SUM(CASE WHEN rx.allocation_id IS NULL
          THEN x.allocated_qty ELSE 0 END) AS gap_assigned
      FROM whs_slot_allocation x
      LEFT JOIN (
        SELECT DISTINCT allocation_id
        FROM whs_allocation_receipt
      ) rx ON rx.allocation_id = x.id
      GROUP BY x.po_id
    ) pa ON pa.po_id = o2.id
    WHERE o1.close_sw IN ('N', '0')
      -- FILTER approved (2026-10-20): bo PO chua duyet (sheet_sta CHAR(1))
      AND o1.sheet_sta <> '0'
      -- FILTER M1-M6: chi NPL ma goods_no bat dau M1..M6
      -- TODO(PACKING): chua co rule Packing — KHONG doan bang goods_name LIKE/NOT LIKE
        AND (
          o2.goods_no LIKE 'M1%' OR o2.goods_no LIKE 'M2%'
          OR o2.goods_no LIKE 'M3%' OR o2.goods_no LIKE 'M4%'
          OR o2.goods_no LIKE 'M5%' OR o2.goods_no LIKE 'M6%'
          OR o2.goods_no LIKE 'A2%'
        )
      -- FILTER keeper NPL: KEEPER chi thay NPL duoc phan cong active
      -- (manager => @keeperEmpNo = NULL => khong loc)
      AND (
        CAST(? AS NVARCHAR(20)) IS NULL
        OR EXISTS (
          SELECT 1 FROM whs_keeper_material_assignment ma
          WHERE ma.keeper_emp_no = ?
            AND ma.goods_no = o2.goods_no
            AND ma.ended_at IS NULL
        )
      )
      -- BUCKET MOI: 5 moc ngay tinh JS, khong CONVERT o2.del_date
      AND (
        CAST(? AS NVARCHAR(10)) IS NULL
        OR (? = 'od3p' AND (o2.del_date IS NULL OR o2.del_date < ?))
        OR (? = 'od2' AND o2.del_date >= ? AND o2.del_date < ?)
        OR (? = 'od1' AND o2.del_date >= ? AND o2.del_date < ?)
        OR (? = 'next3' AND o2.del_date >= ? AND o2.del_date < ?)
        OR (? = 'next7' AND o2.del_date >= ? AND o2.del_date < ?)
      )
      AND (
        CAST(? AS NVARCHAR(140)) IS NULL
        OR o1.sheet_no LIKE ?
        OR o2.goods_no LIKE ?
        OR o2.made_lot LIKE ?
        OR g.goods_name LIKE ?
        OR o1.su_name11 LIKE ?
        OR EXISTS (
          SELECT 1 FROM pur_notice2 n2k
          WHERE n2k.pur_no = o2.sheet_no
            AND n2k.goods_no = o2.goods_no
            AND (
              n2k.def02 = o2.def02
              OR (n2k.def02 IS NULL AND o2.def02 IS NULL)
            )
            AND n2k.pur_id = o2.sheet_id
            AND n2k.made_lot LIKE ?
        )
      )
      -- HIỆN THỊ (rework 2026-10-29, no-max): ĐÃ BỎ gate assigned_total <
      -- sheet_qty — tổng allocated được vượt PO (sheet_qty chỉ tham khảo),
      -- PO không ẩn khi gán đủ/vượt.
    ;
  `;
    const fillPoParams = [
      // FILTER keeper (manager => NULL, không lọc)
      keeperEmpNo,
      keeperEmpNo,
      // BUCKET: mỗi nhánh = bucket + 2 mốc ngày tương ứng
      bucket,
      bucket,
      twoMonthsAgoStart,
      bucket,
      twoMonthsAgoStart,
      prevMonthStart,
      bucket,
      prevMonthStart,
      today,
      bucket,
      today,
      next3End,
      bucket,
      next3End,
      next7End,
      // KEYWORD: 4 nhánh prefix (po_number, item_code, made_lot, notice made_lot)
      prefixPattern,
      prefixPattern,
      prefixPattern,
      prefixPattern,
      // 2 nhánh contains (material, supplier)
      containsPattern,
      containsPattern,
      // notice made_lot trong EXISTS
      prefixPattern,
    ];
    guardParams(fillPoParams);
    await query(toDialect(fillPoSql), fillPoParams);

    // CREATE INDEX trên #PO sau khi nạp — JOIN #PO x #Notice theo PO-LINE KEY
    // [R2] nhanh hơn khi #PO lớn.
    const indexPoSql = `
    CREATE INDEX ix_po_key
      ON #PO (po_number, item_code, def02, del_day);
  `;
    const indexPoParams = [];
    guardParams(indexPoParams);
    await query(toDialect(indexPoSql), indexPoParams);

    // Nạp notice khớp key 4 trường [R2] (pur_no + goods_no + def02 +
    // pur_id = sheet_id — PO identity fix 2026-10-29; 2026-10-28 user duyệt
    // bỏ điều kiện ngày def23) của candidate PO (chỉ build từ #PO đã lọc —
    // không scan toàn bộ pur_notice2); def02 so khớp NULL-SAFE. pur_id ghim
    // notice về đúng DÒNG PO — notice của dòng khác (cùng PO + goods +
    // def02) không còn fan-out; nhánh gap tính noticed đúng từng dòng,
    // nhánh notice dedupe rn = 1 (giữ làm safety net).
    const fillNoticeSql = `
    SELECT
      n2.id AS notice_id,
      p.po_id AS po_id,
      n2.pur_no AS pur_no,
      n2.goods_no AS goods_no,
      n2.made_lot AS made_lot,
      n2.sheet_qty AS sheet_qty,
      n2.def02 AS def02,
      n2.unit_no AS unit_no,
      -- Đồng hồ tạm nhập (2026-10-28): giờ tạm nhập = notice1.create_date
      -- LEFT JOIN vì notice thiếu header coi như chưa biết giờ (NULL = hiện)
      n1.create_date AS create_date
    INTO #Notice
    FROM #PO p
    JOIN pur_notice2 n2
      ON n2.pur_no = p.po_number
     AND n2.goods_no = p.item_code
     AND n2.pur_id = p.sheet_id
     AND ((n2.def02 IS NULL AND p.def02 IS NULL) OR n2.def02 = p.def02)
    LEFT JOIN pur_notice1 n1 ON n1.sheet_no = n2.sheet_no;
  `;
    const fillNoticeParams = [];
    guardParams(fillNoticeParams);
    await query(toDialect(fillNoticeSql), fillNoticeParams);

    // Index #Notice theo po_id và theo key GRN [R3].
    const indexNoticeSql = `
    CREATE INDEX ix_notice_po
      ON #Notice (po_id);
    CREATE INDEX ix_notice_lot
      ON #Notice (pur_no, goods_no, made_lot);
  `;
    const indexNoticeParams = [];
    guardParams(indexNoticeParams);
    await query(toDialect(indexNoticeSql), indexNoticeParams);

    // Nạp in2 theo PO của candidate (lọc PO trước — không GROUP BY toàn bộ
    // pur_in2). Dùng cho: (a) loại notice lot đã GRN theo [R3]; (b) arrived /
    // grnRef của nhánh gap.
    const fillPurInSql = `
    SELECT DISTINCT
      i2.pur_no AS pur_no,
      i2.goods_no AS goods_no,
      i2.made_lot AS made_lot,
      i2.pur_id AS pur_id,
      i2.sheet_no AS sheet_no
    INTO #PurIn
    FROM pur_in2 i2
    JOIN (SELECT DISTINCT po_number FROM #PO) p
      ON p.po_number = i2.pur_no;
  `;
    const fillPurInParams = [];
    guardParams(fillPurInParams);
    await query(toDialect(fillPurInSql), fillPurInParams);

    // Index #PurIn theo key GRN [R3] và theo PO+goods.
    const indexPurInSql = `
    CREATE INDEX ix_purin_lot
      ON #PurIn (pur_no, goods_no, made_lot);
    CREATE INDEX ix_purin_po
      ON #PurIn (pur_no, goods_no, pur_id);
  `;
    const indexPurInParams = [];
    guardParams(indexPurInParams);
    await query(toDialect(indexPurInSql), indexPurInParams);
  }

  /**
   * DROP 3 bảng tạm giải phóng connection pooled (chạy trước khi trả
   * connection về pool — temp table là tài nguyên của session).
   * @private
   * @param {Function} query query fn của withTransaction
   * @returns {Promise<void>}
   */
  async dropTempTables(query) {
    const dropPurInSql = `
    IF OBJECT_ID('tempdb..#PurIn') IS NOT NULL DROP TABLE #PurIn;
  `;
    const dropPurInParams = [];
    guardParams(dropPurInParams);
    await query(toDialect(dropPurInSql), dropPurInParams);

    const dropNoticeSql = `
    IF OBJECT_ID('tempdb..#Notice') IS NOT NULL DROP TABLE #Notice;
  `;
    const dropNoticeParams = [];
    guardParams(dropNoticeParams);
    await query(toDialect(dropNoticeSql), dropNoticeParams);

    const dropPoSql = `
    IF OBJECT_ID('tempdb..#PO') IS NOT NULL DROP TABLE #PO;
  `;
    const dropPoParams = [];
    guardParams(dropPoParams);
    await query(toDialect(dropPoSql), dropPoParams);
  }

  /**
   * LIST /pos — PIPELINE HẸP (audit performance 2026-10-19): bucket + keyword
   * + eligibility + keeper ĐƯỢC ĐẨY VÀO câu fill #PO của fillTempTables =>
   * candidate PO nhỏ cực đại TRƯỚC khi build #Notice / #PurIn (khi có bucket
   * cụ thể, không scan toàn bộ lịch sử). Kết quả list trả từ #PO đã lọc.
   *
   * Câu SELECT cuối (hiển thị cập nhật 2026-10-29, no-max): gap (qty =
   * sheet_qty − noticed theo key [R2] − gap_assigned, có thể ≤ 0 khi
   * over-assign; CHỈ ẩn khi T8-side hết hàng sheet_qty − noticed ≤ 0 —
   * KHÔNG ẩn do gap_assigned đạt/vượt remaining, sheet_qty chỉ tham khảo)
   * UNION ALL notice_branch (mỗi đợt tạm nhập 1 dòng; hiện khi create_date
   * trong 24h và chưa có trong pur_in2 theo [R3]; 1 notice chỉ 1 dòng rn = 1).
   * Cả 2 nhánh đã qua #PO lọc lifecycle/permission — KHÔNG còn gate
   * "chưa gán hết theo pur_order" (đã bỏ 2026-10-29). Keyword + bucket ở
   * câu này là safety net trùng lặp với pushdown. NULL del_date = od3p
   * (thống nhất countPurchaseBuckets).
   *
   * Optimization đếm (counts): total lấy từ COUNT(*) OVER() gắn ngay trong
   * câu rows (không chạy câu count riêng); CHỈ khi trang vượt cuối (rows rỗng,
   * page > 1) mới fallback câu count riêng không phân trang — normal case chỉ
   * 1 query lấy cả rows lẫn total.
   *
   * Toàn bộ pipeline + câu SELECT cuối + DROP temp nằm trong 1
   * withTransaction — temp table phải thấy được xuyên suốt trên cùng
   * connection (xem fillTempTables).
   * @param {{ keyword?: string, bucket?: string | null, today: string,
   *   prevMonthStart: string, twoMonthsAgoStart: string, next3End: string,
   *   next7End: string, keeperEmpNo?: string | null, page: number,
   *   pageSize: number }} opts
   * @returns {Promise<{ rows: Record<string, unknown>[], total: number }>}
   */
  async searchPurchases(opts) {
    return db.withTransaction(async (query) => {
      const sp = searchParams(opts);
      await this.fillTempTables(query, sp);

      const offset = (opts.page - 1) * opts.pageSize;
      const sqlRows = `
    -- DECLARE @prefixPattern NVARCHAR(140) = 'PO1%';
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    -- DECLARE @bucket NVARCHAR(10) = 'od1';
    -- DECLARE @today DATETIME = '2026-10-20';
    -- DECLARE @prevMonthStart DATETIME = '2026-09-01';
    -- DECLARE @twoMonthsAgoStart DATETIME = '2026-08-01';
    -- DECLARE @next3End DATETIME = '2026-10-24';
    -- DECLARE @next7End DATETIME = '2026-10-28';
    -- DECLARE @offset INT = 0;
    -- DECLARE @pageSize INT = 20;
    WITH noticed AS (
      SELECT po_id, SUM(sheet_qty) AS noticed_qty, MAX(create_date) AS latest_create
      FROM #Notice
      GROUP BY po_id
    ),
    gap AS (
      SELECT
        CAST(p.po_id AS VARCHAR(40)) AS id,
        p.po_id AS po_id,
        p.po_number AS po_number,
        p.item_code AS item_code,
        p.material AS material,
        p.supplier AS supplier,
        (p.sheet_qty - COALESCE(nc.noticed_qty, 0) - p.gap_assigned) AS qty,
        p.sheet_qty AS sheet_qty,
        p.unit AS unit,
        p.unit_price AS unit_price,
        CASE WHEN p.check_sta = 'Y' THEN 1 ELSE 0 END AS confirmed,
        p.del_date AS eta,
        CASE WHEN EXISTS (
          SELECT 1 FROM #PurIn pi
          WHERE pi.pur_no = p.po_number AND pi.goods_no = p.item_code
            AND pi.pur_id = p.sheet_id
        ) THEN 1 ELSE 0 END AS arrived,
        (SELECT MAX(pi2.sheet_no) FROM #PurIn pi2
          WHERE pi2.pur_no = p.po_number AND pi2.goods_no = p.item_code
            AND pi2.pur_id = p.sheet_id)
            AS grn_ref,
        -- Gap row CHƯA có tạm nhập nên chưa có business lot (made_lot PO
        -- không phải lot tạm nhập — 2026-10-29); lot thật chỉ ở notice_branch.
        CAST(NULL AS VARCHAR(40)) AS lot_no,
        p.assigned_total AS assigned_qty,
        p.del_date AS del_date,
        p.sheet_date AS sheet_date,
        p.po_id AS po_sort,
        0 AS lot_sort
      FROM #PO p
      LEFT JOIN noticed nc ON nc.po_id = p.po_id
      -- HIỆN THỊ (2026-10-28): đồng hồ tạm nhập 24h — chưa có notice,
      -- hoặc notice1.create_date mới nhất còn trong 24h (NULL = hiện)
      WHERE (
        nc.po_id IS NULL
        OR nc.latest_create IS NULL
        OR nc.latest_create >= DATEADD(HOUR, -24, GETDATE())
      )
      -- ẨN gap rỗng (rework 2026-10-29, no-max): chỉ ẩn khi T8 đã tạm nhập
      -- đủ tham chiếu — sheet_qty − noticed <= 0; KHÔNG trừ gap_assigned
      -- để tổng allocated đạt/vượt PO không làm row biến mất (user được
      -- gán vượt PO, sheet_qty chỉ là tham khảo — row có thể hiện với
      -- qty <= 0 khi over-assign phần chưa tạm nhập). Mirror memory
      -- repository if (sheet_qty - noticed > 0).
      AND (p.sheet_qty - COALESCE(nc.noticed_qty, 0)) > 0
    ),
    notice_branch AS (
      SELECT
        CONCAT(x.po_id, '-N', x.notice_id) AS id,
        x.po_id AS po_id,
        p2.po_number AS po_number,
        p2.item_code AS item_code,
        p2.material AS material,
        p2.supplier AS supplier,
        x.sheet_qty AS qty,
        p2.sheet_qty AS sheet_qty,
        x.unit_no AS unit,
        p2.unit_price AS unit_price,
        CASE WHEN p2.check_sta = 'Y' THEN 1 ELSE 0 END AS confirmed,
        p2.del_date AS eta,
        1 AS arrived,
        CAST(NULL AS VARCHAR(20)) AS grn_ref,
        x.made_lot AS lot_no,
        p2.assigned_total AS assigned_qty,
        p2.del_date AS del_date,
        p2.sheet_date AS sheet_date,
        x.po_id AS po_sort,
        x.notice_id AS lot_sort
      FROM (
        SELECT
          n.notice_id,
          n.po_id,
          n.pur_no,
          n.goods_no,
          n.made_lot,
          n.sheet_qty,
          n.unit_no,
          n.create_date,
          ROW_NUMBER() OVER (
            PARTITION BY n.notice_id ORDER BY n.po_id ASC
          ) AS rn
        FROM #Notice n
      ) x
      JOIN #PO p2 ON p2.po_id = x.po_id
      WHERE x.rn = 1
        AND (x.create_date IS NULL
             OR x.create_date >= DATEADD(HOUR, -24, GETDATE()))
        AND NOT EXISTS (
          SELECT 1 FROM #PurIn pi
          WHERE pi.pur_no = x.pur_no
            AND pi.goods_no = x.goods_no
            AND pi.made_lot = x.made_lot
        )
    ),
    eligible AS (
      SELECT * FROM gap
      UNION ALL
      SELECT * FROM notice_branch
    )
    SELECT
      u.id AS [id],
      CAST(u.po_id AS VARCHAR(20)) AS [poLine],
      u.po_number AS [poNumber],
      u.item_code AS [itemCode],
      u.material AS [material],
      u.supplier AS [supplier],
      CAST(u.qty AS FLOAT) AS [qty],
      CAST(u.sheet_qty AS FLOAT) AS [sheetQty],
      u.unit AS [unit],
      CAST(u.unit_price AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN u.confirmed = 1 THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      u.eta AS [eta],
      CAST(CASE WHEN u.arrived = 1 THEN 1 ELSE 0 END AS BIT) AS [arrived],
      u.grn_ref AS [grnRef],
      u.lot_no AS [lotNo],
      CAST(u.assigned_qty AS FLOAT) AS [assignedQty],
      CAST(0 AS BIT) AS [closed],
      u.sheet_date AS [sheetDate],
      u.del_date AS [delDate],
      'mock' AS [source],
      COUNT(*) OVER() AS [totalCnt]
    FROM eligible u
    WHERE (
      CAST(? AS NVARCHAR(140)) IS NULL
      OR u.po_number LIKE ?
      OR u.item_code LIKE ?
      OR u.lot_no LIKE ?
      OR u.material LIKE ?
      OR u.supplier LIKE ?
    )
    AND (
      CAST(? AS NVARCHAR(10)) IS NULL
      OR (? = 'od3p' AND (u.del_date IS NULL OR u.del_date < ?))
      OR (? = 'od2' AND u.del_date >= ? AND u.del_date < ?)
      OR (? = 'od1' AND u.del_date >= ? AND u.del_date < ?)
      OR (? = 'next3' AND u.del_date >= ? AND u.del_date < ?)
      OR (? = 'next7' AND u.del_date >= ? AND u.del_date < ?)
    )
    ORDER BY u.del_date ASC, u.po_sort ASC, u.lot_sort ASC
    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
  `;
      const rowsParams = [
        // KEYWORD: 4 nhánh prefix (po_number, item_code, lot_no) + 2 contains
        sp.prefixPattern,
        sp.prefixPattern,
        sp.prefixPattern,
        sp.prefixPattern,
        sp.containsPattern,
        sp.containsPattern,
        // BUCKET: mỗi nhánh = bucket + 2 mốc ngày tương ứng
        sp.bucket,
        sp.bucket,
        sp.twoMonthsAgoStart,
        sp.bucket,
        sp.twoMonthsAgoStart,
        sp.prevMonthStart,
        sp.bucket,
        sp.prevMonthStart,
        sp.today,
        sp.bucket,
        sp.today,
        sp.next3End,
        sp.bucket,
        sp.next3End,
        sp.next7End,
        // Phân trang
        offset,
        opts.pageSize,
      ];
      guardParams(rowsParams);
      const rowsResult = await query(toDialect(sqlRows), rowsParams);
      const rows = rowsResult.rows;
      let total = 0;
      if (rows.length === 0 && opts.page > 1) {
        // Trang vượt cuối: COUNT(*) OVER() rỗng — đếm riêng (không phân trang),
        // cùng predicate keyword + bucket. NULL del_date = od3p (thống nhất
        // với câu rows + countPurchaseBuckets).
        const sqlCount = `
    -- DECLARE @prefixPattern NVARCHAR(140) = NULL;
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    -- DECLARE @bucket NVARCHAR(10) = NULL;
    -- DECLARE @today DATETIME = '2026-10-20';
    -- DECLARE @prevMonthStart DATETIME = '2026-09-01';
    -- DECLARE @twoMonthsAgoStart DATETIME = '2026-08-01';
    -- DECLARE @next3End DATETIME = '2026-10-24';
    -- DECLARE @next7End DATETIME = '2026-10-28';
    WITH noticed AS (
      SELECT po_id, SUM(sheet_qty) AS noticed_qty, MAX(create_date) AS latest_create
      FROM #Notice
      GROUP BY po_id
    ),
    gap AS (
      SELECT
        p.po_id AS po_id,
        p.po_number AS po_number,
        p.item_code AS item_code,
        p.material AS material,
        p.supplier AS supplier,
        -- Gap row chưa có tạm nhập — chưa có business lot (2026-10-29).
        CAST(NULL AS VARCHAR(40)) AS lot_no,
        p.del_date AS del_date,
        p.po_id AS po_sort,
        0 AS lot_sort
      FROM #PO p
      LEFT JOIN noticed nc ON nc.po_id = p.po_id
      -- HIỆN THỊ (2026-10-28): đồng hồ tạm nhập 24h — chưa có notice hoặc
      -- notice1.create_date mới nhất còn trong 24h (NULL = hiện)
      WHERE (
        nc.po_id IS NULL
        OR nc.latest_create IS NULL
        OR nc.latest_create >= DATEADD(HOUR, -24, GETDATE())
      )
      -- ẨN gap rỗng (rework 2026-10-29, no-max): chỉ ẩn khi T8 đã tạm nhập
      -- đủ tham chiếu — sheet_qty − noticed <= 0; KHÔNG trừ gap_assigned
      -- để tổng allocated đạt/vượt PO không làm row biến mất (user được
      -- gán vượt PO, sheet_qty chỉ là tham khảo — row có thể hiện với
      -- qty <= 0 khi over-assign phần chưa tạm nhập). Mirror memory
      -- repository if (sheet_qty - noticed > 0).
      AND (p.sheet_qty - COALESCE(nc.noticed_qty, 0)) > 0
    ),
    notice_branch AS (
      SELECT
        x.po_id AS po_id,
        p2.po_number AS po_number,
        p2.item_code AS item_code,
        p2.material AS material,
        p2.supplier AS supplier,
        x.made_lot AS lot_no,
        p2.del_date AS del_date,
        x.po_id AS po_sort,
        x.notice_id AS lot_sort
      FROM (
        SELECT
          n.notice_id,
          n.po_id,
          n.pur_no,
          n.goods_no,
          n.made_lot,
          n.sheet_qty,
          n.create_date,
          ROW_NUMBER() OVER (
            PARTITION BY n.notice_id ORDER BY n.po_id ASC
          ) AS rn
        FROM #Notice n
      ) x
      JOIN #PO p2 ON p2.po_id = x.po_id
      WHERE x.rn = 1
        AND (x.create_date IS NULL
             OR x.create_date >= DATEADD(HOUR, -24, GETDATE()))
        AND NOT EXISTS (
          SELECT 1 FROM #PurIn pi
          WHERE pi.pur_no = x.pur_no
            AND pi.goods_no = x.goods_no
            AND pi.made_lot = x.made_lot
        )
    ),
    eligible AS (
      SELECT * FROM gap
      UNION ALL
      SELECT * FROM notice_branch
    )
    SELECT COUNT(*) AS [total]
    FROM eligible u
    WHERE (
      CAST(? AS NVARCHAR(140)) IS NULL
      OR u.po_number LIKE ?
      OR u.item_code LIKE ?
      OR u.lot_no LIKE ?
      OR u.material LIKE ?
      OR u.supplier LIKE ?
    )
    AND (
      CAST(? AS NVARCHAR(10)) IS NULL
      OR (? = 'od3p' AND (u.del_date IS NULL OR u.del_date < ?))
      OR (? = 'od2' AND u.del_date >= ? AND u.del_date < ?)
      OR (? = 'od1' AND u.del_date >= ? AND u.del_date < ?)
      OR (? = 'next3' AND u.del_date >= ? AND u.del_date < ?)
      OR (? = 'next7' AND u.del_date >= ? AND u.del_date < ?)
    );
  `;
        const countParams = [
          // KEYWORD: 4 nhánh prefix + 2 contains
          sp.prefixPattern,
          sp.prefixPattern,
          sp.prefixPattern,
          sp.prefixPattern,
          sp.containsPattern,
          sp.containsPattern,
          // BUCKET: mỗi nhánh = bucket + 2 mốc ngày tương ứng
          sp.bucket,
          sp.bucket,
          sp.twoMonthsAgoStart,
          sp.bucket,
          sp.twoMonthsAgoStart,
          sp.prevMonthStart,
          sp.bucket,
          sp.prevMonthStart,
          sp.today,
          sp.bucket,
          sp.today,
          sp.next3End,
          sp.bucket,
          sp.next3End,
          sp.next7End,
        ];
        guardParams(countParams);
        const counted = await query(toDialect(sqlCount), countParams);
        total = Number(counted.rows[0] ? counted.rows[0].total : 0);
      } else if (rows.length > 0) {
        total = Number(rows[0].totalCnt || 0);
      }
      // totalCnt là cột nội bộ của pipeline (chỉ dùng khi không chạy
      // COUNT riêng) — service map qua toApiPo (whitelist) nên không
      // lộ ra FE; không tự strip trong repository (refactor 2026-10-26).
      await this.dropTempTables(query);
      return { rows, total };
    });
  }

  /**
   * COUNT BUCKET — PIPELINE RỘNG (audit performance 2026-10-19): KHÔNG push
   * bucket vào #PO (phải đếm TẤT CẢ bucket cùng lúc — bucket=null nên #PO giữ
   * base rộng), chỉ push keyword + eligibility + keeper. User chấp nhận count
   * có base rộng hơn list — list không bị ép scan toàn bộ lịch sử (list chạy
   * pipeline hẹp riêng, 2 pipeline KHÔNG dùng chung #PO vì điều kiện nạp khác
   * nhau). Trả { [bucket]: count }.
   *
   * Câu SQL: COUNT DISTINCT po_number theo bucket ETA — dùng CHÍNH pipeline
   * #PO/#Notice/#PurIn đã nạp (reuse, không chạy lại từ đầu). Keyword áp dụng,
   * bucket KHÔNG lọc (đếm tất cả bucket cùng lúc). NULL del_date rơi vào od3p
   * (match memory bucketOfCase). Bucket mới 2026-10-20: 5 mốc ngày theo thứ
   * tự twoMonthsAgoStart / prevMonthStart / today / next3End / next7End —
   * phải khớp search.service (computeBucketDates). Filter approved / M1-M6 /
   * keeper đã ĐƯỢC push sớm trong câu fill #PO (#PO đã lọc) nên số bucket
   * tính đúng scope quyền của người xem (keeper chỉ thấy NPL được phân công
   * active của mình). del_date >= next7End: nằm ngoài 5 bucket -> bucket NULL,
   * bị loại khỏi kết quả đếm (WHERE t.bucket IS NOT NULL).
   * @param {{ keyword?: string, today: string, prevMonthStart: string,
   *   twoMonthsAgoStart: string, next3End: string, next7End: string,
   *   keeperEmpNo?: string | null }} opts
   * @returns {Promise<Record<string, number>>} số dòng mỗi bucket
   */
  async countPurchaseBuckets(opts) {
    return db.withTransaction(async (query) => {
      const sp = searchParams(opts);
      await this.fillTempTables(query, { ...sp, bucket: null });

      const sqlBuckets = `
    -- DECLARE @prefixPattern NVARCHAR(140) = NULL;
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    -- DECLARE @today DATETIME = '2026-10-20';
    -- DECLARE @prevMonthStart DATETIME = '2026-09-01';
    -- DECLARE @twoMonthsAgoStart DATETIME = '2026-08-01';
    -- DECLARE @next3End DATETIME = '2026-10-24';
    -- DECLARE @next7End DATETIME = '2026-10-28';
    WITH noticed AS (
      SELECT po_id, SUM(sheet_qty) AS noticed_qty, MAX(create_date) AS latest_create
      FROM #Notice
      GROUP BY po_id
    ),
    gap AS (
      SELECT
        p.po_number AS po_number,
        p.item_code AS item_code,
        p.material AS material,
        p.supplier AS supplier,
        -- Gap row chưa có tạm nhập — chưa có business lot (2026-10-29).
        CAST(NULL AS VARCHAR(40)) AS lot_no,
        p.del_date AS del_date
      FROM #PO p
      LEFT JOIN noticed nc ON nc.po_id = p.po_id
      -- HIỆN THỊ (2026-10-28): đồng hồ tạm nhập 24h — chưa có notice hoặc
      -- notice1.create_date mới nhất còn trong 24h (NULL = hiện)
      WHERE (
        nc.po_id IS NULL
        OR nc.latest_create IS NULL
        OR nc.latest_create >= DATEADD(HOUR, -24, GETDATE())
      )
      -- ẨN gap rỗng (rework 2026-10-29, no-max): chỉ ẩn khi T8 đã tạm nhập
      -- đủ tham chiếu — sheet_qty − noticed <= 0; KHÔNG trừ gap_assigned
      -- để tổng allocated đạt/vượt PO không làm row biến mất (user được
      -- gán vượt PO, sheet_qty chỉ là tham khảo — row có thể hiện với
      -- qty <= 0 khi over-assign phần chưa tạm nhập). Mirror memory
      -- repository if (sheet_qty - noticed > 0).
      AND (p.sheet_qty - COALESCE(nc.noticed_qty, 0)) > 0
    ),
    notice_branch AS (
      SELECT
        p2.po_number AS po_number,
        p2.item_code AS item_code,
        p2.material AS material,
        p2.supplier AS supplier,
        x.made_lot AS lot_no,
        p2.del_date AS del_date
      FROM (
        SELECT
          n.notice_id,
          n.po_id,
          n.pur_no,
          n.goods_no,
          n.made_lot,
          n.sheet_qty,
          n.create_date,
          ROW_NUMBER() OVER (
            PARTITION BY n.notice_id ORDER BY n.po_id ASC
          ) AS rn
        FROM #Notice n
      ) x
      JOIN #PO p2 ON p2.po_id = x.po_id
      WHERE x.rn = 1
        AND (x.create_date IS NULL
             OR x.create_date >= DATEADD(HOUR, -24, GETDATE()))
        AND NOT EXISTS (
          SELECT 1 FROM #PurIn pi
          WHERE pi.pur_no = x.pur_no
            AND pi.goods_no = x.goods_no
            AND pi.made_lot = x.made_lot
        )
    ),
    eligible AS (
      SELECT * FROM gap
      UNION ALL
      SELECT * FROM notice_branch
    )
    SELECT t.bucket AS [bucket], COUNT(DISTINCT t.po_number) AS [n]
    FROM (
      SELECT
        u.po_number,
        CASE
          WHEN u.del_date IS NULL OR u.del_date < ? THEN 'od3p'
          WHEN u.del_date >= ? AND u.del_date < ? THEN 'od2'
          WHEN u.del_date >= ? AND u.del_date < ? THEN 'od1'
          WHEN u.del_date >= ? AND u.del_date < ? THEN 'next3'
          WHEN u.del_date >= ? AND u.del_date < ? THEN 'next7'
          ELSE NULL
        END AS bucket
      FROM eligible u
      WHERE (
        CAST(? AS NVARCHAR(140)) IS NULL
        OR u.po_number LIKE ?
        OR u.item_code LIKE ?
        OR u.lot_no LIKE ?
        OR u.material LIKE ?
        OR u.supplier LIKE ?
      )
    ) t
    WHERE t.bucket IS NOT NULL
    GROUP BY t.bucket;
  `;
      const bucketsParams = [
        // CASE bucket: 9 mốc ngày (thứ tự trong CASE, TRƯỚC phần WHERE)
        sp.twoMonthsAgoStart,
        sp.twoMonthsAgoStart,
        sp.prevMonthStart,
        sp.prevMonthStart,
        sp.today,
        sp.today,
        sp.next3End,
        sp.next3End,
        sp.next7End,
        // KEYWORD: 4 nhánh prefix + 2 contains
        sp.prefixPattern,
        sp.prefixPattern,
        sp.prefixPattern,
        sp.prefixPattern,
        sp.containsPattern,
        sp.containsPattern,
      ];
      guardParams(bucketsParams);
      const bucketsResult = await query(toDialect(sqlBuckets), bucketsParams);
      const buckets = {};
      for (const row of bucketsResult.rows) {
        buckets[row.bucket] = Number(row.n);
      }

      await this.dropTempTables(query);
      return buckets;
    });
  }

}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository().pos;
} else {
  module.exports = new PoModel();
  module.exports.PoModel = PoModel; // for reset.repository tx use
}
