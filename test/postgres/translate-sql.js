'use strict';

const { TABLES } = require('../../src/config/tables');

const TABLE_PAIRS = [
  ['sys_userpass', TABLES.userPass],
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

// Chuyển cú pháp SQL Server cho chế độ PostgreSQL.
function toPostgresSql(text) {
  let out = text.replace(/\bCOUNT_BIG\s*\(/gi, 'COUNT(');
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

module.exports = toPostgresSql;
