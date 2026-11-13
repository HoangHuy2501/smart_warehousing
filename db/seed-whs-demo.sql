-- ============================================================
-- SEED DỮ LIỆU MẪU CHO WH3 — CHỈ INSERT KHI CHƯA TỒN TẠI
-- ============================================================
-- NGUYÊN TẮC: MỌI lệnh đều dùng MERGE / WHERE NOT EXISTS
--              KHÔNG ghi đè dữ liệu đã có của người dùng
-- ============================================================

USE [your_database_name];
GO

SET NOCOUNT ON;
GO

PRINT '========================================';
PRINT 'Seed whs_user_role (3 tai khoan demo)';
PRINT '========================================';
GO

MERGE INTO whs_user_role AS tgt
USING (VALUES
  ('EMP001', 'KEEPER',  '123456', 0, 1),
  ('EMP002', 'KEEPER',  '123456', 0, 1),
  ('EMP003', 'MANAGER', '123456', 0, 1)
) AS src (emp_no, role, password, locked, active)
  ON tgt.emp_no = src.emp_no
WHEN NOT MATCHED THEN
  INSERT (emp_no, role, password, locked, active)
  VALUES (src.emp_no, src.role, src.password, src.locked, src.active);
GO

PRINT 'whs_user_role — done';
GO

-- ============================================================
-- SEED KỆ (whs_slots) — 27 kệ GIF3, A1/A2 thuộc EMP001, A3 thuộc EMP002
-- ============================================================
PRINT ' ';
PRINT '========================================';
PRINT 'Seed whs_slots (27 ke GIF3 — A1/A2: EMP001, A3: EMP002)';
PRINT '========================================';
GO

DECLARE @slots TABLE (
  code         VARCHAR(30),
  warehouse    VARCHAR(20),
  slot_row     VARCHAR(10),
  floor        VARCHAR(10),
  position     VARCHAR(10),
  keeper_emp_no VARCHAR(40),
  locked       BIT,
  is_full      BIT,
  active       BIT
);

INSERT INTO @slots (code, warehouse, slot_row, floor, position, keeper_emp_no, locked, is_full, active)
SELECT 'GIF3-' + row_code + '-' + floor_str + '-' + pos_str,
       'GIF3',
       row_code,
       floor_str,
       pos_str,
       CASE row_code WHEN 'A3' THEN 'EMP002' ELSE 'EMP001' END,
       CASE WHEN row_code = 'A2' AND floor_str = '03' AND pos_str = '02' THEN 1 ELSE 0 END,
       CASE WHEN row_code = 'A1' AND floor_str = '03' AND pos_str = '01' THEN 1 ELSE 0 END,
       1
FROM (VALUES ('A1'),('A2'),('A3')) AS rows(row_code)
CROSS JOIN (VALUES ('01'),('02'),('03')) AS floors(floor_str)
CROSS JOIN (VALUES ('01'),('02'),('03')) AS positions(pos_str);

MERGE INTO whs_slots AS tgt
USING @slots AS src
  ON tgt.code = src.code
WHEN NOT MATCHED THEN
  INSERT (code, warehouse, slot_row, floor, position, keeper_emp_no, locked, is_full, active)
  VALUES (src.code, src.warehouse, src.slot_row, src.floor, src.position, src.keeper_emp_no, src.locked, src.is_full, src.active);
GO

PRINT 'whs_slots — done (27 ke)';
GO

-- ============================================================
-- SEED t8_bas_emp (3 nhan vien demo)
-- ============================================================
PRINT ' ';
PRINT '========================================';
PRINT 'Seed t8_bas_emp (3 nhan vien demo)';
PRINT '========================================';
GO

MERGE INTO t8_bas_emp AS tgt
USING (VALUES
  (1, 'EMP001', N'Nguyễn Văn An', 'an.nguyen@germton.com', 'GI-IT', 'GI',  'NV', 'Y'),
  (2, 'EMP002', N'Trần Thị Bình',  'binh.tran@germton.com','GI-IT', 'GI',  'NV', 'Y'),
  (3, 'EMP003', N'Lê Văn Cường',   'cuong.le@germton.com', 'GI-IT', 'GI',  'QL', 'Y')
) AS src (id, emp_no, emp_name, email, dept_no, org_no, duty_no, act_sw)
  ON tgt.emp_no = src.emp_no
WHEN NOT MATCHED THEN
  INSERT (id, emp_no, emp_name, email, dept_no, org_no, duty_no, act_sw)
  VALUES (src.id, src.emp_no, src.emp_name, src.email, src.dept_no, src.org_no, src.duty_no, src.act_sw);
GO

PRINT 't8_bas_emp — done';
GO

-- ============================================================
-- KIỂM TRA KẾT QUẢ
-- ============================================================
PRINT ' ';
PRINT '========================================';
PRINT 'Kiem tra ket qua seed';
PRINT '========================================';
GO

SELECT 'whs_user_role' AS tbl, COUNT(*) AS cnt FROM whs_user_role
UNION ALL
SELECT 'whs_slots', COUNT(*) FROM whs_slots
UNION ALL
SELECT 't8_bas_emp', COUNT(*) FROM t8_bas_emp;
GO

-- Thong ke ke theo day + thu kho
SELECT
  slot_row AS [Day],
  keeper_emp_no AS [ThuKho],
  COUNT(*) AS [SoKe]
FROM whs_slots
WHERE warehouse = 'GIF3'
GROUP BY slot_row, keeper_emp_no
ORDER BY slot_row, keeper_emp_no;
GO

PRINT ' ';
PRINT '========================================';
PRINT 'HOAN THANH SEED';
PRINT '========================================';
GO
